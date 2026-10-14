"""금속산화물 unipolar RRAM 전도성 필라멘트 모델 (독립 구현, 2차원 원통 좌표).

근거 자료
	[R] U. Russo et al., "Self-accelerated thermal dissolution model for reset programming in
	    unipolar RRAM devices", IEEE TED 56(2), 193-200, 2009 (DOI 10.1109/TED.2008.2010584)
	    → 전위 식 (1), 열 식 (2), 저항 온도 의존 식 (4), 열 용해 식 (5), 파라미터 Table I, Fig. 4
	[C] U. Russo et al., "Filament conduction and reset mechanism in NiO-based RRAM devices",
	    IEEE TED 56(2), 186-192, 2009 (DOI 10.1109/TED.2008.2010583)
	    → 등가 열저항 정의 식 (6), SET은 전류 제한, RESET은 전압 스윕
	[D] H. Li et al., "Variation-aware, reliability-emphasized design and optimization of RRAM
	    using SPICE model", DATE 2015 → SET 측면 성장 식 (2), 사이클 간 장벽 산포 식 (10),(11)
	[M] PKU-Stanford RRAM v2.0Beta Quick User Guide, Table 3 → SET 파라미터, RL, CP 기본값

구조
	- 필라멘트(CF)와 둘레 산화막을 원통 좌표 (r, z) 격자로 나누고, 매 시각 정상 상태
	  전위·온도를 자기 일관적으로 푼다 ([R] 식 (1)-(4), 시간 적분 없음 [R]).
	- 상태 변수는 높이 z마다의 CF 경계 반경 r_b(z). RESET에서는 경계 온도로 [R] 식 (5)만큼
	  안쪽으로, SET에서는 [D] 식 (2)만큼 바깥쪽으로 움직인다.
	- unipolar: SET과 RESET은 같은 극성. 어느 식을 쓸지는 동작으로 정한다
	  (SET = compliance 있음: 성장 + 용해, RESET = compliance 없음: 용해만) (A25).
자료에 없는 내용은 ASSUMPTIONS.md (A#)에 정리했다. 내부 계산은 모두 SI 단위.
"""

import math
from dataclasses import dataclass, field, replace

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy.optimize import brentq


# ---------------------------------------------------------------- 물리 상수
Q_E = 1.602176634e-19	# 기본 전하량 [C]
K_B = 1.380649e-23	# 볼츠만 상수 [J/K]
EV = Q_E	# 1 eV [J]


# --------------------------------------------------------------- 파라미터
@dataclass(frozen=True)
class Params:
	# 소자 형상과 물성: [R] Table I (NiO 소자)
	L0: float = 160e-9	# 산화막 두께 = CF 길이 [m]
	phi0: float = 80e-9	# 포밍된 CF 지름 [m]
	rho_cf: float = 810e-8	# T0에서의 CF 비저항 [ohm*m] (810 uOhm*cm)
	rho_ox: float = 80e6 * 1e-8	# 산화막 비저항 [ohm*m] (80e6 uOhm*cm)
	kappa_cf: float = 21.4	# CF 열전도도 [W/(K m)]
	kappa_ox: float = 20.0	# 산화막 열전도도 [W/(K m)]
	alpha_T: float = 1.7e-3	# CF 비저항 온도 계수 [1/K], [R] 식 (4)
	Ed: float = 1.2 * EV	# 열 용해 활성화 에너지 [J], [R] 식 (5)의 Ea
	vD0: float = 200.0	# 용해 속도 전인자 [m/s], [R] 식 (5) ([R]에서도 피팅값)
	T0: float = 300.0	# 소자(주변) 온도 [K]
	R_dom: float = 53.3e-9	# 계산 영역 반경 [m]. [R] Fig. 4 B점(0.78 V에서 530 K)에 맞춘 값 (A31)
	# SET 측면 성장: [D] 식 (2), 값은 [M] Table 3
	Ea: float = 0.7 * EV	# VO 평균 활성화 에너지 [J]
	alpha_a: float = 0.75e-9	# 에너지 증강 계수 [m]
	f: float = 1e13	# VO 진동 주파수 [Hz]
	dr: float = 0.25e-9	# 측면 성장 단위 Delta_r [m] (A4)
	Z: float = 1.0	# 전하수 [-]
	# 기생 성분: [M] Table 3
	RL: float = 20.0	# 전극 접촉 저항 [ohm]
	CP: float = 20e-15	# 전극 기생 정전용량 [F]
	# 전극층 (A41). t_el = 0이면 [R]처럼 산화막 끝면이 T0·고정 전위인 이상적 전극.
	# t_el > 0이면 위·아래에 두께 t_el의 전극층을 계산 영역에 넣고 그 바깥 면을 T0·고정 전위로 둔다.
	# 물성 기본값은 TiN: kappa_el = 11.9 W/(K m) [Samani 2013, Thin Solid Films 537, 108],
	# rho_el = 125 uOhm*cm (DC 반응성 스퍼터 TiN 전극, 약 10 nm) [J. Mater. Sci.: Mater. Electron. 2018, 10.1007/s10854-018-9066-4]
	t_el: float = 0.0	# 전극 두께 [m]
	kappa_el: float = 11.9	# 전극 열전도도 [W/(K m)]
	rho_el: float = 125e-8	# 전극 비저항 [ohm*m] (125 uOhm*cm), 온도 무관으로 둠 (A41)
	# 교수님 요청: 필라멘트 밀도와 셀 면적 (A10)
	n_f: float = 1e14	# 단위면적당 필라멘트 수 [1/m^2] (A22)
	A_cell: float = 1e-14	# 셀 면적 [m^2] (100 nm x 100 nm) → N = 1

	@property
	def N(self):
		"""병렬로 놓인 동일 필라멘트 수, round(n_f*A_cell) >= 1 (A10)."""
		return max(1, int(round(self.n_f * self.A_cell)))


