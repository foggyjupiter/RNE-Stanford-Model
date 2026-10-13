// 파형, 회로 풀이, 과도 시뮬레이션, 읽기 / 고정 상태, 변동성. python/rram_model.py를 옮긴 것.
// (A#)는 ASSUMPTIONS.md 참고.

import { DEFAULT_GRID, EV, filamentCount, type GridSpec, type Params } from "./params";
import { FieldSolver, boundaryVelocity, makeGrid, type Fields, type Grid } from "./fields";

export type Op = "set" | "reset";

export interface Waveform {
	v: (t: number) => number;	// 인가 전압 [V]
	op: (t: number) => Op;	// 그 시각의 동작
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

// unipolar 스윕: 0 -> vReset -> 0 (RESET 동작) -> vSet -> 0 (SET 동작), 구간마다 tRamp [s].
// 포밍된 LRS에서 시작하므로 RESET이 먼저다
export function sweepWaveform(vReset = 1.6, vSet = 4.0, tRamp = 0.25): Waveform {
	const ts = [0, 1, 2, 3, 4].map((k) => k * tRamp);
	return { v: piecewiseLinear(ts, [0, vReset, 0, vSet, 0]), op: (t) => (t < 2 * tRamp ? "reset" : "set"), tEnd: ts[4], corners: ts };
}

// RESET만 하는 삼각파 0 -> vMax -> 0 ([R] Fig. 3, 5 비교용)
export function resetRampWaveform(vMax: number, tRamp: number): Waveform {
	const ts = [0, tRamp, 2 * tRamp];
	return { v: piecewiseLinear(ts, [0, vMax, 0]), op: () => "reset", tEnd: ts[2], corners: ts };
}

// 사다리꼴 펄스 하나 (지연 0, 상승 = 하강 = tEdge)
export function pulseWaveform(op: Op, vPulse: number, tEdge = 10e-9, tWidth = 1e-6): Waveform {
	const ts = [0, tEdge, tEdge + tWidth, 2 * tEdge + tWidth];
	return { v: piecewiseLinear(ts, [0, vPulse, vPulse, 0]), op: () => op, tEnd: ts[3], corners: ts };
}

// 직렬 compliance 저항: SET 동작이면 rs, RESET 동작이면 rsReset (A14) [ohm]
export function seriesR(op: Op, rs: number, rsReset: number): number {
	return op === "set" ? rs : rsReset;
}

// Brent 근 찾기 (f(a), f(b) 부호가 반대). scipy brentq와 같은 허용오차 의미: |dx| <= xtol + rtol*|x|
export function brent(fn: (x: number) => number, a: number, b: number, xtol = 1e-7, rtol = 1e-9, maxIter = 200): number {
	let fa = fn(a);
	let fb = fn(b);
	if (fa === 0) return a;
	if (fb === 0) return b;
	if (fa * fb > 0) throw new Error("brent: 구간 양 끝 부호가 같음");
	let c = a;
	let fc = fa;
	let d = b - a;
	let e = d;
	for (let it = 0; it < maxIter; it++) {
		if (fb * fc > 0) {
			c = a;
			fc = fa;
			d = b - a;
			e = d;
		}
		if (Math.abs(fc) < Math.abs(fb)) {
			a = b;
			b = c;
			c = a;
			fa = fb;
			fb = fc;
			fc = fa;
		}
		const tol = 0.5 * (xtol + rtol * Math.abs(b));
		const m = 0.5 * (c - b);
		if (Math.abs(m) <= tol || fb === 0) return b;
		if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
			const s = fb / fa;
			let pp: number;
			let qq: number;
			if (a === c) {
				pp = 2 * m * s;
				qq = 1 - s;
			} else {
				const q0 = fa / fc;
				const r = fb / fc;
				pp = s * (2 * m * q0 * (q0 - r) - (b - a) * (r - 1));
				qq = (q0 - 1) * (r - 1) * (s - 1);
			}
			if (pp > 0) qq = -qq;
			else pp = -pp;
			if (2 * pp < Math.min(3 * m * qq - Math.abs(tol * qq), Math.abs(e * qq))) {
				e = d;
				d = pp / qq;
			} else {
				d = m;
				e = d;
			}
		} else {
			d = m;
			e = d;
		}
		a = b;
		fa = fb;
		b += Math.abs(d) > tol ? d : m > 0 ? tol : -tol;
		fb = fn(b);
	}
	return b;
}

