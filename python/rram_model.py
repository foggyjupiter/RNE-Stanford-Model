"""금속산화물 unipolar RRAM 전도성 필라멘트 모델 (독립 구현).

근거 자료
	[D] H. Li et al., "Variation-aware, reliability-emphasized design and optimization
	    of RRAM using SPICE model", DATE 2015, 식 (1)-(11)
	    → SET(갭 닫힘, 측면 성장), 호핑/옴 전도, 변동성
	[R] U. Russo et al., "Self-accelerated thermal dissolution model for reset programming
	    in unipolar RRAM devices", IEEE TED 56(2), 193-200, 2009 (DOI 10.1109/TED.2008.2010584)
	    → RESET: 열 용해 식 (5), 저항의 온도 의존 식 (4), 열 방정식 식 (2), Table I
	[C] U. Russo et al., "Filament conduction and reset mechanism in NiO-based RRAM devices",
	    IEEE TED 56(2), 186-192, 2009 (DOI 10.1109/TED.2008.2010583)
	    → 1차원 열 근사 식 (2),(3), 등가 열저항 식 (6)
	[M] PKU-Stanford RRAM v2.0Beta Quick User Guide, Table 3 → 파라미터 이름과 기본값

unipolar: SET과 RESET을 같은 극성에서 한다. 어느 쪽 식을 쓸지는 전압 부호가 아니라
동작(SET = compliance 있음, RESET = compliance 없음)으로 정한다 (A25).

필라멘트는 길이 방향으로 n칸(칸 길이 ≈ a)으로 나누고 칸마다 폭 w_i를 둔다. 온도는 칸마다
정상 상태 1차원 열 방정식으로 구한다 (시간 적분 없음). RESET에서는 가장 뜨거운 칸이 먼저
가늘어지고, 거기에 전류가 몰려 더 뜨거워지는 자기 가속이 계산 결과로 나온다 [R].

자료에 없는 내용은 ASSUMPTIONS.md (A1, A2, ...)에 정리했다. 내부 계산은 모두 SI 단위.
"""

import math
from dataclasses import dataclass, replace, field

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq


# ---------------------------------------------------------------- 물리 상수
Q_E = 1.602176634e-19	# 기본 전하량 [C]
K_B = 1.380649e-23	# 볼츠만 상수 [J/K]
EV = Q_E	# 1 eV [J]


# --------------------------------------------------------------- 파라미터
@dataclass(frozen=True)
class Params:
	# 매뉴얼 Table 3 (기본값, SI 단위)
	I0: float = 1e13	# 호핑 전류 밀도 [A/m^2]
	rho: float = 19.64e-6	# T0에서의 CF 비저항 [ohm*m] (19.64 uOhm*m)
	a: float = 0.25e-9	# VO 사이 거리 [m]
	f: float = 1e13	# VO 진동 주파수 [Hz]
	Ea: float = 0.7 * EV	# VO 평균 활성화 에너지 (SET) [J]
	alpha_a: float = 0.75e-9	# 에너지 증강 계수, VO 생성 [m]
	Z: float = 1.0	# 전하수 [-]
	Rth: float = 5e5	# 유효 열저항 [K/W]
	RH: float = 200e6	# 산화막 기생 저항 [ohm]
	RL: float = 20.0	# 전극 접촉 저항 [ohm]
	CP: float = 20e-15	# 전극 기생 정전용량 [F]
	L0: float = 3e-9	# 스위칭층 두께 [m]
	WCF: float = 5e-9	# 스위칭층 폭 (CF 폭 최댓값) [m]
	VT: float = 0.4	# 호핑 특성 전압 [V]
	T0: float = 300.0	# 주변 온도 [K]
	deltaGap: float = 4e-5	# 갭 변동 속도, [D] 식 (8)의 delta_g [m/s]
	deltaCF: float = 1e-4	# CF 폭 변동 속도, [D] 식 (9)의 delta_r [m/s]
	# Russo [R] Table I (unipolar RESET)
	Ed: float = 1.2 * EV	# 열 용해 활성화 에너지, [R] 식 (5)의 Ea [J]
	vD0: float = 200.0	# 용해 속도 전인자, [R] 식 (5) [m/s] ([R]에서도 피팅값)
	alpha_T: float = 1.7e-3	# CF 비저항 온도 계수, [R] 식 (4) [1/K]
	# Table 3에 없음 -- 가정
	gT: float = 0.25e-9	# [D] 식 (6)의 호핑 감쇠 길이 [m], 피팅값 (A3)
	dr: float = 0.25e-9	# [D] 식 (2)의 측면 성장 단위 Delta_r [m] (A4)
	# 교수님 요청: 필라멘트 밀도와 셀 면적 (A10)
	n_f: float = 1e16	# 단위면적당 필라멘트 수 [1/m^2]
	A_cell: float = 100e-18	# 셀 면적 [m^2] (10 nm x 10 nm)

	@property
	def N(self):
		"""병렬로 놓인 동일 필라멘트 수, round(n_f*A_cell) >= 1 (A10)."""
		return max(1, int(round(self.n_f * self.A_cell)))

	@property
	def n_cells(self):
		"""필라멘트 길이 방향 칸 수: 칸 길이가 VO 간격 a에 가장 가깝게, 최소 3칸 (A26)."""
		return max(3, int(round(self.L0 / self.a)))


