// Algebraic parts of the model against python/golden.
//
// Tolerance: relative 1e-8.
// Both implementations solve the same closed-form equations; the only difference is the root
// finder (Python brentq xtol 1e-15 / rtol 1e-12, here safeguarded Newton to ~1e-13 relative).
// Observed worst case is ~1e-10, so 1e-8 leaves two orders of margin while any change in an
// equation or parameter (>= 1e-6 relative effect) still fails.

import { describe, expect, test } from "vitest";
import { loadCsv } from "./golden";
import { DEFAULT, cellCurrent, filamentCount, filamentCurrent, ivFixedState, readResistance, solveVsw } from "../src/model";

const RTOL = 1e-8;

function relErr(a: number, b: number, floor: number): number {
	return Math.abs(a - b) / (Math.abs(b) + floor);
}

describe("golden: algebraic", () => {
	test("filament_current.csv: single-filament I and V_gap", () => {
		const g = loadCsv("filament_current.csv");
		for (let k = 0; k < g.v_V.length; k++) {
			const r = filamentCurrent(g.v_V[k], g.x_m[k], g.w_m[k], DEFAULT);
			expect(relErr(r.i, g.i_A[k], 1e-30)).toBeLessThan(RTOL);
			expect(relErr(r.vGap, g.v_gap_V[k], 1e-15)).toBeLessThan(RTOL);
		}
	});

	test("fixed_state_iv.csv: fixed-state read I-V", () => {
		const g = loadCsv("fixed_state_iv.csv");
		for (let k = 0; k < g.v_V.length; k++) {
			const i = ivFixedState([g.v_V[k]], g.x_m[k], g.A_m2[k], DEFAULT)[0];
			expect(relErr(i, g.i_A[k], 1e-20)).toBeLessThan(RTOL);	// floor: I = 0 exactly at V = 0
		}
	});

	test("read_resistance.csv: R at 0.2 V", () => {
		const g = loadCsv("read_resistance.csv");
		for (let k = 0; k < g.R_ohm.length; k++) expect(relErr(readResistance(g.x_m[k], g.w_m[k], DEFAULT), g.R_ohm[k], 0)).toBeLessThan(RTOL);
	});
});

describe("model invariants", () => {
	test("filament current is odd in V", () => {
		for (const v of [0.05, 0.3, 1.7]) {
			const a = filamentCurrent(v, 1e-9, 2e-9, DEFAULT);
			const b = filamentCurrent(-v, 1e-9, 2e-9, DEFAULT);
			expect(a.i).toBeCloseTo(-b.i, 20);
		}
	});

	test("series equation is satisfied by solveVsw", () => {
		const rs = 18e3;	// [ohm]
		for (const va of [-2.5, -0.2, 0.2, 1.3, 2.5]) {
			for (const [x, w] of [[3e-9, 0.5e-9], [0, 5e-9], [1e-9, 2e-9]]) {
				const vs = solveVsw(va, x, w, DEFAULT, rs);
				const resid = vs + cellCurrent(vs, x, w, DEFAULT) * (DEFAULT.RL + rs) - va;
				expect(Math.abs(resid)).toBeLessThan(1e-12);
			}
		}
	});

	test("filament count N = round(nF*aCell), at least 1", () => {
		expect(filamentCount(DEFAULT)).toBe(1);
		expect(filamentCount({ ...DEFAULT, nF: 4e16 })).toBe(4);
		expect(filamentCount({ ...DEFAULT, nF: 1e10 })).toBe(1);
	});
});
