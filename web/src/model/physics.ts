// 전도, 온도, 상태 변화율. python/rram_model.py를 옮긴 것.
// 식 번호는 H. Li et al., DATE 2015 기준.

import { EPS_X, K_B, Q_E, W_MIN, filamentCount, type Params } from "./params";

const EXP_CAP = 700;	// exp/sinh 인자 상한, 시도점이 멀리 튈 때 오버플로 방지

function expc(z: number): number {
	return Math.exp(Math.min(z, EXP_CAP));
}

function clamp01(z: number): number {
	return Math.min(Math.max(z, 0), 1);
}

// CF 단면적 [m^2]. w는 CF 지름, A = pi*w^2/4 (A1)
export function cfArea(w: number): number {
	return Math.PI * w * w / 4;
}

// cfArea의 역함수 [m]
export function cfWidthFromArea(A: number): number {
	return Math.sqrt(4 * A / Math.PI);
}

// 식 (6)의 전인자 I0*A*exp(-x/gT) [A]
function hopPrefactor(x: number, w: number, p: Params): number {
	return p.I0 * cfArea(w) * Math.exp(-x / p.gT);
}

// 식 (6): I_hop = I0*A*exp(-x/gT)*sinh(V_gap/VT) [A]
export function hopCurrent(vGap: number, x: number, w: number, p: Params): number {
	return hopPrefactor(x, w, p) * Math.sinh(Math.min(vGap / p.VT, EXP_CAP));
}

// 식 (7): R_CF = rho*(L0 - x)/A [ohm]
export function cfResistance(x: number, w: number, p: Params): number {
	return p.rho * Math.max(p.L0 - x, 0) / cfArea(w);
}

export interface FilamentPoint {
	i: number;	// 필라멘트 전류 [A]
	vGap: number;	// 갭 양단 전압 [V]
	didv: number;	// 필라멘트의 dI/dV [A/V]
}

// 단조 증가하는 g(z) (g(lo) <= 0 <= g(hi))에 대한 안전장치 뉴턴법.
// 뉴턴 스텝이 구간을 벗어나면 이분법으로 대신한다.
function solveMonotone(g: (z: number) => [number, number], lo: number, hi: number, z0: number): number {
	let z = Math.min(Math.max(z0, lo), hi);
	for (let k = 0; k < 200; k++) {
		const [gz, dg] = g(z);
		if (gz === 0) return z;
		if (gz < 0) lo = z;
		else hi = z;
		let zn = dg > 0 ? z - gz / dg : NaN;
		if (!(zn > lo && zn < hi)) zn = 0.5 * (lo + hi);
		if (Math.abs(zn - z) <= 1e-15 + 1e-13 * Math.abs(zn) || hi - lo <= 1e-15 + 1e-13 * Math.abs(zn)) return zn;
		z = zn;
	}
	return z;
}

// 필라멘트 1개: CF(옴 전도)와 갭(호핑 전도)의 직렬 연결 (A2). v에 대해 홀함수.
export function filamentCurrent(v: number, x: number, w: number, p: Params): FilamentPoint {
	const pre = hopPrefactor(x, w, p);
	const rCf = cfResistance(x, w, p);
	if (v === 0) {
		const dHop = pre / p.VT;
		const didv = rCf > 0 ? 1 / (rCf + 1 / dHop) : dHop;
		return { i: 0, vGap: 0, didv };
	}
	const s = v > 0 ? 1 : -1;
	const va = Math.abs(v);
	if (rCf <= 0) {
		const arg = Math.min(va / p.VT, EXP_CAP);
		return { i: s * pre * Math.sinh(arg), vGap: v, didv: pre * Math.cosh(arg) / p.VT };
	}
	const g = (vg: number): [number, number] => {
		const arg = Math.min(vg / p.VT, EXP_CAP);
		return [pre * Math.sinh(arg) - (va - vg) / rCf, pre * Math.cosh(arg) / p.VT + 1 / rCf];
	};
	// '전압이 모두 CF에 걸린 경우'와 '모두 갭에 걸린 경우' 추정값 중 작은 쪽에서 시작
	const vg0 = Math.min(va, p.VT * Math.asinh(va / rCf / Math.max(pre, 1e-300)));
	const vg = solveMonotone(g, 0, va, vg0);
	const dHop = pre * Math.cosh(Math.min(vg / p.VT, EXP_CAP)) / p.VT;
	// 직렬 합성: dI/dV = 1/(R_CF + 1/(dI_hop/dV_gap))
	return { i: s * (va - vg) / rCf, vGap: s * vg, didv: 1 / (rCf + 1 / dHop) };
}

