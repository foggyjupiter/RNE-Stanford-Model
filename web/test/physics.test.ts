// 모델의 대수 부분을 python/golden과 비교.
//
// 허용 오차: 상대 1e-8.
// 두 구현은 같은 닫힌 형태의 식을 풀고, 차이는 근 찾기 방법뿐이다
// (파이썬 brentq xtol 1e-15 / rtol 1e-12, 여기서는 상대 ~1e-13까지 수렴하는 안전장치 뉴턴법).
// 관측된 최악값이 ~1e-10이므로 1e-8은 두 자릿수 여유를 주면서도,
// 식이나 파라미터가 바뀌면 (상대 영향 >= 1e-6) 여전히 실패한다.

import { describe, expect, test } from "vitest";
import { loadCsv } from "./golden";
import { DEFAULT, cellCurrent, filamentCount, filamentCurrent, ivFixedState, readResistance, solveVsw } from "../src/model";

const RTOL = 1e-8;

function relErr(a: number, b: number, floor: number): number {
	return Math.abs(a - b) / (Math.abs(b) + floor);
}

describe("golden: 대수 부분", () => {
	test("filament_current.csv: 단일 필라멘트 I와 V_gap", () => {
		const g = loadCsv("filament_current.csv");
		for (let k = 0; k < g.v_V.length; k++) {
			const r = filamentCurrent(g.v_V[k], g.x_m[k], g.w_m[k], DEFAULT);
			expect(relErr(r.i, g.i_A[k], 1e-30)).toBeLessThan(RTOL);
			expect(relErr(r.vGap, g.v_gap_V[k], 1e-15)).toBeLessThan(RTOL);
		}
	});

	test("fixed_state_iv.csv: 고정 상태 읽기 I-V", () => {
		const g = loadCsv("fixed_state_iv.csv");
		for (let k = 0; k < g.v_V.length; k++) {
			const i = ivFixedState([g.v_V[k]], g.x_m[k], g.A_m2[k], DEFAULT)[0];
			expect(relErr(i, g.i_A[k], 1e-20)).toBeLessThan(RTOL);	// 하한: V = 0에서 I가 정확히 0
		}
	});

	test("read_resistance.csv: 0.2 V에서의 R", () => {
		const g = loadCsv("read_resistance.csv");
		for (let k = 0; k < g.R_ohm.length; k++) expect(relErr(readResistance(g.x_m[k], g.w_m[k], DEFAULT), g.R_ohm[k], 0)).toBeLessThan(RTOL);
	});
});

describe("모델 불변 성질", () => {
	test("필라멘트 전류는 V에 대해 홀함수", () => {
		for (const v of [0.05, 0.3, 1.7]) {
			const a = filamentCurrent(v, 1e-9, 2e-9, DEFAULT);
			const b = filamentCurrent(-v, 1e-9, 2e-9, DEFAULT);
			expect(a.i).toBeCloseTo(-b.i, 20);
		}
	});

	test("solveVsw의 해가 직렬 방정식을 만족한다", () => {
		const rs = 18e3;	// [ohm]
		for (const va of [-2.5, -0.2, 0.2, 1.3, 2.5]) {
			for (const [x, w] of [[3e-9, 0.5e-9], [0, 5e-9], [1e-9, 2e-9]]) {
				const vs = solveVsw(va, x, w, DEFAULT, rs);
				const resid = vs + cellCurrent(vs, x, w, DEFAULT) * (DEFAULT.RL + rs) - va;
				expect(Math.abs(resid)).toBeLessThan(1e-12);
			}
		}
	});

	test("필라멘트 수 N = round(nF*aCell), 최소 1", () => {
		expect(filamentCount(DEFAULT)).toBe(1);
		expect(filamentCount({ ...DEFAULT, nF: 4e16 })).toBe(4);
		expect(filamentCount({ ...DEFAULT, nF: 1e10 })).toBe(1);
	});
});
