"""측정 데이터 모드(web/src/model/measurement.ts, inverse.ts) 정답지를 만든다.

1. 측정 프로그램과 같은 형식의 엑셀(golden/measure_6nm_fixture.xlsx)을 가상 측정으로 만든다
   (실험 데이터는 저장소에 넣지 않는다). 가상 측정은 examples/synthetic_measurement.csv
   (inverse.ipynb의 NiO 가상 소자)를 0.1 V 계단으로 다시 읽은 것.
2. measurement.py로 분류하고 inverse.py로 정적 역산값을 뽑아 golden/measure.json에 저장한다.
실행: python golden_measure.py
"""

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import openpyxl

import inverse as inv
import measurement as ms
import rram_model as rm

GOLDEN = Path("golden")
src = inv.load_sweeps("examples/synthetic_measurement.csv")


def sheet(wb, n, title, vmax, cc, stop, v, i):
	ws = wb.create_sheet(f"Sweep {n} (0.0V~{vmax:.1f}V, Step 0.1V)")
	ws.append(["Sweep Name", f"Sweep {n} (0.0V~{vmax:.1f}V, Step 0.1V)" + (f" ({stop})" if stop else "")])
	ws.append(["Sweep Range", f"0.0V to {vmax:.1f}V (step 0.1V)"])
	ws.append(["Area Constant (um^2)", 1.0])
	ws.append(["Compliance I (A)", cc])
	ws.append([])
	ws.append(["Voltage (V)", "Current I (A)", "Current Density J (A/cm^2)"])
	for a, b in zip(v, i):
		ws.append([round(float(a), 6), float(b), float(b) / 1e-8])


def step01(s, stop_drop=False):
	"""0.02 V 계단 가상 측정을 0.1 V 계단으로 (0 V 점 포함)."""
	grid = np.round(np.arange(0.0, s.v.max() + 1e-9, 0.1), 6)
	ii = np.interp(grid, s.v, s.i, left=0.0)
	if stop_drop:
		k = int(np.argmax(ii))
		below = np.where(ii[k:] < 0.5 * ii[k])[0]
		end = k + int(below[0]) + 1 if below.size else len(grid)
		grid, ii = grid[:end], ii[:end]
	return grid, ii


wb = openpyxl.Workbook()
wb.remove(wb.active)
by = {s.op: [] for s in src}
for s in src:
	by[s.op].append(s)
n = 0
v = np.round(np.arange(0.0, 3.0 + 1e-9, 0.1), 6)
n += 1; sheet(wb, n, "", 5.0, 1e-5, "Compliance Stop", v, np.where(v < 2.95, v / 5e9 * (1 + v), 1e-5))	# 포밍 전 누설 (5 GΩ) + 3 V에서 CC
for r in by["reset"]:
	v, i = step01(r, stop_drop=True)
	n += 1; sheet(wb, n, "", 5.0, 0.1, "Early Stop", v, i)
	v2, i2 = step01(by["set"][0])
	hit = int(np.argmax(i2 >= 0.9e-3))
	n += 1; sheet(wb, n, "", 5.0, 1e-3, "Compliance Stop", v2[:hit + 1], i2[:hit + 1])
v = np.round(np.arange(0.0, 1.0 + 1e-9, 0.1), 6)
n += 1; sheet(wb, n, "", 1.0, 0.1, "", v, v / 600.0)	# 읽기
n += 1; sheet(wb, n, "", 5.0, 0.1, "Early Stop", v[:4], v[:4] * 1e-9)	# HRS에서 멈춤
fixture = GOLDEN / "measure_6nm_fixture.xlsx"
wb.save(fixture)
# 분류와 역산
ses = ms.load_xlsx(str(fixture))
p = replace(rm.DEFAULT, **{**rm.OUR_DEVICE, "A_cell": 1e-12, "n_f": 1e12, "L0": 6e-9})
out = {"kinds": [s.kind for s in ses.sweeps], "r01": [s.r01 for s in ses.sweeps], "area": ses.area, "thickness": ses.thickness}
form = ms.first_forming([ses])
rp = inv.low_field_resistance(np.abs(form[0][1].v), np.abs(form[0][1].i))
out["r_pristine"] = rp
out["rho_ox"] = inv.oxide_resistivity(rp, p)
RL = 20.0
out["resets"] = []
for s in ses.sweeps:
	if s.kind == "reset":
		f = inv.reset_features(np.abs(s.v), np.abs(s.i), RL)
		rr = inv.russo_extraction(f, 1.7e-3, 300.0)
		out["resets"].append({"index": s.index, "R0": f.R0, "v_reset": f.v_reset, "i_reset": f.i_reset, "T_crit": rr.T_crit, "Rth_fit": rr.Rth_fit})
	elif s.kind == "set":
		f = inv.set_features(np.abs(s.v), np.abs(s.i), s.cc, RL)
		out.setdefault("sets", []).append({"index": s.index, "R_hrs": f.R_hrs, "v_set": f.v_set})
phis = list(np.geomspace(3e-9, 1.9 * p.R_dom, 6))
c = inv.model_lrs_curve(p, phis, 600.0, 1.7e-3)
out["curve"] = {"phi": list(map(float, c["phi"])), "R0": list(map(float, c["R0"])), "Rth": list(map(float, c["Rth"]))}
fit = inv.fit_lrs(30.0, 30.0 * 3000.0, p, 600.0, 1.7e-3, phis=np.array(phis))
out["fit_lrs"] = {"R0": 30.0, "Rth": 9e4, "phi": fit.phi, "N": fit.N}
# 열 보정 (A56)과 호핑 갭 (A55)
k, phi_k = inv.fit_kappa_el(30.0, 2.87e4, p, 800.0, 1.7e-3)
out["fit_kappa_el"] = {"R0": 30.0, "Rth": 2.87e4, "T_target": 800.0, "kappa_el": k, "phi": phi_k}
pk = replace(p, kappa_el=k, rho_ox=1.84e10, hop=1)
out["fit_gap"] = {"R_hrs": 6.4e5, "phi": phi_k, "kappa_el": k, "rho_ox": 1.84e10, "gap": inv.fit_gap(6.4e5, phi_k, 1.0, pk).gap}
out["params"] = {"A_cell": p.A_cell, "L0": p.L0}
json.dump(out, open(GOLDEN / "measure.json", "w"), indent=1)
print(json.dumps({k: out[k] for k in ("kinds", "rho_ox", "fit_lrs", "fit_kappa_el", "fit_gap")}, ensure_ascii=False))
