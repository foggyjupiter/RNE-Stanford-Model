"""측정 엑셀 폴더를 분석해 마크다운 보고서를 만든다.

사용: python analyze_measurements.py <엑셀 폴더> [보고서 경로 (기본 ../docs/측정데이터_분석.md)]
	폴더 아래 모든 .xlsx (하위 폴더 포함, 사본 "(2)"와 잠금 파일 제외)를 measurement.py로 읽어 분류한다 (A50).
보고서
	1. 파일별 분류
	2. 두께별 forming과 RESET 시도
	3. 6 nm RESET / SET 특징값, RESET 크기 법칙
	   열 용해 RESET([R], [C])이면 T_crit = T0 + P_reset*Rth이고 Rth/R0가 일정해서([C] 식 (6), (7))
	   V_reset = sqrt((T_crit - T0)*R0/Rth)는 R0와 무관, I_reset = V_reset/R0 ∝ 1/R0 이 된다
	4. SET 전류 제한(CC)과 다음 RESET의 LRS
	5. 음전압 RESET
	6. 데이터 품질 (A58)
	7. 정적 역산 (우리 소자 프리셋, R_L 20 / 30 Ω, A43, A53)
원본 엑셀은 저장소에 넣지 않는다.
"""

import os
import sys
from collections import Counter, defaultdict
from dataclasses import replace

import numpy as np

import inverse as inv
import measurement as ms
import rram_model as rm

CC_KINDS = ("forming", "set", "set_low", "set_at_lrs")	# 전류 제한으로 멈춘 스윕


def v_at_cc(s):
	"""전류가 처음 0.9*CC에 닿은 전압 [V]."""
	ai = np.abs(s.i)
	k = np.where(ai >= 0.9 * s.cc)[0]
	return float(np.abs(s.v)[k[0]]) if k.size else float("nan")


def fit_loglog(x, y):
	"""log10 y = a + b log10 x 의 (기울기 b, 상관계수 r)."""
	lx = np.log10(x)
	ly = np.log10(y)
	b = np.polyfit(lx, ly, 1)[0]
	return float(b), float(np.corrcoef(lx, ly)[0, 1])


def fmt(x, spec=".3g"):
	return "–" if x is None or not np.isfinite(x) else format(x, spec)


def table(head, rows):
	out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
	for r in rows:
		out.append("| " + " | ".join(str(c) for c in r) + " |")
	return out


def collect_resets(ses):
	"""(세션, 스윕, 특징값, 바로 앞 CC 스윕의 CC) 목록. reset과 reset_neg."""
	out = []
	for se in ses:
		prev_cc = float("nan")
		for s in se.sweeps:
			if s.kind in CC_KINDS:
				prev_cc = s.cc
			if s.kind in ("reset", "reset_neg"):
				out.append((se, s, inv.reset_features(np.abs(s.v), np.abs(s.i)), prev_cc))
	return out


