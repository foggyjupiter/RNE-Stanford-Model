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

// 쓰기-읽기 시퀀스: 사이클마다 SET 펄스 → 읽기 → RESET 펄스 → 읽기.
// 각 동작은 따로 시뮬레이션하고 시간축을 이어 붙인다 (동작마다 알맞은 스텝 상한을 쓰기 위해).
export interface PulseOp {
	v: number;	// 펄스 진폭 [V]
	width: number;	// 평탄부 폭 [s]
}

export interface SequenceJob {
	kind: "sequence";
	set: PulseOp;
	reset: PulseOp;
	read: PulseOp;
	tEdge: number;	// 상승/하강 시간 [s]
	rs: number;	// SET 펄스의 compliance 저항 [ohm]. 읽기는 0, RESET은 Rs_reset = 0 (A14)
	x0: number;	// [m]
	w0: number;	// [m]
	params: Params;
	cycles: number;
	variability?: Variability;	// 식 (10),(11)만 적용, 펄스에서는 chi(t) 생략 (A23)
	seed?: number;
}

export type Job = TransientJob | FixedJob | SequenceJob;

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

export type ProgressFn = (done: number, total: number) => void;

// 각 결과의 시간축을 앞 결과의 끝 시각만큼 밀어 하나로 잇는다
function concatResults(parts: SimResult[]): SimResult {
	// 두 번째 구간부터는 첫 점(직전 구간의 끝과 같은 시각·상태)을 뺀다
	const n = parts.reduce((s, r, idx) => s + r.t.length - (idx > 0 ? 1 : 0), 0);
	const out: SimResult = {
		t: new Float64Array(n),
		vApp: new Float64Array(n),
		vSw: new Float64Array(n),
		i: new Float64Array(n),
		x: new Float64Array(n),
		w: new Float64Array(n),
		T: new Float64Array(n),
		stats: { steps: 0, rejected: 0, nfev: 0, n: parts[0].stats.n },
	};
	let k = 0;
	let offset = 0;
	for (let idx = 0; idx < parts.length; idx++) {
		const r = parts[idx];
		for (let j = idx > 0 ? 1 : 0; j < r.t.length; j++) {
			out.t[k] = r.t[j] + offset;
			out.vApp[k] = r.vApp[j];
			out.vSw[k] = r.vSw[j];
			out.i[k] = r.i[j];
			out.x[k] = r.x[j];
			out.w[k] = r.w[j];
			out.T[k] = r.T[j];
			k++;
		}
		offset += r.t[r.t.length - 1];
		out.stats.steps += r.stats.steps;
		out.stats.rejected += r.stats.rejected;
		out.stats.nfev += r.stats.nfev;
	}
	return out;
}

// 읽기 펄스 평탄부 가운데의 V/I [ohm]. Rs = 0이므로 RL을 포함한 셀 저항 = readResistance()와 같은 정의
function plateauResistance(r: SimResult, tEdge: number, width: number): number {
	const tMid = tEdge + width / 2;
	let k = 0;
	while (k < r.t.length - 1 && r.t[k] < tMid) k++;
	return r.vApp[k] / r.i[k];
}

function runSequence(job: SequenceJob, onProgress?: ProgressFn): TransientOutput {
	const rng = job.variability ? normalRng(job.seed ?? 1) : undefined;
	const cycles: SimResult[] = [];
	const summary: CycleSummary[] = [];
	let x = job.x0;
	let w = job.w0;
	const run = (op: PulseOp, p: Params, rs: number): SimResult => {
		const wf = pulseWaveform(op.v, job.tEdge, op.width, op.width + 2 * job.tEdge);
		// 스텝 상한: 펄스 golden과 같은 0.1 ns, 긴 펄스는 길이/2000까지 허용
		const r = simulate(wf, x, w, p, { rs, rsReset: 0, includeCp: true, maxStep: Math.max(0.1e-9, wf.tEnd / 2000), nOut: 801 });
		x = r.x[r.x.length - 1];
		w = r.w[r.w.length - 1];
		return r;
	};
	for (let c = 0; c < job.cycles; c++) {
		const p = job.variability && rng ? sampleCycleParams(job.params, job.variability, rng) : job.params;
		const parts = [run(job.set, p, job.rs), run(job.read, p, 0), run(job.reset, p, 0), run(job.read, p, 0)];
		cycles.push(concatResults(parts));
		summary.push({
			rLrs: plateauResistance(parts[1], job.tEdge, job.read.width),
			rEnd: plateauResistance(parts[3], job.tEdge, job.read.width),
			vSet: NaN,
			vReset: NaN,
		});
		onProgress?.(c + 1, job.cycles);
	}
	return { kind: "transient", cycles, summary };
}

export function runJob(job: Job, onProgress?: ProgressFn): JobOutput {
	if (job.kind === "fixed") return { kind: "fixed", v: Float64Array.from(job.v), i: ivFixedState(job.v, job.x, job.aCf, job.params, job.rs ?? 0) };
	if (job.kind === "sequence") return runSequence(job, onProgress);
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
		onProgress?.(c + 1, job.cycles);
	}
	return { kind: "transient", cycles, summary };
}
