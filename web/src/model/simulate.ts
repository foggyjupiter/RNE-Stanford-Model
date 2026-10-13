// 파형, 과도 시뮬레이션, 읽기 / 고정 상태 계산, 변동성.
// python/rram_model.py를 옮긴 것. (A#)는 ASSUMPTIONS.md 참고.

import { EV, W_MIN, filamentCount, type Params } from "./params";
import { cellCurrent, cfWidthFromArea, filamentCurrent, solveVsw, stateRates, temperature } from "./physics";
import { integrate } from "./solver";

export interface Waveform {
	v: (t: number) => number;	// 시간 t [s]에서의 인가 전압 [V]
	tEnd: number;	// [s]
	corners: number[];	// 꺾임점 [s]
}

function piecewiseLinear(ts: number[], vs: number[]): (t: number) => number {
	return (t: number): number => {
		if (t <= ts[0]) return vs[0];
		for (let k = 1; k < ts.length; k++) {
			if (t <= ts[k]) {
				const span = ts[k] - ts[k - 1];
				return span > 0 ? vs[k - 1] + (vs[k] - vs[k - 1]) * (t - ts[k - 1]) / span : vs[k];
			}
		}
		return vs[vs.length - 1];
	};
}

// 삼각파 0 -> vSet -> 0 -> vReset -> 0, 구간마다 tRamp [s]
export function sweepWaveform(vSet = 2.5, vReset = -2.5, tRamp = 100e-6): Waveform {
	const ts = [0, 1, 2, 3, 4].map((k) => k * tRamp);
	return { v: piecewiseLinear(ts, [0, vSet, 0, vReset, 0]), tEnd: ts[4], corners: ts };
}

// 매뉴얼 AC 덱과 같은 사다리꼴 펄스 (지연 0, 상승 = 하강 = tEdge, 평탄부 tWidth)
export function pulseWaveform(vPulse = 2, tEdge = 10e-9, tWidth = 80e-9, tTotal = 100e-9): Waveform {
	const ts = [0, tEdge, tEdge + tWidth, 2 * tEdge + tWidth, Math.max(tTotal, 2 * tEdge + tWidth)];
	return { v: piecewiseLinear(ts, [0, vPulse, vPulse, 0, 0]), tEnd: ts[4], corners: ts };
}

// 직렬 compliance 저항: vApp >= 0 (SET)이면 rs, vApp < 0이면 rsReset (A14) [ohm]
export function seriesR(vApp: number, rs: number, rsReset: number): number {
	return vApp >= 0 ? rs : rsReset;
}

export interface SimOptions {
	rs?: number;	// SET compliance 저항 [ohm]
	rsReset?: number;	// RESET 직렬 저항 [ohm]
	includeCp?: boolean;	// CP를 상태 변수로 (펄스) 또는 무시 (스윕) (A11)
	nOut?: number;	// 균일 출력점 수
	maxStep?: number;	// [s], 기본 tEnd/2000
	rtol?: number;
	noiseDt?: number;	// 식 (8),(9)의 chi(t) 유지 시간 [s]. undefined면 잡음 없음 (A12)
	rng?: () => number;	// 표준정규 난수 생성기, noiseDt를 쓸 때 필요
}

export interface SimResult {
	t: Float64Array;	// [s]
	vApp: Float64Array;	// [V]
	vSw: Float64Array;	// [V]
	i: Float64Array;	// 단자 전류 [A]
	x: Float64Array;	// 갭 [m]
	w: Float64Array;	// CF 폭 [m]
	T: Float64Array;	// 필라멘트 온도 [K]
	stats: { steps: number; rejected: number; nfev: number; n: number };
}

