// 과도 시뮬레이션을 python/golden과 비교 (파이썬은 BDF, 여기서는 ROS2).
//
// 허용 오차 (상대오차):
// - 점별: I, x, w, T 모두 1e-3. 단, ±1 출력 샘플의 시간 창 안에서 비교한다.
//   시간 창을 두는 이유: 급격한 SET에서는 I가 출력 간격 하나(tEnd/2000) 안에서 몇 자릿수 바뀐다.
//   두 적분기는 내부 스텝 위치가 달라서 같은 사건이 이웃 샘플에 찍힐 수 있고, 같은 샘플끼리만
//   엄격히 비교하면 샘플 간격보다 작은 시간 어긋남이 O(1) 오차로 보고된다. 시간 창 밖에서는 엄격하다.
//   1e-3인 이유: 두 실행 모두 rtol = 1e-6이고 관측된 최악값은 ~1.5e-4 (sweep_n4, 전류).
//   Ea만 0.1% 바꿔도 SET 시점과 전류가 1e-2 넘게 바뀌므로 모델 오류는 여전히 잡힌다.
// - 하한 (0에 가까운 값으로 나누는 것 방지): x는 |x| + a (격자 한 칸보다 작은 갭은 물리적으로 의미 없음).
//   스윕 전류는 1e-12 A (그래프 범위 1e-9 A보다 훨씬 아래). 펄스 전류는 1e-3 * max|I|
//   (전체 크기의 0.1%, 선형 펄스 그래프에서 보이지 않음). 펄스 끝(V = 0)에서 CP 방전 전류가
//   0을 지나고 직렬 저항이 Rs_reset에서 Rs로 바뀌기 때문이다 (A14). 그 점의 잔류 전류는 ~8 nA이고
//   두 구현의 차이는 ~1e-10 A.
// - 스칼라: V_SET / V_RESET은 출력 전압 한 스텝 안에서 일치, I_max는 1e-3 이내.

import { describe, expect, test } from "vitest";
import { loadCsv } from "./golden";
import {
	DEFAULT, INIT_HRS, INIT_LRS, RS_PULSE, RS_SWEEP, normalRng, pulseWaveform, sampleCycleParams,
	simulate, sweepWaveform, switchingVoltage, DEFAULT_VARIABILITY,
	type Params, type SimOptions, type SimResult, type Waveform,
} from "../src/model";

const RTOL = 1e-3;

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

// golden의 [k-1, k+1] 범위를 벗어난 정도의 최대 상대오차 (r은 golden 시각으로 보간)
function windowedRelErr(tr: ArrayLike<number>, a: ArrayLike<number>, tg: number[], b: number[], floor: number): { err: number; at: number } {
	let worst = 0;
	let at = 0;
	for (let k = 0; k < b.length; k++) {
		const v = interp(tr, a, tg[k]);
		const nb = [b[Math.max(k - 1, 0)], b[k], b[Math.min(k + 1, b.length - 1)]];
		const lo = Math.min(...nb);
		const hi = Math.max(...nb);
		const d = v < lo ? lo - v : v > hi ? v - hi : 0;
		const e = d / (Math.abs(b[k]) + floor);
		if (e > worst) {
			worst = e;
			at = tg[k];
		}
	}
	return { err: worst, at };
}

interface Case {
	file: string;
	wf: Waveform;
	init: readonly number[] | (() => readonly number[]);
	opt: SimOptions;
	p: Params;
	pulse: boolean;
}

const lastState = (file: string): readonly number[] => {
	const g = loadCsv(file);
	return [g.x_m[g.x_m.length - 1], g.w_m[g.w_m.length - 1]];
};

const sweepOpt: SimOptions = { rs: RS_SWEEP };
const pulseOpt: SimOptions = { rs: RS_PULSE, includeCp: true, maxStep: 0.1e-9 };