// 스위칭 노드로 흐르는 전류: 병렬 필라멘트 N개 + RH 누설 [A]
export function cellCurrent(vSw: number, x: number, w: number, p: Params): number {
	return filamentCount(p) * filamentCurrent(vSw, x, w, p).i + vSw / p.RH;
}

// vApp = V_sw + I_cell(V_sw)*(RL + Rs)를 풀어 V_sw를 구한다 [V]
export function solveVsw(vApp: number, x: number, w: number, p: Params, rs: number): number {
	if (vApp === 0) return 0;
	const rSer = p.RL + rs;
	const n = filamentCount(p);
	const g = (vs: number): [number, number] => {
		const fp = filamentCurrent(vs, x, w, p);
		return [vs + (n * fp.i + vs / p.RH) * rSer - vApp, 1 + (n * fp.didv + 1 / p.RH) * rSer];
	};
	if (vApp > 0) return solveMonotone(g, 0, vApp, vApp);
	return solveMonotone(g, vApp, 0, vApp);
}

// 식 (5): T = T0 + |I*V|*Rth, 필라멘트별 (A6) [K]
export function temperature(iF: number, v: number, p: Params): number {
	return p.T0 + Math.abs(iF * v) * p.Rth;
}

// 식 (1): SET 중 |dx/dt| [m/s]. 전계 E = |V|/L0 (A5)
export function rateSetGap(v: number, T: number, p: Params): number {
	const E = Math.abs(v) / p.L0;	// [V/m]
	return p.a * p.f * expc(-(p.Ea - p.alphaA * p.Z * Q_E * E) / (K_B * T));
}

// 식 (2): SET 중 dr/dt, r = w/2 [m/s]
export function rateSetWidth(v: number, w: number, T: number, p: Params): number {
	const E = Math.abs(v) / p.L0;	// [V/m]
	const r = Math.max(w / 2, 1e-12);	// [m]
	const pref = p.dr + p.dr * p.dr / (2 * r);	// [m]
	return pref * p.f * expc(-(p.Ea - p.alphaA * p.Z * Q_E * E) / (K_B * T));
}

// 식 (3),(4): RESET 중 dx/dt, O2- 방출과 재결합 중 느린 쪽 [m/s]
export function rateResetGap(v: number, T: number, p: Params): number {
	const va = Math.abs(v);
	const E = va / p.L0;	// [V/m]
	const kT = K_B * T;	// [J]
	const r3 = p.a * p.f * expc(-(p.Ei - p.gamma * p.Z * Q_E * va) / kT);
	const r4 = p.a * p.f * expc(-p.Eh / kT) * Math.sinh(Math.min(p.alphaH * p.Z * Q_E * E / kT, EXP_CAP));
	return Math.min(r3, r4);
}

export interface Rates {
	dx: number;	// dx/dt [m/s]
	dw: number;	// dw/dt [m/s]
	T: number;	// 필라멘트 온도 [K]
	iF: number;	// 필라멘트 전류 [A]
}

// 상태 변화율. SET (V>0): 2단계, 갭이 먼저 닫히고 그다음 측면 성장 (A7).
// RESET (V<0): 갭이 커지고 폭은 그대로 (A16). chiG, chiR: 식 (8),(9)의 잡음.
export function stateRates(vSw: number, x: number, w: number, p: Params, chiG = 0, chiR = 0): Rates {
	const xc = Math.min(Math.max(x, 0), p.L0);
	const wc = Math.min(Math.max(w, W_MIN), p.WCF);
	const iF = filamentCurrent(vSw, xc, wc, p).i;
	const T = temperature(iF, vSw, p);
	let dx = 0;
	let dw = 0;
	if (vSw > 0) {
		const sGap = clamp01(x / EPS_X);
		dx = -rateSetGap(vSw, T, p);
		dw = 2 * rateSetWidth(vSw, wc, T, p) * (1 - sGap);
	} else if (vSw < 0) {
		dx = rateResetGap(vSw, T, p);
	}
	// 식 (8),(9): 변화율에 더해지는 잡음
	dx += p.deltaGap * chiG;
	dw += 2 * p.deltaCF * chiR;
	// 부드러운 벽으로 x를 [0, L0], w를 [W_MIN, WCF]에 가둔다 (A8)
	dx *= dx < 0 ? clamp01(x / EPS_X) : clamp01((p.L0 - x) / EPS_X);
	dw *= dw < 0 ? clamp01((w - W_MIN) / EPS_X) : clamp01((p.WCF - w) / EPS_X);
	return { dx, dw, T, iF };
}