DEFAULT = Params()

# TiN 전극 프리셋 (A41). 두께 50 nm는 가정값: 실험 소자의 전극 두께로 바꿔 쓸 것
TIN_ELECTRODE = {"t_el": 50e-9, "kappa_el": 11.9, "rho_el": 125e-8}

RS_SET = 3e3	# SET 동작 compliance 저항 기본값 [ohm] (A15)



# ---------------------------------------------------------------- 격자
@dataclass(frozen=True)
class GridSpec:
	dr_fine: float = 4e-9	# CF 근처 반경 방향 칸 [m] (A35: 브라우저 계산 속도와의 절충)
	growth: float = 1.15	# 바깥쪽 칸 증가 비율
	nz: int = 40	# 길이 방향 칸 수
	el_growth: float = 1.6	# 전극층 칸 증가 비율 (1.3 대비 Rth 차이 0.4% 이하) (산화막 쪽 첫 칸 = 산화막 칸) (A41)


DEFAULT_GRID = GridSpec()


@dataclass
class Grid:
	r_faces: np.ndarray	# 반경 방향 셀 경계 [m]
	z_faces: np.ndarray	# 길이 방향 셀 경계 [m]
	rc: np.ndarray	# 셀 중심 반경 [m]
	zc: np.ndarray	# 셀 중심 높이 [m]


def make_grid(p, gs=DEFAULT_GRID):
	"""반경: CF 근처(0.75*phi0까지) 균일 dr_fine, 그 밖은 등비로 R_dom까지. 길이: 균일 nz칸."""
	r_fine = min(0.75 * p.phi0, p.R_dom)
	faces = list(np.arange(0.0, r_fine + 1e-15, gs.dr_fine))
	if faces[-1] < r_fine - 1e-15:
		faces.append(r_fine)
	d = gs.dr_fine
	while faces[-1] < p.R_dom - 1e-15:
		d *= gs.growth
		faces.append(min(faces[-1] + d, p.R_dom))
	rf = np.array(faces)
	zf = np.linspace(0.0, p.L0, gs.nz + 1)
	return Grid(rf, zf, 0.5 * (rf[:-1] + rf[1:]), 0.5 * (zf[:-1] + zf[1:]))


def electrode_faces(p, gs, dz0):
	"""전극층 안의 칸 경계 (산화막 면에서 잰 거리, 0 .. t_el) [m]. 첫 칸 dz0, 바깥으로 el_growth배씩."""
	faces = [0.0]
	d = dz0
	while faces[-1] < p.t_el - 1e-15:
		faces.append(min(faces[-1] + d, p.t_el))
		d *= gs.el_growth
	return np.array(faces)


def electrode_radius(p):
	"""전극층의 반경 방향 계산 범위 [m] (A41).

	전극은 셀 전체로 퍼져 있으므로 셀 등가 반경 sqrt(A_cell/pi)까지 넓힌다. 다만 바깥 면(T0)까지의
	거리가 t_el이라 열은 접촉점에서 수 t_el 안에서 빠지므로 R_dom + 10 t_el에서 자른다. 최소 R_dom.
	"""
	return max(p.R_dom, min(math.sqrt(p.A_cell / math.pi), p.R_dom + 10 * p.t_el))