// 회로 방정식을 셀 전압 Vc에 대해 푼다:
// (vApp - Vc)/rSer = N*I(Vc) + CP*(Vc - vPrev)/dt   (CP 항은 후진 Euler, A11)
export function solveCell(fs: FieldSolver, p: Params, vApp: number, rSer: number, cp = 0, dt = 0, vPrev = 0): { vc: number; fld: Fields } {
	const c = cp > 0 && dt > 0 ? cp / dt : 0;
	const n = filamentCount(p);
	if (vApp === 0 && c === 0) return { vc: 0, fld: fs.solve(0) };
	const pts = c > 0 ? [0, vApp, vPrev] : [0, vApp];
	const lo = Math.min(...pts);
	const hi = Math.max(...pts);
	if (hi - lo < 1e-15) return { vc: lo, fld: fs.solve(lo) };
	const g = (vc: number): number => (vApp - vc) / rSer - n * fs.solve(vc).I - c * (vc - vPrev);
	const vc = brent(g, lo, hi);
	return { vc, fld: fs.solve(vc) };
}

export interface SimOptions {
	rs?: number;	// SET compliance 저항 [ohm]
	rsReset?: number;	// RESET 직렬 저항 [ohm]
	includeCp?: boolean;	// CP 포함 (펄스)
	dvMax?: number;	// 한 스텝 전압 변화 상한 [V]
	drbMax?: number;	// 한 스텝 경계 이동 상한 [m], 기본 drFine/4
	grid?: GridSpec;
	onProgress?: (frac: number) => void;
}

export interface SimResult {
	t: Float64Array;	// [s]
	vApp: Float64Array;	// [V]
	vCell: Float64Array;	// 셀 양단 전압 [V]
	i: Float64Array;	// 단자 전류 [A]
	rMin: Float64Array;	// 가장 가는 곳 CF 반경 [m]
	T: Float64Array;	// 최고 온도 [K]
	rbEnd: Float64Array;	// 마지막 CF 경계 반경 r_b(z) [m]
	hot: { t: number; v: number; rb: Float64Array; T: Float64Array };	// 최고 온도 시점의 형상과 온도 분포
	grid: Grid;
	steps: number;
}

