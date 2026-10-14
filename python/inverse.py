"""측정 I-V에서 소자 파라미터를 역산한다 (Russo [C] 추출법 + 2차원 모델 피팅).

근거
	[C] U. Russo et al., IEEE TED 56(2) 186-192 (2009):
		식 (1) R(T) = R*[1 + alpha(T0 - T*)]           → 저항 온도 계수 alpha (온도별 LRS 측정)
		식 (5) R = R0[1 + gamma*alpha(Tmax - T0)]      → R(V)에서 필라멘트 최고 온도, gamma = 2/3
		식 (6) Tcrit = T0 + Preset*Rth                 → 등가 열저항
		식 (7) sigma/kappa_eq = 8 Rth / R              → 전기·열 전도도 비
		식 (10),(11) Kissinger: ln(beta/Tcrit^2) 대 1/(k Tcrit)의 기울기 = -Ea,
		             beta = 2 Vreset (Rth/R) dV/dt     → 열 용해 활성화 에너지 (램프 속도를 바꾼 측정)
	rram_model.py의 2차원 모델 ([R] Russo TED 56(2) 193-200)로 위 값들을 형상(필라멘트 지름·개수, 갭)과
	속도 파라미터(v_D0, E_a)로 옮긴다. 가정은 ASSUMPTIONS.md A42-A45.

측정 데이터 형식 (CSV, 한 파일에 여러 스윕 가능)
	sweep, op, v_V, i_A [, rate_Vps, icc_A]
	op: forming | set | reset. 스윕마다 측정 순서대로. 전압은 양의 극성 (unipolar).
"""

import math
from dataclasses import dataclass, field, replace

import numpy as np
from scipy.optimize import brentq

import rram_model as rm


# ---------------------------------------------------------------- 측정 데이터
@dataclass
class Sweep:
	sweep: int	# 스윕 번호
	op: str	# "forming" | "set" | "reset"
	v: np.ndarray	# 인가 전압 [V], 측정 순서
	i: np.ndarray	# 전류 [A]
	rate: float = float("nan")	# 평균 램프 속도 [V/s] = 계단 / 머무는 시간 (A42)
	icc: float = float("nan")	# 전류 제한 [A]


def load_sweeps(path):
	"""CSV를 읽어 Sweep 목록으로. 열: sweep, op, v_V, i_A [, rate_Vps, icc_A]."""
	import csv
	rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
	out = {}
	for r in rows:
		k = int(r["sweep"])
		if k not in out:
			out[k] = {"op": r["op"].strip().lower(), "v": [], "i": [],
				"rate": float(r.get("rate_Vps") or "nan"), "icc": float(r.get("icc_A") or "nan")}
		out[k]["v"].append(float(r["v_V"]))
		out[k]["i"].append(float(r["i_A"]))
	return [Sweep(k, d["op"], np.array(d["v"]), np.array(d["i"]), d["rate"], d["icc"]) for k, d in sorted(out.items())]


def save_sweeps(path, sweeps):
	"""Sweep 목록을 load_sweeps 형식 CSV로 저장."""
	with open(path, "w", encoding="utf-8") as fh:
		fh.write("sweep,op,v_V,i_A,rate_Vps,icc_A\n")
		for s in sweeps:
			for vk, ik in zip(s.v, s.i):
				fh.write(f"{s.sweep},{s.op},{vk:.6g},{ik:.6g},{s.rate:.6g},{s.icc:.6g}\n")


# ---------------------------------------------------------------- 특징값 추출 (측정·모델 공통)
def low_field_resistance(v, i, v_lin=0.2):
	"""원점을 지나는 직선 I = V/R을 0 < V <= v_lin 점들에 최소제곱으로 맞춘 저항 [ohm].

	v_lin 안에 점이 두 개 미만이면 처음 두 점을 쓴다. [C] Fig. 4: 0.1 V 아래에서 옴 법칙.
	"""
	v = np.asarray(v, float)
	i = np.asarray(i, float)
	m = (v > 0) & (v <= v_lin + 1e-12)
	if m.sum() < 2:
		m = np.zeros_like(v, bool)
		m[np.where(v > 0)[0][:2]] = True
	return float(np.sum(v[m] ** 2) / np.sum(v[m] * i[m]))