def full_grid(g, p, gs=DEFAULT_GRID):
	"""전극층까지 넣은 열·전기 계산용 격자, 아래 전극 칸 수 (A41). t_el = 0이면 (g, 0).

	길이: 산화막 칸 위아래에 전극 칸 (산화막 쪽 첫 칸 = 산화막 칸, 바깥으로 el_growth배).
	반경: 전극층을 electrode_radius(p)까지 넓히기 위해 R_dom 밖에 칸을 el_growth배씩 덧붙인다.
	R_dom 밖의 산화막 행은 계산에서 빼는 셀이다 (FieldSolver 참고).
	"""
	if p.t_el <= 0:
		return g, 0
	ef = electrode_faces(p, gs, g.z_faces[1] - g.z_faces[0])
	zf = np.concatenate([-ef[::-1], g.z_faces[1:-1], p.L0 + ef])
	rf = list(g.r_faces)
	d = rf[-1] - rf[-2]
	r_el = electrode_radius(p)
	while rf[-1] < r_el - 1e-15:
		d *= gs.el_growth
		rf.append(min(rf[-1] + d, r_el))
	rf = np.array(rf)
	return Grid(rf, zf, 0.5 * (rf[:-1] + rf[1:]), 0.5 * (zf[:-1] + zf[1:])), len(ef) - 1


def cf_fraction(g, rb):
	"""셀별 CF 단면적 비율 (nz, nr). 경계가 걸친 셀은 면적 비율로 섞어 경계 이동이 매끄럽게 (A30)."""
	r0 = g.r_faces[:-1][None, :]
	r1 = g.r_faces[1:][None, :]
	f = (rb[:, None] ** 2 - r0 ** 2) / (r1 ** 2 - r0 ** 2)
	return np.clip(f, 0.0, 1.0)


# ---------------------------------------------------------------- 정상 상태 전위·온도
def _assemble(g, k):
	"""-div(k grad u) 유한체적 행렬. 위/아래 전극(z)은 Dirichlet, 축과 옆면(r)은 Neumann [R].

	반환: (A, G_top, G_bot, Gr, Gz). G_top/G_bot: 끝 셀과 전극 사이 컨덕턴스,
	Gr/Gz: 반경/길이 방향 면 컨덕턴스.
	"""
	nz, nr = k.shape
	rf = g.r_faces
	dz = np.diff(g.z_faces)
	ring = math.pi * (rf[1:] ** 2 - rf[:-1] ** 2)
	h_in = rf[1:-1] - g.rc[:-1]
	h_out = g.rc[1:] - rf[1:-1]
	area_r = 2 * math.pi * rf[1:-1][None, :] * dz[:, None]
	Gr = area_r / (h_in[None, :] / k[:, :-1] + h_out[None, :] / k[:, 1:])
	Gz = ring[None, :] / (0.5 * dz[:-1, None] / k[:-1, :] + 0.5 * dz[1:, None] / k[1:, :])
	G_bot = ring * k[0, :] / (0.5 * dz[0])
	G_top = ring * k[-1, :] / (0.5 * dz[-1])
	idx = np.arange(nz * nr).reshape(nz, nr)
	diag = np.zeros((nz, nr))
	diag[:, :-1] += Gr
	diag[:, 1:] += Gr
	diag[:-1, :] += Gz
	diag[1:, :] += Gz
	diag[0, :] += G_bot
	diag[-1, :] += G_top
	rows = np.concatenate([idx[:, :-1].ravel(), idx[:, 1:].ravel(), idx[:-1, :].ravel(), idx[1:, :].ravel(), idx.ravel()])
	cols = np.concatenate([idx[:, 1:].ravel(), idx[:, :-1].ravel(), idx[1:, :].ravel(), idx[:-1, :].ravel(), idx.ravel()])
	vals = np.concatenate([-Gr.ravel(), -Gr.ravel(), -Gz.ravel(), -Gz.ravel(), diag.ravel()])
	A = sp.csc_matrix((vals, (rows, cols)), shape=(nz * nr, nz * nr))
	return A, G_top, G_bot, Gr, Gz


@dataclass
class Fields:
	V: np.ndarray	# 전위 (nz, nr) [V]
	T: np.ndarray	# 온도 (nz, nr) [K]
	I: float	# 필라멘트 1개 전류 [A]
	P: float	# 소비 전력 [W]


OFF = 1e-9	# 계산에서 빼는 셀의 전도도 배율 [-] (A41)


