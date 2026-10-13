// Model parameters and physical constants. All values SI.
// Names / defaults: PKU-Stanford RRAM v2.0Beta Quick User Guide, Table 3.
// Items marked (A#) are assumptions documented in ASSUMPTIONS.md.

export const Q_E = 1.602176634e-19;	// elementary charge [C]
export const K_B = 1.380649e-23;	// Boltzmann constant [J/K]
export const EV = Q_E;	// 1 eV [J]

export interface Params {
	I0: number;	// hopping current density [A/m^2]
	rho: number;	// CF resistivity [ohm*m]
	a: number;	// distance between VO [m]
	f: number;	// VO vibration frequency [Hz]
	Ea: number;	// VO average activation energy [J]
	Eh: number;	// O2- hopping barrier [J]
	Ei: number;	// electrode/oxide interface barrier [J]
	alphaA: number;	// energy enhancement factor, generation [m]
	alphaH: number;	// energy enhancement factor, O2- hopping [m]
	gamma: number;	// voltage enhancement factor [-]
	Z: number;	// charge number [-]
	Rth: number;	// effective thermal resistance [K/W]
	RH: number;	// oxide parasitic resistance [ohm]
	RL: number;	// electrode contact resistance [ohm]
	CP: number;	// electrode parasitic capacitance [F]
	L0: number;	// switching layer thickness [m]
	WCF: number;	// switching layer width = max CF width [m]
	VT: number;	// characteristic voltage of hopping [V]
	T0: number;	// ambient temperature [K]
	deltaGap: number;	// gap varying rate, delta_g in eq. (8) [m/s]
	deltaCF: number;	// CF width varying rate, delta_r in eq. (9) [m/s]
	gT: number;	// hopping decay length in eq. (6), fitted value [m] (A3)
	dr: number;	// lateral growth step Delta_r in eq. (2) [m] (A4)
	nF: number;	// filaments per unit area [1/m^2] (A10)
	aCell: number;	// cell area [m^2] (A10)
}

// Table 3 'Weff' and 'crit_x' have no equation in the source paper and are not used (A9).
export const DEFAULT: Readonly<Params> = Object.freeze({
	I0: 1e13,	// [A/m^2]
	rho: 19.64e-6,	// [ohm*m] (19.64 uOhm*m)
	a: 0.25e-9,	// [m]
	f: 1e13,	// [Hz]
	Ea: 0.7 * EV,	// [J]
	Eh: 1.12 * EV,	// [J]
	Ei: 0.82 * EV,	// [J]
	alphaA: 0.75e-9,	// [m]
	alphaH: 0.75e-9,	// [m]
	gamma: 1.5,	// [-]
	Z: 1,	// [-]
	Rth: 5e5,	// [K/W]
	RH: 200e6,	// [ohm]
	RL: 20,	// [ohm]
	CP: 20e-15,	// [F]
	L0: 3e-9,	// [m]
	WCF: 5e-9,	// [m]
	VT: 0.4,	// [V]
	T0: 300,	// [K]
	deltaGap: 4e-5,	// [m/s]
	deltaCF: 1e-4,	// [m/s]
	gT: 0.25e-9,	// [m] (A3)
	dr: 0.25e-9,	// [m] (A4)
	nF: 1e16,	// [1/m^2] (A10)
	aCell: 100e-18,	// [m^2], 10 nm x 10 nm (A10)
});

// Number of identical parallel filaments, round(nF*aCell) >= 1 (A10)
export function filamentCount(p: Params): number {
	return Math.max(1, Math.round(p.nF * p.aCell));
}

export const RS_SWEEP = 18e3;	// default SET compliance resistor, I-V sweep [ohm] (A15)
export const RS_PULSE = 10e3;	// default SET compliance resistor, pulse [ohm] (A15)

// Initial states, Table 3: x0 in {L0, 0}, w0 in {0.5 nm, WCF}
export const INIT_HRS: readonly [number, number] = [3e-9, 0.5e-9];	// [x0 m, w0 m] before SET
export const INIT_LRS: readonly [number, number] = [0, 5e-9];	// [x0 m, w0 m] before RESET

export const W_MIN = 0.1e-9;	// numerical floor on CF width [m] (A8)
export const EPS_X = 2.5e-12;	// soft-wall / two-step blending length, 0.01*a [m] (A7, A8)
