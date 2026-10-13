# golden — 2단계 정답지 (unipolar 2차원 모델)

`python/reference.ipynb` 8절에서 만듭니다. 모든 값은 SI 단위, 기본 파라미터(`rram_model.DEFAULT`)와 기본 격자(반경 4 nm, 길이 40칸)를 쓴 결정론적 결과입니다.

## 시계열 파일 (열: `t_s,v_app_V,v_cell_V,i_A,r_min_m,T_max_K`)

`r_min_m`은 가장 가는 곳의 필라멘트 반경, `T_max_K`는 계산 영역의 최고 온도입니다. 시간점은 적응 스텝이 실제로 밟은 시각입니다.

| 파일 | 파형 | 시작 상태 | 직렬 저항 | C_P |
|---|---|---|---|---|
| `reset_sweep_4Vps.csv` | RESET만: 0 → 1.6 → 0 V, 4 V/s ([R] Fig. 3 조건) | 포밍된 LRS (반경 40 nm) | 0 | 무시 |
| `cycle_sweep.csv` | 0 → 1.6 V (RESET) → 0 → 4.0 V (SET) → 0, 구간당 0.25 s | 포밍된 LRS | SET 3 kΩ / RESET 0 | 무시 |
| `pulse_reset.csv` | RESET 3 V, 평탄부 10 µs, 상승·하강 10 ns | 포밍된 LRS | 0 | 포함 (20 fF) |
| `pulse_set.csv` | SET 2.5 V, 평탄부 1 µs, 상승·하강 10 ns | `hrs_profile.csv` | 3 kΩ | 포함 |

## 정적 파일

- `hrs_profile.csv` — `z_m,rb_m`: `reset_sweep_4Vps` 끝의 필라멘트 경계 반경 (pulse_set 시작 상태)
- `read_resistance.csv` — `r_neck_m,neck_len_m,R_ohm`: 가운데 잘록 구간(반경, 길이)을 둔 형상의 0.1 V 읽기 저항 (R_L 포함). 길이 0이면 균일한 원기둥
- `fixed_state_iv.csv` — `r_neck_m,neck_len_m,v_V,i_A`: 고정 상태 모드 I-V
- `fields.csv` — `r_neck_m,neck_len_m,v_V,i_A,T_max_K,P_W`: 셀 전압을 직접 준 정상 상태 전위·온도 풀이 한 번의 결과. 핵심 함수 단위 테스트용