class FieldSolver:
	"""한 CF 형상(rb)에 대해 정상 상태 전위·온도를 푸는 도우미. 열 행렬 분해를 재사용한다."""

	def __init__(self, g, p, rb, gs=DEFAULT_GRID):
		self.g = g
		self.p = p
		self.f = cf_fraction(g, rb)
		# 전극층이 있으면 산화막 위아래에 전극 행을 붙인 격자에서 푼다 (A41)
		self.gf, self.nb = full_grid(g, p, gs)
		nzf, nrf = len(self.gf.zc), len(self.gf.rc)
		nz, nr = len(g.zc), len(g.rc)
		self.ox = (slice(self.nb, self.nb + nz), slice(0, nr))
		# R_dom 밖 산화막 행: 산화막을 R_dom에서 단열로 둔 [R] 보정(A31)을 유지하려고 사실상 끊는다
		self.off = (slice(self.nb, self.nb + nz), slice(nr, nrf))
		kappa = np.full((nzf, nrf), p.kappa_el)
		kappa[self.off] = OFF * p.kappa_ox
		kappa[self.ox] = self.f * p.kappa_cf + (1 - self.f) * p.kappa_ox
		A, self.Gt_th, self.Gb_th, _, _ = _assemble(self.gf, kappa)
		self.lu_th = spla.splu(A)
		self.T_last = None

	def solve(self, v, tol=0.05, max_iter=80, relax=0.7):
		"""셀 양단 전압 v [V]에서 V, T를 Picard 반복으로 푼다 ([R] 식 (1)-(4)). 부호 대칭.

		반환하는 V, T는 산화막 행만 (전극층은 계산에만 쓴다). P는 전극층 발열 포함.
		"""
		g, p, f = self.gf, self.p, self.f
		nz, nr = len(g.zc), len(g.rc)
		s = 1.0 if v >= 0 else -1.0
		va = abs(v)
		T = self.T_last.copy() if self.T_last is not None else np.full((nz, nr), p.T0)
		sigma = np.full((nz, nr), 1.0 / p.rho_el)
		sigma[self.off] = OFF / p.rho_ox
		for it in range(max_iter):
			rho = p.rho_cf * (1 + p.alpha_T * (T[self.ox] - p.T0))
			sigma[self.ox] = f / rho + (1 - f) / p.rho_ox
			A_e, Gt_e, Gb_e, Gr_e, Gz_e = _assemble(g, sigma)
			b = np.zeros(nz * nr)
			b[(nz - 1) * nr:] = Gt_e * va
			V = spla.spsolve(A_e, b).reshape(nz, nr)
			# 줄 발열: 면 컨덕턴스 G*dV^2를 양쪽 셀에 반씩 (총합 = I*V)
			q = np.zeros((nz, nr))
			pr = Gr_e * (V[:, 1:] - V[:, :-1]) ** 2
			q[:, :-1] += 0.5 * pr
			q[:, 1:] += 0.5 * pr
			pz = Gz_e * (V[1:, :] - V[:-1, :]) ** 2
			q[:-1, :] += 0.5 * pz
			q[1:, :] += 0.5 * pz
			q[0, :] += Gb_e * V[0, :] ** 2
			q[-1, :] += Gt_e * (va - V[-1, :]) ** 2
			bt = q.copy()
			bt[0, :] += self.Gb_th * p.T0
			bt[-1, :] += self.Gt_th * p.T0
			T_new = self.lu_th.solve(bt.ravel()).reshape(nz, nr)
			dT = float(np.max(np.abs(T_new - T)))
			T = T_new if it == 0 else T + relax * (T_new - T)
			if dT < tol:
				break
		self.T_last = T
		I = float(np.sum(Gt_e * (va - V[-1, :])))
		return Fields(s * V[self.ox], T[self.ox], s * I, float(q.sum()))


def boundary_values(g, fld, rb):
	"""각 높이에서 CF 경계(r = rb)의 온도와 길이 방향 전계 크기 [K], [V/m]."""
	nz = len(rb)
	Tb = np.empty(nz)
	Eb = np.empty(nz)
	dz = np.diff(g.zc)
	V = np.abs(fld.V)
	for j in range(nz):
		Tb[j] = np.interp(rb[j], g.rc, fld.T[j])
		vj = np.interp(rb[j], g.rc, V[j])
		up = np.interp(rb[j], g.rc, V[min(j + 1, nz - 1)])
		dn = np.interp(rb[j], g.rc, V[max(j - 1, 0)])
		span = (g.zc[min(j + 1, nz - 1)] - g.zc[max(j - 1, 0)])
		Eb[j] = abs(up - dn) / span if span > 0 else 0.0
	return Tb, Eb


# ---------------------------------------------------------------- 경계 이동 속도
def rate_dissolve(T, p):
	"""[R] 식 (5): 열 용해로 CF 경계가 축 쪽으로 움직이는 속도 v_D [m/s]."""
	return p.vD0 * np.exp(-p.Ed / (K_B * T))


def rate_grow(r, E, T, p):
	"""[D] 식 (2): SET 중 CF 경계가 바깥쪽으로 움직이는 속도 dr/dt [m/s].

	전계 E는 경계 위치의 국소 길이 방향 전계 (2차원 계산에서 얻음, A33).
	Delta_r^2/(2r)이 r -> 0에서 발산하지 않도록 r은 Delta_r/2 이상으로 둔다 (A32).
	"""
	re = np.maximum(r, 0.5 * p.dr)
	pref = p.dr + p.dr * p.dr / (2.0 * re)
	return pref * p.f * np.exp(-(p.Ea - p.alpha_a * p.Z * Q_E * E) / (K_B * T))