DEFAULT = Params()

RS_SWEEP = 18e3	# I-V 스윕 SET 동작의 compliance 저항 기본값 [ohm] (A15)
RS_PULSE = 10e3	# 펄스 SET 동작의 compliance 저항 기본값 [ohm] (A15)

W_MIN = 0.1e-9	# CF 폭 하한 [m]. 이 폭까지 녹은 칸 = 끊어진 필라멘트 (A8, A27)
EPS_X = 2.5e-12	# 부드러운 벽 / 2단계 전환 혼합 길이, 0.01*a [m] (A7, A8)

# 초기 상태, 매뉴얼 Table 3: x0 ∈ {L0, 0}, w0 ∈ {0.5 nm, WCF}. 모든 칸이 같은 폭에서 시작
INIT_HRS = (DEFAULT.L0, 0.5e-9)	# 포밍 전 (x0 [m], w0 [m])
INIT_LRS = (0.0, DEFAULT.WCF)	# RESET 전 (x0 [m], w0 [m])


# ---------------------------------------------------------- 공용
def _ramp(z):
	"""z를 [0, 1]로 자른다."""
	return min(max(z, 0.0), 1.0)


def _exp(z):
	"""적분기 시도점이 멀리 튈 때 오버플로를 막도록 인자에 상한을 둔 exp."""
	return math.exp(min(z, 700.0))


def cf_area(w):
	"""CF 단면적 [m^2]. w는 CF *지름* (매뉴얼의 'CF width'), A = pi*w^2/4 (A1)."""
	return math.pi * w * w / 4.0


def cf_width_from_area(A):
	"""cf_area의 역함수: w = sqrt(4A/pi) [m]."""
	return math.sqrt(4.0 * A / math.pi)


# ---------------------------------------------------------- 전도 + 열 (한 필라멘트)
def hop_prefactor(x, w_tip, p):
	"""[D] 식 (6)의 전인자 I0*A*exp(-x/gT) [A]. 갭에 닿은 끝 칸의 폭 w_tip을 쓴다 (A28)."""
	return p.I0 * cf_area(w_tip) * math.exp(-x / p.gT)


def gap_voltage(i, x, w_tip, p):
	"""[D] 식 (6)의 역함수: 전류 i가 흐를 때 갭 양단 전압 V_gap = VT*asinh(i/pre) [V]."""
	return p.VT * math.asinh(i / hop_prefactor(x, w_tip, p))


@dataclass
class Filament:
	v: float	# 필라멘트 양단 전압 (갭 + CF) [V]
	i: float	# 필라멘트 전류 [A]
	r_cf: float	# CF 저항 (온도 반영) [ohm]
	t_cells: np.ndarray	# 칸별 온도 [K]
	t_set: float	# SET 식용 온도, [D] 식 (5): T0 + P*Rth [K]


