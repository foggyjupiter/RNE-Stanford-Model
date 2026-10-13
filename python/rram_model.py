"""Metal-oxide bipolar RRAM conductive-filament model (independent implementation).

Governing equations come from the public paper
	H. Li et al., "Variation-aware, reliability-emphasized design and optimization
	of RRAM using SPICE model", DATE 2015, eqs. (1)-(11)
and parameter names / default values from the PKU-Stanford RRAM v2.0Beta
Quick User Guide, Table 3. Anything not stated in those sources is listed in
ASSUMPTIONS.md (tagged A1, A2, ...) and referenced in comments below.

All internal quantities are SI.
"""

import math
from dataclasses import dataclass, replace, field

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq


# ---------------------------------------------------------------- constants
Q_E = 1.602176634e-19	# elementary charge [C]
K_B = 1.380649e-23	# Boltzmann constant [J/K]
EV = Q_E	# 1 eV in [J]


# --------------------------------------------------------------- parameters
@dataclass(frozen=True)
class Params:
	# Manual Table 3 (default values, SI units)
	I0: float = 1e13	# hopping current density [A/m^2]
	rho: float = 19.64e-6	# CF resistivity [ohm*m] (19.64 uOhm*m)
	a: float = 0.25e-9	# distance between VO [m]
	f: float = 1e13	# VO vibration frequency [Hz]
	Ea: float = 0.7 * EV	# VO average activation energy [J]
	Eh: float = 1.12 * EV	# O2- hopping barrier [J]
	Ei: float = 0.82 * EV	# electrode/oxide interface barrier [J]
	alpha_a: float = 0.75e-9	# energy enhancement factor for generation [m]
	alpha_h: float = 0.75e-9	# energy enhancement factor for O2- hopping [m]
	gamma: float = 1.5	# voltage enhancement factor [-]
	Z: float = 1.0	# charge number [-]
	Rth: float = 5e5	# effective thermal resistance [K/W]
	RH: float = 200e6	# oxide parasitic resistance [ohm]
	RL: float = 20.0	# electrode contact resistance [ohm]
	CP: float = 20e-15	# electrode parasitic capacitance [F]
	L0: float = 3e-9	# switching layer thickness [m]
	WCF: float = 5e-9	# switching layer width (max CF width) [m]
	Weff: float = 0.5e-9	# effective width [m] (not used, see A9)
	VT: float = 0.4	# characteristic voltage of hopping [V]
	T0: float = 300.0	# ambient temperature [K]
	deltaGap: float = 4e-5	# gap varying rate, delta_g in eq. (8) [m/s]
	deltaCF: float = 1e-4	# CF width varying rate, delta_r in eq. (9) [m/s]
	crit_x: float = 0.5e-9	# gap variation fitting point [m] (not used, see A9)
	# Not in Table 3 -- assumptions
	gT: float = 0.25e-9	# hopping decay length in eq. (6) [m] (A3)
	dr: float = 0.25e-9	# lateral growth step Delta_r in eq. (2) [m] (A4)
	# Professor's request: filament density and cell area (A10)
	n_f: float = 1e16	# filaments per unit area [1/m^2]
	A_cell: float = 100e-18	# cell area [m^2] (10 nm x 10 nm)

	@property
	def N(self):
		"""Number of identical parallel filaments, round(n_f*A_cell) >= 1 (A10)."""
		return max(1, int(round(self.n_f * self.A_cell)))


DEFAULT = Params()

RS_DEFAULT = 18e3	# default SET compliance resistor [ohm], gives ~100 uA at 2.5 V (A15)

# Initial states, manual Table 3: x0 in {L0, 0}, w0 in {0.5 nm, WCF}
INIT_HRS = (DEFAULT.L0, 0.5e-9)	# (x0 [m], w0 [m]) before SET
INIT_LRS = (0.0, DEFAULT.WCF)	# (x0 [m], w0 [m]) before RESET


# ---------------------------------------------------------- conduction (6)(7)
def cf_area(w):
	"""CF cross-section [m^2]. w is the CF *diameter* (manual 'CF width'), A = pi*w^2/4 (A1)."""
	return math.pi * w * w / 4.0


def cf_width_from_area(A):
	"""Inverse of cf_area: w = sqrt(4A/pi) [m]."""
	return math.sqrt(4.0 * A / math.pi)


def hop_current(v_gap, x, w, p):
	"""Eq. (6): I_hop = I0 * A * exp(-g/gT) * sinh(V_gap/VT) [A]."""
	return p.I0 * cf_area(w) * math.exp(-x / p.gT) * math.sinh(min(v_gap / p.VT, 700.0))


def cf_resistance(x, w, p):
	"""Eq. (7): R_CF = rho*(L0 - g)/A [ohm]."""
	return p.rho * max(p.L0 - x, 0.0) / cf_area(w)


