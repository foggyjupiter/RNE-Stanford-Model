"""금속산화물 bipolar RRAM 전도성 필라멘트 모델 (독립 구현).

지배 방정식은 공개 논문
	H. Li et al., "Variation-aware, reliability-emphasized design and optimization
	of RRAM using SPICE model", DATE 2015, 식 (1)-(11)
에서, 파라미터 이름과 기본값은 PKU-Stanford RRAM v2.0Beta Quick User Guide
Table 3에서 가져왔다. 두 자료에 없는 내용은 ASSUMPTIONS.md에 (A1, A2, ... 표시로)
정리했고 아래 주석에서 그 번호를 참조한다.

내부 계산은 모두 SI 단위.
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
	rho: float = 19.64e-6	# CF 비저항 [ohm*m] (19.64 uOhm*m)
	a: float = 0.25e-9	# VO 사이 거리 [m]
	f: float = 1e13	# VO 진동 주파수 [Hz]
	Ea: float = 0.7 * EV	# VO 평균 활성화 에너지 [J]
	Eh: float = 1.12 * EV	# O2- 호핑 장벽 [J]
	Ei: float = 0.82 * EV	# 전극/산화막 계면 장벽 [J]
	alpha_a: float = 0.75e-9	# 에너지 증강 계수, VO 생성 [m]
	alpha_h: float = 0.75e-9	# 에너지 증강 계수, O2- 호핑 [m]
	gamma: float = 1.5	# 전압 증강 계수 [-]
	Z: float = 1.0	# 전하수 [-]
	Rth: float = 5e5	# 유효 열저항 [K/W]
	RH: float = 200e6	# 산화막 기생 저항 [ohm]
	RL: float = 20.0	# 전극 접촉 저항 [ohm]
	CP: float = 20e-15	# 전극 기생 정전용량 [F]
	L0: float = 3e-9	# 스위칭층 두께 [m]
	WCF: float = 5e-9	# 스위칭층 폭 (CF 폭 최댓값) [m]
	Weff: float = 0.5e-9	# 유효 폭 [m] (사용 안 함, A9)
	VT: float = 0.4	# 호핑 특성 전압 [V]
	T0: float = 300.0	# 주변 온도 [K]
	deltaGap: float = 4e-5	# 갭 변동 속도, 식 (8)의 delta_g [m/s]
	deltaCF: float = 1e-4	# CF 폭 변동 속도, 식 (9)의 delta_r [m/s]
	crit_x: float = 0.5e-9	# 갭 변동 피팅점 [m] (사용 안 함, A9)
	# Table 3에 없음 -- 가정
	gT: float = 0.25e-9	# 식 (6)의 호핑 감쇠 길이 [m], 피팅값 (A3)
	dr: float = 0.25e-9	# 식 (2)의 측면 성장 단위 Delta_r [m] (A4)
	# 교수님 요청: 필라멘트 밀도와 셀 면적 (A10)
	n_f: float = 1e16	# 단위면적당 필라멘트 수 [1/m^2]
	A_cell: float = 100e-18	# 셀 면적 [m^2] (10 nm x 10 nm)

	@property
	def N(self):
		"""병렬로 놓인 동일 필라멘트 수, round(n_f*A_cell) >= 1 (A10)."""
		return max(1, int(round(self.n_f * self.A_cell)))


DEFAULT = Params()

RS_SWEEP = 18e3	# I-V 스윕용 SET compliance 저항 기본값 [ohm], 2.5 V에서 약 100 uA (A15)
RS_PULSE = 10e3	# 펄스용 SET compliance 저항 기본값 [ohm], 2 V에서 약 100 uA (A15)

# 초기 상태, 매뉴얼 Table 3: x0 ∈ {L0, 0}, w0 ∈ {0.5 nm, WCF}
INIT_HRS = (DEFAULT.L0, 0.5e-9)	# SET 전 (x0 [m], w0 [m])
INIT_LRS = (0.0, DEFAULT.WCF)	# RESET 전 (x0 [m], w0 [m])


# ---------------------------------------------------------- 전도 (6)(7)
def cf_area(w):
	"""CF 단면적 [m^2]. w는 CF *지름* (매뉴얼의 'CF width'), A = pi*w^2/4 (A1)."""
	return math.pi * w * w / 4.0


def cf_width_from_area(A):
	"""cf_area의 역함수: w = sqrt(4A/pi) [m]."""
	return math.sqrt(4.0 * A / math.pi)


def hop_current(v_gap, x, w, p):
	"""식 (6): I_hop = I0 * A * exp(-g/gT) * sinh(V_gap/VT) [A]."""
	return p.I0 * cf_area(w) * math.exp(-x / p.gT) * math.sinh(min(v_gap / p.VT, 700.0))


def cf_resistance(x, w, p):
	"""식 (7): R_CF = rho*(L0 - g)/A [ohm]."""
	return p.rho * max(p.L0 - x, 0.0) / cf_area(w)


def filament_current(v, x, w, p):
	"""필라멘트 1개의 전류 = CF(옴 전도)와 갭(호핑 전도)의 직렬 연결 (A2).

	I_hop(V_gap) = (V - V_gap)/R_CF 를 brentq로 풀어 V_gap을 구한다.
	(I [A], V_gap [V])를 반환. v에 대해 홀함수.
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
	"""스위칭 노드로 흐르는 전류: 병렬 필라멘트 N개 + RH 누설 [A]."""
	i_f, _ = filament_current(v_sw, x, w, p)
	return p.N * i_f + v_sw / p.RH