def thermal_solve(i, x, ws, p):
	"""전류 i일 때 CF 칸들의 온도 분포와 CF 저항.

	[R] 식 (2)(4), [C] 식 (2): -K d^2 theta/dz^2 = I^2 rho0 [1 + alpha_T theta] / A(z), theta = T - T0.
	양 끝(전극)은 theta = 0 [R]. K = kappa_eq*A = L_CF / (8 Rth): 균일한 필라멘트에서 최고 온도가
	T0 + P*Rth가 되도록 [C] 식 (6)에서 정한 등가 열 컨덕턴스. 폭과 무관한 상수로 둔다 (A29).
	격자: 노드 0..n (끝 노드 고정), 칸 k는 노드 k와 k+1 사이. 칸 온도 = 두 노드 평균.
	열폭주로 해가 없으면 None.
	"""
	n = len(ws)
	L = p.L0 - x
	if L <= 1e-15:
		return np.zeros(n), 0.0
	h = L / n
	K = L / (8.0 * p.Rth)	# [W*m/K]
	areas = np.array([cf_area(w) for w in ws])
	c = i * i * p.rho / areas	# 칸별 단위 길이당 기준 발열 [W/m]
	a = p.alpha_T
	if n == 1:
		theta = np.zeros(2)
	else:
		m = n - 1	# 내부 노드 수
		kh = K / (h * h)
		lower = np.empty(m)
		diag = np.empty(m)
		upper = np.empty(m)
		rhs = np.empty(m)
		for j in range(1, n):
			cl = c[j - 1]
			cr = c[j]
			diag[j - 1] = 2.0 * kh - a * (cl + cr) / 4.0
			lower[j - 1] = -kh - a * cl / 4.0
			upper[j - 1] = -kh - a * cr / 4.0
			rhs[j - 1] = (cl + cr) / 2.0
		# Thomas 알고리즘
		for j in range(1, m):
			if diag[j - 1] == 0.0:
				return None
			f = lower[j] / diag[j - 1]
			diag[j] -= f * upper[j - 1]
			rhs[j] -= f * rhs[j - 1]
		inner = np.empty(m)
		if diag[m - 1] == 0.0:
			return None
		inner[m - 1] = rhs[m - 1] / diag[m - 1]
		for j in range(m - 2, -1, -1):
			inner[j] = (rhs[j] - upper[j] * inner[j + 1]) / diag[j]
		if not np.all(np.isfinite(inner)) or np.any(inner < 0.0):
			return None	# 열폭주 (전류가 너무 큼)
		theta = np.concatenate([[0.0], inner, [0.0]])
	t_cells = 0.5 * (theta[:-1] + theta[1:])
	r_cf = float(np.sum(p.rho * (1.0 + a * t_cells) * h / areas))
	return t_cells, r_cf


def filament_at_current(i, x, ws, p):
	"""전류 i (>= 0)에서 필라멘트 전압과 온도. 열폭주면 None."""
	sol = thermal_solve(i, x, ws, p)
	if sol is None:
		return None
	t_cells, r_cf = sol
	v = gap_voltage(i, x, ws[-1], p) + i * r_cf
	return Filament(v, i, r_cf, p.T0 + t_cells, p.T0 + i * v * p.Rth)


def _current_upper(v, x, ws, p, r_series):
	"""전류 상한: 직렬 저항만 있을 때, 갭만 있을 때, 차가운 CF만 있을 때 중 가장 작은 값."""
	bounds = []
	if r_series > 0.0:
		bounds.append(v / r_series)
	bounds.append(hop_prefactor(x, ws[-1], p) * math.sinh(min(v / p.VT, 700.0)))
	L = p.L0 - x
	if L > 1e-15:
		r_cold = sum(p.rho * (L / len(ws)) / cf_area(w) for w in ws)
		bounds.append(v / r_cold)
	return min(bounds)


def solve_filament(v_app, x, ws, p, r_series):
	"""v_app = V_sw + (N*I + V_sw/RH)*r_series, V_sw = V_f(I)를 I에 대해 푼다 (부호 대칭).

	r_series = RL + Rs (CP를 무시할 때) 또는 0 (V_sw를 직접 줄 때).
	(V_sw [V], Filament)를 반환. V_f(I)는 I에 대해 단조 증가 (alpha_T >= 0).
	"""
	s = 1.0 if v_app >= 0 else -1.0
	va = abs(v_app)
	if va == 0.0:
		t0 = np.full(len(ws), p.T0)
		return 0.0, Filament(0.0, 0.0, thermal_solve(0.0, x, ws, p)[1], t0, p.T0)
	big = 1e30

	def g(i):
		fil = filament_at_current(i, x, ws, p)
		if fil is None:
			return big
		return fil.v + (p.N * i + fil.v / p.RH) * r_series - va

	hi = _current_upper(va, x, ws, p, r_series)
	i = brentq(g, 0.0, hi, xtol=1e-18, rtol=1e-12)
	fil = filament_at_current(i, x, ws, p)
	fil.v *= s
	fil.i *= s
	return fil.v, fil


