# RRAM 시뮬레이터

금속산화물 bipolar RRAM의 전도성 필라멘트(conductive filament) 모델을 독립적으로 구현하고, 브라우저에서 돌아가는 시뮬레이터를 만드는 프로젝트입니다.
프로젝트 지침: `CLAUDE.md`. 가정과 그 근거: `ASSUMPTIONS.md`.

## 진행 상황

- [x] 1단계: 파이썬 레퍼런스 (`python/`)
- [x] 2단계: TypeScript 코어 (`web/src/model/`)
- [x] 3단계: UI (`web/`)

## 1단계 — 파이썬 레퍼런스

```bash
pip install -r python/requirements.txt
cd python
jupyter nbconvert --to notebook --execute --inplace reference.ipynb   # 약 4분, golden/ 재생성
```

- `python/rram_model.py`: 모델 본체 (식 1–11, Table 3 기본값, SI 단위)
- `python/reference.ipynb`: 검증 노트북 (스윕, 램프 속도, 펄스, 읽기 저항, 고정 상태 모드, 병렬 필라멘트, 변동성)
- `python/golden/`: 2단계용 정답 CSV (`golden/README.md` 참고)

## 2단계 — TypeScript 코어

```bash
cd web
npm install
npm test          # vitest: python/golden과 비교
npm run typecheck
```

- `params.ts`: Table 3 파라미터, 물리 상수, 기본값 (`RS_SWEEP` 18 kΩ, `RS_PULSE` 10 kΩ)
- `physics.ts`: 전도 (식 6–7, 직렬 내부 해), 온도 (5), 변화율 (1)–(4), (8)–(9)
- `solver.ts`: 적응형 Rosenbrock ROS2 (L-stable) + 스텝당 상태 변화량 상한
- `simulate.ts`: 파형, 과도 시뮬레이션, 읽기 저항, 고정 상태 모드, 변동성 (10)–(11)
- `jobs.ts` / `worker.ts` / `client.ts`: 직렬화 가능한 작업 정의, Web Worker, Promise 클라이언트 (새 요청이 오면 이전 계산은 취소)

## 3단계 — UI

```bash
cd web
npm run dev       # http://localhost:5173
npm run build     # dist/ 에 정적 파일 생성
```

- 스택: Vite + TypeScript + Plotly.js. 계산은 Web Worker에서 돌고, 새 입력이 오면 이전 계산을 취소합니다.
- 모드: **I-V 스윕** / **펄스** / **쓰기-읽기 시퀀스** / **고정 상태** (갭과 필라멘트 면적을 직접 정해 읽기 I-V 확인)
- 파라미터 패널: 매뉴얼 Table 3 기준 그룹 (HRS 관련 / LRS 관련 / 스위칭 전압 / 속도 / 기생 성분) + 필라멘트 밀도. 슬라이더 범위는 권장 범위이며, 숫자 입력으로 범위 밖 값도 넣을 수 있습니다(경고 표시). Table 3이 한 값만 주는 항목(V_T, α_a, α_h, γ)은 숫자 입력만 둡니다. `Weff`, `crit_x`는 제외 (A9).
- 변동성: 켜면 여러 사이클을 겹쳐 그리고 LRS/HRS 분포 히스토그램을 보여 줍니다. 스윕 1사이클이 약 0.25 s(잡음 포함 약 1 s)라, 켤 때 사이클 수가 1이면 5로 올리고 그 이상은 그대로 둡니다. 계산 중에는 진행 막대와 취소 버튼이 나옵니다.
- 쓰기-읽기 기본 펄스: SET +2 V / 80 ns, RESET −2.5 V / 1 µs → 창 약 73배 (A21)
- 내보내기: 결과 CSV(모든 사이클, SI 단위), 사이클 요약 CSV, 차트별 PNG
- 라이트/다크 모드: 시스템 설정을 따르고, 오른쪽 위 버튼으로 바꿀 수 있습니다.

## 모델의 한계

- **다중 사이클 거동은 근사입니다.** 근거 논문 [2]에 RESET 중 필라멘트 폭 변화식이 없어서 RESET 뒤에도 폭이 그대로 남습니다. 그래서 2번째 사이클부터는 측정보다 SET이 완만하고 V_SET이 높게 나옵니다 (ASSUMPTIONS A16).
- `gT`(호핑 감쇠 길이, 0.25 nm)는 매뉴얼에도 논문에도 없는 **피팅값**입니다 (A3).
- N개의 병렬 필라멘트는 모두 동일하다고 보고 **필라멘트 사이의 경쟁은 무시합니다** (A10).
- Table 3의 `Weff`, `crit_x`는 대응하는 식이 없어 쓰지 않습니다 (A9).

## 참고 자료 (`refs/`, 라이선스 때문에 커밋하지 않음)

`refs/` 폴더는 `.gitignore`에 들어 있습니다. 아래 파일을 로컬에 직접 넣어 주세요.

- `RRAM Model v2.0Beta Quick User Guide.pdf` (PKU-Stanford RRAM v2.0Beta 패키지에 포함, http://nano.stanford.edu/models.php)
- `DATE2015_HTLi_FinalVersion.pdf` — H. Li et al., DATE 2015

원본 모델의 `.va` 파일은 읽지도 사용하지도 않았습니다.

## 인용

- 원 모델: PKU-Stanford RRAM SPICE Model v2.0Beta, Peking University & Stanford University, 2015.
- [1] H.-S. P. Wong et al., "Metal–Oxide RRAM," Proc. IEEE, vol. 100, no. 6, pp. 1951–1970, 2012.
- [2] H. Li et al., "Variation-aware, reliability-emphasized design and optimization of RRAM using SPICE model," DATE, pp. 1426–1430, 2015.
- [3] Z. Jiang et al., "Verilog-A compact model for oxide-based RRAM," SISPAD, pp. 41–44, 2014.
- [4] H. Li et al., "A SPICE model of resistive random access memory for large-scale memory array simulation," IEEE EDL, vol. 35, no. 2, pp. 211–213, 2014.
- [5] X. Guan, S. Yu, and H.-S. P. Wong, "A SPICE compact model of metal oxide resistive switching memory with variations," IEEE EDL, pp. 1405–1407, 2012.
