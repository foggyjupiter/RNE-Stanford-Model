// runJob은 Web Worker가 실행하는 함수이므로 simulate()를 직접 부른 결과와 같아야 한다.

import { describe, expect, test } from "vitest";
import { DEFAULT, DEFAULT_VARIABILITY, INIT_HRS, RS_PULSE, RS_SWEEP, ivFixedState, readResistance, runJob, simulate, sweepWaveform } from "../src/model";

describe("runJob", () => {
	test("결정론적 과도 작업은 simulate()와 같고, 사이클은 끝 상태를 이어받는다", () => {
		const out = runJob({
			kind: "transient",
			wave: { kind: "sweep", vSet: 2.5, vReset: -2.5, tRamp: 10e-6 },
			x0: INIT_HRS[0],
			w0: INIT_HRS[1],
			params: DEFAULT,
			opt: { rs: RS_SWEEP },
			cycles: 2,
		});
		if (out.kind !== "transient") throw new Error("kind");
		const direct = simulate(sweepWaveform(2.5, -2.5, 10e-6), INIT_HRS[0], INIT_HRS[1], DEFAULT, { rs: RS_SWEEP });
		expect(Array.from(out.cycles[0].i)).toEqual(Array.from(direct.i));
		expect(out.cycles[1].x[0]).toBe(direct.x[direct.x.length - 1]);
		expect(out.summary[0].rEnd / out.summary[0].rLrs).toBeGreaterThan(10);	// RESET으로 R이 커짐
	});

	test("변동성 작업은 시드로 재현된다", () => {
		const job = {
			kind: "transient" as const,
			wave: { kind: "sweep" as const, vSet: 2.5, vReset: -2.5, tRamp: 10e-6 },
			x0: INIT_HRS[0],
			w0: INIT_HRS[1],
			params: DEFAULT,
			opt: { rs: RS_SWEEP, noiseDt: 0.2e-6 },
			cycles: 2,
			variability: DEFAULT_VARIABILITY,
			seed: 7,
		};
		const a = runJob(job);
		const b = runJob(job);
		if (a.kind !== "transient" || b.kind !== "transient") throw new Error("kind");
		expect(a.summary).toEqual(b.summary);
	});

	test("고정 상태 작업은 ivFixedState()와 같다", () => {
		const v = [-0.5, -0.1, 0, 0.1, 0.5];
		const out = runJob({ kind: "fixed", v, x: 1e-9, aCf: 20e-18, params: DEFAULT });
		if (out.kind !== "fixed") throw new Error("kind");
		expect(Array.from(out.i)).toEqual(Array.from(ivFixedState(v, 1e-9, 20e-18, DEFAULT)));
	});
});

describe("쓰기-읽기 시퀀스", () => {
	test("기본 펄스 조건에서 LRS/HRS 창이 열리고 사이클마다 재현된다", () => {
		const progress: number[] = [];
		const out = runJob({
			kind: "sequence",
			set: { v: 2, width: 80e-9 },
			reset: { v: -2.5, width: 1e-6 },
			read: { v: 0.2, width: 50e-9 },
			tEdge: 10e-9,
			rs: RS_PULSE,
			x0: INIT_HRS[0],
			w0: INIT_HRS[1],
			params: DEFAULT,
			cycles: 2,
		}, (done) => progress.push(done));
		if (out.kind !== "transient") throw new Error("kind");
		expect(progress).toEqual([1, 2]);
		for (const s of out.summary) {
			// 읽기 펄스로 잰 저항은 상태만으로 계산한 readResistance와 같은 정의 (RL 포함)
			expect(s.rLrs).toBeLessThan(2e4);	// [ohm]
			expect(s.rEnd).toBeGreaterThan(1e6);	// [ohm]
		}
		const c = out.cycles[0];
		for (let k = 1; k < c.t.length; k++) expect(c.t[k]).toBeGreaterThan(c.t[k - 1]);
	});

	test("읽기 펄스 저항 = 정적 readResistance", () => {
		const out = runJob({
			kind: "sequence",
			set: { v: 2, width: 80e-9 },
			reset: { v: -2.5, width: 1e-6 },
			read: { v: 0.2, width: 50e-9 },
			tEdge: 10e-9,
			rs: RS_PULSE,
			x0: INIT_HRS[0],
			w0: INIT_HRS[1],
			params: DEFAULT,
			cycles: 1,
		});
		if (out.kind !== "transient") throw new Error("kind");
		const c = out.cycles[0];
		const rStatic = readResistance(c.x[c.x.length - 1], c.w[c.w.length - 1], DEFAULT, 0.2);
		expect(Math.abs(out.summary[0].rEnd - rStatic) / rStatic).toBeLessThan(1e-3);
	});
});