def boundary_velocity(op, rb, g, fld, p):
	"""경계 반경의 시간 변화율 [m/s]. op = "set" (성장 + 용해) | "reset" (용해만) (A25)."""
	Tb, Eb = boundary_values(g, fld, rb)
	vel = -np.where(rb > 0.0, rate_dissolve(Tb, p), 0.0)
	if op == "set":
		vel = vel + rate_grow(rb, Eb, Tb, p)
	# 영역 밖으로는 자라지 않는다
	vel = np.where((rb >= 0.98 * p.R_dom) & (vel > 0), 0.0, vel)
	return vel


# ---------------------------------------------------------------- 파형
@dataclass
class Waveform:
	v: object	# v(t) [V]
	op: object	# op(t) -> "set" | "reset"
	t_end: float	# [s]
	corners: np.ndarray	# 꺾임점 [s]


def _interp(ts, vs):
	return lambda t: float(np.interp(t, ts, vs))


def sweep_waveform(v_reset=1.5, v_set=3.0, t_ramp=0.25):
	"""unipolar 스윕: 0 -> v_reset -> 0 (RESET 동작) -> v_set -> 0 (SET 동작), 구간마다 t_ramp [s].

	포밍된 LRS에서 시작하므로 RESET을 먼저 한다. 기본 램프는 [R] Fig. 3의 4 V/s 근처.
	"""
	ts = np.array([0.0, 1, 2, 3, 4]) * t_ramp
	vs = np.array([0.0, v_reset, 0.0, v_set, 0.0])
	return Waveform(_interp(ts, vs), lambda t: "reset" if t < 2 * t_ramp else "set", ts[-1], ts)


def pulse_waveform(op, v_pulse, t_edge=10e-9, t_width=1e-6):
	"""사다리꼴 펄스 하나 (지연 0, 상승 = 하강 = t_edge). op = "set" | "reset"."""
	ts = np.array([0.0, t_edge, t_edge + t_width, 2 * t_edge + t_width])
	vs = np.array([0.0, v_pulse, v_pulse, 0.0])
	return Waveform(_interp(ts, vs), lambda t: op, ts[-1], ts)


def ramp_waveform(op, v_max, rate):
	"""한 방향 램프 0 -> v_max (rate [V/s]) 하나. 측정에서 RESET이 일어나면 끊는 스윕을 흉내 낸다.

	계단 스윕(계단 dV, 머무는 시간 tau)은 평균 램프 속도 dV/tau의 연속 램프로 본다 (A42).
	"""
	ts = np.array([0.0, v_max / rate])
	return Waveform(_interp(ts, np.array([0.0, v_max])), lambda t: op, ts[-1], ts)


def series_r(op, Rs, Rs_reset):
	"""직렬 compliance 저항: SET 동작이면 Rs, RESET 동작이면 Rs_reset (A14) [ohm]."""
	return Rs if op == "set" else Rs_reset


# ---------------------------------------------------------------- 셀 전압 풀이
def solve_cell(fs, p, v_app, r_ser, cp=0.0, dt=0.0, v_prev=0.0):
	"""인가 전압과 셀 전압 V_c 사이의 회로 방정식을 V_c에 대해 푼다.

	(v_app - V_c)/r_ser = N*I(V_c) + CP*(V_c - v_prev)/dt   (CP 항은 후진 Euler, A11)
	r_ser = RL + Rs. 반환: (V_c, Fields).
	"""
	c = cp / dt if (cp > 0 and dt > 0) else 0.0
	if v_app == 0.0 and c == 0.0:
		return 0.0, fs.solve(0.0)

	def g(vc):
		return (v_app - vc) / r_ser - p.N * fs.solve(vc).I - c * (vc - v_prev)

	lo, hi = sorted([0.0, v_app] + ([v_prev] if c > 0 else []))[0], sorted([0.0, v_app] + ([v_prev] if c > 0 else []))[-1]
	if hi - lo < 1e-15:
		return lo, fs.solve(lo)
	vc = brentq(g, lo, hi, xtol=1e-7, rtol=1e-9)
	return vc, fs.solve(vc)


def solve_cell_cc(fs, p, i_cc, v_hi, cp=0.0, dt=0.0, v_prev=0.0):
	"""전류 제한(CC) 상태의 셀 전압: N*I(V_c) + CP*(V_c - v_prev)/dt = i_cc 를 V_c에 대해 푼다 (A40).

	측정기가 단자 전류를 i_cc에 고정하도록 출력 전압을 낮춘 상태. v_hi는 제한 없이 푼 셀 전압
	(이때 전류가 i_cc보다 크므로 해는 [lo, v_hi] 안에 있다). 반환: (V_c, Fields).
	"""
	c = cp / dt if (cp > 0 and dt > 0) else 0.0

	def g(vc):
		return p.N * fs.solve(vc).I + c * (vc - v_prev) - i_cc

	lo = min(0.0, v_prev) if c > 0 else 0.0
	vc = brentq(g, lo, v_hi, xtol=1e-7, rtol=1e-9)
	return vc, fs.solve(vc)