def filament_current(v, x, w, p):
	"""Current through one filament = CF (ohmic) in series with gap (hopping) (A2).

	Solves I_hop(V_gap) = (V - V_gap)/R_CF for V_gap with brentq.
	Returns (I [A], V_gap [V]). Odd in v.
	"""
	if v == 0.0:
		return 0.0, 0.0
	s = 1.0 if v > 0 else -1.0
	va = abs(v)
	r_cf = cf_resistance(x, w, p)
	if r_cf <= 0.0:
		return s * hop_current(va, x, w, p), v
	g = lambda vg: hop_current(vg, x, w, p) - (va - vg) / r_cf
	vg = brentq(g, 0.0, va, xtol=1e-15, rtol=1e-12)
	return s * (va - vg) / r_cf, s * vg


def cell_current(v_sw, x, w, p):
	"""Current through the switching node: N filaments in parallel + RH leakage [A]."""
	i_f, _ = filament_current(v_sw, x, w, p)
	return p.N * i_f + v_sw / p.RH


def solve_vsw(v_app, x, w, p, Rs):
	"""Solve v_app = V_sw + I_cell(V_sw)*(RL + Rs) for the switching-node voltage V_sw [V]."""
	if v_app == 0.0:
		return 0.0
	r_ser = p.RL + Rs
	g = lambda vs: vs + cell_current(vs, x, w, p) * r_ser - v_app
	lo, hi = (0.0, v_app) if v_app > 0 else (v_app, 0.0)
	return brentq(g, lo, hi, xtol=1e-15, rtol=1e-12)


def temperature(i_f, v, p):
	"""Eq. (5): T = T0 + I*V*Rth, per filament (A6) [K]."""
	return p.T0 + abs(i_f * v) * p.Rth


# ---------------------------------------------------------- dynamics (1)-(4)
W_MIN = 0.1e-9	# numerical floor on CF width [m] (A8)
EPS_X = 2.5e-12	# soft-wall / two-step blending length, 0.01*a [m] (A7, A8)


def _ramp(z):
	"""Clip z to [0, 1]."""
	return min(max(z, 0.0), 1.0)


def _exp(z):
	"""exp with the argument capped to avoid overflow on far-off integrator trial points."""
	return math.exp(min(z, 700.0))


def rate_set_gap(v, T, p):
	"""Eq. (1): dg/dt magnitude during SET [m/s]."""
	E = abs(v) / p.L0	# field, A5
	return p.a * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_set_width(v, w, T, p):
	"""Eq. (2): dr/dt during SET, r = w/2 [m/s]."""
	E = abs(v) / p.L0
	r = max(w / 2.0, 1e-12)
	pref = p.dr + p.dr * p.dr / (2.0 * r)
	return pref * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_reset_gap(v, T, p):
	"""Eqs. (3),(4): dg/dt during RESET = slower of O2- release and recombination [m/s]."""
	va = abs(v)
	E = va / p.L0
	kT = K_B * T
	r3 = p.a * p.f * _exp(-(p.Ei - p.gamma * p.Z * Q_E * va) / kT)
	r4 = p.a * p.f * _exp(-p.Eh / kT) * math.sinh(min(p.alpha_h * p.Z * Q_E * E / kT, 700.0))
	return min(r3, r4)


def state_rates(v_sw, x, w, p, chi_g=0.0, chi_r=0.0):
	"""Return (dx/dt, dw/dt, T, I_filament).

	SET (V>0): two-step process (A7): gap closes first, then CF grows laterally.
	RESET (V<0): gap grows, width unchanged (paper has no width equation for RESET).
	chi_g, chi_r: noise samples for eqs. (8),(9); zero in the standard model.
	"""
	# Newton iterates of the integrator may leave the box; evaluate physics on the clipped state
	xc = min(max(x, 0.0), p.L0)
	wc = min(max(w, W_MIN), p.WCF)
	i_f, _ = filament_current(v_sw, xc, wc, p)
	T = temperature(i_f, v_sw, p)
	dx = 0.0
	dw = 0.0
	if v_sw > 0.0:
		# two-step SET (A7): lateral growth switches on as the gap closes, blended over EPS_X
		s_gap = _ramp(x / EPS_X)
		dx = -rate_set_gap(v_sw, T, p)
		dw = 2.0 * rate_set_width(v_sw, wc, T, p) * (1.0 - s_gap)
	elif v_sw < 0.0:
		dx = rate_reset_gap(v_sw, T, p)
	# eqs. (8),(9): additive noise on the rates
	dx += p.deltaGap * chi_g
	dw += 2.0 * p.deltaCF * chi_r
	# soft walls keep x in [0, L0] and w in [W_MIN, WCF] with a continuous RHS (A8)
	if dx < 0.0:
		dx *= _ramp(x / EPS_X)
	else:
		dx *= _ramp((p.L0 - x) / EPS_X)
	if dw < 0.0:
		dw *= _ramp((w - W_MIN) / EPS_X)
	else:
		dw *= _ramp((p.WCF - w) / EPS_X)
	return dx, dw, T, i_f




