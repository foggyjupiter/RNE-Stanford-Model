// 직렬화 가능한 작업 정의와 순수 실행 함수. 테스트와 Web Worker 안에서 그대로 쓴다.

import { DEFAULT_GRID, type GridSpec, type Params } from "./params";
import { makeGrid } from "./fields";
import {
	ivFixedState, neckProfile, normalRng, pulseWaveform, readResistance, resetPoint, resetRampWaveform,
	sampleCycleParams, simulate, type Op, type SimResult, type Variability, type Waveform,
} from "./simulate";

export interface SweepJob {
	kind: "sweep";
	vReset: number;	// RESET 구간 최대 전압 [V]
	vSet: number;	// SET 구간 최대 전압 [V]
	tRamp: number;	// 구간당 램프 시간 [s]
	rs: number;	// SET compliance 저항 [ohm]
	params: Params;
	cycles: number;	// 각 사이클은 직전 사이클의 끝 상태에서 시작
	variability?: Variability;	// [D] 식 (10),(11)
	seed?: number;
	grid?: GridSpec;
}

export interface PulseJob {
	kind: "pulse";
	op: Op;
	v: number;	// 진폭 [V]
	width: number;	// 평탄부 [s]
	tEdge: number;	// 상승/하강 [s]
	rs: number;	// SET compliance 저항 [ohm]
	params: Params;
	grid?: GridSpec;
}

export interface PulseOp {
	v: number;	// 진폭 [V]
	width: number;	// 평탄부 [s]
}

// 쓰기-읽기 시퀀스: 사이클마다 RESET 펄스 → 읽기 → SET 펄스 → 읽기.
// 읽기는 vRead에서의 정적 저항 (읽기 전압이 낮아 상태를 바꾸지 않는다고 본다, A36)
export interface SequenceJob {
	kind: "sequence";
	reset: PulseOp;
	set: PulseOp;
	vRead: number;	// [V]
	tEdge: number;	// [s]
	rs: number;	// SET compliance 저항 [ohm]
	params: Params;
	cycles: number;
	variability?: Variability;
	seed?: number;
	grid?: GridSpec;
}

export interface FixedJob {
	kind: "fixed";
	v: number[];	// [V]
	rNeck: number;	// 잘록 구간 반경 [m]
	neckLen: number;	// 잘록 구간 길이 [m]
	params: Params;
	grid?: GridSpec;
}

export type Job = SweepJob | PulseJob | SequenceJob | FixedJob;

export interface CycleSummary {
	rLrs: number;	// LRS 읽기 저항 [ohm]
	rHrs: number;	// HRS 읽기 저항 [ohm]
	vReset: number;	// [V]
	iReset: number;	// [A]
	vSet: number;	// [V], 스윕만
}

export interface TransientOutput {
	kind: "transient";
	cycles: SimResult[];
	summary: CycleSummary[];
	rStart: number;	// 시작 상태 읽기 저항 [ohm]
	rEnd: number;	// 끝 상태 읽기 저항 [ohm]
}

export interface FixedOutput {
	kind: "fixed";
	v: Float64Array;	// [V]
	i: Float64Array;	// [A]
	r01: number;	// 0.1 V 읽기 저항 [ohm]
	rb: Float64Array;	// CF 형상 [m]
	z: Float64Array;	// 높이 [m]
}

export type JobOutput = TransientOutput | FixedOutput;

export type ProgressFn = (done: number, total: number) => void;

export const V_READ = 0.1;	// 기본 읽기 전압 [V], [C] Fig. 3

// 각 결과의 시간축을 앞 결과의 끝 시각만큼 밀어 하나로 잇는다 (두 번째부터는 첫 점 제외)
export function concatResults(parts: SimResult[]): SimResult {
	const n = parts.reduce((s, r, idx) => s + r.t.length - (idx > 0 ? 1 : 0), 0);
	const mk = (): Float64Array => new Float64Array(n);
	const out: SimResult = { ...parts[parts.length - 1], t: mk(), vApp: mk(), vCell: mk(), i: mk(), rMin: mk(), T: mk(), steps: 0 };
	let k = 0;
	let offset = 0;
	let hotT = -Infinity;
	for (let idx = 0; idx < parts.length; idx++) {
		const r = parts[idx];
		for (let j = idx > 0 ? 1 : 0; j < r.t.length; j++) {
			out.t[k] = r.t[j] + offset;
			out.vApp[k] = r.vApp[j];
			out.vCell[k] = r.vCell[j];
			out.i[k] = r.i[j];
			out.rMin[k] = r.rMin[j];
			out.T[k] = r.T[j];
			k++;
		}
		let tm = -Infinity;
		for (let j = 0; j < r.T.length; j++) tm = Math.max(tm, r.T[j]);
		if (tm > hotT) {
			hotT = tm;
			out.hot = { ...r.hot, t: r.hot.t + offset };
		}
		offset += r.t[r.t.length - 1];
		out.steps += r.steps;
	}
	return out;
}

