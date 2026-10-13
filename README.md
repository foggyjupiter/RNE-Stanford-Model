# RRAM Simulator

An independent implementation of the conductive-filament model for metal-oxide bipolar RRAM, with a browser-based simulator (in progress).
Project guidelines: `CLAUDE.md`. Assumptions and their rationale: `ASSUMPTIONS.md`.

## Status

- [x] Stage 1: Python reference (`python/`)
- [ ] Stage 2: TypeScript core (`web/src/model/`)
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