# ---------------------------------------------------------- 변화율
def rate_set_gap(v, T, p):
	"""[D] 식 (1): SET 중 dg/dt의 크기 [m/s]. 전계 E = |V|/L0 (A5)."""
	E = abs(v) / p.L0
	return p.a * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_set_width(v, w, T, p):
	"""[D] 식 (2): SET 중 dr/dt, r = w/2 [m/s]."""
	E = abs(v) / p.L0
	r = max(w / 2.0, 1e-12)
	pref = p.dr + p.dr * p.dr / (2.0 * r)
	return pref * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_dissolve(T, p):
	"""[R] 식 (5): 열 용해로 CF 경계가 축 쪽으로 움직이는 속도 v_D = vD0*exp(-Ed/kT) [m/s]."""
	return p.vD0 * _exp(-p.Ed / (K_B * T))


def state_rates(op, v_sw, x, ws, p, chi_g=0.0, chi_r=0.0, fil=None):
	"""(dx/dt, dw_i/dt 배열, Filament)를 반환.

	op = "set":   [D] 식 (1),(2) 성장 (2단계, A7) + [R] 식 (5) 용해
	op = "reset": [R] 식 (5) 용해만 (A25)
	용해는 칸마다 그 칸의 온도로 계산한다 [R]. 성장은 [D] 식 (5)의 온도를 쓴다.
	chi_g, chi_r: [D] 식 (8),(9)의 잡음 (모든 칸에 같은 chi_r).
	"""
	n = len(ws)
	xc = min(max(x, 0.0), p.L0)
	wc = np.clip(ws, W_MIN, p.WCF)
	if fil is None:
		_, fil = solve_filament(v_sw, xc, wc, p, 0.0)
	dw = np.empty(n)
	dx = 0.0
	for k in range(n):
		dw[k] = -2.0 * rate_dissolve(fil.t_cells[k], p)	# w는 지름이므로 2배
	if op == "set" and v_sw != 0.0:
		s_gap = _ramp(x / EPS_X)
		dx = -rate_set_gap(v_sw, fil.t_set, p)
		for k in range(n):
			dw[k] += 2.0 * rate_set_width(v_sw, wc[k], fil.t_set, p) * (1.0 - s_gap)
	# [D] 식 (8),(9): 변화율에 더해지는 잡음
	dx += p.deltaGap * chi_g
	dw += 2.0 * p.deltaCF * chi_r
	# 부드러운 벽으로 x를 [0, L0], w를 [W_MIN, WCF]에 가둔다 (A8)
	dx *= _ramp(x / EPS_X) if dx < 0.0 else _ramp((p.L0 - x) / EPS_X)
	for k in range(n):
		if dw[k] < 0.0:
			dw[k] *= _ramp((ws[k] - W_MIN) / EPS_X)
		else:
			dw[k] *= _ramp((p.WCF - ws[k]) / EPS_X)
	return dx, dw, fil


# ---------------------------------------------------------------- 파형
@dataclass
class Waveform:
	v: object	# v(t) [V]
	op: object	# op(t) -> "set" | "reset"
	t_end: float	# [s]
	corners: np.ndarray	# 꺾임점 [s]


def _interp(ts, vs):
	return lambda t: float(np.interp(t, ts, vs))


def sweep_waveform(v_set=2.5, v_reset=2.0, t_ramp=100e-6):
	"""unipolar 스윕: 0 -> v_set -> 0 (SET 동작) -> v_reset -> 0 (RESET 동작), 구간마다 t_ramp."""
	ts = np.array([0.0, 1, 2, 3, 4]) * t_ramp
	vs = np.array([0.0, v_set, 0.0, v_reset, 0.0])
	return Waveform(_interp(ts, vs), lambda t: "set" if t < 2 * t_ramp else "reset", ts[-1], ts)


def pulse_waveform(op, v_pulse=2.0, t_edge=10e-9, t_width=80e-9, t_total=None):
	"""사다리꼴 펄스 하나 (지연 0, 상승=하강=t_edge). op = "set" | "reset"."""
	t_tot = t_total if t_total is not None else t_width + 2 * t_edge
	ts = np.array([0.0, t_edge, t_edge + t_width, 2 * t_edge + t_width, max(t_tot, 2 * t_edge + t_width)])
	vs = np.array([0.0, v_pulse, v_pulse, 0.0, 0.0])
	return Waveform(_interp(ts, vs), lambda t: op, ts[-1], ts)


def series_r(op, Rs, Rs_reset):
	"""직렬 compliance 저항: SET 동작이면 Rs, RESET 동작이면 Rs_reset (A14) [ohm]."""
	return Rs if op == "set" else Rs_reset


