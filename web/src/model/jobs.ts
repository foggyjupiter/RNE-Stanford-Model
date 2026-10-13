// 직렬화 가능한 작업 정의와 순수 실행 함수. 테스트와 Web Worker 안에서 그대로 쓴다.

import { type Params } from "./params";
import { ivFixedState, normalRng, pulseWaveform, readResistance, sampleCycleParams, simulate, sweepWaveform, switchingVoltage, type SimOptions, type SimResult, type Variability, type Waveform } from "./simulate";

export type WaveSpec =
	| { kind: "sweep"; vSet: number; vReset: number; tRamp: number }	// [V, V, s]
	| { kind: "pulse"; vPulse: number; tEdge: number; tWidth: number; tTotal: number };	// [V, s, s, s]

export function makeWaveform(w: WaveSpec): Waveform {
	if (w.kind === "sweep") return sweepWaveform(w.vSet, w.vReset, w.tRamp);
	return pulseWaveform(w.vPulse, w.tEdge, w.tWidth, w.tTotal);
}

export interface TransientJob {
	kind: "transient";
	wave: WaveSpec;
	x0: number;	// [m]
	w0: number;	// [m]
	params: Params;
	opt: Omit<SimOptions, "rng">;
	cycles: number;	// 반복 사이클 수, 각 사이클은 직전 사이클의 끝 상태에서 시작
	variability?: Variability;	// 식 (8)-(11) 활성화, opt.noiseDt 필요
	seed?: number;
	vRead?: number;	// 사이클별 저항을 읽는 전압 [V], 기본 0.2
}

export interface FixedJob {
	kind: "fixed";
	v: number[];	// [V]
	x: number;	// 갭 [m]
	aCf: number;	// CF 면적 [m^2]
	params: Params;
	rs?: number;	// [ohm]
}

export type Job = TransientJob | FixedJob;

export interface CycleSummary {
	rLrs: number;	// 양의 반주기 뒤(0 V 통과 시점 상태) vRead에서의 저항, 펄스는 NaN [ohm]
	rEnd: number;	// 사이클 끝 상태의 vRead 저항 [ohm]
	vSet: number;	// [V]
	vReset: number;	// [V]
}

export interface TransientOutput {
	kind: "transient";
	cycles: SimResult[];
	summary: CycleSummary[];
}

export interface FixedOutput {
	kind: "fixed";
	v: Float64Array;	// [V]
	i: Float64Array;	// [A]
}

export type JobOutput = TransientOutput | FixedOutput;

export function runJob(job: Job): JobOutput {
	if (job.kind === "fixed") return { kind: "fixed", v: Float64Array.from(job.v), i: ivFixedState(job.v, job.x, job.aCf, job.params, job.rs ?? 0) };
	const wf = makeWaveform(job.wave);
	const vRead = job.vRead ?? 0.2;
	const rng = job.variability ? normalRng(job.seed ?? 1) : undefined;
	const cycles: SimResult[] = [];
	const summary: CycleSummary[] = [];
	let x = job.x0;
	let w = job.w0;
	for (let c = 0; c < job.cycles; c++) {
		const p = job.variability && rng ? sampleCycleParams(job.params, job.variability, rng) : job.params;
		const opt: SimOptions = job.variability ? { ...job.opt, rng } : { ...job.opt, noiseDt: undefined };
		const r = simulate(wf, x, w, p, opt);
		cycles.push(r);
		let rLrs = NaN;
		if (job.wave.kind === "sweep") {
			// SET 구간 뒤 인가 전압이 0으로 돌아온 시점(t = 2*tRamp)의 상태
			const tMid = 2 * job.wave.tRamp;
			let k = 0;
			while (k < r.t.length - 1 && r.t[k] < tMid) k++;
			rLrs = readResistance(r.x[k], r.w[k], p, vRead);
		}
		const sv = switchingVoltage(r, p);
		x = r.x[r.x.length - 1];
		w = r.w[r.w.length - 1];
		summary.push({ rLrs, rEnd: readResistance(x, w, p, vRead), vSet: sv.vSet, vReset: sv.vReset });
	}
	return { kind: "transient", cycles, summary };
}
