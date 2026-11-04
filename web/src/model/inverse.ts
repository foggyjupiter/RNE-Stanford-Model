// 측정 I-V 역산. python/inverse.py를 옮긴 것 (정적 단계 + SET 활성화 에너지 피팅).
// 근거: [C] Russo et al., IEEE TED 56(2) 186-192 (2009)
//   식 (5) R = R0[1 + γα(Tmax − T0)] (γ = 2/3), 식 (6) Tcrit = T0 + Preset·Rth, 식 (7) σ/κ_eq = 8 Rth/R.
// 2차원 모델로 위 값을 필라멘트 지름·개수와 SET 파라미터로 옮긴다. 가정은 ASSUMPTIONS.md A42-A45, A50-A54.

import { DEFAULT_GRID, EV, type GridSpec, type Params } from "./params";
import { FieldSolver, makeGrid } from "./fields";
import { brent, rampWaveform, simulate, type SimResult } from "./simulate";

// 원점을 지나는 직선 I = V/R을 0 < V <= vLin 점들에 최소제곱으로 맞춘 저항 [ohm].
// 점이 두 개 미만이면 처음 두 양의 점을 쓴다 ([C] Fig. 4: 0.1 V 아래에서 옴 법칙)
export function lowFieldResistance(v: ArrayLike<number>, i: ArrayLike<number>, vLin = 0.2): number {
	let idx: number[] = [];
	for (let k = 0; k < v.length; k++) if (v[k] > 0 && v[k] <= vLin + 1e-12) idx.push(k);
	if (idx.length < 2) {
		idx = [];
		for (let k = 0; k < v.length && idx.length < 2; k++) if (v[k] > 0) idx.push(k);
	}
	let a = 0;
	let b = 0;
	for (const k of idx) {
		a += v[k] * v[k];
		b += v[k] * i[k];
	}
	return a / b;
}

export interface ResetFeatures {
	R0: number;	// 저전계 LRS 저항, R_L 뺀 값 [ohm]
	vReset: number;	// 전류 최대점 전압 [V]
	iReset: number;	// [A]
	v: number[];	// RESET 전까지의 양의 전압 [V]
	R: number[];	// V/I − R_L [ohm]
	P: number[];	// V·I [W]
	drop: number;	// 최대점 뒤 최소 전류 / 최대 전류
}

// RESET 스윕 특징값. RESET 점 = 전류 최대점 ([R] VI절)
export function resetFeatures(v: ArrayLike<number>, iIn: ArrayLike<number>, RL = 0, vLin = 0.2): ResetFeatures {
	const i = Array.from(iIn, Math.abs);
	let k = 0;
	for (let j = 1; j < i.length; j++) if (i[j] > i[k]) k = j;
	let mn = Infinity;
	for (let j = k; j < i.length; j++) mn = Math.min(mn, i[j]);
	const vv = Array.from(v).slice(0, k + 1);
	const ii = i.slice(0, k + 1);
	const R0 = lowFieldResistance(vv, ii, vLin) - RL;
	const out: ResetFeatures = { R0, vReset: v[k], iReset: i[k], v: [], R: [], P: [], drop: mn / i[k] };
	for (let j = 0; j <= k; j++) {
		if (vv[j] > 0) {
			out.v.push(vv[j]);
			out.R.push(vv[j] / ii[j] - RL);
			out.P.push(vv[j] * ii[j]);
		}
	}
	return out;
}

// [C] 식 (5)를 Tmax에 대해 [K]
export function russoTemperature(R: number, R0: number, alpha: number, T0 = 300, gamma = 2 / 3): number {
	return T0 + (R / R0 - 1) / (gamma * alpha);
}

export interface RussoResult {
	T: number[];	// RESET 전 각 점의 최고 온도 [K]
	tCrit: number;	// RESET 점의 온도 [K]
	pReset: number;	// [W]
	rthReset: number;	// [C] 식 (6) [K/W]
	rthFit: number;	// T − T0 = Rth·P 기울기 [K/W] (A43)
	sigmaKappa: number;	// [C] 식 (7): 8 Rth/R0 [K/(W·ohm)]
}

export function russoExtraction(f: ResetFeatures, alpha: number, T0 = 300, gamma = 2 / 3): RussoResult {
	const T = f.R.map((r) => russoTemperature(r, f.R0, alpha, T0, gamma));
	const tCrit = T[T.length - 1];
	const pReset = f.P[f.P.length - 1];
	let a = 0;
	let b = 0;
	for (let k = 0; k < T.length; k++) {
		if (f.P[k] > 0) {
			a += f.P[k] * (T[k] - T0);
			b += f.P[k] * f.P[k];
		}
	}
	const rthFit = a / b;
	return { T, tCrit, pReset, rthReset: (tCrit - T0) / pReset, rthFit, sigmaKappa: 8 * rthFit / f.R0 };
}