# ---------------------------------------------------------------- 시뮬레이터
@dataclass
class Result:
	t: np.ndarray	# 시간 [s]
	v_app: np.ndarray	# 인가 전압 [V]
	v_sw: np.ndarray	# 스위칭 노드 전압 [V]
	i: np.ndarray	# 단자 전류 [A]
	x: np.ndarray	# 갭 길이 [m]
	w: np.ndarray	# 가장 가는 칸의 폭 (병목) [m]
	w_mean: np.ndarray	# 칸 폭 평균 [m]
	T: np.ndarray	# 가장 뜨거운 칸의 온도 [K]
	w_cells: np.ndarray	# 마지막 시점의 칸별 폭 [m]
	info: dict = field(default_factory=dict)

	def table(self):
		return np.column_stack([self.t, self.v_app, self.v_sw, self.i, self.x, self.w, self.w_mean, self.T])


CSV_HEADER = "t_s,v_app_V,v_sw_V,i_A,x_m,w_min_m,w_mean_m,T_max_K"


def simulate(wf, x0, w0, p=DEFAULT, Rs=0.0, Rs_reset=0.0, include_cp=False,
		n_out=2001, max_step=None, rtol=1e-6, noise_dt=None, rng=None):
	"""상태 방정식을 BDF로 적분한다. 상태 = [x, w_1..w_n] (+ V_sw).

	w0: 스칼라면 모든 칸이 같은 폭, 배열이면 칸별 폭.
	include_cp=False: CP 무시, 우변을 계산할 때마다 V_sw를 대수적으로 푼다 (A11).
	include_cp=True : V_sw가 상태 변수, CP*dV_sw/dt = (v_app - V_sw)/(RL+Rs) - I_cell.
	noise_dt: [D] 식 (8),(9)의 계단형 chi(t) 유지 시간 (A12). None이면 잡음 없음.
	"""
	n = p.n_cells
	ws0 = np.full(n, w0) if np.isscalar(w0) else np.asarray(w0, dtype=float)
	if len(ws0) != n:
		raise ValueError(f"w0 길이 {len(ws0)} != 칸 수 {n}")
	if max_step is None:
		max_step = wf.t_end / 2000
	bps = [0.0, wf.t_end] + [float(c) for c in wf.corners if 0.0 < c < wf.t_end]
	chi = None
	if noise_dt is not None:
		rng = rng if rng is not None else np.random.default_rng()
		n_chi = int(math.ceil(wf.t_end / noise_dt))
		chi = rng.standard_normal((n_chi, 2))
		bps.extend(k * noise_dt for k in range(1, n_chi))
	bps = np.unique(np.array(bps))
	cur = [0.0, 0.0]

	def r_ser(t):
		return p.RL + series_r(wf.op(t), Rs, Rs_reset)

	if include_cp:
		def rhs(t, y):
			vs = y[n + 1]
			op = wf.op(t)
			dx, dw, fil = state_rates(op, vs, y[0], y[1:n + 1], p, cur[0], cur[1])
			i_cell = p.N * fil.i + vs / p.RH
			dv = ((wf.v(t) - vs) / r_ser(t) - i_cell) / p.CP
			return np.concatenate([[dx], dw, [dv]])
		y = np.concatenate([[x0], ws0, [0.0]])
		atol = np.concatenate([[1e-14], np.full(n, 1e-14), [1e-7]])
	else:
		def rhs(t, y):
			xc = min(max(y[0], 0.0), p.L0)
			wc = np.clip(y[1:], W_MIN, p.WCF)
			_, fil = solve_filament(wf.v(t), xc, wc, p, r_ser(t))
			dx, dw, _ = state_rates(wf.op(t), fil.v, y[0], y[1:], p, cur[0], cur[1], fil=fil)
			return np.concatenate([[dx], dw])
		y = np.concatenate([[x0], ws0])
		atol = np.concatenate([[1e-14], np.full(n, 1e-14)])

	t_eval = np.unique(np.concatenate([np.linspace(0.0, wf.t_end, n_out), bps]))
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
		y[1:n + 1] = np.clip(y[1:n + 1], W_MIN, p.WCF)
		ts.append(sol.t)
		ys.append(sol.y)
	t_all = np.concatenate(ts)
	y_all = np.concatenate(ys, axis=1)

	m = t_all.size
	out = {k: np.empty(m) for k in ("v_app", "v_sw", "i", "x", "w", "w_mean", "T")}
	for k in range(m):
		t = t_all[k]
		va = wf.v(t)
		xk = min(max(y_all[0, k], 0.0), p.L0)
		wk = np.clip(y_all[1:n + 1, k], W_MIN, p.WCF)
		if include_cp:
			vs = y_all[n + 1, k]
			_, fil = solve_filament(vs, xk, wk, p, 0.0)
			ik = (va - vs) / r_ser(t)	# 단자 전류, CP 충전 전류 포함
		else:
			vs, fil = solve_filament(va, xk, wk, p, r_ser(t))
			ik = p.N * fil.i + vs / p.RH
		out["v_app"][k] = va
		out["v_sw"][k] = vs
		out["i"][k] = ik
		out["x"][k] = xk
		out["w"][k] = wk.min()
		out["w_mean"][k] = wk.mean()
		out["T"][k] = max(fil.t_cells.max(), fil.t_set) if p.L0 - xk > 1e-15 else fil.t_set
	w_last = np.clip(y_all[1:n + 1, -1], W_MIN, p.WCF)
	return Result(t_all, out["v_app"], out["v_sw"], out["i"], out["x"], out["w"], out["w_mean"], out["T"],
			w_last, {"nfev": nfev, "N": p.N, "n_cells": n})


