// Conduction, temperature and state rates. Port of python/rram_model.py.
// Equation numbers refer to H. Li et al., DATE 2015.

import { EPS_X, K_B, Q_E, W_MIN, filamentCount, type Params } from "./params";

const EXP_CAP = 700;	// cap on exp/sinh arguments, avoids overflow at far-off trial points

function expc(z: number): number {
	return Math.exp(Math.min(z, EXP_CAP));
}

function clamp01(z: number): number {
	return Math.min(Math.max(z, 0), 1);
}

// CF cross-section [m^2]; w is the CF diameter, A = pi*w^2/4 (A1)
export function cfArea(w: number): number {
	return Math.PI * w * w / 4;
}

// Inverse of cfArea [m]
export function cfWidthFromArea(A: number): number {
	return Math.sqrt(4 * A / Math.PI);
}

// Eq. (6) prefactor I0*A*exp(-x/gT) [A]
function hopPrefactor(x: number, w: number, p: Params): number {
	return p.I0 * cfArea(w) * Math.exp(-x / p.gT);
}

// Eq. (6): I_hop = I0*A*exp(-x/gT)*sinh(V_gap/VT) [A]
export function hopCurrent(vGap: number, x: number, w: number, p: Params): number {
	return hopPrefactor(x, w, p) * Math.sinh(Math.min(vGap / p.VT, EXP_CAP));
}

// Eq. (7): R_CF = rho*(L0 - x)/A [ohm]
export function cfResistance(x: number, w: number, p: Params): number {
	return p.rho * Math.max(p.L0 - x, 0) / cfArea(w);
}

export interface FilamentPoint {
	i: number;	// filament current [A]
	vGap: number;	// voltage across the gap [V]
	didv: number;	// dI/dV of the filament [A/V]
}

// Safeguarded Newton on a monotonically increasing g(z) with g(lo) <= 0 <= g(hi).
// Falls back to bisection whenever the Newton step leaves the bracket.
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

// One filament: CF (ohmic) in series with the gap (hopping) (A2). Odd in v.
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
	// start from the smaller of 'all voltage on CF' and 'all voltage on gap' estimates
	const vg0 = Math.min(va, p.VT * Math.asinh(va / rCf / Math.max(pre, 1e-300)));
	const vg = solveMonotone(g, 0, va, vg0);
	const dHop = pre * Math.cosh(Math.min(vg / p.VT, EXP_CAP)) / p.VT;
	// series combination: dI/dV = 1/(R_CF + 1/(dI_hop/dV_gap))
	return { i: s * (va - vg) / rCf, vGap: s * vg, didv: 1 / (rCf + 1 / dHop) };
}

// Current into the switching node: N filaments in parallel + RH leakage [A]
export function cellCurrent(vSw: number, x: number, w: number, p: Params): number {
	return filamentCount(p) * filamentCurrent(vSw, x, w, p).i + vSw / p.RH;
}

// Solve vApp = V_sw + I_cell(V_sw)*(RL + Rs) for V_sw [V]
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

// Eq. (5): T = T0 + |I*V|*Rth per filament (A6) [K]
export function temperature(iF: number, v: number, p: Params): number {
	return p.T0 + Math.abs(iF * v) * p.Rth;
}

// Eq. (1): |dx/dt| during SET [m/s]; field E = |V|/L0 (A5)
export function rateSetGap(v: number, T: number, p: Params): number {
	const E = Math.abs(v) / p.L0;	// [V/m]
	return p.a * p.f * expc(-(p.Ea - p.alphaA * p.Z * Q_E * E) / (K_B * T));
}

// Eq. (2): dr/dt during SET, r = w/2 [m/s]
export function rateSetWidth(v: number, w: number, T: number, p: Params): number {
	const E = Math.abs(v) / p.L0;	// [V/m]
	const r = Math.max(w / 2, 1e-12);	// [m]
	const pref = p.dr + p.dr * p.dr / (2 * r);	// [m]
	return pref * p.f * expc(-(p.Ea - p.alphaA * p.Z * Q_E * E) / (K_B * T));
}

// Eqs. (3),(4): dx/dt during RESET, slower of O2- release and recombination [m/s]
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
	T: number;	// filament temperature [K]
	iF: number;	// filament current [A]
}

// State rates. SET (V>0): two-step, gap first then lateral growth (A7).
// RESET (V<0): gap grows, width unchanged (A16). chiG, chiR: noise of eqs. (8),(9).
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
	// eqs. (8),(9): additive noise on the rates
	dx += p.deltaGap * chiG;
	dw += 2 * p.deltaCF * chiR;
	// soft walls keep x in [0, L0], w in [W_MIN, WCF] (A8)
	dx *= dx < 0 ? clamp01(x / EPS_X) : clamp01((p.L0 - x) / EPS_X);
	dw *= dw < 0 ? clamp01((w - W_MIN) / EPS_X) : clamp01((p.WCF - w) / EPS_X);
	return { dx, dw, T, iF };
}
