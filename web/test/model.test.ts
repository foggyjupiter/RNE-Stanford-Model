// 모델을 python/golden과 비교한다 (unipolar 2차원 모델).
//
// 허용 오차 (상대오차):
// - 정상 상태 풀이 (fields, 읽기 저항, 몬테카를로 소자 저항): 1e-8.
//   두 구현은 같은 유한체적 식, 같은 Picard 반복(허용 0.05 K)을 쓰고 선형 풀이만 다르다
//   (파이썬 LU, 여기서는 대역 Cholesky). 관측된 최악값 ~4e-12라 1e-8은 네 자릿수 여유.
// - 고정 상태 I-V: 1e-5 (하한 1e-9·max|I|). 회로 풀이의 Brent 허용오차(전압 1e-7 V)가
//   작은 전압 점에서 상대오차로 커진다. 관측된 최악값 ~4e-7.
// - 과도 응답 (I, 가장 가는 곳 반경, 최고 온도): 1e-5. 두 구현은 같은 적응 스텝 규칙을 써서
//   스텝 수가 같고(340/1138/641/508), 관측된 최악값 ~2e-7. ±1 출력 샘플 시간 창 안에서 비교한다
//   (스텝 시각이 반올림 수준에서 달라 경계에서 이웃 샘플에 찍힐 수 있으므로).
//   하한: 전류 1e-3·max|I|, 반경 1 nm.
// 민감도: v_D0를 1% 바꾸면 RESET 시점이 달라져 과도 응답 비교가 1e-2 넘게 어긋난다.

import { describe, expect, test } from "vitest";
import { loadCsv } from "./golden";
import {
	DEFAULT, DEFAULT_GRID, FieldSolver, OUR_DEVICE, TIN_ELECTRODE, gapProfile, deviceRead, ivFixedState, makeGrid, neckProfile, pulseWaveform, rampWaveform,
	readResistance, resetRampWaveform, simulate, sweepWaveform, type Params, type SimOptions, type Waveform,
} from "../src/model";

const P = DEFAULT;

function interp(t: ArrayLike<number>, y: ArrayLike<number>, tq: number): number {
	let lo = 0;
	let hi = t.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (t[mid] <= tq) lo = mid;
		else hi = mid;
	}
	const s = t[hi] > t[lo] ? (tq - t[lo]) / (t[hi] - t[lo]) : 0;
	return y[lo] + s * (y[hi] - y[lo]);
}

// golden의 [k-1, k+1] 범위를 벗어난 정도의 최대 상대오차 (계산값은 golden 시각으로 보간)
function windowedRelErr(tr: ArrayLike<number>, a: ArrayLike<number>, tg: number[], b: number[], floor: number): number {
	let worst = 0;
	for (let k = 0; k < b.length; k++) {
		const v = interp(tr, a, tg[k]);
		const nb = [b[Math.max(k - 1, 0)], b[k], b[Math.min(k + 1, b.length - 1)]];
		const lo = Math.min(...nb);
		const hi = Math.max(...nb);
		const d = v < lo ? lo - v : v > hi ? v - hi : 0;
		worst = Math.max(worst, d / (Math.abs(b[k]) + floor));
	}
	return worst;
}

function profile(rNeck: number, len: number): Float64Array {
	const g = makeGrid(P, DEFAULT_GRID);
	return len > 0 ? neckProfile(rNeck, len, P) : new Float64Array(g.nz).fill(rNeck);
}