// CF 경계를 시간에 따라 움직이며 응답을 계산한다. 경계 이동은 명시적 Euler + 적응 스텝 (A34)
export function simulate(wf: Waveform, rb0: number | ArrayLike<number> | null, p: Params, o: SimOptions = {}): SimResult {
	const gs = o.grid ?? DEFAULT_GRID;
	const g = makeGrid(p, gs);
	const nz = g.nz;
	const rs = o.rs ?? 3e3;
	const rsReset = o.rsReset ?? 0;
	const dvMax = o.dvMax ?? 1e-2;
	const drbMax = o.drbMax ?? gs.drFine / 4;
	let rb = new Float64Array(nz);
	if (rb0 === null) rb.fill(p.phi0 / 2);
	else if (typeof rb0 === "number") rb.fill(rb0);
	else rb = Float64Array.from(rb0);
	const corners = [...new Set(wf.corners.filter((c) => c > 0 && c < wf.tEnd))].sort((a, b) => a - b);
	const ts: number[] = [];
	const vas: number[] = [];
	const vcs: number[] = [];
	const is: number[] = [];
	const rmins: number[] = [];
	const tms: number[] = [];
	let hot = { t: 0, v: 0, rb: Float64Array.from(rb), T: new Float64Array(0) };
	let hotT = -Infinity;
	let t = 0;
	let vc = 0;
	let dt = 0;
	let tPrev: Float64Array | null = null;
	const eps = 1e-12 * Math.max(wf.tEnd, 1e-9);
	for (;;) {
		const va = wf.v(t);
		const op = wf.op(Math.min(t, wf.tEnd * (1 - 1e-12)));
		const rSer = p.RL + seriesR(op, rs, rsReset);
		const fs = new FieldSolver(g, p, rb);
		fs.tLast = tPrev;
		const sol = solveCell(fs, p, va, rSer, o.includeCp ? p.CP : 0, dt, vc);
		vc = sol.vc;
		tPrev = sol.fld.T;
		ts.push(t);
		vas.push(va);
		vcs.push(vc);
		is.push((va - vc) / rSer);
		let rmin = Infinity;
		for (let j = 0; j < nz; j++) rmin = Math.min(rmin, rb[j]);
		rmins.push(rmin);
		tms.push(sol.fld.tMax);
		if (sol.fld.tMax > hotT) {
			hotT = sol.fld.tMax;
			hot = { t, v: va, rb: Float64Array.from(rb), T: sol.fld.T };
		}
		if (t >= wf.tEnd) break;
		o.onProgress?.(t / wf.tEnd);
		const vel = boundaryVelocity(op, rb, g, sol.fld, p);
		let dtNext = wf.tEnd - t;
		let vm = 0;
		for (let j = 0; j < nz; j++) vm = Math.max(vm, Math.abs(vel[j]));
		if (vm > 0) dtNext = Math.min(dtNext, drbMax / vm);
		const slope = Math.abs(wf.v(t + eps) - va) / eps;
		if (slope > 0) dtNext = Math.min(dtNext, dvMax / slope);
		const nxt = corners.find((c) => c > t + 1e-18);
		if (nxt !== undefined) dtNext = Math.min(dtNext, nxt - t);	// 파형 꺾임점을 정확히 지난다
		dt = Math.max(dtNext, 1e-15);
		for (let j = 0; j < nz; j++) rb[j] = Math.min(Math.max(rb[j] + vel[j] * dt, 0), p.Rdom);
		t = Math.min(t + dt, wf.tEnd);
	}
	return {
		t: Float64Array.from(ts),
		vApp: Float64Array.from(vas),
		vCell: Float64Array.from(vcs),
		i: Float64Array.from(is),
		rMin: Float64Array.from(rmins),
		T: Float64Array.from(tms),
		rbEnd: Float64Array.from(rb),
		hot,
		grid: g,
		steps: ts.length,
	};
}

// ---------------------------------------------------------------- 읽기 / 고정 상태
function profileOf(rb: number | ArrayLike<number>, g: Grid): Float64Array {
	return typeof rb === "number" ? new Float64Array(g.nz).fill(rb) : Float64Array.from(rb);
}

// vRead에서의 셀 저항 (RL 포함, 스위칭 없음) [ohm]. 0.1 V는 [C] Fig. 3의 측정 조건
export function readResistance(rb: number | ArrayLike<number>, p: Params, vRead = 0.1, gs: GridSpec = DEFAULT_GRID): number {
	const g = makeGrid(p, gs);
	const fs = new FieldSolver(g, p, profileOf(rb, g));
	const sol = solveCell(fs, p, vRead, p.RL);
	return vRead / (filamentCount(p) * sol.fld.I);
}

// 고정 상태 모드용 CF 형상: 가운데 길이 len 구간만 반경 rNeck, 나머지는 phi0/2
export function neckProfile(rNeck: number, len: number, p: Params, gs: GridSpec = DEFAULT_GRID): Float64Array {
	const g = makeGrid(p, gs);
	const rb = new Float64Array(g.nz).fill(p.phi0 / 2);
	const mid = p.L0 / 2;
	for (let j = 0; j < g.nz; j++) if (Math.abs(g.zc[j] - mid) <= len / 2) rb[j] = rNeck;
	return rb;
}

// 고정 상태 모드: CF 형상 rb에서의 정적 I-V (RL 포함, 스위칭 없음)
export function ivFixedState(v: readonly number[], rb: number | ArrayLike<number>, p: Params, gs: GridSpec = DEFAULT_GRID): Float64Array {
	const g = makeGrid(p, gs);
	const fs = new FieldSolver(g, p, profileOf(rb, g));
	const out = new Float64Array(v.length);
	for (let k = 0; k < v.length; k++) out[k] = filamentCount(p) * solveCell(fs, p, v[k], p.RL).fld.I;
	return out;
}

