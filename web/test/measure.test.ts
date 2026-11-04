// 측정 데이터 모드를 python/golden/measure.json과 비교한다 (python/golden_measure.py가 만든 정답지).
//
// 허용 오차 (상대오차):
// - 엑셀 읽기·분류·특징값(저전계 저항, RESET 점, [C] 식 (5)-(6)): 1e-12. 같은 산술을 같은 순서로 한다.
// - 모델 곡선과 지름 맞춤: 1e-8. 정상 상태 풀이(대역 Cholesky 대 LU)의 차이 (model.test.ts와 같은 근거).
// - 열 보정 κ_el (A56): 상대 2e-3. 두 구현 모두 ln κ에서 근 찾기 허용오차 1e-3 (Brent 구현이 달라 그만큼 어긋날 수 있음).
// - 호핑 갭 (A55): 절대 0.02 nm. 근 찾기 허용오차 0.01 nm의 두 배.
// - 데이터 품질 지표 (A58): 상대 1e-9 (값이 0에 가까우면 절대 1e-12). 같은 산술, 2차 맞춤만 정규방정식 대 numpy.polyfit.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { goldenPath } from "./golden";
import {
	DEFAULT, OUR_DEVICE, firstForming, qualityNumbers, fitGap, fitKappaEl, fitLrs, lowFieldResistance, modelLrsCurve, oxideResistivity, parseSession, readXlsx, resetFeatures,
	russoExtraction, setFeatures, type Params, type Session,
} from "../src/model";

const G = JSON.parse(readFileSync(goldenPath("measure.json"), "utf8"));
const P: Params = { ...DEFAULT, ...OUR_DEVICE, aCell: 1e-12, nF: 1e12, L0: 6e-9 } as Params;
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

async function load(): Promise<Session> {
	return parseSession("6nm fixture.xlsx", await readXlsx(readFileSync(goldenPath("measure_6nm_fixture.xlsx"))));
}

describe("측정 데이터: 엑셀 읽기와 분류", () => {
	test("분류, 0.1 V 저항, 면적, 두께", async () => {
		const s = await load();
		expect(s.sweeps.map((x) => x.kind)).toEqual(G.kinds);
		s.sweeps.forEach((x, k) => expect(rel(x.r01, G.r01[k])).toBeLessThan(1e-12));
		expect(s.area).toBeCloseTo(G.area * 1, 20);
		expect(s.thickness).toBeCloseTo(6e-9, 20);
	});

	test("포밍 전 저항과 산화막 비저항", async () => {
		const s = await load();
		const f = firstForming([s]);
		const rp = lowFieldResistance(f[0].v.map(Math.abs), f[0].i.map(Math.abs));
		expect(rel(rp, G.r_pristine)).toBeLessThan(1e-12);
		expect(rel(oxideResistivity(rp, P), G.rho_ox)).toBeLessThan(1e-12);
	});

	test("RESET·SET 특징값과 [C] 추출", async () => {
		const s = await load();
		const resets = s.sweeps.filter((x) => x.kind === "reset");
		expect(resets.length).toBe(G.resets.length);
		resets.forEach((x, k) => {
			const g = G.resets[k];
			const f = resetFeatures(x.v.map(Math.abs), x.i.map(Math.abs), 20);
			const rr = russoExtraction(f, 1.7e-3, 300);
			expect(x.index).toBe(g.index);
			expect(rel(f.R0, g.R0)).toBeLessThan(1e-12);
			expect(f.vReset).toBe(g.v_reset);
			expect(rel(f.iReset, g.i_reset)).toBeLessThan(1e-12);
			expect(rel(rr.tCrit, g.T_crit)).toBeLessThan(1e-12);
			expect(rel(rr.rthFit, g.Rth_fit)).toBeLessThan(1e-12);
		});
		const sets = s.sweeps.filter((x) => x.kind === "set");
		sets.forEach((x, k) => {
			const g = G.sets[k];
			const f = setFeatures(x.v.map(Math.abs), x.i.map(Math.abs), x.cc, 20);
			expect(rel(f.rHrs, g.R_hrs)).toBeLessThan(1e-12);
			expect(f.vSet).toBe(g.v_set);
		});
	});
});

describe("측정 데이터: 모델 곡선과 지름 맞춤", () => {
	test("Rth/R0 곡선 (필라멘트 1개)", () => {
		const c = modelLrsCurve(P, G.curve.phi, 600, 1.7e-3);
		c.R0.forEach((r, k) => expect(rel(r, G.curve.R0[k])).toBeLessThan(1e-8));
		c.Rth.forEach((r, k) => expect(rel(r, G.curve.Rth[k])).toBeLessThan(1e-8));
	});

	test("fitLrs", () => {
		const c = modelLrsCurve(P, G.curve.phi, 600, 1.7e-3);
		const f = fitLrs(G.fit_lrs.R0, G.fit_lrs.Rth, P, 600, 1.7e-3, undefined, 0.2, c);
		expect(rel(f.phi, G.fit_lrs.phi)).toBeLessThan(1e-8);
		expect(rel(f.N, G.fit_lrs.N)).toBeLessThan(1e-8);
	});
});

describe("측정 데이터: 열 보정과 호핑 갭", () => {
	test("fitKappaEl (A56)", () => {
		const g = G.fit_kappa_el;
		const k = fitKappaEl(g.R0, g.Rth, P, g.T_target, 1.7e-3);
		expect(rel(k.phi, g.phi)).toBeLessThan(1e-8);
		expect(rel(k.kappaEl, g.kappa_el)).toBeLessThan(2e-3);
	}, 120000);

	test("fitGap (A55)", () => {
		const g = G.fit_gap;
		const gap = fitGap(g.R_hrs, g.phi, 1, { ...P, kappaEl: g.kappa_el, rhoOx: g.rho_ox, hop: 1 });
		expect(Math.abs(gap - g.gap)).toBeLessThan(0.02e-9);
	}, 120000);
});

describe("측정 데이터: 품질 지표 (A58)", () => {
	test("qualityNumbers", async () => {
		const s = await load();
		const sweeps = s.sweeps.map((x) => ({ file: x.file, index: x.index, kind: x.kind, v: x.v, i: x.i, cc: x.cc, firstForming: false }));
		const q = qualityNumbers(sweeps);
		const g = G.quality;
		const pairs: [number, number][] = [
			[q.nSweeps, g.n_sweeps], [q.nUsable, g.n_usable], [q.resetsPerDevice, g.resets_per_device], [q.nPreReset, g.n_pre_reset],
			[q.nPreResetMin, g.n_pre_reset_min], [q.step, g.step], [q.vResetQuant, g.v_reset_quant], [q.vSetQuant, g.v_set_quant],
			[q.snr, g.snr], [q.snrP25, g.snr_p25], [q.nonMono, g.non_mono], [q.cvReset, g.cv_reset], [q.cvSet, g.cv_set],
			[q.sLogLrs, g.s_log_lrs], [q.sLogHrs, g.s_log_hrs], [q.overshoot, g.overshoot], [q.overshootMin, g.overshoot_min], [q.overshootMax, g.overshoot_max],
		];
		for (const [a, b] of pairs) expect(Math.abs(a - b)).toBeLessThan(Math.max(1e-9 * Math.abs(b), 1e-12));
		expect(q.counts).toEqual(g.counts);
	});
});