export function simulate(wf: Waveform, x0: number, w0: number, p: Params, o: SimOptions = {}): SimResult {
	const rs = o.rs ?? 0;
	const rsReset = o.rsReset ?? 0;
	const includeCp = o.includeCp ?? false;
	const nOut = o.nOut ?? 2001;
	const maxStep = o.maxStep ?? wf.tEnd / 2000;
	const nFil = filamentCount(p);

	// 꺾임점: 파형 꺾임점과 잡음 갱신 시점
	const bps = wf.corners.filter((c) => c > 0 && c < wf.tEnd);
	let chi: Float64Array | null = null;
	if (o.noiseDt !== undefined) {
		if (!o.rng) throw new Error("simulate: noiseDt를 쓰려면 rng가 필요합니다");
		const nChi = Math.ceil(wf.tEnd / o.noiseDt);
		chi = new Float64Array(2 * nChi);
		for (let k = 0; k < chi.length; k++) chi[k] = o.rng();
		for (let k = 1; k < nChi; k++) bps.push(k * o.noiseDt);
	}
	const cur = [0, 0];	// 잡음 표본, 구간 안에서는 일정

	const tSet = new Set<number>();
	for (let k = 0; k < nOut; k++) tSet.add(wf.tEnd * k / (nOut - 1));
	for (const c of [...wf.corners, ...bps]) tSet.add(c);
	const sorted = [...tSet].filter((t) => t >= 0 && t <= wf.tEnd).sort((p1, p2) => p1 - p2);
	// 거의 겹치는 점 제거 (linspace와 꺾임점의 부동소수 반올림 차이) — ~1e-25 s짜리 스텝을 막는다
	const tOut: number[] = [];
	for (const t of sorted) {
		if (tOut.length === 0 || t - tOut[tOut.length - 1] > 1e-9 * wf.tEnd) tOut.push(t);
		else if (t === wf.tEnd) tOut[tOut.length - 1] = t;
	}

	const rhs = includeCp
		? (t: number, y: Float64Array, out: Float64Array): void => {
			const r = stateRates(y[2], y[0], y[1], p, cur[0], cur[1]);
			const va = wf.v(t);
			const iCell = nFil * r.iF + y[2] / p.RH;
			out[0] = r.dx;
			out[1] = r.dw;
			out[2] = ((va - y[2]) / (p.RL + seriesR(va, rs, rsReset)) - iCell) / p.CP;
		}
		: (t: number, y: Float64Array, out: Float64Array): void => {
			const va = wf.v(t);
			const vs = solveVsw(va, y[0], y[1], p, seriesR(va, rs, rsReset));
			const r = stateRates(vs, y[0], y[1], p, cur[0], cur[1]);
			out[0] = r.dx;
			out[1] = r.dw;
		};
	const y0 = includeCp ? [x0, w0, 0] : [x0, w0];
	const atol = includeCp ? [1e-14, 1e-14, 1e-7] : [1e-14, 1e-14];	// [m, m, V]
	// 스위칭 구간 스텝 상한: 한 스텝에서 x, w는 최대 a/10까지만 바뀐다 [m]
	const maxDelta = includeCp ? [p.a / 10, p.a / 10, Infinity] : [p.a / 10, p.a / 10];

	const res = integrate(rhs, y0, tOut, {
		rtol: o.rtol ?? 1e-6,
		atol,
		maxStep,
		maxDelta,
		breakpoints: bps,
		onSegment: (ta, tb) => {
			if (!chi || o.noiseDt === undefined) return;
			const k = Math.min(Math.floor((ta + tb) / 2 / o.noiseDt), chi.length / 2 - 1);
			cur[0] = chi[2 * k];
			cur[1] = chi[2 * k + 1];
		},
		onSegmentEnd: (y) => {
			y[0] = Math.min(Math.max(y[0], 0), p.L0);
			y[1] = Math.min(Math.max(y[1], W_MIN), p.WCF);
		},
	});

	const n = tOut.length;
	const out: SimResult = {
		t: Float64Array.from(tOut),
		vApp: new Float64Array(n),
		vSw: new Float64Array(n),
		i: new Float64Array(n),
		x: new Float64Array(n),
		w: new Float64Array(n),
		T: new Float64Array(n),
		stats: { steps: res.steps, rejected: res.rejected, nfev: res.nfev, n: nFil },
	};
	for (let k = 0; k < n; k++) {
		const yk = res.y[k];
		const va = wf.v(tOut[k]);
		const x = Math.min(Math.max(yk[0], 0), p.L0);
		const w = Math.min(Math.max(yk[1], W_MIN), p.WCF);
		const rSer = p.RL + seriesR(va, rs, rsReset);
		const vs = includeCp ? yk[2] : solveVsw(va, x, w, p, seriesR(va, rs, rsReset));
		const iF = filamentCurrent(vs, x, w, p).i;
		out.vApp[k] = va;
		out.vSw[k] = vs;
		out.x[k] = x;
		out.w[k] = w;
		out.T[k] = temperature(iF, vs, p);
		out.i[k] = includeCp ? (va - vs) / rSer : nFil * iF + vs / p.RH;	// CP 모드: CP 충전 전류를 포함한 단자 전류
	}
	return out;
}

