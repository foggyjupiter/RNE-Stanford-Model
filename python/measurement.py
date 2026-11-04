"""측정 프로그램이 내보낸 엑셀(.xlsx)을 읽어 스윕을 분류하고 inverse.py 형식으로 바꾼다.

엑셀 형식 (파일 하나 = 소자 하나, 시트 하나 = 측정 순서대로 한 스윕)
	Sweep Name            "Sweep 3 (0.0V~5.0V, Step 0.1V) (Compliance Stop)"
	Sweep Range           "0.0V to 5.0V (step 0.1V)"
	Area Constant (um^2)  20800
	Compliance I (A)      1e-05
	(빈 줄)
	Voltage (V) | Current I (A) | Current Density J (A/cm^2)
멈춘 방식: Compliance Stop = 전류가 CC에 닿아 측정기가 멈춤 (SET),
	Early Stop = 전류가 떨어진 뒤 손으로 멈춤 (RESET), 표시 없음 = 끝까지 (0-1 V 읽기 등).

분류 규칙 (A50)
	read        표시 없음, |V| <= 1 V
	forming     파일에서 첫 RESET 전에 CC에 닿은 스윕 (포밍 전 상태에서 시작)
	set         첫 RESET 뒤에 CC에 닿은 스윕 (점이 3개 이상, 0.1 V 전류가 CC의 1/100 아래 = HRS에서 시작)
	set_low     첫 RESET 뒤에 CC에 닿았지만 HRS에서 시작하지 않은 스윕 (0.1 V 전류 >= CC/100)
	set_at_lrs  0.1 V에서 바로 CC에 닿은 스윕 (이미 LRS)
	reset       Early Stop, 최대 전류 > 0.1 mA이고 그 뒤 절반 아래로 떨어짐 (음전압이면 reset_neg).
	            최대 전류점까지 저항이 처음 점의 0.9배 아래로 떨어지지 않아야 함 (LRS에서 시작한 RESET)
	set_reset   위와 같지만 RESET 전에 저항이 떨어짐 (제한 없는 RESET 스윕 중에 먼저 SET이 일어남)
	stopped_hrs Early Stop, 최대 전류 < 1 µA (SET이 남지 않아 RESET할 것이 없던 스윕)
	other       그 밖
"""

import glob
import os
import re
from dataclasses import dataclass, field

import numpy as np

import inverse as inv


@dataclass
class MeasuredSweep:
	index: int	# 파일 안 순서 (1부터)
	title: str	# 시트 이름
	kind: str	# 위 분류
	v: np.ndarray	# [V]
	i: np.ndarray	# [A] (부호 그대로)
	cc: float	# 전류 제한 [A]
	stop: str	# "Compliance Stop" | "Early Stop" | ""
	step: float	# 계단 [V]
	r01: float	# 0.1 V 점의 저항 V/I [ohm] (없으면 nan)


@dataclass
class Session:
	path: str
	label: str	# 파일 이름 (확장자 없음)
	thickness: float	# 파일 이름의 "6nm" 등 [m] (없으면 nan)
	area: float	# Area Constant [m^2]
	sweeps: list = field(default_factory=list)


def _r_at(v, i, vq=0.1):
	k = np.where(np.isclose(np.abs(v), vq, atol=1e-6))[0]
	return float(abs(v[k[0]] / i[k[0]])) if k.size and i[k[0]] != 0 else float("nan")