# ---------------------------------------------------------------- waveforms
def sweep_waveform(v_set=2.5, v_reset=-2.5, t_ramp=100e-6):
	"""Triangular 0 -> v_set -> 0 -> v_reset -> 0, each leg t_ramp [s]. Returns (v(t), t_end, corners)."""
	corners_t = np.array([0.0, 1, 2, 3, 4]) * t_ramp
	corners_v = np.array([0.0, v_set, 0.0, v_reset, 0.0])
	return (lambda t: float(np.interp(t, corners_t, corners_v))), corners_t[-1], corners_t


def pulse_waveform(v_pulse=2.0, t_edge=10e-9, t_width=80e-9, t_total=100e-9):
	"""Trapezoidal pulse as in the manual's AC decks (delay 0, rise=fall=t_edge, flat t_width)."""
	corners_t = np.array([0.0, t_edge, t_edge + t_width, 2 * t_edge + t_width, max(t_total, 2 * t_edge + t_width)])
	corners_v = np.array([0.0, v_pulse, v_pulse, 0.0, 0.0])
	return (lambda t: float(np.interp(t, corners_t, corners_v))), corners_t[-1], corners_t


# ---------------------------------------------------------------- simulator
@dataclass
class Result:
	t: np.ndarray	# time [s]
	v_app: np.ndarray	# applied voltage [V]
	v_sw: np.ndarray	# switching-node voltage [V]
	i: np.ndarray	# terminal current [A]
	x: np.ndarray	# gap length [m]
	w: np.ndarray	# CF width [m]
	T: np.ndarray	# filament temperature [K]
	info: dict = field(default_factory=dict)

	def table(self):
		return np.column_stack([self.t, self.v_app, self.v_sw, self.i, self.x, self.w, self.T])


CSV_HEADER = "t_s,v_app_V,v_sw_V,i_A,x_m,w_m,T_K"


def series_r(v_app, Rs, Rs_reset):
	"""Series compliance resistance: Rs while v_app >= 0 (SET), Rs_reset while v_app < 0 (A14) [ohm]."""
	return Rs if v_app >= 0.0 else Rs_reset


