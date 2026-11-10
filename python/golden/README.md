# golden — 2단계 정답지 (unipolar 2차원 모델)

`python/reference.ipynb` 8절에서 만듭니다. 모든 값은 SI 단위, 기본 파라미터(`rram_model.DEFAULT`)와 기본 격자(반경 4 nm, 길이 40칸)를 쓴 결정론적 결과입니다.

## 시계열 파일 (열: `t_s,v_app_V,v_cell_V,i_A,r_min_m,T_max_K`)

`r_min_m`은 가장 가는 곳의 필라멘트 반경, `T_max_K`는 계산 영역의 최고 온도입니다. 시간점은 적응 스텝이 실제로 밟은 시각입니다.

| 파일 | 파형 | 시작 상태 | 직렬 저항 | C_P |
|---|---|---|---|---|
| `reset_sweep_4Vps.csv` | RESET만: 0 → 1.6 → 0 V, 4 V/s ([R] Fig. 3 조건) | 포밍된 LRS (반경 40 nm) | 0 | 무시 |
| `cycle_sweep.csv` | 0 → 1.6 V (RESET) → 0 → 4.0 V (SET) → 0, 구간당 0.25 s | 포밍된 LRS | SET 3 kΩ / RESET 0 | 무시 |
| `cycle_sweep_cc.csv` | `cycle_sweep.csv`와 같은 파형 | 포밍된 LRS | SET 전류 제한 1 mA (A40) / RESET 0 | 무시 |
| `reset_ramp_tin.csv` | RESET 램프 하나: 0 → 1.6 V, 4 V/s | 포밍된 LRS | 0, **TiN 전극 50 nm** (`TIN_ELECTRODE`, A41) | 무시 |
| `our_reset_ramp.csv` | 우리 소자(`OUR_DEVICE`): RESET 램프 0 → 1.5 V, 1 V/s. 마지막 열 `i_cell_A` = 필라멘트 전류 | 포밍된 CF (5 nm) | 0 | 무시 |
| `our_reset_ramp_hop.csv` | `our_reset_ramp.csv`와 같고 **갭 호핑 켬**(A55, 스텝 상한 g_T/5). 노트북 3b절 | 포밍된 CF (5 nm) | 0 | 무시 |
| `our_set_cc_stop.csv` | 우리 소자: SET 램프 0 → 5 V, 1 V/s, CC 100 µA에서 멈춤(0.1 s 유지, A52) | `our_hrs_profile.csv` | CC 100 µA | 무시 |
| `our_set_cc_stop_cp.csv` | 위와 같고 패드 정전용량 0.61 nF 포함(셀 전압 스텝 ≤ 0.05 V). 방전 중 온도는 HfO₂ 녹는점 3047 K에서 자름 (A59) | `our_hrs_profile.csv` | CC 100 µA | 포함 (0.61 nF) |
| `pulse_reset.csv` | RESET 3 V, 평탄부 10 µs, 상승·하강 10 ns | 포밍된 LRS | 0 | 포함 (20 fF) |
| `pulse_set.csv` | SET 2.5 V, 평탄부 1 µs, 상승·하강 10 ns | `hrs_profile.csv` | 3 kΩ | 포함 |

`our_set_cc_stop*.csv`의 CC 유지 구간은 기본 스텝 상한(1 nm) 결과이며 스텝에 수렴한 값이 아닙니다 (A60). 두 구현이 같은 규칙으로 계산하는지 확인하는 용도입니다.

## 정적 파일

- `hrs_profile.csv` — `z_m,rb_m`: `reset_sweep_4Vps` 끝의 필라멘트 경계 반경 (pulse_set 시작 상태)
- `read_resistance.csv` — `r_neck_m,neck_len_m,R_ohm`: 가운데 잘록 구간(반경, 길이)을 둔 형상의 0.1 V 읽기 저항 (R_L 포함). 길이 0이면 균일한 원기둥
- `fixed_state_iv.csv` — `r_neck_m,neck_len_m,v_V,i_A`: 고정 상태 모드 I-V
- `fields.csv` — `r_neck_m,neck_len_m,v_V,i_A,T_max_K,P_W`: 셀 전압을 직접 준 정상 상태 전위·온도 풀이 한 번의 결과. 핵심 함수 단위 테스트용
- `our_hrs_profile.csv` — `z_m,rb_m`: `our_reset_ramp` 끝의 경계 반경 (우리 소자 SET 시작 상태)
- `our_hrs_profile_hop.csv` — `z_m,rb_m`: `our_reset_ramp_hop` 끝의 경계 반경 (갭 약 0.9 nm)
- `fields_hop.csv` — `gap_m,v_V,i_A,T_max_K,P_W,g_hop_m`: 갭 호핑 전도(A55)를 켠 정상 상태 풀이. 우리 소자 물성, 지름 78 nm CF 가운데 끊긴 갭 0.5–4 nm
- `fields_tin.csv` — `A_cell_m2,r_neck_m,neck_len_m,v_V,i_A,T_max_K,P_W`: `fields.csv`와 같은 풀이를 TiN 전극층(50 nm)으로. 셀 면적 0.01 µm²(전극 옆 범위 ≈ R_dom)와 1 µm²(옆으로 넓힘) 두 가지

## 측정 데이터 모드 (`golden_measure.py`가 만듦, 노트북과 별도)

- `measure_6nm_fixture.xlsx` — 측정 프로그램과 같은 형식의 엑셀 (시트마다 Sweep Name / Sweep Range / Area Constant / Compliance I, 그 아래 Voltage·Current·J 열). 실험 데이터가 아니라 `examples/synthetic_measurement.csv`(가상 소자)를 0.1 V 계단으로 다시 읽은 것. 포밍 전 누설은 5 GΩ으로 넣음
- `measure.json` — 위 엑셀의 분류, 0.1 V 저항, 포밍 전 저항, 산화막 비저항, RESET·SET 특징값과 [C] 추출값(R_L 20 Ω, α 1.7e-3), 우리 소자 물성(`OUR_DEVICE`, 셀 1 µm²)의 Rth/R0 곡선과 `fit_lrs` 결과, 열 보정(`fit_kappa_el`), 호핑 갭(`fit_gap`), 데이터 품질 지표(`data_quality`, A58)