// ---------------------------------------------------------------- 변동성 [D] (10),(11)
export interface Variability {
	sigmaEa: number;	// 사이클 간 Ea(SET) 표준편차 [J] (A13)
	sigmaEd: number;	// 사이클 간 Ed(RESET) 표준편차 [J] (A13)
}

export const DEFAULT_VARIABILITY: Readonly<Variability> = Object.freeze({
	sigmaEa: 0.02 * EV,	// [J]
	sigmaEd: 0.02 * EV,	// [J]
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

// [D] 식 (10),(11): 한 사이클의 SET/RESET 장벽을 몬테카를로로 뽑는다 (RESET 장벽은 Ed, A13)
export function sampleCycleParams(p: Params, v: Variability, rng: () => number): Params {
	return { ...p, Ea: p.Ea + v.sigmaEa * rng(), Ed: p.Ed + v.sigmaEd * rng() };
}

// ---------------------------------------------------------------- 진단
// RESET 구간(전체의 앞 절반, 스윕이 아니면 전체)에서 |I|가 최대인 (V_reset, I_reset)
export function resetPoint(r: SimResult, sweep = true): { v: number; i: number } {
	const half = sweep ? r.t[r.t.length - 1] / 2 : Infinity;
	let k = 0;
	for (let m = 0; m < r.t.length && r.t[m] <= half; m++) if (Math.abs(r.i[m]) > Math.abs(r.i[k])) k = m;
	return { v: r.vApp[k], i: r.i[k] };
}

// SET 구간에서 셀 저항이 처음으로 구간 시작값의 1/10 아래로 떨어지는 인가 전압 [V]
export function setPoint(r: SimResult): number {
	const half = r.t[r.t.length - 1] / 2;
	let r0 = NaN;
	for (let m = 0; m < r.t.length; m++) {
		if (r.t[m] <= half || Math.abs(r.vApp[m]) <= 0.05) continue;
		const R = Math.abs(r.vCell[m] / (r.i[m] === 0 ? 1e-30 : r.i[m]));
		if (Number.isNaN(r0)) r0 = R;
		else if (R < r0 / 10) return r.vApp[m];
	}
	return NaN;
}

// ---------------------------------------------------------------- 소자 간 몬테카를로 (교수님 요청)
// 고정 상태에서 필라멘트 개수, 필라멘트마다 지름·잘록 구간(갭) 반경·길이를 무작위로 뽑아 읽기 저항 분포를 본다.
// 필라멘트마다 형상이 달라 각각 2차원으로 풀고 병렬로 합친다 (A38).
export interface FilamentGeom {
	phi: number;	// 필라멘트 지름 [m]
	rNeck: number;	// 잘록 구간 반경 [m]
	neckLen: number;	// 잘록 구간 길이 [m]
}

export interface MonteCarloSpec {
	devices: number;	// 소자 수
	rNeck: number;	// 잘록 구간 반경 평균 [m]
	neckLen: number;	// 잘록 구간 길이 평균 [m]
	sigmaPhi: number;	// 지름의 상대 표준편차 [-] (A39)
	sigmaNeck: number;	// 잘록 반경의 상대 표준편차 [-] (A39)
	sigmaLen: number;	// 잘록 길이의 상대 표준편차 [-] (A39)
}

export const DEFAULT_MC: Readonly<MonteCarloSpec> = Object.freeze({
	devices: 100,
	rNeck: 4e-9,	// [m]
	neckLen: 8e-9,	// [m]
	sigmaPhi: 0.2,
	sigmaNeck: 0.3,
	sigmaLen: 0.3,
});

// 시드를 받는 균등 [0, 1) 난수 (mulberry32)
export function uniformRng(seed: number): () => number {
	let s = seed >>> 0;
	return (): number => {
		s = (s + 0x6d2b79f5) >>> 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 15), z | 1);
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
		return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
	};
}

