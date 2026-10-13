// runJob is what the Web Worker executes; it must reproduce direct simulate() calls.

import { describe, expect, test } from "vitest";
import { DEFAULT, DEFAULT_VARIABILITY, INIT_HRS, RS_SWEEP, ivFixedState, runJob, simulate, sweepWaveform } from "../src/model";

describe("runJob", () => {
	test("deterministic transient job equals simulate(), cycles chain end states", () => {
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
		expect(out.summary[0].rEnd / out.summary[0].rLrs).toBeGreaterThan(10);	// RESET raised R
	});

	test("variability job is reproducible by seed", () => {
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

	test("fixed job equals ivFixedState()", () => {
		const v = [-0.5, -0.1, 0, 0.1, 0.5];
		const out = runJob({ kind: "fixed", v, x: 1e-9, aCf: 20e-18, params: DEFAULT });
		if (out.kind !== "fixed") throw new Error("kind");
		expect(Array.from(out.i)).toEqual(Array.from(ivFixedState(v, 1e-9, 20e-18, DEFAULT)));
	});
});