const CASES: Case[] = [
	{ file: "sweep_cycle1.csv", wf: sweepWaveform(), init: INIT_HRS, opt: sweepOpt, p: DEFAULT, pulse: false },
	{ file: "sweep_cycle2.csv", wf: sweepWaveform(), init: () => lastState("sweep_cycle1.csv"), opt: sweepOpt, p: DEFAULT, pulse: false },
	{ file: "sweep_ramp_10us.csv", wf: sweepWaveform(2.5, -2.5, 10e-6), init: INIT_HRS, opt: sweepOpt, p: DEFAULT, pulse: false },
	{ file: "sweep_ramp_100us.csv", wf: sweepWaveform(2.5, -2.5, 100e-6), init: INIT_HRS, opt: sweepOpt, p: DEFAULT, pulse: false },
	{ file: "sweep_ramp_1000us.csv", wf: sweepWaveform(2.5, -2.5, 1e-3), init: INIT_HRS, opt: sweepOpt, p: DEFAULT, pulse: false },
	{ file: "sweep_n4.csv", wf: sweepWaveform(), init: INIT_HRS, opt: sweepOpt, p: { ...DEFAULT, nF: 4e16 }, pulse: false },
	{ file: "pulse_set.csv", wf: pulseWaveform(2), init: INIT_HRS, opt: pulseOpt, p: DEFAULT, pulse: true },
	{ file: "pulse_reset.csv", wf: pulseWaveform(-2), init: INIT_LRS, opt: pulseOpt, p: DEFAULT, pulse: true },
];

describe("golden: 과도 응답", () => {
	for (const c of CASES) {
		test(c.file, () => {
			const g = loadCsv(c.file);
			const init = typeof c.init === "function" ? c.init() : c.init;
			const r: SimResult = simulate(c.wf, init[0], init[1], c.p, c.opt);
			const iMaxG = Math.max(...g.i_A.map(Math.abs));
			const iFloor = c.pulse ? 1e-3 * iMaxG : 1e-12;	// [A]
			const checks: [string, ArrayLike<number>, number[], number][] = [
				["i", r.i, g.i_A, iFloor],
				["x", r.x, g.x_m, c.p.a],
				["w", r.w, g.w_m, 0],
				["T", r.T, g.T_K, 0],
			];
			for (const [name, a, b, floor] of checks) {
				const e = windowedRelErr(r.t, a, g.t_s, b, floor);
				expect(e.err, `${name}, t = ${e.at} s`).toBeLessThan(RTOL);
			}
			const iMax = Math.max(...Array.from(r.i, Math.abs));
			expect(Math.abs(iMax - iMaxG) / iMaxG).toBeLessThan(RTOL);
			if (!c.pulse) {
				const dv = 2.5 / ((g.t_s.length - 1) / 4);	// 출력 한 스텝에 해당하는 전압 [V]
				const sTs = switchingVoltage(r, c.p);
				const gRes = { t: g.t_s, vApp: g.v_app_V, i: g.i_A, x: g.x_m } as unknown as SimResult;
				const sPy = switchingVoltage(gRes, c.p);
				expect(Math.abs(sTs.vSet - sPy.vSet)).toBeLessThanOrEqual(dv + 1e-12);
				expect(Math.abs(sTs.vReset - sPy.vReset)).toBeLessThanOrEqual(dv + 1e-12);
			}
		});
	}
});

describe("변동성", () => {
	test("같은 시드면 같은 사이클, 다른 시드면 다른 결과", () => {
		const wf = sweepWaveform(2.5, -2.5, 10e-6);
		const run = (seed: number): SimResult => {
			const rng = normalRng(seed);
			const pc = sampleCycleParams(DEFAULT, DEFAULT_VARIABILITY, rng);
			return simulate(wf, INIT_HRS[0], INIT_HRS[1], pc, { rs: RS_SWEEP, noiseDt: 0.2e-6, rng });
		};
		const a = run(1);
		const b = run(1);
		const c = run(2);
		expect(Array.from(a.i)).toEqual(Array.from(b.i));
		expect(a.x[a.x.length - 1]).not.toBe(c.x[c.x.length - 1]);
		for (let k = 0; k < a.x.length; k++) {
			expect(a.x[k]).toBeGreaterThanOrEqual(0);
			expect(a.x[k]).toBeLessThanOrEqual(DEFAULT.L0);
		}
	});

	test("normalRng의 평균은 ~0, 분산은 1", () => {
		const rng = normalRng(42);
		const n = 200_000;
		let s = 0;
		let s2 = 0;
		for (let k = 0; k < n; k++) {
			const z = rng();
			s += z;
			s2 += z * z;
		}
		expect(Math.abs(s / n)).toBeLessThan(0.01);
		expect(Math.abs(s2 / n - 1)).toBeLessThan(0.02);
	});
});