def simulate(v_func, t_end, x0, w0, p=DEFAULT, Rs=0.0, Rs_reset=0.0, include_cp=False,
		n_out=2001, max_step=None, rtol=1e-6, noise_dt=None, rng=None, corners=None):
	"""Integrate the state equations with BDF.

	include_cp=False: CP neglected, V_sw solved algebraically each RHS call (A11).
	include_cp=True : V_sw becomes a state, CP*dV_sw/dt = (v_app - V_sw)/(RL+Rs) - I_cell.
	corners: waveform breakpoints [s]; integration restarts there.
	noise_dt: hold time of the piecewise-constant chi(t) for eqs. (8),(9) (A12). None -> no noise.
	"""
	if max_step is None:
		max_step = t_end / 2000
	# Breakpoints where the RHS is discontinuous: waveform corners and noise updates.
	# The integrator is restarted at each one so BDF never steps across a jump.
	bps = [0.0, t_end]
	if corners is not None:
		bps.extend(float(c) for c in corners if 0.0 < c < t_end)
	chi = None
	if noise_dt is not None:
		rng = rng if rng is not None else np.random.default_rng()
		n_chi = int(math.ceil(t_end / noise_dt))
		chi = rng.standard_normal((n_chi, 2))
		bps.extend(k * noise_dt for k in range(1, n_chi))
	bps = np.unique(np.array(bps))
	cur = [0.0, 0.0]	# current noise sample (chi_g, chi_r), constant inside a segment

	if include_cp:
		def rhs(t, y):
			x, w, vs = y
			dx, dw, _, i_f = state_rates(vs, x, w, p, cur[0], cur[1])
			i_cell = p.N * i_f + vs / p.RH
			va = v_func(t)
			dv = ((va - vs) / (p.RL + series_r(va, Rs, Rs_reset)) - i_cell) / p.CP
			return [dx, dw, dv]
		y = np.array([x0, w0, 0.0])
		atol = [1e-14, 1e-14, 1e-7]
	else:
		def rhs(t, y):
			x, w = y
			va = v_func(t)
			vs = solve_vsw(va, x, w, p, series_r(va, Rs, Rs_reset))
			dx, dw, _, _ = state_rates(vs, x, w, p, cur[0], cur[1])
			return [dx, dw]
		y = np.array([x0, w0])
		atol = [1e-14, 1e-14]

	t_eval = np.unique(np.concatenate([np.linspace(0.0, t_end, n_out), bps]))
	ts = [np.array([0.0])]
	ys = [y[:, None]]
	nfev = 0
	for k in range(len(bps) - 1):
		t_a, t_b = bps[k], bps[k + 1]
		if chi is not None:
			cur[0], cur[1] = chi[min(int((t_a + t_b) / 2 / noise_dt), len(chi) - 1)]
		te = t_eval[(t_eval > t_a) & (t_eval <= t_b)]
		sol = solve_ivp(rhs, (t_a, t_b), y, method="BDF", t_eval=te,
				max_step=max_step, rtol=rtol, atol=atol)
		if not sol.success:
			raise RuntimeError(f"solve_ivp failed on [{t_a:.3e}, {t_b:.3e}] s: {sol.message}")
		nfev += sol.nfev
		y = sol.y[:, -1].copy()
		y[0] = min(max(y[0], 0.0), p.L0)
		y[1] = min(max(y[1], W_MIN), p.WCF)
		ts.append(sol.t)
		ys.append(sol.y)
	t_all = np.concatenate(ts)
	y_all = np.concatenate(ys, axis=1)

	n = t_all.size
	v_app = np.array([v_func(t) for t in t_all])
	x = np.clip(y_all[0], 0.0, p.L0)
	w = np.clip(y_all[1], W_MIN, p.WCF)
	v_sw = np.empty(n)
	i = np.empty(n)
	T = np.empty(n)
	for k in range(n):
		if include_cp:
			vs = y_all[2][k]
		else:
			vs = solve_vsw(v_app[k], x[k], w[k], p, series_r(v_app[k], Rs, Rs_reset))
		i_f, _ = filament_current(vs, x[k], w[k], p)
		v_sw[k] = vs
		T[k] = temperature(i_f, vs, p)
		if include_cp:
			i[k] = (v_app[k] - vs) / (p.RL + series_r(v_app[k], Rs, Rs_reset))	# terminal current includes CP charging
		else:
			i[k] = p.N * i_f + vs / p.RH
	return Result(t_all, v_app, v_sw, i, x, w, T, {"nfev": nfev, "N": p.N})


# ---------------------------------------------------------- read / fixed state
def read_resistance(x, w, p=DEFAULT, v_read=0.2):
	"""Cell resistance at v_read with RL, no switching [ohm]."""
	v_sw = solve_vsw(v_read, x, w, p, 0.0)
	return v_read / cell_current(v_sw, x, w, p)


def iv_fixed_state(v, x, A_cf, p=DEFAULT, Rs=0.0):
	"""Fixed-state mode: static I-V for user-given gap x [m] and CF area A_cf [m^2]. No switching."""
	w = cf_width_from_area(A_cf)
	out = np.empty(len(v))
	for k, vk in enumerate(v):
		vs = solve_vsw(float(vk), x, w, p, Rs)
		out[k] = cell_current(vs, x, w, p)
	return out


# ---------------------------------------------------------- variability (10)(11)
@dataclass(frozen=True)
class Variability:
	sigma_Ea: float = 0.02 * EV	# cycle-to-cycle std of Ea [J] (A13)
	sigma_Ei: float = 0.02 * EV	# cycle-to-cycle std of Ei [J] (A13)
	sigma_Eh: float = 0.02 * EV	# cycle-to-cycle std of Eh [J] (A13)


def sample_cycle_params(p, var, rng):
	"""Eqs. (10),(11): Monte-Carlo draw of energy barriers for one cycle."""
	return replace(p,
		Ea=p.Ea + var.sigma_Ea * rng.standard_normal(),
		Ei=p.Ei + var.sigma_Ei * rng.standard_normal(),
		Eh=p.Eh + var.sigma_Eh * rng.standard_normal())


def switching_voltage(res, p=DEFAULT):
	"""Diagnostic switching voltages of a sweep. Returns (V_set, V_reset) [V] or nan.

	V_set  : applied voltage where the gap first closes to below a (= one VO spacing).
	V_reset: applied voltage of the peak |I| on the negative branch (onset of gradual RESET).
	"""
	i = np.abs(res.i)
	pos = np.where((res.v_app > 0) & (res.x < p.a))[0]
	v_set = res.v_app[pos[0]] if pos.size else np.nan
	# RESET: voltage of max |I| in the negative branch (onset of gradual reset)
	neg = np.where(res.v_app < 0)[0]
	v_reset = res.v_app[neg[np.argmax(i[neg])]] if neg.size else np.nan
	return v_set, v_reset