# ---------------------------------------------------------- 읽기 / 고정 상태
def read_resistance(x, ws, p=DEFAULT, v_read=0.2):
	"""v_read에서의 셀 저항 (RL, RH 포함, 스위칭 없음) [ohm]. ws: 스칼라 또는 칸별 폭."""
	wv = np.full(p.n_cells, ws) if np.isscalar(ws) else np.asarray(ws, dtype=float)
	v_sw, fil = solve_filament(v_read, x, wv, p, p.RL)
	return v_read / (p.N * fil.i + v_sw / p.RH)


def iv_fixed_state(v, x, A_cf, p=DEFAULT, Rs=0.0):
	"""고정 상태 모드: 갭 x [m], 모든 칸이 같은 CF 면적 A_cf [m^2]일 때의 정적 I-V. 스위칭 없음."""
	wv = np.full(p.n_cells, cf_width_from_area(A_cf))
	out = np.empty(len(v))
	for k, vk in enumerate(v):
		vs, fil = solve_filament(float(vk), x, wv, p, p.RL + Rs)
		out[k] = p.N * fil.i + vs / p.RH
	return out


# ---------------------------------------------------------- 변동성 [D] (10)(11)
@dataclass(frozen=True)
class Variability:
	sigma_Ea: float = 0.02 * EV	# 사이클 간 Ea(SET) 표준편차 [J] (A13)
	sigma_Ed: float = 0.02 * EV	# 사이클 간 Ed(RESET) 표준편차 [J] (A13)


def sample_cycle_params(p, var, rng):
	"""[D] 식 (10),(11): 한 사이클의 SET/RESET 에너지 장벽을 몬테카를로로 뽑는다.

	[D]의 (11)은 bipolar RESET 장벽(Ei, Eh)에 대한 것이다. unipolar에서는 RESET 장벽이 Ed이므로
	같은 방식으로 Ed에 적용한다 (A13).
	"""
	return replace(p,
		Ea=p.Ea + var.sigma_Ea * rng.standard_normal(),
		Ed=p.Ed + var.sigma_Ed * rng.standard_normal())


def switching_voltage(res, p=DEFAULT):
	"""스윕의 스위칭 전압 (진단용). (V_set, V_reset) [V] 또는 nan을 반환.

	V_set  : SET 구간에서 R(=V/I)이 처음으로 시작값의 1/10 아래로 떨어지는 인가 전압.
	V_reset: RESET 구간에서 |I|가 최대인 인가 전압 (그 뒤 전류가 무너지는 지점).
	"""
	n = len(res.t)
	half = res.t[-1] / 2
	i = np.abs(res.i)
	set_idx = np.where((res.t <= half) & (res.v_app > 0.05))[0]
	v_set = np.nan
	if set_idx.size:
		r = res.v_app[set_idx] / np.maximum(i[set_idx], 1e-30)
		hit = np.where(r < r[0] / 10)[0]
		if hit.size:
			v_set = res.v_app[set_idx[hit[0]]]
	reset_idx = np.where(res.t > half)[0]
	v_reset = res.v_app[reset_idx[np.argmax(i[reset_idx])]] if reset_idx.size else np.nan
	return v_set, v_reset
