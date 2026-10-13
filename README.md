# RRAM 시뮬레이터

금속산화물 bipolar RRAM의 전도성 필라멘트(conductive filament) 모델을 독립적으로 구현하고, 브라우저에서 돌아가는 시뮬레이터를 만드는 프로젝트입니다(진행 중).
프로젝트 지침: `CLAUDE.md`. 가정과 그 근거: `ASSUMPTIONS.md`.

## 진행 상황

- [x] 1단계: 파이썬 레퍼런스 (`python/`)
- [x] 2단계: TypeScript 코어 (`web/src/model/`)
- [ ] 3단계: UI (`web/`)

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