describe("golden: 정상 상태", () => {
	test("fields.csv: 전위·온도 풀이 한 번", () => {
		const f = loadCsv("fields.csv");
		const g = makeGrid(P, DEFAULT_GRID);
		for (let k = 0; k < f.v_V.length; k++) {
			const fld = new FieldSolver(g, P, profile(f.r_neck_m[k], f.neck_len_m[k])).solve(f.v_V[k]);
			expect(Math.abs(fld.I - f.i_A[k]) / f.i_A[k]).toBeLessThan(1e-8);
			expect(Math.abs(fld.tMax - f.T_max_K[k]) / f.T_max_K[k]).toBeLessThan(1e-8);
			expect(Math.abs(fld.P - f.P_W[k]) / f.P_W[k]).toBeLessThan(1e-8);
		}
	});

	test("fields_tin.csv: TiN 전극층 (A41)", () => {
		const f = loadCsv("fields_tin.csv");
		for (let k = 0; k < f.v_V.length; k++) {
			const p: Params = { ...P, ...TIN_ELECTRODE, aCell: f.A_cell_m2[k], nF: 1 / f.A_cell_m2[k] };
			const g = makeGrid(p, DEFAULT_GRID);
			const rb = f.neck_len_m[k] > 0 ? neckProfile(f.r_neck_m[k], f.neck_len_m[k], p) : new Float64Array(g.nz).fill(f.r_neck_m[k]);
			const fld = new FieldSolver(g, p, rb).solve(f.v_V[k]);
			expect(Math.abs(fld.I - f.i_A[k]) / f.i_A[k]).toBeLessThan(1e-8);
			expect(Math.abs(fld.tMax - f.T_max_K[k]) / f.T_max_K[k]).toBeLessThan(1e-8);
			expect(Math.abs(fld.P - f.P_W[k]) / f.P_W[k]).toBeLessThan(1e-8);
		}
	});

	test("fields_hop.csv: 갭 호핑 전도 (A55)", () => {
		const f = loadCsv("fields_hop.csv");
		const p = { ...P, ...OUR_DEVICE, phi0: 78e-9, rhoOx: 1.84e10, hop: 1 } as Params;
		const g = makeGrid(p, DEFAULT_GRID);
		for (let k = 0; k < f.v_V.length; k++) {
			const fs = new FieldSolver(g, p, gapProfile(78e-9, f.gap_m[k], p));
			const fld = fs.solve(f.v_V[k]);
			expect(Math.abs(fs.gHop - f.g_hop_m[k]) / f.g_hop_m[k]).toBeLessThan(1e-12);
			expect(Math.abs(fld.I - f.i_A[k]) / f.i_A[k]).toBeLessThan(1e-8);
			expect(Math.abs(fld.tMax - f.T_max_K[k]) / f.T_max_K[k]).toBeLessThan(1e-8);
		}
	});

	test("read_resistance.csv: 0.1 V 읽기 저항", () => {
		const r = loadCsv("read_resistance.csv");
		for (let k = 0; k < r.R_ohm.length; k++) {
			const R = readResistance(profile(r.r_neck_m[k], r.neck_len_m[k]), P);
			expect(Math.abs(R - r.R_ohm[k]) / r.R_ohm[k]).toBeLessThan(1e-8);
		}
	});

	test("fixed_state_iv.csv: 고정 상태 I-V", () => {
		const f = loadCsv("fixed_state_iv.csv");
		const imax = Math.max(...f.i_A.map(Math.abs));
		for (let k = 0; k < f.v_V.length; k++) {
			const i = ivFixedState([f.v_V[k]], profile(f.r_neck_m[k], f.neck_len_m[k]), P)[0];
			expect(Math.abs(i - f.i_A[k]) / (Math.abs(f.i_A[k]) + 1e-9 * imax)).toBeLessThan(1e-5);
		}
	});

	test("mc_devices.csv: 필라멘트가 서로 다른 소자의 읽기 저항", () => {
		const m = loadCsv("mc_devices.csv");
		for (const c of [...new Set(m.case)]) {
			const idx = m.case.map((x, k) => (x === c ? k : -1)).filter((k) => k >= 0);
			const fil = idx.map((k) => ({ phi: m.phi_m[k], rNeck: m.r_neck_m[k], neckLen: m.neck_len_m[k] }));
			const R = deviceRead(fil, P);
			expect(Math.abs(R - m.R_device_ohm[idx[0]]) / m.R_device_ohm[idx[0]]).toBeLessThan(1e-8);
		}
	});
});