# ---------------------------------------------------------------- 시뮬레이터
@dataclass
class Result:
	t: np.ndarray	# 시간 [s]
	v_app: np.ndarray	# 인가 전압 [V]
	v_cell: np.ndarray	# 셀(필라멘트) 양단 전압 [V]
	i: np.ndarray	# 단자 전류 [A]
	r_min: np.ndarray	# 가장 가는 곳의 CF 반경 [m]
	T: np.ndarray	# 최고 온도 [K]
	rb_end: np.ndarray	# 마지막 CF 경계 반경 r_b(z) [m]
	snapshots: list = field(default_factory=list)	# (t, v_app, rb, T) 몇 장
	info: dict = field(default_factory=dict)

	def table(self):
		return np.column_stack([self.t, self.v_app, self.v_cell, self.i, self.r_min, self.T])


CSV_HEADER = "t_s,v_app_V,v_cell_V,i_A,r_min_m,T_max_K"


def simulate(wf, rb0=None, p=DEFAULT, gs=DEFAULT_GRID, Rs=RS_SET, Rs_reset=0.0, include_cp=False,
		dv_max=1e-2, drb_max=None, n_snap=0, i_cc=None):
	"""CF 경계를 시간에 따라 움직이며 응답을 계산한다.

	rb0: 초기 경계 반경 (스칼라 또는 높이별 배열). None이면 포밍된 CF (phi0/2).
	시간 적분: 경계 이동은 명시적 Euler + 적응 스텝 (A34):
		한 스텝에서 전압 변화 <= dv_max, 경계 이동 <= drb_max (기본: 반경 격자의 1/4).
	include_cp: CP를 후진 Euler로 포함 (펄스용).
	n_snap: 등간격 시각에 (rb, T) 스냅숏 저장 개수.
	i_cc: SET 동작의 전류 제한 [A] (A40). 주면 SET 동작에서 Rs 대신 단자 전류를 i_cc로 자른다.
		v_app에는 설정 전압을 그대로 기록한다 (측정 I-V처럼 CC 구간이 수평선으로 보인다).
	"""
	g = make_grid(p, gs)
	nz = len(g.zc)
	if rb0 is None:
		rb = np.full(nz, p.phi0 / 2)
	elif np.isscalar(rb0):
		rb = np.full(nz, float(rb0))
	else:
		rb = np.array(rb0, dtype=float)
	drb_max = drb_max if drb_max is not None else gs.dr_fine / 4
	corners = sorted(set(float(c) for c in wf.corners if 0 < c < wf.t_end))
	snap_times = list(np.linspace(0, wf.t_end, n_snap)) if n_snap else []
	t = 0.0
	vc = 0.0
	T_prev = None
	out = {k: [] for k in ("t", "v_app", "v_cell", "i", "r_min", "T")}
	snaps = []
	dt = 0.0
	while True:
		va = wf.v(t)
		op = wf.op(min(t, wf.t_end * (1 - 1e-12)))
		cc = i_cc is not None and op == "set"
		r_ser = p.RL + (0.0 if cc else series_r(op, Rs, Rs_reset))
		cp = p.CP if include_cp else 0.0
		fs = FieldSolver(g, p, rb, gs)
		fs.T_last = T_prev
		vc_new, fld = solve_cell(fs, p, va, r_ser, cp, dt, vc)
		i_term = (va - vc_new) / r_ser
		if cc and i_term > i_cc:
			vc_new, fld = solve_cell_cc(fs, p, i_cc, vc_new, cp, dt, vc)
			i_term = i_cc
		vc = vc_new
		T_prev = fs.T_last	# 전극층 포함 전체 격자 온도 (다음 스텝 초기값)
		out["t"].append(t)
		out["v_app"].append(va)
		out["v_cell"].append(vc)
		out["i"].append(i_term)
		out["r_min"].append(float(rb.min()))
		out["T"].append(float(fld.T.max()))
		while snap_times and t >= snap_times[0] - 1e-15:
			snaps.append((t, va, rb.copy(), fld.T.copy()))
			snap_times.pop(0)
		if t >= wf.t_end:
			break
		vel = boundary_velocity(op, rb, g, fld, p)
		lims = [wf.t_end - t]
		vm = float(np.max(np.abs(vel)))
		if vm > 0:
			lims.append(drb_max / vm)
		slope = abs(wf.v(t + 1e-12 * max(wf.t_end, 1e-9)) - va) / (1e-12 * max(wf.t_end, 1e-9))
		if slope > 0:
			lims.append(dv_max / slope)
		nxt = [c for c in corners if c > t + 1e-18]
		if nxt:
			lims.append(nxt[0] - t)	# 파형 꺾임점을 정확히 지난다
		dt = max(min(lims), 1e-15)
		rb = np.clip(rb + vel * dt, 0.0, p.R_dom)
		t = min(t + dt, wf.t_end)
	res = Result(*(np.array(out[k]) for k in ("t", "v_app", "v_cell", "i", "r_min", "T")), rb.copy(), snaps,
			{"steps": len(out["t"]), "z": g.zc.copy(), "r": g.rc.copy()})
	return res