export interface SetFeatures {
	rHrs: number;	// 저전계 HRS 저항, R_L 뺀 값 [ohm]
	vSet: number;	// 전류가 처음 0.9·I_CC 이상인 전압 [V] (CC 없으면 가장 크게 오르는 점)
}

export function setFeatures(v: ArrayLike<number>, iIn: ArrayLike<number>, icc = NaN, RL = 0, vLin = 0.2): SetFeatures {
	const i = Array.from(iIn, Math.abs);
	const rHrs = lowFieldResistance(v, i, vLin) - RL;
	let vSet = NaN;
	if (Number.isFinite(icc)) {
		const k = i.findIndex((x) => x >= 0.9 * icc);
		if (k >= 0) vSet = v[k];
	} else {
		let best = 1;
		let bk = -1;
		for (let k = 1; k < i.length; k++) {
			const r = i[k] / Math.max(i[k - 1], 1e-30);
			if (bk < 0 || r > best) {
				best = r;
				bk = k;
			}
		}
		if (bk >= 0) vSet = v[bk];
	}
	return { rHrs, vSet };
}

// 포밍 전 저전계 저항으로 산화막 비저항 [ohm·m] (A44)
export function oxideResistivity(rPristine: number, p: Params): number {
	return (rPristine - p.RL) * p.aCell / p.L0;
}

export function uniformCf(phi: number, p: Params, gs: GridSpec = DEFAULT_GRID): Float64Array {
	return new Float64Array(makeGrid(p, gs).nz).fill(phi / 2);
}

// 지름 phi CF의 가운데 길이 gap 구간을 반경 rNeck(기본 0 = 끊긴 갭)으로 ([R] Fig. 2·6).
// 끊긴 갭은 끝이 걸친 칸을 반경 Δr·(1 − 걸친 비율)로 두어 호핑 갭 길이(A55)가 gap에 대해 연속이 되게 한다
export function gapProfile(phi: number, gap: number, p: Params, gs: GridSpec = DEFAULT_GRID, rNeck = 0): Float64Array {
	const g = makeGrid(p, gs);
	const rb = new Float64Array(g.nz).fill(phi / 2);
	if (rNeck > 0) {
		for (let j = 0; j < g.nz; j++) if (Math.abs(g.zc[j] - p.L0 / 2) <= gap / 2) rb[j] = rNeck;
		return rb;
	}
	const lo = p.L0 / 2 - gap / 2;
	const hi = p.L0 / 2 + gap / 2;
	for (let j = 0; j < g.nz; j++) {
		const z0 = g.zFaces[j];
		const z1 = g.zFaces[j + 1];
		const fr = Math.min(Math.max((Math.min(z1, hi) - Math.max(z0, lo)) / (z1 - z0), 0), 1);
		if (fr > 0) rb[j] = p.dr * (1 - fr);
	}
	return rb;
}

// HRS 저항으로 끊긴 갭 길이 [m] (호핑 전도가 켜져 있을 때, A55). 범위 밖이면 NaN
export function fitGap(rHrs: number, phi: number, N: number, p: Params, gs: GridSpec = DEFAULT_GRID): number {
	const g = makeGrid(p, gs);
	const dz = p.L0 / g.nz;
	const rOf = (gap: number): number => deviceResistance(gapProfile(phi, gap, p, gs), N, p, gs);
	const lo = 0.5 * dz;
	const hi = p.L0 - 2 * dz;
	if (!(rOf(lo) <= rHrs && rHrs <= rOf(hi))) return NaN;
	return brent((x) => Math.log(rOf(x) / rHrs), lo, hi, 0.01e-9);
}

// 필라멘트 1개 정적 I-V (R_L 없음)
export function filamentStatic(rb: ArrayLike<number>, p: Params, vList: number[], gs: GridSpec = DEFAULT_GRID): { I: number[]; T: number[] } {
	const fs = new FieldSolver(makeGrid(p, gs), p, rb, gs);
	const I: number[] = [];
	const T: number[] = [];
	for (const v of vList) {
		const f = fs.solve(v);
		I.push(f.I);
		T.push(f.tMax);
	}
	return { I, T };
}

export interface LrsCurve {
	phi: number[];	// [m]
	R0: number[];	// 필라멘트 1개 저전계 저항 [ohm]
	Rth: number[];	// 측정과 같은 추출로 뽑은 Rth [K/W]
	ratio: number[];	// Rth/R0 [K/(W·ohm)]
}

export function geomspace(a: number, b: number, n: number): number[] {
	return Array.from({ length: n }, (_, k) => a * Math.pow(b / a, k / (n - 1)));
}