describe("golden: 과도 응답", () => {
	const hp = loadCsv("hrs_profile.csv");
	const cases: [string, Waveform, ArrayLike<number> | null, SimOptions, Params?][] = [
		["reset_sweep_4Vps.csv", resetRampWaveform(1.6, 0.4), null, {}],
		["cycle_sweep.csv", sweepWaveform(1.6, 4.0, 0.25), null, { rs: 3e3 }],
		["cycle_sweep_cc.csv", sweepWaveform(1.6, 4.0, 0.25), null, { iCc: 1e-3 }],
		["reset_ramp_tin.csv", rampWaveform("reset", 1.6, 4.0), null, {}, { ...P, ...TIN_ELECTRODE }],
		["pulse_reset.csv", pulseWaveform("reset", 3.0, 10e-9, 10e-6), null, { includeCp: true }],
		["pulse_set.csv", pulseWaveform("set", 2.5, 10e-9, 1e-6), Float64Array.from(hp.rb_m), { includeCp: true, rs: 3e3 }],
	];
	for (const [file, wf, rb0, opt, params] of cases) {
		test(file, () => {
			const g = loadCsv(file);
			const r = simulate(wf, rb0, params ?? P, opt);
			const imax = Math.max(...g.i_A.map(Math.abs));
			expect(windowedRelErr(r.t, r.i, g.t_s, g.i_A, 1e-3 * imax)).toBeLessThan(1e-5);
			expect(windowedRelErr(r.t, r.rMin, g.t_s, g.r_min_m, 1e-9)).toBeLessThan(1e-5);
			expect(windowedRelErr(r.t, r.T, g.t_s, g.T_max_K, 0)).toBeLessThan(1e-5);
		}, 120000);
	}
});