@dataclass
class ResetFeatures:
	R0: float	# 저전계 LRS 저항, R_L 뺀 값 [ohm]
	v_reset: float	# 전류 최대점 전압 [V]
	i_reset: float	# [A]
	v: np.ndarray	# RESET 전까지의 전압 [V]
	R: np.ndarray	# R = V/I - R_L [ohm]
	P: np.ndarray	# V*I [W]
	drop: float	# 최대점 뒤 최소 전류 / 최대 전류 (작을수록 확실한 RESET)


def reset_features(v, i, RL=0.0, v_lin=0.2):
	"""RESET 스윕에서 특징값. RESET 점 = 전류 최대점 ([R] VI절: Ireset은 RESET I-V의 최대 전류).

	drop = 최대점 뒤 최소 전류 / 최대 전류. 0.5보다 크면 RESET이 끝나지 않은 스윕으로 본다.
	"""
	v = np.asarray(v, float)
	i = np.abs(np.asarray(i, float))
	k = int(np.argmax(i))
	drop = float(i[k:].min() / i[k])
	pre = slice(0, k + 1)
	vv, ii = v[pre], i[pre]
	pos = vv > 0
	R0 = low_field_resistance(vv, ii, v_lin) - RL
	return ResetFeatures(R0, float(v[k]), float(i[k]), vv[pos], vv[pos] / ii[pos] - RL, vv[pos] * ii[pos], drop)


def russo_temperature(R, R0, alpha, T0=300.0, gamma=2.0 / 3.0):
	"""[C] 식 (5): R = R0[1 + gamma*alpha(Tmax - T0)] 를 Tmax에 대해 [K]."""
	return T0 + (np.asarray(R) / R0 - 1.0) / (gamma * alpha)


@dataclass
class RussoResult:
	T: np.ndarray	# RESET 전 각 점의 필라멘트 최고 온도 [K], [C] 식 (5)
	T_crit: float	# RESET 점의 온도 [K]
	P_reset: float	# [W]
	Rth_reset: float	# [C] 식 (6): (Tcrit - T0)/Preset [K/W]
	Rth_fit: float	# T - T0 = Rth*P 를 RESET 전 모든 점에 맞춘 기울기 [K/W] (A43)
	sigma_kappa: float	# [C] 식 (7): 8 Rth / R0 [K/(W ohm)]


def russo_extraction(f, alpha, T0=300.0, gamma=2.0 / 3.0):
	"""[C]의 추출: R(V) → T(V) → Tcrit, Rth, sigma/kappa."""
	T = russo_temperature(f.R, f.R0, alpha, T0, gamma)
	T_crit = float(T[-1])
	P_reset = float(f.P[-1])
	m = f.P > 0
	Rth_fit = float(np.sum(f.P[m] * (T[m] - T0)) / np.sum(f.P[m] ** 2))
	Rth_reset = (T_crit - T0) / P_reset
	return RussoResult(T, T_crit, P_reset, Rth_reset, Rth_fit, 8 * Rth_fit / f.R0)


def kissinger(points):
	"""[C] 식 (10),(11): 램프 속도가 다른 RESET들에서 열 용해 활성화 에너지 [J].

	points: (rate [V/s], v_reset [V], T_crit [K], Rth [K/W], R0 [ohm]) 목록. 서로 다른 램프 속도가 둘 이상 필요.
	beta = 2 Vreset (Rth/R) dV/dt, ln(beta/Tcrit^2) = c - Ea/(k Tcrit).
	반환: (Ea [J], 절편, x, y).
	"""
	pts = [p for p in points if np.isfinite(p[0])]
	if len({round(math.log10(p[0]), 3) for p in pts}) < 2:
		return float("nan"), float("nan"), np.array([]), np.array([])
	beta = np.array([2 * vr * rth / r0 * rate for rate, vr, tc, rth, r0 in pts])
	tc = np.array([p[2] for p in pts])
	x = 1.0 / (rm.K_B * tc)
	y = np.log(beta / tc ** 2)
	slope, icpt = np.polyfit(x, y, 1)
	return float(-slope), float(icpt), x, y