# ---------------------------------------------------------------- 읽기 / 고정 상태
def read_resistance(rb, p=DEFAULT, gs=DEFAULT_GRID, v_read=0.1):
	"""v_read에서의 셀 저항 (RL 포함, 스위칭 없음) [ohm]. rb: 스칼라 또는 높이별 반경.

	읽기 전압 0.1 V는 [C] Fig. 3의 저항 측정 조건(100 mV 기울기)을 따른다.
	"""
	g = make_grid(p, gs)
	rbv = np.full(len(g.zc), rb) if np.isscalar(rb) else np.asarray(rb, dtype=float)
	fs = FieldSolver(g, p, rbv, gs)
	vc, fld = solve_cell(fs, p, v_read, p.RL)
	return v_read / (p.N * fld.I)


def neck_profile(r_neck, length, p=DEFAULT, gs=DEFAULT_GRID):
	"""고정 상태 모드용 CF 형상: 가운데 길이 `length` 구간만 반경 r_neck, 나머지는 phi0/2."""
	g = make_grid(p, gs)
	rb = np.full(len(g.zc), p.phi0 / 2)
	mid = p.L0 / 2
	rb[np.abs(g.zc - mid) <= length / 2] = r_neck
	return rb


def iv_fixed_state(v, rb, p=DEFAULT, gs=DEFAULT_GRID):
	"""고정 상태 모드: 주어진 CF 형상 rb에서의 정적 I-V (RL 포함, 스위칭 없음)."""
	g = make_grid(p, gs)
	rbv = np.full(len(g.zc), rb) if np.isscalar(rb) else np.asarray(rb, dtype=float)
	fs = FieldSolver(g, p, rbv, gs)
	out = np.empty(len(v))
	for k, vk in enumerate(v):
		vc, fld = solve_cell(fs, p, float(vk), p.RL)
		out[k] = p.N * fld.I
	return out


# ---------------------------------------------------------- 변동성 [D] (10)(11)
@dataclass(frozen=True)
class Variability:
	sigma_Ea: float = 0.02 * EV	# 사이클 간 Ea(SET) 표준편차 [J] (A13)
	sigma_Ed: float = 0.02 * EV	# 사이클 간 Ed(RESET) 표준편차 [J] (A13)


def sample_cycle_params(p, var, rng):
	"""[D] 식 (10),(11): 한 사이클의 SET/RESET 장벽을 몬테카를로로 뽑는다 (RESET 장벽은 Ed, A13)."""
	return replace(p,
		Ea=p.Ea + var.sigma_Ea * rng.standard_normal(),
		Ed=p.Ed + var.sigma_Ed * rng.standard_normal())


# ---------------------------------------------------------- 진단
def reset_point(res):
	"""RESET 구간에서 |I|가 최대인 (V_reset [V], I_reset [A]). 그 뒤 전류가 무너진다."""
	half = res.t[-1] / 2 if res.t[-1] > 0 else 0
	idx = np.arange(len(res.t)) if half == 0 else np.where(res.t <= half)[0]
	k = idx[np.argmax(np.abs(res.i[idx]))]
	return res.v_app[k], res.i[k]


def set_point(res, p=DEFAULT):
	"""SET 구간에서 셀 저항이 처음으로 구간 시작값의 1/10 아래로 떨어지는 인가 전압 [V]."""
	half = res.t[-1] / 2
	idx = np.where((res.t > half) & (np.abs(res.v_app) > 0.05))[0]
	if idx.size == 0:
		return np.nan
	r = np.abs(res.v_cell[idx] / np.where(res.i[idx] == 0, 1e-30, res.i[idx]))
	hit = np.where(r < r[0] / 10)[0]
	return res.v_app[idx[hit[0]]] if hit.size else np.nan


# ---------------------------------------------------------- 소자 간 몬테카를로 (교수님 요청)
# 고정 상태에서 필라멘트 개수, 필라멘트마다 지름·잘록 구간(갭) 반경·길이를 무작위로 뽑아
# 읽기 저항 분포를 본다. 필라멘트마다 형상이 달라 각각 2차원으로 풀고 병렬로 합친다 (A38).
@dataclass(frozen=True)
class FilamentGeom:
	phi: float	# 필라멘트 지름 [m]
	r_neck: float	# 잘록 구간(끊어지려는 곳) 반경 [m]
	neck_len: float	# 잘록 구간 길이 [m]