// 우리 소자 (A51-A54): 평균 전계 SET, CC에 닿으면 멈춤, 패드 정전용량 방전.
// RESET 램프는 위와 같은 파형 비교 (반경 하한 0.1 nm: RESET 뒤 가장 가는 곳이 0.04 nm). 필라멘트 전류(i_cell)도 비교한다.
// SET은 CC 도달이라는 문턱 사건이라 파형 대신 사건 값으로 비교한다: 두 스텝 상한(경계 이동, 전압 변화)이
// 거의 같은 스텝에서 반올림 차이로 고르는 쪽이 갈려 시각이 한 스텝 안에서 어긋나고, 그러면 CC 도달 직후의
// 급격한 방전이 다른 샘플에 찍혀 파형 비교가 무의미해진다 (관측: 43번째 스텝 dt 0.0099998 대 0.01 s).
// 허용: CC 도달 전압 ±0.02 V (계단 0.01 V의 두 배), 필라멘트 최대 전류 5%, C_P 없을 때 도달 순간의 가장 가는 곳 반경 1e-5.
// 끝 상태(가장 가는 곳 5%)는 C_P 방전으로 정해지는 경우만 본다. C_P가 없으면 CC를 0.1 s 유지하는 동안 전류 고정 성장과
// 가열이 되먹임해 스텝 선택에 민감하다 (관측: 끝 반경 1.64 대 1.27 nm, A49).
describe("golden: 우리 소자", () => {
	const Pour = { ...P, ...OUR_DEVICE } as Params;
	test("our_reset_ramp.csv", () => {
		const g = loadCsv("our_reset_ramp.csv");
		const r = simulate(rampWaveform("reset", 1.5, 1.0), null, Pour, {});
		const imax = Math.max(...g.i_A.map(Math.abs));
		const cmax = Math.max(...g.i_cell_A.map(Math.abs));
		expect(windowedRelErr(r.t, r.i, g.t_s, g.i_A, 1e-3 * imax)).toBeLessThan(1e-5);
		expect(windowedRelErr(r.t, r.iCell, g.t_s, g.i_cell_A, 1e-3 * cmax)).toBeLessThan(1e-5);
		expect(windowedRelErr(r.t, r.rMin, g.t_s, g.r_min_m, 1e-10)).toBeLessThan(1e-5);
		expect(windowedRelErr(r.t, r.T, g.t_s, g.T_max_K, 0)).toBeLessThan(1e-5);
	}, 300000);
	// 갭 호핑을 켠 RESET (A55, A61). 끊기기 전(갭이 생기기 전)까지는 파형을 비교한다: 스텝 상한이 gT/5로 작아
	// 스텝이 많아서 반올림 누적이 크다(관측 최악 ~4e-5) → 1e-4. 끊긴 뒤 CF 끝이 녹는 과정은 작은 차이를 키우는
	// 불안정이라(A61) 파형은 수십 % 갈라질 수 있어, 끝 상태의 HRS(1%)와 갭 길이(한 칸)로 본다. 관측: HRS 0.1% 차이.
	test("our_reset_ramp_hop.csv", () => {
		const g = loadCsv("our_reset_ramp_hop.csv");
		const ge = Float64Array.from(loadCsv("our_hrs_profile_hop.csv").rb_m);
		const Ph = { ...Pour, hop: 1 } as Params;
		const r = simulate(rampWaveform("reset", 1.5, 1.0), null, Ph, {});
		let kb = g.r_min_m.findIndex((x) => x < Ph.dr);	// golden에서 처음 갭이 생긴 샘플
		if (kb < 0) kb = g.r_min_m.length;
		const pre = (a: number[]): number[] => a.slice(0, kb);
		const imax = Math.max(...g.i_A.map(Math.abs));
		expect(windowedRelErr(r.t, r.i, pre(g.t_s), pre(g.i_A), 1e-3 * imax)).toBeLessThan(1e-4);
		expect(windowedRelErr(r.t, r.rMin, pre(g.t_s), pre(g.r_min_m), 1e-10)).toBeLessThan(1e-4);
		expect(windowedRelErr(r.t, r.T, pre(g.t_s), pre(g.T_max_K), 0)).toBeLessThan(1e-4);
		const hrsG = readResistance(ge, Ph);
		expect(Math.abs(readResistance(r.rbEnd, Ph) - hrsG) / hrsG).toBeLessThan(0.01);
		const dz = Ph.L0 / DEFAULT_GRID.nz;
		const gapLen = (rb: ArrayLike<number>): number => Array.from(rb).reduce((acc, x) => acc + Math.max(0, 1 - x / Ph.dr), 0) * dz;
		expect(Math.abs(gapLen(r.rbEnd) - gapLen(ge))).toBeLessThan(dz * 1.0001);
	}, 600000);
	const cases: [string, SimOptions, boolean][] = [
		["our_set_cc_stop.csv", { iCc: 1e-4, ccHold: 0.1 }, false],
		["our_set_cc_stop_cp.csv", { iCc: 1e-4, ccHold: 0.1, includeCp: true, dvcMax: 0.05 }, true],
	];
	const ccIndex = (i: ArrayLike<number>): number => {
		for (let k = 0; k < i.length; k++) if (Math.abs(i[k]) >= 0.9e-4) return k;
		return -1;
	};
	const amax = (a: ArrayLike<number>): number => Math.max(...Array.from(a, Math.abs));
	for (const [file, opt, endState] of cases) {
		test(file, () => {
			const g = loadCsv(file);
			const rb0 = Float64Array.from(loadCsv("our_hrs_profile.csv").rb_m);
			const r = simulate(rampWaveform("set", 5.0, 1.0), rb0, Pour, opt);
			const k = ccIndex(r.i);
			const kg = ccIndex(g.i_A);
			expect(Math.abs(r.vApp[k] - g.v_app_V[kg])).toBeLessThan(0.02);
			// C_P가 있으면 CC 도달이 방전으로 반경이 급히 자라는 도중이라 도달 순간 반경은 스텝 시각에 민감 → 끝 상태로 본다
			if (!endState) expect(Math.abs(r.rMin[k] - g.r_min_m[kg]) / g.r_min_m[kg]).toBeLessThan(1e-5);
			const cm = amax(g.i_cell_A);
			expect(Math.abs(amax(r.iCell) - cm) / cm).toBeLessThan(0.05);
			if (endState) {
				const rEnd = g.r_min_m[g.r_min_m.length - 1];
				expect(Math.abs(r.rMin[r.rMin.length - 1] - rEnd) / Math.max(rEnd, 1e-10)).toBeLessThan(0.05);
			}
		}, 300000);
	}
});