@dataclass
class SetFeatures:
	R_hrs: float	# 저전계 HRS 저항, R_L 뺀 값 [ohm]
	v_set: float	# 전류가 처음으로 0.9*I_CC 이상 (CC 없으면 가장 크게 오르는 점) [V]


def set_features(v, i, icc=float("nan"), RL=0.0, v_lin=0.2):
	"""SET 스윕에서 특징값."""
	v = np.asarray(v, float)
	i = np.abs(np.asarray(i, float))
	R = low_field_resistance(v, i, v_lin) - RL
	if np.isfinite(icc):
		hit = np.where(i >= 0.9 * icc)[0]
		vs = float(v[hit[0]]) if hit.size else float("nan")
	else:
		ratio = i[1:] / np.maximum(i[:-1], 1e-30)
		vs = float(v[int(np.argmax(ratio)) + 1])
	return SetFeatures(R, vs)


def oxide_resistivity(R_pristine, p):
	"""포밍 전(필라멘트 없음) 저전계 저항으로 산화막 비저항 [ohm m] = R*A_cell/L0 (A44)."""
	return (R_pristine - p.RL) * p.A_cell / p.L0


# ---------------------------------------------------------------- 모델 쪽 계산 (정적, 빠름)
def uniform_cf(phi, p, gs=rm.DEFAULT_GRID):
	g = rm.make_grid(p, gs)
	return np.full(len(g.zc), phi / 2)


def gap_profile(phi, gap, p, gs=rm.DEFAULT_GRID, r_neck=0.0):
	"""지름 phi CF의 가운데 길이 gap 구간을 반경 r_neck(기본 0 = 완전히 끊긴 갭)으로 둔 형상.

	[R] Fig. 2·6: 열 용해는 가운데(최고 온도)에서 시작한다. 갭 안은 산화막.
	"""
	g = rm.make_grid(p, gs)
	rb = np.full(len(g.zc), phi / 2)
	rb[np.abs(g.zc - p.L0 / 2) <= gap / 2] = r_neck
	return rb


def filament_static(rb, p, v_list, gs=rm.DEFAULT_GRID):
	"""필라멘트 1개의 정적 I-V (R_L 없음). 반환: (I [A], Tmax [K])."""
	g = rm.make_grid(p, gs)
	fs = rm.FieldSolver(g, p, rb, gs)
	I = np.empty(len(v_list))
	T = np.empty(len(v_list))
	for k, v in enumerate(v_list):
		f = fs.solve(float(v))
		I[k] = f.I
		T[k] = f.T.max()
	return I, T


def model_lrs_curve(p, phis, T_target, alpha=None, gs=rm.DEFAULT_GRID, n_pts=8):
	"""필라멘트 지름마다 측정과 같은 방법으로 뽑은 R0, Rth (필라멘트 1개).

	필라멘트에 전압을 올려 최고 온도가 T_target에 이를 때까지의 정적 R(V)를 만들고,
	측정과 똑같이 [C] 식 (5)로 온도를 뽑아 Rth를 맞춘다 (같은 추출을 양쪽에 적용, A43).
	alpha: 추출에 쓸 저항 온도 계수 (기본: 모델의 alpha_T).
	반환: dict(phi, R0, Rth, ratio=Rth/R0) 배열.
	"""
	alpha = p.alpha_T if alpha is None else alpha
	out = {"phi": [], "R0": [], "Rth": [], "Rth_true": []}
	for phi in phis:
		rb = uniform_cf(phi, p, gs)
		g = rm.make_grid(p, gs)
		fs = rm.FieldSolver(g, p, rb, gs)
		f0 = fs.solve(1e-3)
		R0 = 1e-3 / f0.I
		# T_target에 이르는 전압을 대략 찾는다: Tmax - T0 ~ V^2
		f1 = fs.solve(0.1)
		v_top = 0.1 * math.sqrt(max(T_target - p.T0, 1.0) / max(f1.T.max() - p.T0, 1e-6))
		for _ in range(6):
			ft = fs.solve(v_top)
			if abs(ft.T.max() - T_target) < 2:
				break
			v_top *= math.sqrt((T_target - p.T0) / max(ft.T.max() - p.T0, 1e-6))
		vs = np.linspace(v_top / n_pts, v_top, n_pts)
		I, T = filament_static(rb, p, vs, gs)
		R = vs / I
		P = vs * I
		Tx = russo_temperature(R, R0, alpha, p.T0)
		out["phi"].append(phi)
		out["R0"].append(R0)
		out["Rth"].append(float(np.sum(P * (Tx - p.T0)) / np.sum(P ** 2)))
		out["Rth_true"].append(float(np.sum(P * (T - p.T0)) / np.sum(P ** 2)))
	out = {k: np.array(v) for k, v in out.items()}
	out["ratio"] = out["Rth"] / out["R0"]
	return out


