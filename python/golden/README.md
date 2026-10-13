# golden — 2단계 정답지

`python/reference.ipynb` 8절에서 만듭니다. 모든 값은 SI 단위입니다. 모두 기본 파라미터(`rram_model.DEFAULT`)를 쓴 결정론적 결과입니다(변동성 없음).

## 시계열 파일 (열: `t_s,v_app_V,v_sw_V,i_A,x_m,w_m,T_K`)

| 파일 | 파형 | 초기 상태 (x0, w0) | Rs / Rs_reset | CP | 기타 |
|---|---|---|---|---|---|
| `sweep_cycle1.csv` | 0→+2.5→0→−2.5→0 V, 구간마다 100 µs | (3 nm, 0.5 nm) | 18 kΩ / 0 | 무시 | |
| `sweep_cycle2.csv` | 위와 같음 | cycle1의 마지막 상태 | 18 kΩ / 0 | 무시 | |
| `sweep_ramp_10us.csv`, `_100us`, `_1000us` | 위와 같음, 구간당 램프 10 µs / 100 µs / 1 ms | (3 nm, 0.5 nm) | 18 kΩ / 0 | 무시 | |
| `sweep_n4.csv` | cycle1과 같음 | (3 nm, 0.5 nm) | 18 kΩ / 0 | 무시 | `n_f = 4e16` → N = 4 |
| `pulse_set.csv` | +2 V, 상승/하강 10 ns, 평탄부 80 ns, 전체 100 ns | (3 nm, 0.5 nm) | 10 kΩ / 0 | 포함 (20 fF) | max_step 0.1 ns |
| `pulse_reset.csv` | −2 V, 같은 모양 | (0, 5 nm) | 10 kΩ / 0 | 포함 | max_step 0.1 ns |

시간점: 균일한 2001개 점 + 파형 꺾임점. CP 모드에서 `i_A`는 단자 전류(CP 충전 전류 포함)입니다.

## 정적 파일

- `read_resistance.csv` — `x_m,w_m,R_ohm`: 0.2 V 읽기에서의 셀 저항 (RL, RH 포함, Rs = 0)
- `fixed_state_iv.csv` — `x_m,A_m2,v_V,i_A`: 고정 상태 모드 I-V (x, A_CF 지정)
- `filament_current.csv` — `v_V,x_m,w_m,i_A,v_gap_V`: 기생 성분 없이 격자점에서 계산한 단일 필라멘트 전류 (식 6–7 직렬). 핵심 함수 단위 테스트용