// vRead에서의 셀 저항 (RL, RH 포함, 스위칭 없음) [ohm]
export function readResistance(x: number, w: number, p: Params, vRead = 0.2): number {
	const vs = solveVsw(vRead, x, w, p, 0);
	return vRead / cellCurrent(vs, x, w, p);
}

// 고정 상태 모드: 사용자가 정한 갭 x [m]와 CF 면적 aCf [m^2]에서의 정적 I-V, 스위칭 없음
export function ivFixedState(v: readonly number[], x: number, aCf: number, p: Params, rs = 0): Float64Array {
	const w = cfWidthFromArea(aCf);
	const out = new Float64Array(v.length);
	for (let k = 0; k < v.length; k++) {
		const vs = solveVsw(v[k], x, w, p, rs);
		out[k] = cellCurrent(vs, x, w, p);
	}
	return out;
}

// ---------------------------------------------------------------- 변동성 (10),(11)
export interface Variability {
	sigmaEa: number;	// 사이클 간 Ea 표준편차 [J] (A13)
	sigmaEi: number;	// 사이클 간 Ei 표준편차 [J] (A13)
	sigmaEh: number;	// 사이클 간 Eh 표준편차 [J] (A13)
}

export const DEFAULT_VARIABILITY: Readonly<Variability> = Object.freeze({
	sigmaEa: 0.02 * EV,	// [J]
	sigmaEi: 0.02 * EV,	// [J]
	sigmaEh: 0.02 * EV,	// [J]
});

// 시드를 받는 표준정규 난수 생성기: mulberry32 + Box-Muller
export function normalRng(seed: number): () => number {
	let s = seed >>> 0;
	const uniform = (): number => {
		s = (s + 0x6d2b79f5) >>> 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 15), z | 1);
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
		return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
	};
	let spare: number | null = null;
	return (): number => {
		if (spare !== null) {
			const v = spare;
			spare = null;
			return v;
		}
		let u = 0;
		while (u === 0) u = uniform();
		const r = Math.sqrt(-2 * Math.log(u));
		const th = 2 * Math.PI * uniform();
		spare = r * Math.sin(th);
		return r * Math.cos(th);
	};
}

// 식 (10),(11): 한 사이클의 에너지 장벽을 몬테카를로로 뽑는다
export function sampleCycleParams(p: Params, v: Variability, rng: () => number): Params {
	return { ...p, Ea: p.Ea + v.sigmaEa * rng(), Ei: p.Ei + v.sigmaEi * rng(), Eh: p.Eh + v.sigmaEh * rng() };
}

// 스윕의 스위칭 전압 (진단용) [V]: V_SET = V>0에서 처음으로 x < a가 되는 전압,
// V_RESET = 음의 구간에서 |I|가 최대인 인가 전압. 없으면 NaN.
export function switchingVoltage(r: SimResult, p: Params): { vSet: number; vReset: number } {
	let vSet = NaN;
	let vReset = NaN;
	let iMax = -1;
	for (let k = 0; k < r.t.length; k++) {
		if (Number.isNaN(vSet) && r.vApp[k] > 0 && r.x[k] < p.a) vSet = r.vApp[k];
		if (r.vApp[k] < 0 && Math.abs(r.i[k]) > iMax) {
			iMax = Math.abs(r.i[k]);
			vReset = r.vApp[k];
		}
	}
	return { vSet, vReset };
}