@dataclass
class LrsFit:
	phi: float	# 필라멘트 지름 [m]
	N: float	# 병렬 필라멘트 수 (연속값)
	phi_lo: float	# 비율 Rth/R0 를 ±rel 흔들었을 때 지름 범위 [m]
	phi_hi: float
	curve: dict = field(repr=False, default_factory=dict)


def fit_lrs(R0, Rth, p, T_target, alpha=None, gs=rm.DEFAULT_GRID, rel=0.2, phis=None):
	"""측정 R0 (R_L 뺀 값)와 Rth로 필라멘트 지름과 개수 (A43).

	N개 동일 필라멘트 병렬이면 R0 = R_fil/N, Rth = Rth_fil/N 이라 Rth/R0 = Rth_fil/R_fil 은 N과 무관하다.
	그래서 비율로 지름을 정하고, R0로 개수를 정한다 ([C] 식 (7)의 sigma/kappa_eq 분석과 같은 원리).
	"""
	if phis is None:
		phis = np.geomspace(3e-9, 1.9 * p.R_dom, 24)
	c = model_lrs_curve(p, phis, T_target, alpha, gs)
	lr = np.log(c["ratio"])
	order = np.argsort(lr)

	def phi_at(q):
		x = math.log(q)
		if x < lr[order][0] or x > lr[order][-1]:
			return float("nan")
		return float(np.exp(np.interp(x, lr[order], np.log(c["phi"][order]))))

	q = Rth / R0
	phi = phi_at(q)
	N = float(np.exp(np.interp(math.log(phi), np.log(c["phi"]), np.log(c["R0"])))) / R0 if np.isfinite(phi) else float("nan")
	lo, hi = sorted([phi_at(q * (1 - rel)), phi_at(q * (1 + rel))])
	return LrsFit(phi, N, lo, hi, c)


def device_resistance(rb, N, p, gs=rm.DEFAULT_GRID, v_read=0.1):
	"""필라멘트 N개(동일) 병렬 + 셀 산화막 누설의 저전계 저항 (R_L 뺀 값) [ohm]."""
	I, _ = filament_static(rb, p, [v_read], gs)
	g_ox = p.A_cell / (p.rho_ox * p.L0)
	return v_read / (N * I[0] + g_ox * v_read)


@dataclass
class GapFit:
	gap: float	# r = 0 갭 길이 [m] (mode "gap")
	r_neck: float	# 잘록 반경 [m] (mode "neck")
	neck_len: float	# 가정한 잘록 길이 [m]


def fit_gap(R_hrs, phi, N, p, gs=rm.DEFAULT_GRID, neck_len=None):
	"""HRS 저항으로 갭 크기 (A45). 두 가지로 푼다.

	gap : 가운데 길이 gap 구간이 완전히 끊김 (r = 0, 산화막으로 채움). 갭 길이를 푼다.
	neck: 가운데 길이 neck_len 구간이 반경 r_neck 으로 가늘어짐. r_neck을 푼다.
	R_hrs가 모델 범위 밖이면 nan.
	"""
	g = rm.make_grid(p, gs)
	dz = p.L0 / len(g.zc)
	neck_len = 2 * dz if neck_len is None else neck_len

	def r_of_gap(gap):
		return device_resistance(gap_profile(phi, gap, p, gs), N, p, gs)

	def r_of_neck(rn):
		return device_resistance(gap_profile(phi, neck_len, p, gs, rn), N, p, gs)

	gap = float("nan")
	lo, hi = dz, p.L0
	if r_of_gap(lo) <= R_hrs <= r_of_gap(hi):
		gap = brentq(lambda x: math.log(r_of_gap(x) / R_hrs), lo, hi, xtol=0.05 * dz)
	rn = float("nan")
	lo, hi = 0.2 * p.dr, phi / 2
	if r_of_neck(hi) <= R_hrs <= r_of_neck(lo):
		rn = brentq(lambda x: math.log(r_of_neck(x) / R_hrs), lo, hi, xtol=0.01e-9)
	return GapFit(gap, rn, neck_len)