def solve_vsw(v_app, x, w, p, Rs):
	"""v_app = V_sw + I_cell(V_sw)*(RL + Rs) 를 풀어 스위칭 노드 전압 V_sw를 구한다 [V]."""
	if v_app == 0.0:
		return 0.0
	r_ser = p.RL + Rs
	g = lambda vs: vs + cell_current(vs, x, w, p) * r_ser - v_app
	lo, hi = (0.0, v_app) if v_app > 0 else (v_app, 0.0)
	return brentq(g, lo, hi, xtol=1e-15, rtol=1e-12)


def temperature(i_f, v, p):
	"""식 (5): T = T0 + I*V*Rth, 필라멘트별 (A6) [K]."""
	return p.T0 + abs(i_f * v) * p.Rth


# ---------------------------------------------------------- 동역학 (1)-(4)
W_MIN = 0.1e-9	# CF 폭의 수치적 하한 [m] (A8)
EPS_X = 2.5e-12	# 부드러운 벽 / 2단계 전환 혼합 길이, 0.01*a [m] (A7, A8)


def _ramp(z):
	"""z를 [0, 1]로 자른다."""
	return min(max(z, 0.0), 1.0)


def _exp(z):
	"""적분기 시도점이 멀리 튈 때 오버플로를 막도록 인자에 상한을 둔 exp."""
	return math.exp(min(z, 700.0))


def rate_set_gap(v, T, p):
	"""식 (1): SET 중 dg/dt의 크기 [m/s]."""
	E = abs(v) / p.L0	# 전계 [V/m], A5
	return p.a * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_set_width(v, w, T, p):
	"""식 (2): SET 중 dr/dt, r = w/2 [m/s]."""
	E = abs(v) / p.L0
	r = max(w / 2.0, 1e-12)
	pref = p.dr + p.dr * p.dr / (2.0 * r)
	return pref * p.f * _exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def rate_reset_gap(v, T, p):
	"""식 (3),(4): RESET 중 dg/dt = O2- 방출과 재결합 중 느린 쪽 [m/s]."""
	va = abs(v)
	E = va / p.L0
	kT = K_B * T
	r3 = p.a * p.f * _exp(-(p.Ei - p.gamma * p.Z * Q_E * va) / kT)
	r4 = p.a * p.f * _exp(-p.Eh / kT) * math.sinh(min(p.alpha_h * p.Z * Q_E * E / kT, 700.0))
	return min(r3, r4)


