# RRAM Simulator

An independent implementation of the conductive-filament model for metal-oxide bipolar RRAM, with a browser-based simulator (in progress).
Project guidelines: `CLAUDE.md`. Assumptions and their rationale: `ASSUMPTIONS.md`.

## Status

- [x] Stage 1: Python reference (`python/`)
- [x] Stage 2: TypeScript core (`web/src/model/`)
- [ ] Stage 3: UI (`web/`)

## Stage 1 — Python reference

```bash
pip install -r python/requirements.txt
cd python
jupyter nbconvert --to notebook --execute --inplace reference.ipynb   # ~4 min, regenerates golden/
```

- `python/rram_model.py`: model core (eqs. 1–11, Table 3 defaults, SI units)
- `python/reference.ipynb`: validation notebook (sweep, ramp rate, pulses, read resistance, fixed-state mode, parallel filaments, variability)
- `python/golden/`: expected-value CSVs for Stage 2 (see `golden/README.md`)

## Stage 2 — TypeScript core

```bash
cd web
npm install
npm test          # vitest: compares against python/golden
npm run typecheck
```

- `params.ts`: Table 3 parameters, constants, defaults (`RS_SWEEP` 18 kΩ, `RS_PULSE` 10 kΩ)
- `physics.ts`: conduction (eqs. 6–7, series inner solve), temperature (5), rates (1)–(4), (8)–(9)
- `solver.ts`: adaptive Rosenbrock ROS2 (L-stable) + per-step state-change cap
- `simulate.ts`: waveforms, transient simulation, read resistance, fixed-state mode, variability (10)–(11)
- `jobs.ts` / `worker.ts` / `client.ts`: serializable jobs, Web Worker, promise client (a new request cancels the previous one)

## Model limitations

- **Multi-cycle behavior is approximate.** The source paper [2] has no equation for filament-width change during RESET, so the width stays as-is after RESET. From the 2nd cycle on, SET is more gradual and V_SET higher than measurements (ASSUMPTIONS A16).
- `gT` (hopping decay length, 0.25 nm) is a **fitted value** given in neither the manual nor the paper (A3).
- N parallel filaments are treated as identical and **competition between filaments is ignored** (A10).
- `Weff` and `crit_x` from Table 3 are unused because there is no corresponding equation (A9).

## References (`refs/`, not committed — license)

The `refs/` folder is in `.gitignore`. Place these files there locally:

- `RRAM Model v2.0Beta Quick User Guide.pdf` (included in the PKU-Stanford RRAM v2.0Beta package, http://nano.stanford.edu/models.php)
- `DATE2015_HTLi_FinalVersion.pdf` — H. Li et al., DATE 2015

The model's `.va` file was not read or used.

## Citations

- Original model: PKU-Stanford RRAM SPICE Model v2.0Beta, Peking University & Stanford University, 2015.
- [1] H.-S. P. Wong et al., "Metal–Oxide RRAM," Proc. IEEE, vol. 100, no. 6, pp. 1951–1970, 2012.
- [2] H. Li et al., "Variation-aware, reliability-emphasized design and optimization of RRAM using SPICE model," DATE, pp. 1426–1430, 2015.
- [3] Z. Jiang et al., "Verilog-A compact model for oxide-based RRAM," SISPAD, pp. 41–44, 2014.
- [4] H. Li et al., "A SPICE model of resistive random access memory for large-scale memory array simulation," IEEE EDL, vol. 35, no. 2, pp. 211–213, 2014.
- [5] X. Guan, S. Yu, and H.-S. P. Wong, "A SPICE compact model of metal oxide resistive switching memory with variations," IEEE EDL, pp. 1405–1407, 2012.