# ---------------------------------------------------------------- 모델 쪽 계산 (과도, 느림)
def params_with_N(p, N):
	"""N(연속값)을 가장 가까운 정수 개수로 두도록 n_f를 맞춘 파라미터 (A10은 정수 개수)."""
	return replace(p, n_f=max(1, round(N)) / p.A_cell)


def model_v_reset(rb, p, rate, v_max, gs=rm.DEFAULT_GRID):
	"""RESET 램프(제한 없음)에서 전류 최대점 전압 [V]. 측정과 같은 reset_features로 뽑는다."""
	r = rm.simulate(rm.ramp_waveform("reset", v_max, rate), rb, p, gs, Rs_reset=0.0)
	f = reset_features(r.v_app, r.i, p.RL)
	return f.v_reset, r


def fit_vD0(v_reset, rb, p, rate, gs=rm.DEFAULT_GRID, span=1e3):
	"""측정 V_reset에 맞는 열 용해 전인자 v_D0 [m/s] ([R] 식 (5), E_d 고정). vD0가 클수록 V_reset이 낮다."""
	v_max = 1.5 * v_reset + 0.5

	def resid(lv):
		vr, _ = model_v_reset(rb, replace(p, vD0=math.exp(lv)), rate, v_max, gs)
		return vr - v_reset

	lo, hi = math.log(p.vD0 / span), math.log(p.vD0 * span)
	a, b = resid(lo), resid(hi)
	if a * b > 0:
		return float("nan")
	return math.exp(brentq(resid, lo, hi, xtol=0.02))


def fit_dissolution(points, rb, p, gs=rm.DEFAULT_GRID, Ed_range=(0.8, 2.0), T_ref=650.0, log=print):
	"""램프 속도가 다른 RESET들의 V_reset에 맞는 (E_d [J], v_D0 [m/s]) (A47).

	points: (rate [V/s], v_reset [V]). E_d를 정하면 가운데 램프 속도의 V_reset으로 v_D0가 정해지고,
	그때 가장 느린·빠른 램프의 V_reset 차이가 측정과 같아지도록 E_d를 찾는다.
	램프 속도가 하나면 E_d는 p.Ed로 두고 v_D0만 맞춘다. 과도 계산 수십 번 (수 분~수십 분).
	"""
	pts = sorted(points)
	rates = [r for r, _ in pts]
	mid = len(pts) // 2
	if len({round(math.log10(r), 3) for r in rates}) < 2:
		return p.Ed, fit_vD0(pts[mid][1], rb, p, pts[mid][0], gs)
	d_meas = pts[-1][1] - pts[0][1]

	cache = {}

	def at(ed):
		key = round(ed, 6)
		if key in cache:
			return cache[key]
		# E_d를 바꾸면 v_D0 출발값도 T_ref [K]에서 속도가 같도록 옮긴다 (탐색 범위 안에 들게)
		pe = replace(p, Ed=ed * rm.EV, vD0=p.vD0 * math.exp((ed * rm.EV - p.Ed) / (rm.K_B * T_ref)))
		vd = fit_vD0(pts[mid][1], rb, pe, pts[mid][0], gs)
		if not np.isfinite(vd):
			cache[key] = (float("nan"), vd)
			return cache[key]
		pe = replace(pe, vD0=vd)
		v_lo, _ = model_v_reset(rb, pe, pts[0][0], 1.5 * pts[0][1] + 0.5, gs)
		v_hi, _ = model_v_reset(rb, pe, pts[-1][0], 1.5 * pts[-1][1] + 0.5, gs)
		log(f"    E_d {ed:.3f} eV → v_D0 {vd:.3g} m/s, V_reset 차이 {v_hi - v_lo:.3f} V (측정 {d_meas:.3f} V)")
		cache[key] = ((v_hi - v_lo) - d_meas, vd)
		return cache[key]

	# E_d가 클수록 열 활성이 가팔라 램프 속도에 덜 민감하다 (V_reset 차이가 작아진다)
	lo, hi = Ed_range
	f_lo, _ = at(lo)
	f_hi, _ = at(hi)
	if not (np.isfinite(f_lo) and np.isfinite(f_hi)) or f_lo * f_hi > 0:
		return float("nan"), float("nan")
	ed = brentq(lambda x: at(x)[0], lo, hi, xtol=0.02)
	_, vd = at(ed)
	return ed * rm.EV, vd