def state_rates(v_sw, x, w, p, chi_g=0.0, chi_r=0.0):
	"""(dx/dt, dw/dt, T, I_filament)를 반환.

	SET (V>0): 2단계 과정 (A7): 먼저 갭이 닫히고, 그다음 CF가 옆으로 자란다.
	RESET (V<0): 갭이 커지고 폭은 그대로 (논문에 RESET 중 폭 변화식이 없음).
	chi_g, chi_r: 식 (8),(9)의 잡음 표본. 표준 모델에서는 0.
	"""
	# 적분기의 뉴턴 반복점은 범위를 벗어날 수 있으므로 물리량은 잘라낸 상태로 계산
	xc = min(max(x, 0.0), p.L0)
	wc = min(max(w, W_MIN), p.WCF)
	i_f, _ = filament_current(v_sw, xc, wc, p)
	T = temperature(i_f, v_sw, p)
	dx = 0.0
	dw = 0.0
	if v_sw > 0.0:
		# 2단계 SET (A7): 갭이 닫히면 측면 성장이 켜짐, EPS_X 폭에서 혼합
		s_gap = _ramp(x / EPS_X)
		dx = -rate_set_gap(v_sw, T, p)
		dw = 2.0 * rate_set_width(v_sw, wc, T, p) * (1.0 - s_gap)
	elif v_sw < 0.0:
		dx = rate_reset_gap(v_sw, T, p)
	# 식 (8),(9): 변화율에 더해지는 잡음
	dx += p.deltaGap * chi_g
	dw += 2.0 * p.deltaCF * chi_r
	# 부드러운 벽으로 x를 [0, L0], w를 [W_MIN, WCF]에 가둠, 우변은 연속 (A8)
	if dx < 0.0:
		dx *= _ramp(x / EPS_X)
	else:
		dx *= _ramp((p.L0 - x) / EPS_X)
	if dw < 0.0:
		dw *= _ramp((w - W_MIN) / EPS_X)
	else:
		dw *= _ramp((p.WCF - w) / EPS_X)
	return dx, dw, T, i_f




# ---------------------------------------------------------------- 파형
def sweep_waveform(v_set=2.5, v_reset=-2.5, t_ramp=100e-6):
	"""삼각파 0 -> v_set -> 0 -> v_reset -> 0, 구간마다 t_ramp [s]. (v(t), t_end, corners)를 반환."""
	corners_t = np.array([0.0, 1, 2, 3, 4]) * t_ramp
	corners_v = np.array([0.0, v_set, 0.0, v_reset, 0.0])
	return (lambda t: float(np.interp(t, corners_t, corners_v))), corners_t[-1], corners_t


def pulse_waveform(v_pulse=2.0, t_edge=10e-9, t_width=80e-9, t_total=100e-9):
	"""매뉴얼 AC 덱과 같은 사다리꼴 펄스 (지연 0, 상승=하강=t_edge, 평탄부 t_width)."""
	corners_t = np.array([0.0, t_edge, t_edge + t_width, 2 * t_edge + t_width, max(t_total, 2 * t_edge + t_width)])
	corners_v = np.array([0.0, v_pulse, v_pulse, 0.0, 0.0])
	return (lambda t: float(np.interp(t, corners_t, corners_v))), corners_t[-1], corners_t


# ---------------------------------------------------------------- 시뮬레이터
@dataclass
class Result:
	t: np.ndarray	# 시간 [s]
	v_app: np.ndarray	# 인가 전압 [V]
	v_sw: np.ndarray	# 스위칭 노드 전압 [V]
	i: np.ndarray	# 단자 전류 [A]
	x: np.ndarray	# 갭 길이 [m]
	w: np.ndarray	# CF 폭 [m]
	T: np.ndarray	# 필라멘트 온도 [K]
	info: dict = field(default_factory=dict)

	def table(self):
		return np.column_stack([self.t, self.v_app, self.v_sw, self.i, self.x, self.w, self.T])


CSV_HEADER = "t_s,v_app_V,v_sw_V,i_A,x_m,w_m,T_K"


def series_r(v_app, Rs, Rs_reset):
	"""직렬 compliance 저항: v_app >= 0 (SET)이면 Rs, v_app < 0이면 Rs_reset (A14) [ohm]."""
	return Rs if v_app >= 0.0 else Rs_reset


