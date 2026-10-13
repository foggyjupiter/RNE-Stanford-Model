# RRAM 시뮬레이터

금속산화물 **unipolar** RRAM의 전도성 필라멘트(conductive filament) 모델을 독립적으로 구현하고, 브라우저에서 돌아가는 시뮬레이터를 만드는 프로젝트입니다.
프로젝트 지침: `CLAUDE.md`. 가정과 그 근거: `ASSUMPTIONS.md`.

## 진행 상황

- [x] 1단계: 파이썬 레퍼런스 (`python/`)
- [x] 2단계: TypeScript 코어 (`web/src/model/`)
- [x] 3단계: UI (`web/`)

## 모델 개요 (unipolar)

SET과 RESET을 **같은 극성**에서 하는 unipolar RRAM 모델입니다.

- **RESET (열 용해):** Russo et al. [6]의 모델을 그대로 옮겼습니다. 필라멘트와 둘레 산화막을 원통 좌표 2차원 격자로 나누고, 매 시각 전위·온도 분포를 풉니다. 필라멘트 경계는 그 위치 온도에 따라 [6] 식 (5) `v_D = v_D0·exp(−E_d/kT)`의 속도로 녹아 들어갑니다. 가장 뜨거운 가운데가 먼저 가늘어지고, 거기에 전류가 몰려 더 뜨거워지는 자기 가속으로 RESET이 급격하게 일어납니다.
- **SET (측면 성장):** [2] 식 (2)의 성장 속도를 경계 위치의 국소 전계·온도로 적용합니다. 직렬 compliance 저항으로 전류를 제한합니다.
- **동작 구분:** 같은 극성이라 전압 부호로 SET/RESET을 나눌 수 없습니다. 동작으로 나눕니다(SET = 제한 있음: 성장 + 용해, RESET = 제한 없음: 용해만).
- **소자:** [6] Table I의 NiO 소자(두께 160 nm, 필라멘트 지름 80 nm)를 기본값으로 씁니다.

## 1단계 — 파이썬 레퍼런스

```bash
pip install -r python/requirements.txt
cd python
jupyter nbconvert --to notebook --execute --inplace reference.ipynb   # 약 10분, golden/ 재생성
```

- `python/rram_model.py`: 모델 본체 (2차원 장 풀이, 경계 이동, 회로 풀이, 읽기, 변동성)
- `python/reference.ipynb`: 검증 노트북 ([6] Fig. 2–5 재현, 격자 수렴, unipolar 사이클, compliance 의존성, 펄스, 읽기, 고정 상태, 변동성)
- `python/golden/`: 2단계용 정답 CSV (`golden/README.md` 참고)

## 2단계 — TypeScript 코어

```bash
cd web
npm install
npm test          # vitest: python/golden과 비교
npm run typecheck
```

- `params.ts`: 파라미터, 물리 상수, 기본값 (`RS_SET` 3 kΩ, 격자)
- `fields.ts`: 2차원 격자, 유한체적 조립, 대역 Cholesky 풀이, 전위·온도 Picard 반복, 경계 이동 속도
- `simulate.ts`: 파형, 회로 풀이(Brent), 과도 시뮬레이션, 읽기 저항, 고정 상태, 변동성
- `jobs.ts` / `worker.ts` / `client.ts`: 작업 정의, Web Worker, Promise 클라이언트 (새 요청이 오면 이전 계산은 취소)

## 3단계 — UI

```bash
cd web
npm run dev       # http://localhost:5173
npm run build     # dist/ 에 정적 파일 생성
```