// 지름마다 측정과 같은 추출([C] 식 (5))로 뽑은 R0, Rth (필라멘트 1개, A43)
export function modelLrsCurve(p: Params, phis: number[], tTarget: number, alpha = p.alphaT, gs: GridSpec = DEFAULT_GRID, nPts = 8): LrsCurve {
	const out: LrsCurve = { phi: [], R0: [], Rth: [], ratio: [] };
	for (const phi of phis) {
		const rb = uniformCf(phi, p, gs);
		const fs = new FieldSolver(makeGrid(p, gs), p, rb, gs);
		const f0 = fs.solve(1e-3);
		const R0 = 1e-3 / f0.I;
		const f1 = fs.solve(0.1);
		let vTop = 0.1 * Math.sqrt(Math.max(tTarget - p.T0, 1) / Math.max(f1.tMax - p.T0, 1e-6));
		for (let it = 0; it < 6; it++) {
			const ft = fs.solve(vTop);
			if (Math.abs(ft.tMax - tTarget) < 2) break;
			vTop *= Math.sqrt((tTarget - p.T0) / Math.max(ft.tMax - p.T0, 1e-6));
		}
		const vs = Array.from({ length: nPts }, (_, k) => vTop / nPts + (vTop - vTop / nPts) * k / (nPts - 1));
		const { I } = filamentStatic(rb, p, vs, gs);
		let a = 0;
		let b = 0;
		for (let k = 0; k < vs.length; k++) {
			const P = vs[k] * I[k];
			const Tx = russoTemperature(vs[k] / I[k], R0, alpha, p.T0);
			a += P * (Tx - p.T0);
			b += P * P;
		}
		out.phi.push(phi);
		out.R0.push(R0);
		out.Rth.push(a / b);
		out.ratio.push(a / b / R0);
	}
	return out;
}