def simulate(v_func, t_end, x0, w0, p=DEFAULT, Rs=0.0, Rs_reset=0.0, include_cp=False,
		n_out=2001, max_step=None, rtol=1e-6, noise_dt=None, rng=None, corners=None):
	"""상태 방정식을 BDF로 적분한다.

	include_cp=False: CP 무시, 우변을 계산할 때마다 V_sw를 대수적으로 푼다 (A11).
	include_cp=True : V_sw가 상태 변수, CP*dV_sw/dt = (v_app - V_sw)/(RL+Rs) - I_cell.
	corners: 파형 꺾임점 [s]. 여기서 적분을 다시 시작한다.
	noise_dt: 식 (8),(9)의 계단형 chi(t) 유지 시간 (A12). None이면 잡음 없음.
	"""
	if max_step is None:
		max_step = t_end / 2000
	# 우변이 불연속인 시점: 파형 꺾임점과 잡음 갱신 시점.
	# 각 시점에서 적분기를 다시 시작해 BDF가 불연속을 건너뛰지 않게 한다.
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
	cur = [0.0, 0.0]	# 현재 잡음 표본 (chi_g, chi_r), 구간 안에서는 일정

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
			i[k] = (v_app[k] - vs) / (p.RL + series_r(v_app[k], Rs, Rs_reset))	# 단자 전류, CP 충전 전류 포함
		else:
			i[k] = p.N * i_f + vs / p.RH
	return Result(t_all, v_app, v_sw, i, x, w, T, {"nfev": nfev, "N": p.N})


# ---------------------------------------------------------- 읽기 / 고정 상태
def read_resistance(x, w, p=DEFAULT, v_read=0.2):
	"""v_read에서의 셀 저항 (RL 포함, 스위칭 없음) [ohm]."""
	v_sw = solve_vsw(v_read, x, w, p, 0.0)
	return v_read / cell_current(v_sw, x, w, p)


def iv_fixed_state(v, x, A_cf, p=DEFAULT, Rs=0.0):
	"""고정 상태 모드: 사용자가 정한 갭 x [m]와 CF 면적 A_cf [m^2]에서의 정적 I-V. 스위칭 없음."""
	w = cf_width_from_area(A_cf)
	out = np.empty(len(v))
	for k, vk in enumerate(v):
		vs = solve_vsw(float(vk), x, w, p, Rs)
		out[k] = cell_current(vs, x, w, p)
	return out


# ---------------------------------------------------------- 변동성 (10)(11)
@dataclass(frozen=True)
class Variability:
	sigma_Ea: float = 0.02 * EV	# 사이클 간 Ea 표준편차 [J] (A13)
	sigma_Ei: float = 0.02 * EV	# 사이클 간 Ei 표준편차 [J] (A13)
	sigma_Eh: float = 0.02 * EV	# 사이클 간 Eh 표준편차 [J] (A13)


def sample_cycle_params(p, var, rng):
	"""식 (10),(11): 한 사이클의 에너지 장벽을 몬테카를로로 뽑는다."""
	return replace(p,
		Ea=p.Ea + var.sigma_Ea * rng.standard_normal(),
		Ei=p.Ei + var.sigma_Ei * rng.standard_normal(),
		Eh=p.Eh + var.sigma_Eh * rng.standard_normal())


def switching_voltage(res, p=DEFAULT):
	"""스윕의 스위칭 전압 (진단용). (V_set, V_reset) [V] 또는 nan을 반환.

	V_set  : 갭이 처음으로 a(= VO 간격 한 칸) 아래로 닫히는 인가 전압.
	V_reset: 음의 구간에서 |I|가 최대인 인가 전압 (점진적 RESET의 시작).
	"""
	i = np.abs(res.i)
	pos = np.where((res.v_app > 0) & (res.x < p.a))[0]
	v_set = res.v_app[pos[0]] if pos.size else np.nan
	# RESET: 음의 구간에서 |I|가 최대인 전압 (점진적 RESET의 시작)
	neg = np.where(res.v_app < 0)[0]
	v_reset = res.v_app[neg[np.argmax(i[neg])]] if neg.size else np.nan
	return v_set, v_reset