- 모드: **I-V 스윕**(RESET → SET) / **펄스**(RESET 또는 SET) / **쓰기-읽기 시퀀스** / **고정 상태**(잘록 구간 반경·길이를 정해 읽기 I-V)
- **소자 간 몬테카를로 (고정 상태 모드의 "무작위성 켜기"):** 소자마다 필라멘트 개수(포아송), 필라멘트마다 두께·갭(잘록 구간) 반경·길이(로그정규)를 무작위로 뽑아 읽기 저항 분포, 필라멘트 수–저항 관계, I-V 산포를 보여 줍니다. 소자 100개에 약 4초 (ASSUMPTIONS A38, A39)
- 결과: I-V, 인가 전압·전류·가장 가는 곳 반경·최고 온도 대 시간, **필라멘트 형상과 온도 분포 지도**([6] Fig. 2와 같은 그림)
- 파라미터 패널: RESET(열 용해) / SET(측면 성장) / 소자 형상 / 물성 / 기생 성분 / 필라멘트 밀도
- 변동성: 켜면 사이클을 겹쳐 그리고 LRS/HRS 분포 히스토그램. 2차원 계산이라 **스윕 한 사이클에 약 15초** 걸려서, 켤 때 사이클 수가 1이면 3으로 올립니다. 진행 막대와 취소 버튼이 있습니다.
- 내보내기: 결과 CSV, 사이클 요약 CSV, 차트별 PNG. 라이트/다크 모드

## 모델의 한계

- **V_reset이 논문보다 약 25% 높습니다** (4 V/s에서 1.14 V, 논문 약 0.85–0.95 V). 논문이 피팅값이라 밝힌 v_D0를 바꾸지 않았고, 계산 영역 반경을 논문 Fig. 4에 맞춘 보정값을 씁니다 (ASSUMPTIONS A31).
- **RESET의 급격함과 HRS 값은 격자에 따라 달라집니다** (A35). V_reset은 격자에 무관합니다.
- SET/RESET은 동작으로 나눕니다(A25). 같은 전압에서 두 식을 함께 쓰면 RESET이 일어나지 않습니다.
- SET 식([2], HfOx 기준 파라미터)을 RESET 모델([6], NiO 소자)과 합친 것은 가정입니다.
- N개의 병렬 필라멘트는 동일하다고 보고 경쟁·열 간섭은 무시합니다 (A10).
- 계산이 무거워 슬라이더를 움직이면 결과가 몇 초~수십 초 뒤에 나옵니다.

## 참고 자료 (`refs/`, 라이선스 때문에 커밋하지 않음)

`refs/` 폴더는 `.gitignore`에 들어 있습니다. 아래 파일을 로컬에 직접 넣어 주세요.

- `RRAM Model v2.0Beta Quick User Guide.pdf` (PKU-Stanford RRAM v2.0Beta 패키지에 포함, http://nano.stanford.edu/models.php)
- `DATE2015_HTLi_FinalVersion.pdf` — H. Li et al., DATE 2015
- `russo2009_model.pdf` — Russo et al., IEEE TED 56(2) 193–200 (2009)
- `russo2009_conduction.pdf` — Russo et al., IEEE TED 56(2) 186–192 (2009)

원본 모델의 `.va` 파일은 읽지도 사용하지도 않았습니다.

## 인용

- 원 모델: PKU-Stanford RRAM SPICE Model v2.0Beta, Peking University & Stanford University, 2015.
- [1] H.-S. P. Wong et al., "Metal–Oxide RRAM," Proc. IEEE, vol. 100, no. 6, pp. 1951–1970, 2012.
- [2] H. Li et al., "Variation-aware, reliability-emphasized design and optimization of RRAM using SPICE model," DATE, pp. 1426–1430, 2015.
- [3] Z. Jiang et al., "Verilog-A compact model for oxide-based RRAM," SISPAD, pp. 41–44, 2014.
- [4] H. Li et al., "A SPICE model of resistive random access memory for large-scale memory array simulation," IEEE EDL, vol. 35, no. 2, pp. 211–213, 2014.
- [5] X. Guan, S. Yu, and H.-S. P. Wong, "A SPICE compact model of metal oxide resistive switching memory with variations," IEEE EDL, pp. 1405–1407, 2012.
- [6] U. Russo, D. Ielmini, C. Cagli, and A. L. Lacaita, "Self-accelerated thermal dissolution model for reset programming in unipolar resistive-switching memory (RRAM) devices," IEEE TED, vol. 56, no. 2, pp. 193–200, 2009. DOI 10.1109/TED.2008.2010584
- [7] U. Russo, D. Ielmini, C. Cagli, and A. L. Lacaita, "Filament conduction and reset mechanism in NiO-based resistive-switching memory (RRAM) devices," IEEE TED, vol. 56, no. 2, pp. 186–192, 2009. DOI 10.1109/TED.2008.2010583