def load_xlsx(path):
	"""엑셀 하나를 Session으로. 시트 순서가 측정 순서."""
	import openpyxl
	wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
	label = os.path.splitext(os.path.basename(path))[0]
	label = re.sub(r"#U([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), label)	# 압축 도구가 바꾼 한글 이름
	m = re.search(r"(\d+(?:\.\d+)?)\s*nm", label)
	ses = Session(path, label, float(m.group(1)) * 1e-9 if m else float("nan"), float("nan"))
	reset_seen = False
	for k, ws in enumerate(wb.worksheets, start=1):
		rows = list(ws.iter_rows(values_only=True))
		meta = {}
		start = None
		for j, r in enumerate(rows):
			if r and r[0] == "Voltage (V)":
				start = j + 1
				break
			if r and r[0] is not None:
				meta[str(r[0]).strip()] = r[1]
		data = [r for r in rows[start or len(rows):] if r and isinstance(r[0], (int, float)) and isinstance(r[1], (int, float))]
		if not data:
			continue
		v = np.array([r[0] for r in data], float)
		i = np.array([r[1] for r in data], float)
		name = str(meta.get("Sweep Name", ws.title))
		stop = "Compliance Stop" if "Compliance Stop" in name else "Early Stop" if "Early Stop" in name else ""
		st = re.search(r"[Ss]tep\s*([\d.]+)\s*V", str(meta.get("Sweep Range", name)))
		step = float(st.group(1)) if st else float("nan")
		cc = float(meta.get("Compliance I (A)", "nan"))
		if np.isnan(ses.area) and meta.get("Area Constant (um^2)") is not None:
			ses.area = float(meta["Area Constant (um^2)"]) * 1e-12
		ai = np.abs(i)
		imax = ai.max()
		kmax = int(np.argmax(ai))
		if stop == "" and np.abs(v).max() <= 1.0 + 1e-9:
			kind = "read"
		elif stop == "Compliance Stop" and imax >= 0.98 * cc:
			if len(v) <= 2:
				kind = "set_at_lrs"
			elif not reset_seen:
				kind = "forming"
			else:
				i01 = ai[np.isclose(np.abs(v), 0.1, atol=1e-6)]
				kind = "set" if i01.size and i01[0] < cc / 100 else "set_low"
		elif stop == "Early Stop" and imax > 1e-4 and ai[kmax:].min() < 0.5 * imax:
			pre = np.abs(v[1:kmax + 1]) / np.maximum(ai[1:kmax + 1], 1e-30)
			from_lrs = pre.size == 0 or pre.min() >= 0.9 * pre[0]
			kind = ("reset_neg" if v.min() < 0 else "reset") if from_lrs else "set_reset"
			reset_seen = True
		elif stop == "Early Stop" and imax < 1e-6:
			kind = "stopped_hrs"
		else:
			kind = "other"
		ses.sweeps.append(MeasuredSweep(k, ws.title, kind, v, i, cc, stop, step, _r_at(v, i)))
	return ses


def load_folder(root, skip_copies=("(2)",)):
	"""폴더 아래 모든 엑셀. 엑셀 잠금 파일(~$)과 이름에 skip_copies가 든 사본은 뺀다."""
	out = []
	for f in sorted(glob.glob(os.path.join(root, "**", "*.xlsx"), recursive=True)):
		b = os.path.basename(f)
		if b.startswith("~$") or any(s in b for s in skip_copies):
			continue
		out.append(load_xlsx(f))
	return out


def to_sweeps(sessions, rate, kinds=("forming", "set", "reset")):
	"""inverse.Sweep 목록으로 (양의 극성만). rate: 평균 램프 속도 [V/s] (A42, A50)."""
	out = []
	n = 0
	for ses in sessions:
		for s in ses.sweeps:
			if s.kind not in kinds:
				continue
			n += 1
			op = "forming" if s.kind == "forming" else s.kind
			out.append(inv.Sweep(n, op, np.abs(s.v), np.abs(s.i), rate, s.cc if s.stop == "Compliance Stop" else float("nan")))
	return out


def first_forming(sessions):
	"""파일마다 첫 forming 스윕 (포밍 전 누설로 산화막 비저항을 볼 때). 0.1 V 저항이 1e8 ohm 넘는 것만."""
	out = []
	for ses in sessions:
		for s in ses.sweeps:
			if s.kind == "forming":
				if s.r01 > 1e8:
					out.append((ses, s))
				break
	return out


def cycles(ses):
	"""파일 안에서 SET(또는 forming) 다음에 바로 이어진 RESET 쌍: (set, reset) 목록."""
	out = []
	prev = None
	for s in ses.sweeps:
		if s.kind in ("forming", "set"):
			prev = s
		elif s.kind == "reset" and prev is not None:
			out.append((prev, s))
			prev = None
	return out


def data_quality(sessions):
	"""데이터 품질 지표 (A58). web/src/model/quality.ts의 qualityNumbers와 같은 계산.

	반환 dict: n_sweeps, n_usable, counts, resets_per_device, n_pre_reset(_min), step, v_reset_quant, v_set_quant,
	snr(_p25), non_mono, cv_reset, cv_set, s_log_lrs, s_log_hrs, overshoot(_min, _max).
	"""
	sw = [s for ses in sessions for s in ses.sweeps]
	counts = {}
	for s in sw:
		counts[s.kind] = counts.get(s.kind, 0) + 1
	resets = [s for s in sw if s.kind == "reset"]
	sets = [s for s in sw if s.kind == "set"]
	npre = [int(np.argmax(np.abs(s.i))) for s in resets]
	vr = [abs(s.v[k]) for s, k in zip(resets, npre)]
	steps = [abs(b - a) for s in resets for a, b in zip(s.v[:-1], s.v[1:])]
	step = float(np.median(steps)) if steps else float("nan")
	vs = [inv.set_features(np.abs(s.v), np.abs(s.i), s.cc).v_set for s in sets]
	snr = []
	for s, k in zip(resets, npre):
		v = np.abs(s.v[1:k + 1])
		i = np.abs(s.i[1:k + 1])
		if len(v) < 4:
			continue
		R, P = v / i, v * i
		res = R - np.polyval(np.polyfit(P, R, 2), P)
		snr.append((R[-1] / R[0] - 1) / max(np.std(res) / np.mean(R), 1e-6))
	non_mono = []
	for s in sw:
		if s.kind in ("forming", "set"):
			a = np.abs(s.i[1:])
			non_mono.append(float(np.mean(np.diff(a) < 0)) if len(a) > 1 else 0.0)
	rl = [inv.reset_features(np.abs(s.v), np.abs(s.i)).R0 for s in resets]
	rh = [r for r in (inv.set_features(np.abs(s.v), np.abs(s.i), s.cc).R_hrs for s in sets) if r > 0]
	ratios = []
	for ses in sessions:
		for a, b in cycles(ses):
			if b.kind == "reset":
				ratios.append(float(np.abs(b.i).max() / a.cc))
	med = lambda a: float(np.median(a)) if len(a) else float("nan")
	cv = lambda a: float(np.std(a) / np.mean(a)) if len(a) > 1 else float("nan")
	slog = lambda a: float(np.std(np.log10(a))) if len(a) > 1 else float("nan")
	return {
		"n_sweeps": len(sw), "n_usable": len(resets) + len(sets), "counts": counts,
		"resets_per_device": med([sum(1 for s in ses.sweeps if s.kind == "reset") for ses in sessions]),
		"n_pre_reset": med(npre), "n_pre_reset_min": float(min(npre)) if npre else float("nan"), "step": step,
		"v_reset_quant": 0.5 * step / med(vr), "v_set_quant": 0.5 * step / med([x for x in vs if np.isfinite(x)]),
		"snr": med(snr), "snr_p25": float(np.percentile(snr, 25)) if snr else float("nan"), "non_mono": med(non_mono),
		"cv_reset": cv(vr), "cv_set": cv([x for x in vs if np.isfinite(x)]),
		"s_log_lrs": slog([r for r in rl if r > 0]), "s_log_hrs": slog(rh),
		"overshoot": med(ratios), "overshoot_min": min(ratios) if ratios else float("nan"), "overshoot_max": max(ratios) if ratios else float("nan"),
	}