def model_v_set(rb, p, rate, v_max, icc, gs=rm.DEFAULT_GRID):
	"""CC SET 램프에서 전류가 처음 0.9*I_CC에 닿는 전압 [V]."""
	r = rm.simulate(rm.ramp_waveform("set", v_max, rate), rb, p, gs, i_cc=icc)
	return set_features(r.v_app, r.i, icc, p.RL).v_set, r


def fit_Ea(v_set, rb, p, rate, icc, gs=rm.DEFAULT_GRID, lo_eV=0.4, hi_eV=1.4):
	"""측정 V_set에 맞는 SET 활성화 에너지 E_a [J] ([D] 식 (2)). E_a가 클수록 V_set이 높다."""
	v_max = 1.5 * v_set + 0.5

	def resid(ea):
		vs, _ = model_v_set(rb, replace(p, Ea=ea * rm.EV), rate, v_max, icc, gs)
		return (vs if np.isfinite(vs) else v_max) - v_set

	a, b = resid(lo_eV), resid(hi_eV)
	if a * b > 0:
		return float("nan")
	return brentq(resid, lo_eV, hi_eV, xtol=0.005) * rm.EV


# ---------------------------------------------------------------- 전체 흐름
@dataclass
class Inversion:
	reset: list	# (Sweep, ResetFeatures, RussoResult)
	sets: list	# (Sweep, SetFeatures)
	rho_ox: float	# 포밍 전 저항에서 뽑은 산화막 비저항 [ohm m] (없으면 nan)
	Ed_kissinger: float	# [J], [C] Kissinger 참고값 (램프 속도 2가지 이상일 때)
	Ed: float	# [J], 모델로 맞춘 열 용해 활성화 에너지 (램프 속도 2가지 이상일 때, 아니면 nan)
	lrs: LrsFit
	gap: GapFit
	vD0: float	# [m/s]
	Ea: float	# [J]
	params: rm.Params	# 역산값을 넣은 파라미터