// 평균 mean, 상대 표준편차 rel인 로그정규 표본 (A39)
export function lognormal(normal: () => number, mean: number, rel: number): number {
	if (rel <= 0) return mean;
	const s2 = Math.log(1 + rel * rel);
	return mean * Math.exp(Math.sqrt(s2) * normal() - 0.5 * s2);
}

// 포아송(mean)에서 0을 뺀 분포: 포밍된 소자에는 필라멘트가 적어도 하나 있다 (A39). Knuth 방법
export function poissonAtLeastOne(uniform: () => number, mean: number): number {
	const m = Math.max(mean, 1e-9);
	for (;;) {
		let k = 0;
		let prod = uniform();
		if (m < 30) {
			const L = Math.exp(-m);
			while (prod > L) {
				k++;
				prod *= uniform();
			}
		} else {
			// 평균이 크면 정규 근사 (exp(-m)이 너무 작아짐)
			let u = 0;
			while (u === 0) u = uniform();
			k = Math.max(0, Math.round(m + Math.sqrt(m) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform())));
		}
		if (k >= 1) return k;
	}
}

// 소자 하나의 필라멘트 형상 목록. 개수 평균은 nF*aCell, 지름 평균은 phi0
export function sampleDevice(spec: MonteCarloSpec, p: Params, uniform: () => number, normal: () => number): FilamentGeom[] {
	const n = poissonAtLeastOne(uniform, p.nF * p.aCell);
	const out: FilamentGeom[] = [];
	for (let k = 0; k < n; k++) {
		const phi = Math.min(lognormal(normal, p.phi0, spec.sigmaPhi), 1.8 * p.Rdom);	// 계산 영역 안에 들어가게
		const rNeck = Math.min(lognormal(normal, spec.rNeck, spec.sigmaNeck), phi / 2);
		const neckLen = Math.min(lognormal(normal, spec.neckLen, spec.sigmaLen), p.L0);
		out.push({ phi, rNeck, neckLen });
	}
	return out;
}

// 필라멘트 하나의 경계 반경 r_b(z): 지름 phi, 가운데 neckLen 구간만 반경 rNeck
export function filamentProfile(fg: FilamentGeom, p: Params, gs: GridSpec = DEFAULT_GRID): Float64Array {
	const g = makeGrid(p, gs);
	const rb = new Float64Array(g.nz).fill(fg.phi / 2);
	for (let j = 0; j < g.nz; j++) if (Math.abs(g.zc[j] - p.L0 / 2) <= fg.neckLen / 2) rb[j] = Math.min(fg.rNeck, fg.phi / 2);
	return rb;
}

// 필라멘트가 서로 다른 소자의 정적 I-V (RL 직렬, 필라멘트 병렬 + 셀 전체 산화막 누설, A38)
export function deviceIv(v: readonly number[], filaments: FilamentGeom[], p: Params, gs: GridSpec = DEFAULT_GRID): Float64Array {
	const g = makeGrid(p, gs);
	const solvers = filaments.map((fg) => new FieldSolver(g, p, filamentProfile(fg, p, gs)));
	const gOx = p.aCell / (p.rhoOx * p.L0);	// 필라멘트 밖 산화막 누설 컨덕턴스 [S]
	const out = new Float64Array(v.length);
	for (let k = 0; k < v.length; k++) {
		const vk = v[k];
		if (vk === 0) continue;
		const fn = (vc: number): number => {
			let i = 0;
			for (const fs of solvers) i += fs.solve(vc).I;
			return (vk - vc) / p.RL - i - gOx * vc;
		};
		const vc = brent(fn, Math.min(0, vk), Math.max(0, vk), 1e-9, 1e-10);
		out[k] = (vk - vc) / p.RL;
	}
	return out;
}

// 소자 읽기 저항 (0.1 V, RL 포함) [ohm]
export function deviceRead(filaments: FilamentGeom[], p: Params, gs: GridSpec = DEFAULT_GRID, vRead = 0.1): number {
	return vRead / deviceIv([vRead], filaments, p, gs)[0];
}