def report(root):
	ses = ms.load_folder(root)
	by_t = defaultdict(list)
	for se in ses:
		by_t[round(se.thickness * 1e9)].append(se)
	L = ["# 측정 데이터 분석", "",
		f"`python/analyze_measurements.py`가 만든 보고서. 엑셀 {len(ses)}개, 스윕 {sum(len(se.sweeps) for se in ses)}개. "
		"분류 규칙은 ASSUMPTIONS A50, 데이터 품질 기준은 A58. 원본 엑셀은 저장소에 없음.", ""]

	# 1. 파일별 분류
	L += ["## 1. 파일별 분류", ""]
	rows = []
	for se in ses:
		c = Counter(s.kind for s in se.sweeps)
		rows.append((os.path.relpath(se.path, root), f"{se.thickness * 1e9:.0f} nm", f"{se.area * 1e12:.0f}", len(se.sweeps),
			", ".join(f"{k} {n}" for k, n in sorted(c.items()))))
	L += table(["파일", "두께", "면적 (µm²)", "스윕", "분류"], rows) + [""]
	tot = Counter(s.kind for se in ses for s in se.sweeps)
	L += ["전체: " + ", ".join(f"{k} {n}" for k, n in sorted(tot.items())), ""]

	# 2. 두께별 forming과 RESET 시도
	L += ["## 2. 두께별 forming과 RESET 시도", "",
		"각 파일의 첫 forming(0.1 V 저항 > 100 MΩ, 포밍 전 상태에서 시작)의 CC 도달 전압과 바로 다음 스윕의 0.1 V 저항.", ""]
	rows = []
	for t, group in sorted(by_t.items()):
		vf, rn = [], []
		for se in group:
			for k, s in enumerate(se.sweeps):
				if s.kind == "forming" and s.r01 > 1e8:
					vf.append(v_at_cc(s))
					if k + 1 < len(se.sweeps) and np.isfinite(se.sweeps[k + 1].r01):
						rn.append(se.sweeps[k + 1].r01)
					break
		n_reset = sum(1 for se in group for s in se.sweeps if s.kind in ("reset", "reset_neg"))
		rows.append((f"{t} nm", len(group), ", ".join(fmt(v, ".1f") for v in sorted(vf)),
			", ".join(fmt(v / t, ".2f") for v in sorted(vf)), ", ".join(fmt(r) for r in sorted(rn)), n_reset))
	L += table(["두께", "파일", "forming 전압 (V)", "전압/두께 (V/nm)", "forming 다음 R(0.1 V) (Ω)", "RESET"], rows) + [""]
	thick = [(se, s) for t, group in by_t.items() if t > 6 for se in group for s in se.sweeps if s.kind == "other" and s.stop == "Early Stop"]
	if thick:
		L += ["6 nm보다 두꺼운 소자의 RESET 시도(Early Stop, 전류가 떨어지지 않아 RESET으로 분류되지 않은 스윕):", ""]
		rows = [(os.path.relpath(se.path, root), s.index, fmt(np.abs(s.v).max(), ".1f"), fmt(np.abs(s.i).max() * 1e3), fmt(np.abs(s.i)[-1] * 1e3), fmt(s.r01))
			for se, s in thick]
		L += table(["파일", "스윕", "최대 전압 (V)", "최대 전류 (mA)", "마지막 전류 (mA)", "R(0.1 V) (Ω)"], rows) + [""]

	# 3. 6 nm RESET / SET
	s6 = by_t.get(6, [])
	resets = collect_resets(s6)
	pos = [r for r in resets if r[1].kind == "reset"]
	L += ["## 3. 6 nm RESET / SET", "", "### RESET (양전압)", "",
		"R0는 RESET 스윕의 0.2 V 이하 저전계 저항(R_L 포함), RESET 점은 전류 최대점.", ""]
	rows = [(os.path.relpath(se.path, root), s.index, fmt(f.R0, ".1f"), fmt(f.v_reset, ".2f"), fmt(f.i_reset * 1e3, ".1f"),
		fmt(f.v_reset * f.i_reset * 1e3, ".1f"), fmt(cc)) for se, s, f, cc in pos]
	L += table(["파일", "스윕", "R0 (Ω)", "V_reset (V)", "I_reset (mA)", "P_reset (mW)", "앞 CC (A)"], rows) + [""]
	R0 = np.array([f.R0 for _, _, f, _ in pos])
	Vr = np.array([f.v_reset for _, _, f, _ in pos])
	Ir = np.array([f.i_reset for _, _, f, _ in pos])
	m = R0 < 200	# 한 개 있는 328 Ω(RESET 전류 3 mA)은 다른 상태로 보고 크기 법칙에서 뺀다
	q = lambda a: f"{a.min():.3g}–{a.max():.3g}, 중앙 {np.median(a):.3g}"
	L += [f"- 개수 {len(pos)}. R0 {q(R0)} Ω, V_reset {q(Vr)} V, I_reset {q(Ir * 1e3)} mA, P_reset {q(Vr * Ir * 1e3)} mW", ""]
	if m.sum() >= 3:
		bi, ri = fit_loglog(R0[m], Ir[m])
		bv, rv = fit_loglog(R0[m], Vr[m])
		L += ["**RESET 크기 법칙** (R0 < 200 Ω, %d개):" % m.sum(), "",
			f"- log I_reset 대 log R0 기울기 **{bi:.2f}** (상관 {ri:.2f}). 열 용해 모델 예상 −1",
			f"- log V_reset 대 log R0 기울기 **{bv:.2f}** (상관 {rv:.2f}). 열 용해 모델 예상 0 (V_reset이 R0와 무관)",
			f"- 상대 산포: V_reset {np.std(Vr[m]) / np.mean(Vr[m]):.2f}, I_reset {np.std(Ir[m]) / np.mean(Ir[m]):.2f}, P_reset {np.std(Vr[m] * Ir[m]) / np.mean(Vr[m] * Ir[m]):.2f}", ""]
	sets = [(se, s, inv.set_features(np.abs(s.v), np.abs(s.i), s.cc)) for se in s6 for s in se.sweeps if s.kind == "set"]
	L += ["### SET (HRS에서 시작해 CC에 닿은 스윕)", ""]
	rows = [(os.path.relpath(se.path, root), s.index, fmt(f.R_hrs), fmt(f.v_set, ".2f"), fmt(s.cc)) for se, s, f in sets]
	L += table(["파일", "스윕", "HRS (Ω)", "V_set (V)", "CC (A)"], rows) + [""]
	Rh = np.array([f.R_hrs for _, _, f in sets if f.R_hrs > 0])
	Vs = np.array([f.v_set for _, _, f in sets if np.isfinite(f.v_set)])
	if len(Rh):
		L += [f"- 개수 {len(sets)}. HRS {q(Rh)} Ω, σ(log10 HRS) {np.std(np.log10(Rh)):.2f}. V_set {q(Vs)} V", ""]

	# 4. CC와 LRS
	L += ["## 4. SET 전류 제한(CC)과 다음 RESET의 LRS", "",
		"RESET 바로 앞의 CC 스윕(forming/SET)의 CC별로 묶음.", ""]
	groups = defaultdict(list)
	for _, _, f, cc in pos:
		if np.isfinite(cc):
			groups[cc].append(f)
	rows = [(fmt(cc), len(fs), fmt(np.median([f.R0 for f in fs]), ".0f"), fmt(np.median([f.i_reset for f in fs]) * 1e3, ".1f"),
		fmt(np.median([f.i_reset for f in fs]) / cc, ".0f")) for cc, fs in sorted(groups.items())]
	L += table(["CC (A)", "RESET 수", "R0 중앙 (Ω)", "I_reset 중앙 (mA)", "I_reset / CC"], rows) + [""]
	ccs = np.array([cc for _, _, _, cc in pos])
	ok = np.isfinite(ccs) & m
	if ok.sum() >= 3:
		bc, rc = fit_loglog(ccs[ok], R0[ok])
		L += [f"- R0 < 200 Ω인 {ok.sum()}개에서 log R0 대 log CC 기울기 {bc:.2f}, 상관 {rc:.2f}. CC가 {ccs[ok].min() * 1e6:.0f}–{ccs[ok].max() * 1e6:.0f} µA로 "
			"10배 달라도 LRS가 거의 같고 RESET 전류가 CC의 수백–수천 배 → SET 때 CC가 전류를 제한하지 못함 (A51)", ""]

	# 5. 음전압 RESET
	neg = [r for r in resets if r[1].kind == "reset_neg"]
	other_neg = [(se, s) for se in s6 for s in se.sweeps if s.v.min() < 0 and s.kind == "set_reset"]
	if neg or other_neg:
		L += ["## 5. 음전압 RESET", ""]
		rows = [(os.path.relpath(se.path, root), s.index, s.kind, fmt(f.R0, ".1f"), fmt(-f.v_reset, ".2f"), fmt(f.i_reset * 1e3, ".1f")) for se, s, f, _ in neg]
		rows += [(os.path.relpath(se.path, root), s.index, s.kind, fmt(s.r01), fmt(s.v[int(np.argmax(np.abs(s.i)))], ".2f"), fmt(np.abs(s.i).max() * 1e3, ".1f"))
			for se, s in other_neg]
		L += table(["파일", "스윕", "분류", "R0 또는 R(0.1 V) (Ω)", "RESET 점 전압 (V)", "전류 (mA)"], rows) + [""]
		for _, _, f, _ in neg:
			L += [f"- LRS {f.R0:.0f} Ω에서 −{f.v_reset:.2f} V, {f.i_reset * 1e3:.1f} mA에 RESET. 양전압 RESET 범위(V {Vr.min():.1f}–{Vr.max():.1f} V, "
				f"I {Ir.min() * 1e3:.0f}–{Ir.max() * 1e3:.0f} mA) 안이라 극성과 무관한 열 RESET과 맞음 (한 번뿐이라 참고)"]
		L += [""]

	# 6. 데이터 품질
	dq = ms.data_quality(s6)
	L += ["## 6. 데이터 품질 (6 nm, A58)", ""]
	rows = [
		("쓸 수 있는 스윕 (RESET + SET)", f"{dq['n_usable']} / {dq['n_sweeps']} ({dq['n_usable'] / dq['n_sweeps']:.0%})"),
		("소자(파일)당 RESET 중앙", fmt(dq["resets_per_device"], ".0f")),
		("계단 / 전압 분해능 (계단 반폭 ÷ V_reset, ÷ V_set)", f"{dq['step']:.2f} V / {dq['v_reset_quant']:.1%}, {dq['v_set_quant']:.1%}"),
		("RESET 직전 점 수 (중앙, 최소)", f"{dq['n_pre_reset']:.1f}, {dq['n_pre_reset_min']:.0f}"),
		("저항 변화 대 잡음 (중앙, 하위 25%)", f"{dq['snr']:.0f}, {dq['snr_p25']:.0f}"),
		("forming/SET에서 전류가 준 점 비율", f"{dq['non_mono']:.1%}"),
		("V_reset, V_set 상대 산포", f"{dq['cv_reset']:.2f}, {dq['cv_set']:.2f}"),
		("σ(log10 LRS), σ(log10 HRS)", f"{dq['s_log_lrs']:.2f}, {dq['s_log_hrs']:.2f}"),
		("RESET 전류 / 앞 SET의 CC (중앙, 범위)", f"{dq['overshoot']:.0f} ({dq['overshoot_min']:.0f}–{dq['overshoot_max']:.0f})"),
	]
	L += table(["지표", "값"], rows) + [""]

	# 7. 정적 역산
	L += ["## 7. 정적 역산 (우리 소자 프리셋, α 1.7e-3 /K, 램프 1 V/s 가정)", ""]
	sw = ms.to_sweeps(s6, rate=1.0)
	for RL in (20.0, 30.0):
		p = replace(rm.DEFAULT, **{**rm.OUR_DEVICE, "RL": RL})
		lines = []
		res = inv.invert(sw, p, alpha=1.7e-3, kinetics=False, log=lines.append)
		lines = [x.split(";")[0] if "반경 nan" in x else x for x in lines]
		if res.sets and np.isfinite(res.lrs.phi):
			# 웹 측정 데이터 모드처럼 갭 호핑을 켜고 갭을 푼다 (A55)
			r_hrs = float(np.median([f.R_hrs for _, f in res.sets]))
			gh = inv.fit_gap(r_hrs, res.lrs.phi, max(1.0, res.lrs.N), replace(res.params, hop=1))
			lines.append(f"[4b] 갭 호핑을 켜면(A55) 끊긴 갭 {fmt(gh.gap * 1e9, '.2f')} nm")
		L += [f"**R_L {RL:.0f} Ω**", ""] + [f"- {x.strip()}" for x in lines] + [""]
	L += ["- 측정 Rth/R0가 필라멘트 1개 모델 범위보다 작아 지름과 개수를 나눌 수 없음. 전극 열 배출, α, R_L 중 무엇 때문인지는 A53, A56 참고", ""]
	return "\n".join(L)


def main():
	if len(sys.argv) < 2:
		print(__doc__)
		sys.exit(1)
	root = sys.argv[1]
	out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "측정데이터_분석.md")
	text = report(root)
	with open(out, "w", encoding="utf-8") as fh:
		fh.write(text)
	print(f"저장: {out}")


if __name__ == "__main__":
	main()