@dataclass(frozen=True)
class MonteCarloSpec:
	devices: int = 100	# 소자 수
	r_neck: float = 4e-9	# 잘록 구간 반경 평균 [m]
	neck_len: float = 8e-9	# 잘록 구간 길이 평균 [m]
	sigma_phi: float = 0.2	# 지름의 상대 표준편차 [-] (A39)
	sigma_neck: float = 0.3	# 잘록 반경의 상대 표준편차 [-] (A39)
	sigma_len: float = 0.3	# 잘록 길이의 상대 표준편차 [-] (A39)


def lognormal(rng, mean, rel_sigma):
	"""평균 mean, 상대 표준편차 rel_sigma인 로그정규 표본 (A39)."""
	if rel_sigma <= 0:
		return mean
	s2 = math.log(1.0 + rel_sigma * rel_sigma)
	return mean * math.exp(math.sqrt(s2) * rng.standard_normal() - 0.5 * s2)


def poisson_at_least_one(rng, mean):
	"""포아송(mean)에서 0을 뺀 분포: 포밍된 소자에는 필라멘트가 적어도 하나 있다 (A39)."""
	while True:
		k = int(rng.poisson(max(mean, 1e-9)))
		if k >= 1:
			return k


def sample_device(spec, p, rng):
	"""소자 하나의 필라멘트 형상 목록. 개수 평균은 n_f*A_cell, 지름 평균은 phi0."""
	n = poisson_at_least_one(rng, p.n_f * p.A_cell)
	out = []
	for _ in range(n):
		phi = min(lognormal(rng, p.phi0, spec.sigma_phi), 1.8 * p.R_dom)	# 계산 영역 안에 들어가게
		rn = min(lognormal(rng, spec.r_neck, spec.sigma_neck), phi / 2)
		ln = min(lognormal(rng, spec.neck_len, spec.sigma_len), p.L0)
		out.append(FilamentGeom(phi, rn, ln))
	return out


def filament_profile(fg, p=DEFAULT, gs=DEFAULT_GRID):
	"""필라멘트 하나의 경계 반경 r_b(z): 지름 phi, 가운데 길이 neck_len 구간만 반경 r_neck."""
	g = make_grid(p, gs)
	rb = np.full(len(g.zc), fg.phi / 2)
	rb[np.abs(g.zc - p.L0 / 2) <= fg.neck_len / 2] = min(fg.r_neck, fg.phi / 2)
	return rb


def device_iv(v, filaments, p=DEFAULT, gs=DEFAULT_GRID):
	"""필라멘트가 서로 다른 소자의 정적 I-V (RL 직렬, 필라멘트 병렬 + 셀 전체 산화막 누설).

	필라멘트마다 자기 계산 영역에서 2차원으로 푼다 (영역 간 열·전기 간섭 무시, A38).
	"""
	g = make_grid(p, gs)
	solvers = [FieldSolver(g, p, filament_profile(fg, p, gs), gs) for fg in filaments]
	g_ox = p.A_cell / (p.rho_ox * p.L0)	# 필라멘트 밖 산화막 누설 컨덕턴스 [S]
	out = np.empty(len(v))
	for k, vk in enumerate(v):
		vk = float(vk)
		if vk == 0.0:
			out[k] = 0.0
			continue

		def g_fn(vc):
			return (vk - vc) / p.RL - sum(fs.solve(vc).I for fs in solvers) - g_ox * vc

		lo, hi = sorted([0.0, vk])
		vc = brentq(g_fn, lo, hi, xtol=1e-9, rtol=1e-10)
		out[k] = (vk - vc) / p.RL
	return out


def device_read(filaments, p=DEFAULT, gs=DEFAULT_GRID, v_read=0.1):
	"""소자 읽기 저항 (0.1 V, RL 포함) [ohm]."""
	return v_read / device_iv([v_read], filaments, p, gs)[0]


def monte_carlo(spec, p=DEFAULT, rng=None, gs=DEFAULT_GRID):
	"""소자 spec.devices개를 뽑아 (읽기 저항 배열 [ohm], 필라멘트 수 배열, 형상 목록)을 반환."""
	rng = rng if rng is not None else np.random.default_rng()
	R = np.empty(spec.devices)
	N = np.empty(spec.devices, dtype=int)
	devs = []
	for d in range(spec.devices):
		fil = sample_device(spec, p, rng)
		devs.append(fil)
		N[d] = len(fil)
		R[d] = device_read(fil, p, gs)
	return R, N, devs
