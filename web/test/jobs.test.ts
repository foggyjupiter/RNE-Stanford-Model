// 작업 실행(runJob)과 난수 도우미.

import { describe, expect, test } from "vitest";
import { DEFAULT, DEFAULT_MC, lognormal, normalRng, poissonAtLeastOne, runJob, uniformRng } from "../src/model";

describe("난수 도우미", () => {
	test("로그정규 표본의 평균과 상대 표준편차", () => {
		const nrm = normalRng(3);
		const xs = Array.from({ length: 100000 }, () => lognormal(nrm, 5, 0.3));
		const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
		const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
		expect(Math.abs(mean - 5) / 5).toBeLessThan(0.01);
		expect(Math.abs(sd / mean - 0.3)).toBeLessThan(0.01);
	});

	test("0을 뺀 포아송: 최소 1, 평균은 m/(1-e^-m)", () => {
		const u = uniformRng(5);
		for (const m of [0.5, 1, 4]) {
			const ks = Array.from({ length: 50000 }, () => poissonAtLeastOne(u, m));
			expect(Math.min(...ks)).toBe(1);
			const mean = ks.reduce((a, b) => a + b, 0) / ks.length;
			const want = m / (1 - Math.exp(-m));
			expect(Math.abs(mean - want) / want).toBeLessThan(0.02);
		}
	});
});

describe("runJob", () => {
	test("고정 상태 몬테카를로: 시드로 재현되고 소자 수만큼 결과가 나온다", () => {
		const job = { kind: "fixed" as const, v: [-0.2, 0, 0.2], rNeck: 4e-9, neckLen: 8e-9, params: DEFAULT, mc: { ...DEFAULT_MC, devices: 12 }, seed: 9 };
		const a = runJob(job);
		const b = runJob(job);
		if (a.kind !== "fixed" || b.kind !== "fixed" || !a.mc || !b.mc) throw new Error("kind");
		expect(a.mc.R.length).toBe(12);
		expect(Array.from(a.mc.R)).toEqual(Array.from(b.mc.R));
		for (let d = 0; d < 12; d++) expect(a.mc.N[d]).toBeGreaterThanOrEqual(1);
	}, 60000);

	test("RESET 펄스는 저항을 올리고 SET 스윕 반쪽은 다시 낮춘다 (unipolar 한 사이클)", () => {
		const out = runJob({ kind: "sweep", vReset: 1.6, vSet: 4.0, tRamp: 0.25, rs: 3e3, params: DEFAULT, cycles: 1 });
		if (out.kind !== "transient") throw new Error("kind");
		const s = out.summary[0];
		expect(s.rHrs / out.rStart).toBeGreaterThan(10);	// RESET: 포밍된 LRS 대비 10배 이상
		expect(s.rLrs).toBeLessThan(s.rHrs / 10);	// SET: 다시 낮은 저항
		expect(s.vSet).toBeGreaterThan(s.vReset);	// unipolar: V_set > V_reset
	}, 120000);
});