def invert(sweeps, p, alpha=None, gamma=2.0 / 3.0, gs=rm.DEFAULT_GRID, kinetics=True, v_lin=0.2, log=print):
	"""측정 스윕 목록 → 역산 결과. 단계마다 log로 진행을 알린다.

	1. 포밍 전 스윕 → 산화막 비저항 (A44)
	2. RESET 스윕 → R0, V_reset, [C] 식 (5)-(7) → T_crit, Rth (+ Kissinger E_d)
	3. Rth/R0 → 필라멘트 지름, R0 → 개수 (A43)
	4. SET 스윕의 HRS 저항 → 갭 (A45)
	5. (kinetics) 램프 속도별 V_reset → E_d, v_D0 (A47), V_set → E_a (과도 계산, 느림)
	"""
	alpha = p.alpha_T if alpha is None else alpha
	rho_ox = float("nan")
	forming = [s for s in sweeps if s.op == "forming"]
	if forming:
		rp = np.median([low_field_resistance(s.v, s.i, v_lin) for s in forming])
		rho_ox = oxide_resistivity(rp, p)
		p = replace(p, rho_ox=rho_ox)
		log(f"[1] 포밍 전 저항 {rp:.3g} Ω → 산화막 비저항 {rho_ox:.3g} Ω·m")
	reset = []
	for s in sweeps:
		if s.op != "reset":
			continue
		f = reset_features(s.v, s.i, p.RL, v_lin)
		if f.drop > 0.5:
			log(f"    스윕 {s.sweep}: RESET이 끝나지 않음 (최대 전류 뒤 최소/최대 = {f.drop:.2f}) → 제외")
			continue
		rr = russo_extraction(f, alpha, p.T0, gamma)
		reset.append((s, f, rr))
	if not reset:
		raise ValueError("RESET 스윕이 없습니다")
	R0 = float(np.median([f.R0 for _, f, _ in reset]))
	Rth = float(np.median([rr.Rth_fit for _, _, rr in reset]))
	T_crit = float(np.median([rr.T_crit for _, _, rr in reset]))
	v_reset = float(np.median([f.v_reset for _, f, _ in reset]))
	log(f"[2] RESET {len(reset)}개: R0 {R0:.4g} Ω, V_reset {v_reset:.3g} V, T_crit {T_crit:.0f} K, Rth {Rth:.3g} K/W")
	Ed_k, _, _, _ = kissinger([(s.rate, f.v_reset, rr.T_crit, rr.Rth_fit, f.R0) for s, f, rr in reset])
	if np.isfinite(Ed_k):
		log(f"    참고: Kissinger E_d = {Ed_k / rm.EV:.2f} eV ([C] 식 (5) 온도 사용, 온도 오차에 매우 민감해 모델에 넣지 않음, A47)")
	lrs = fit_lrs(R0, Rth, p, T_crit, alpha, gs)
	log(f"[3] 필라멘트 지름 {lrs.phi * 1e9:.1f} nm (Rth/R0 ±20% → {lrs.phi_lo * 1e9:.1f}–{lrs.phi_hi * 1e9:.1f} nm), 개수 {lrs.N:.2f}")
	sets = []
	for s in sweeps:
		if s.op == "set":
			sets.append((s, set_features(s.v, s.i, s.icc, p.RL, v_lin)))
	gap = GapFit(float("nan"), float("nan"), float("nan"))
	if sets and np.isfinite(lrs.phi):
		R_hrs = float(np.median([f.R_hrs for _, f in sets]))
		gap = fit_gap(R_hrs, lrs.phi, lrs.N, p, gs)
		gtxt = f"끊긴 갭 {gap.gap * 1e9:.2f} nm" if np.isfinite(gap.gap) else "완전히 끊긴 갭으로는 저항이 너무 커서 설명 안 됨"
		log(f"[4] HRS {R_hrs:.4g} Ω → {gtxt}; 길이 {gap.neck_len * 1e9:.0f} nm 잘록 구간이면 반경 {gap.r_neck * 1e9:.2f} nm")
	vD0 = Ea = Ed = float("nan")
	if kinetics and np.isfinite(lrs.phi):
		pN = params_with_N(p, lrs.N)
		pts = [(s.rate, f.v_reset) for s, f, _ in reset if np.isfinite(s.rate)]
		if pts:
			ed, vD0 = fit_dissolution(pts, uniform_cf(lrs.phi, pN, gs), pN, gs, log=log)
			if len({round(math.log10(r), 3) for r, _ in pts}) >= 2:
				Ed = ed
			log(f"[5] RESET 속도: E_d {ed / rm.EV:.3f} eV{'' if np.isfinite(Ed) else ' (고정)'}, v_D0 {vD0:.3g} m/s")
			if np.isfinite(vD0):
				p = replace(p, Ed=ed, vD0=vD0)
				pN = replace(pN, Ed=ed, vD0=vD0)
		srates = [(s.rate, s.icc, f.v_set) for s, f in sets if np.isfinite(s.rate) and np.isfinite(s.icc) and np.isfinite(f.v_set)]
		if srates and np.isfinite(gap.gap):
			rate, icc, vs = (float(np.median([x[k] for x in srates])) for k in range(3))
			Ea = fit_Ea(vs, gap_profile(lrs.phi, gap.gap, pN, gs), pN, rate, icc, gs)
			log(f"    I_CC {icc:.3g} A에서 V_set {vs:.3g} V → E_a {Ea / rm.EV:.3f} eV")
			if np.isfinite(Ea):
				p = replace(p, Ea=Ea)
	if np.isfinite(lrs.N):
		p = params_with_N(p, lrs.N)
	if np.isfinite(lrs.phi):
		p = replace(p, phi0=lrs.phi)
	return Inversion(reset, sets, rho_ox, Ed_k, Ed, lrs, gap, vD0, Ea, p)