// SET 동작만 하는 삼각파 0 -> vSet -> 0
function setRampWaveform(vSet: number, tRamp: number): Waveform {
	const w = resetRampWaveform(vSet, tRamp);
	return { ...w, op: () => "set" };
}

export function runJob(job: Job, onProgress?: ProgressFn): JobOutput {
	const p = job.params;
	const gs = job.grid ?? DEFAULT_GRID;
	if (job.kind === "fixed") {
		const g = makeGrid(p, gs);
		const rb = neckProfile(job.rNeck, job.neckLen, p, gs);
		return {
			kind: "fixed",
			v: Float64Array.from(job.v),
			i: ivFixedState(job.v, rb, p, gs),
			r01: readResistance(rb, p, V_READ, gs),
			rb,
			z: Float64Array.from(g.zc),
		};
	}
	const rStart = readResistance(p.phi0 / 2, p, V_READ, gs);
	if (job.kind === "pulse") {
		// SET 펄스는 RESET 스윕 뒤 HRS에서, RESET 펄스는 포밍된 LRS에서 시작
		let rb0: Float64Array | null = null;
		let base = 0;
		if (job.op === "set") {
			rb0 = simulate(resetRampWaveform(1.6, 0.25), null, p, { grid: gs, onProgress: (f) => onProgress?.(0.5 * f, 1) }).rbEnd;
			base = 0.5;
		}
		const r = simulate(pulseWaveform(job.op, job.v, job.tEdge, job.width), rb0, p, {
			rs: job.rs, includeCp: true, grid: gs, onProgress: (f) => onProgress?.(base + (1 - base) * f, 1),
		});
		const r0 = rb0 ? readResistance(rb0, p, V_READ, gs) : rStart;
		const r1 = readResistance(r.rbEnd, p, V_READ, gs);
		const rp = resetPoint(r, false);
		const isSet = job.op === "set";
		return {
			kind: "transient",
			cycles: [r],
			summary: [{ rLrs: isSet ? r1 : r0, rHrs: isSet ? r0 : r1, vReset: rp.v, iReset: rp.i, vSet: NaN }],
			rStart: r0,
			rEnd: r1,
		};
	}
	const rng = job.variability ? normalRng(job.seed ?? 1) : undefined;
	const cycles: SimResult[] = [];
	const summary: CycleSummary[] = [];
	let rb: Float64Array | null = null;
	for (let c = 0; c < job.cycles; c++) {
		const pc = job.variability && rng ? sampleCycleParams(p, job.variability, rng) : p;
		const prog = (f: number): void => onProgress?.(c + f, job.cycles);
		let r1: SimResult;
		let r2: SimResult;
		let vRead = V_READ;
		if (job.kind === "sweep") {
			// RESET 반쪽과 SET 반쪽을 따로 돌려 이어 붙인다 (가운데 HRS 상태를 읽기 위해)
			r1 = simulate(resetRampWaveform(job.vReset, job.tRamp), rb, pc, { grid: gs, onProgress: (f) => prog(0.5 * f) });
			r2 = simulate(setRampWaveform(job.vSet, job.tRamp), r1.rbEnd, pc, { rs: job.rs, grid: gs, onProgress: (f) => prog(0.5 + 0.5 * f) });
		} else {
			vRead = job.vRead;
			r1 = simulate(pulseWaveform("reset", job.reset.v, job.tEdge, job.reset.width), rb, pc, { rs: job.rs, includeCp: true, grid: gs, onProgress: (f) => prog(0.5 * f) });
			r2 = simulate(pulseWaveform("set", job.set.v, job.tEdge, job.set.width), r1.rbEnd, pc, { rs: job.rs, includeCp: true, grid: gs, onProgress: (f) => prog(0.5 + 0.5 * f) });
		}
		const rp = resetPoint(r1, false);
		const rHrs = readResistance(r1.rbEnd, pc, vRead, gs);
		const rLrs = readResistance(r2.rbEnd, pc, vRead, gs);
		let vSet = NaN;
		if (job.kind === "sweep") {
			// SET 반쪽에서 셀 저항이 처음으로 시작값의 1/10 아래로 떨어지는 전압
			let r0 = NaN;
			for (let m = 0; m < r2.t.length; m++) {
				if (Math.abs(r2.vApp[m]) <= 0.05) continue;
				const R = Math.abs(r2.vCell[m] / (r2.i[m] === 0 ? 1e-30 : r2.i[m]));
				if (Number.isNaN(r0)) {
					r0 = R;
				} else if (R < r0 / 10) {
					vSet = r2.vApp[m];
					break;
				}
			}
		}
		rb = r2.rbEnd;
		cycles.push(concatResults([r1, r2]));
		summary.push({ rLrs, rHrs, vReset: rp.v, iReset: rp.i, vSet });
		onProgress?.(c + 1, job.cycles);
	}
	return { kind: "transient", cycles, summary, rStart, rEnd: summary[summary.length - 1].rLrs };
}
