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
	DEFAULT, DEFAULT_GRID, FieldSolver, deviceRead, ivFixedState, makeGrid, neckProfile, pulseWaveform, readResistance,
	resetRampWaveform, simulate, sweepWaveform, type SimOptions, type Waveform,
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
	const cases: [string, Waveform, ArrayLike<number> | null, SimOptions][] = [
		["reset_sweep_4Vps.csv", resetRampWaveform(1.6, 0.4), null, {}],
		["cycle_sweep.csv", sweepWaveform(1.6, 4.0, 0.25), null, { rs: 3e3 }],
		["cycle_sweep_cc.csv", sweepWaveform(1.6, 4.0, 0.25), null, { iCc: 1e-3 }],
		["pulse_reset.csv", pulseWaveform("reset", 3.0, 10e-9, 10e-6), null, { includeCp: true }],
		["pulse_set.csv", pulseWaveform("set", 2.5, 10e-9, 1e-6), Float64Array.from(hp.rb_m), { includeCp: true, rs: 3e3 }],
	];
	for (const [file, wf, rb0, opt] of cases) {
		test(file, () => {
			const g = loadCsv(file);
			const r = simulate(wf, rb0, P, opt);
			const imax = Math.max(...g.i_A.map(Math.abs));
			expect(windowedRelErr(r.t, r.i, g.t_s, g.i_A, 1e-3 * imax)).toBeLessThan(1e-5);
			expect(windowedRelErr(r.t, r.rMin, g.t_s, g.r_min_m, 1e-9)).toBeLessThan(1e-5);
			expect(windowedRelErr(r.t, r.T, g.t_s, g.T_max_K, 0)).toBeLessThan(1e-5);
		}, 120000);
	}
});
