// Transient simulation against python/golden (BDF in Python vs. ROS2 here).
//
// Tolerances (relative error):
// - Pointwise: 1e-3 for I, x, w, T, compared within a +-1 output-sample time window.
//   Why the window: abrupt SET moves I by orders of magnitude within one output interval
//   (tEnd/2000). The two integrators place internal steps differently, so the same event can
//   land on adjacent samples; a strict same-sample comparison would then report O(1) errors that
//   are only a sub-sample time shift. Outside the window the bound is strict.
//   Why 1e-3: both runs use rtol = 1e-6; observed worst case is ~1.5e-4 (sweep_n4, current).
//   A 0.1 % change of Ea alone shifts SET timing and currents by > 1e-2, so model errors still fail.
// - Floors (avoid dividing by ~0): x uses |x| + a (sub-lattice gaps are not resolved physically);
//   sweep current uses 1e-12 A (far below the 1e-9 A plotted range); pulse current uses
//   1e-3 * max|I| (0.1 % of full scale, invisible on the linear pulse plot), because at the
//   pulse end (V = 0) the CP discharge current crosses zero and the series resistance switches
//   from Rs_reset to Rs (A14); there the residual is ~8 nA and differs by ~1e-10 A between the two.
// - Scalars: V_SET / V_RESET equal within one output voltage step; I_max within 1e-3.

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

// Max relative error of r (interpolated to golden times) outside the golden [k-1, k+1] envelope
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

describe("golden: transient", () => {
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
				expect(e.err, `${name} at t = ${e.at}`).toBeLessThan(RTOL);
			}
			const iMax = Math.max(...Array.from(r.i, Math.abs));
			expect(Math.abs(iMax - iMaxG) / iMaxG).toBeLessThan(RTOL);
			if (!c.pulse) {
				const dv = 2.5 / ((g.t_s.length - 1) / 4);	// one output step in voltage [V]
				const sTs = switchingVoltage(r, c.p);
				const gRes = { t: g.t_s, vApp: g.v_app_V, i: g.i_A, x: g.x_m } as unknown as SimResult;
				const sPy = switchingVoltage(gRes, c.p);
				expect(Math.abs(sTs.vSet - sPy.vSet)).toBeLessThanOrEqual(dv + 1e-12);
				expect(Math.abs(sTs.vReset - sPy.vReset)).toBeLessThanOrEqual(dv + 1e-12);
			}
		});
	}
});

describe("variability", () => {
	test("same seed gives identical cycles; different seeds differ", () => {
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

	test("normalRng has ~zero mean and unit variance", () => {
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