// np.interp (xs 오름차순)
function interp(x: number, xs: number[], ys: number[]): number {
	if (x <= xs[0]) return ys[0];
	if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
	let k = 1;
	while (xs[k] < x) k++;
	return ys[k - 1] + (ys[k] - ys[k - 1]) * (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
}

export interface LrsFit {
	phi: number;	// 필라멘트 지름 [m]
	N: number;	// 병렬 필라멘트 수 (연속값)
	phiLo: number;	// Rth/R0 ±rel에 대한 지름 범위 [m]
	phiHi: number;
	separable: boolean;	// false면 Rth/R0가 모델 범위 밖 → N = 1로 두고 R0로만 지름을 정함
	curve: LrsCurve;
}

// 측정 R0(R_L 뺀 값)와 Rth로 지름·개수 (A43). N개 병렬이면 Rth/R0는 N과 무관 → 비율로 지름, R0로 개수.
// 비율이 모델 범위 밖이면 N = 1로 두고 R0로만 지름
export function fitLrs(R0: number, Rth: number, p: Params, tTarget: number, alpha = p.alphaT, gs: GridSpec = DEFAULT_GRID, rel = 0.2, curve?: LrsCurve): LrsFit {
	const c = curve ?? modelLrsCurve(p, geomspace(3e-9, 1.9 * p.Rdom, 24), tTarget, alpha, gs);
	const lr = c.ratio.map(Math.log);
	const order = lr.map((_, k) => k).sort((a, b) => lr[a] - lr[b]);
	const xs = order.map((k) => lr[k]);
	const ys = order.map((k) => Math.log(c.phi[k]));
	const phiAt = (q: number): number => {
		const x = Math.log(q);
		if (!(x >= xs[0] && x <= xs[xs.length - 1])) return NaN;
		return Math.exp(interp(x, xs, ys));
	};
	const lphi = c.phi.map(Math.log);
	const lR = c.R0.map(Math.log);
	const q = Rth / R0;
	const phi = phiAt(q);
	if (Number.isFinite(phi)) {
		const N = Math.exp(interp(Math.log(phi), lphi, lR)) / R0;
		const a = phiAt(q * (1 - rel));
		const b = phiAt(q * (1 + rel));
		return { phi, N, phiLo: Math.min(a, b), phiHi: Math.max(a, b), separable: true, curve: c };
	}
	// R0는 지름이 커질수록 작아진다: −log R0 오름차순으로 보간
	const nx = lR.map((x) => -x);
	const rev = nx.map((_, k) => k).sort((a, b) => nx[a] - nx[b]);
	const inRange = R0 >= Math.min(...c.R0) && R0 <= Math.max(...c.R0);
	const phi1 = inRange ? Math.exp(interp(-Math.log(R0), rev.map((k) => nx[k]), rev.map((k) => lphi[k]))) : NaN;
	return { phi: phi1, N: 1, phiLo: NaN, phiHi: NaN, separable: false, curve: c };
}

// 열 보정 (A56): 필라멘트 N개로 보고 측정 R0, Rth에 맞는 전극 열전도도 κ_el [W/(K·m)]과 지름 [m].
// 지름은 R0에서 정하고(저전계 저항은 κ_el과 무관), 그 지름에서 모델 Rth가 측정과 같아지도록 κ_el을 찾는다.
// 범위 [lo, hi] 안에 없으면 kappaEl = NaN
export function fitKappaEl(R0: number, Rth: number, p: Params, tTarget: number, alpha = p.alphaT, gs: GridSpec = DEFAULT_GRID, N = 1, lo = 2, hi = 1000): { kappaEl: number; phi: number } {
	const c = modelLrsCurve(p, geomspace(3e-9, 1.9 * p.Rdom, 24), tTarget, alpha, gs);
	const rFil = R0 * N;
	if (!(rFil >= Math.min(...c.R0) && rFil <= Math.max(...c.R0))) return { kappaEl: NaN, phi: NaN };
	const nx = c.R0.map((x) => -Math.log(x));
	const ord = nx.map((_, k) => k).sort((a, b) => nx[a] - nx[b]);
	const phi = Math.exp(interp(-Math.log(rFil), ord.map((k) => nx[k]), ord.map((k) => Math.log(c.phi[k]))));
	const resid = (lk: number): number => {
		const cc = modelLrsCurve({ ...p, kappaEl: Math.exp(lk) }, [phi], tTarget, alpha, gs);
		return Math.log(cc.Rth[0] / N / Rth);
	};
	const a = resid(Math.log(lo));
	const b = resid(Math.log(hi));
	if (a * b > 0) return { kappaEl: NaN, phi };
	return { kappaEl: Math.exp(brent(resid, Math.log(lo), Math.log(hi), 1e-3)), phi };
}

// 필라멘트 N개(동일) 병렬 + 셀 산화막 누설의 저전계 저항 (R_L 뺀 값) [ohm]
export function deviceResistance(rb: ArrayLike<number>, N: number, p: Params, gs: GridSpec = DEFAULT_GRID, vRead = 0.1): number {
	const { I } = filamentStatic(rb, p, [vRead], gs);
	return vRead / (N * I[0] + p.aCell / (p.rhoOx * p.L0) * vRead);
}

// HRS 저항으로 가운데 잘록 구간(길이 neckLen) 반경 [m] (A45). 범위 밖이면 NaN
export function fitNeck(rHrs: number, phi: number, N: number, p: Params, gs: GridSpec = DEFAULT_GRID, neckLen?: number): { rNeck: number; neckLen: number } {
	const g = makeGrid(p, gs);
	const len = neckLen ?? 2 * p.L0 / g.nz;
	const rOf = (rn: number): number => deviceResistance(gapProfile(phi, len, p, gs, rn), N, p, gs);
	const lo = 0.2 * p.dr;
	const hi = phi / 2;
	if (!(rOf(hi) <= rHrs && rHrs <= rOf(lo))) return { rNeck: NaN, neckLen: len };
	return { rNeck: brent((x) => Math.log(rOf(x) / rHrs), lo, hi, 0.01e-9), neckLen: len };
}

// CC SET 램프에서 전류가 처음 0.9·I_CC에 닿는 전압 [V]. 측정처럼 CC에 닿으면 멈춘다 (A52)
export function modelVSet(rb: ArrayLike<number>, p: Params, rate: number, vMax: number, icc: number, gs: GridSpec = DEFAULT_GRID): { vSet: number; r: SimResult } {
	const r = simulate(rampWaveform("set", vMax, rate), rb, p, { iCc: icc, ccHold: 0, grid: gs });
	return { vSet: setFeatures(r.vApp, r.i, icc, p.RL).vSet, r };
}

// 측정 V_set에 맞는 SET 활성화 에너지 E_a [J] ([D] 식 (2)). 못 찾으면 NaN
export function fitEa(vSet: number, rb: ArrayLike<number>, p: Params, rate: number, icc: number, gs: GridSpec = DEFAULT_GRID, loEV = 0.4, hiEV = 3.0, onEval?: (eaEV: number, v: number) => void): number {
	const vMax = 1.5 * vSet + 0.5;
	const resid = (ea: number): number => {
		const { vSet: vs } = modelVSet(rb, { ...p, Ea: ea * EV }, rate, vMax, icc, gs);
		onEval?.(ea, vs);
		return (Number.isFinite(vs) ? vs : vMax) - vSet;
	};
	const a = resid(loEV);
	const b = resid(hiEV);
	if (a * b > 0) return NaN;
	return brent(resid, loEV, hiEV, 0.005) * EV;
}
