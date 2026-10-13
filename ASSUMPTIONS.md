# ASSUMPTIONS

Sources used:

- **[M]** PKU-Stanford RRAM Model v2.0Beta Quick User Guide: Table 2 (scope), Table 3 (parameters), Fig. 3 and 4 (target results), sample HSPICE decks (`.sp`, circuit level only)
- **[D]** H. Li et al., "Variation-aware, reliability-emphasized design and optimization of RRAM using SPICE model", DATE 2015 (manual reference [2]), eqs. (1)–(11)

The `.va` file was not opened. Neither [M] nor [D] states the items below, or they contradict each other. Each one records the choice made, its rationale and where it appears in the code (`python/rram_model.py`).

| ID | Item | Choice | Rationale / impact |
|---|---|---|---|
| A1 | CF area formula | `w` = CF **diameter** (manual's "CF width"), `A = π·w²/4` | [D] eqs. (6),(7) write `π r²/4` while calling `r` the "CF radius", which is inconsistent. Since [M] Table 3 uses width `w` (WCF, w0), I treat the `/4` form as diameter-based. (For radius r it would be `π r²`.) R(x=0, w=5 nm) ≈ 5 kΩ. **Confirmed by the user**: the manual calls it width, and in fixed-state mode the input area must be the actual geometric area. (Reading the formula literally would make R 4× larger, ~20 kΩ.) |
| A2 | CF–gap connection | One filament = CF segment (eq. 7, length `L0 − x`) **in series** with the gap (eq. 6). `V = V_CF + V_gap` with equal current, `V_gap` solved by `brentq` | [D] Fig. 2(a) shows only "metallic path + hopping path". Eq. (7) using length `g0 − g` points to a series structure. `g0` is taken to be `L0`. |
| A3 | Hopping decay length `gT` | `gT = 0.25 nm`, **fitted value** (user-confirmed; adjustable in the UI) | Appears in eq. (6) but is in neither Table 3 nor [D]. Chosen so the HRS read resistance is ~MΩ (an order of magnitude similar to Fig. 3). **Review note on whether it is the same quantity as `a`:** I think they are physically different. `a` is the distance a VO moves in one hop (the length prefactor of the ion-migration rates in eqs. 1, 3, 4). `gT` is the characteristic length over which the hopping/tunneling current through the gap decays exponentially; it is set by the extent of electron wavefunctions at trap sites (the localization length) and is independent of the ion step size. The two only happen to share a value (0.25 nm) because the same order of magnitude was assumed, so they are kept as separate parameters. |
| A4 | Lateral growth step `Δr` in eq. (2) | `Δr = 0.25 nm` (same as `a`) | Not defined in [D]. Assumed to be one lattice step, the same as the VO spacing. |
| A5 | Field `E` | `E = |V_sw| / L0` (average field across the switching layer). `V` in eq. (3) is `|V_sw|` | [D] does not define E. `V_gap/x` diverges as x→0, so I use the average field. |
| A6 | Temperature | `T = T0 + |I_f · V_sw| · Rth`, per filament (eq. 5) | Uses each filament's own power. No thermal crosstalk between filaments. |
| A7 | Two-step SET | V>0: the gap closes first (eq. 1); lateral growth (eq. 2) applies once the gap is closed. The switch is blended linearly over `EPS_X = 2.5 pm (0.01·a)` | [D] says "two-step process" without stating the switching condition. The blend avoids a discontinuous RHS (BDF convergence). |
| A8 | State bounds | `x ∈ [0, L0]`, `w ∈ [W_MIN = 0.1 nm, WCF]`. Rates are cut off by soft walls `EPS_X` wide | When noise (eqs. 8–9) pushed against a hard clip the solution chattered and BDF failed (`Required step size is less than spacing…`); the soft walls fixed this. The effect on the deterministic results is below the output precision. |
| A9 | `Weff`, `crit_x` | **Not used**. Kept in the code's Params but **excluded from the UI** (user decision) | Listed in Table 3 but there is no corresponding equation in [D]. |
| A10 | Filament density (professor's request) | `N = max(1, round(n_f · A_cell))` **identical filaments in parallel**, with the single-filament (x, w) dynamics unchanged. Compliance is solved with the total current `N·I_f`. Defaults `A_cell = 10 nm × 10 nm` ([D] ~10 nm device), `n_f = 1e16 m⁻²` → N = 1 | **Simplification that ignores competition between filaments** (in reality one dominant filament takes over current and heat). [M] Table 2 also says "one dominant filament". `RH`, `CP` and `RL` are cell-level and do not scale with N. |
| A11 | Parasitic topology | applied voltage — `RL + Rs` (series) — node `V_sw` — [switching element ∥ `RH` ∥ `CP`] | Based on [D] Fig. 2(b) and the sample decks. The decks have 20 Ω on both sides, but Table 3 defines a single RL, so RL is used once. **CP:** included in the pulse simulation as a state variable (`include_cp=True`); neglected in the DC sweep because the time constant (RL+Rs)·CP ≈ 0.36 ns ≪ ramp time, so `V_sw` is solved algebraically each step as required. |
| A12 | Noise χ(t) in eqs. (8),(9) | Piecewise-constant Gaussian (unit RMS) redrawn every `noise_dt = 0.2 µs` | The sample DC decks use a `.tran` step of 0.2 µs. The amplitude scales as `δ·sqrt(noise_dt·t)`, so the choice of `noise_dt` changes the size of the scatter. Applied to both SET and RESET, following the paper's equations. |
| A13 | Energy-barrier scatter in eqs. (10),(11) | Redrawn every cycle as Ea, Ei, Eh ~ N(μ, σ), with σ = 0.02 eV each | [D] gives no σ. Chosen so the V_SET and resistance spreads are similar in size to [D] Fig. 5–6. |
| A14 | Polarity of series resistance | `Rs` applies only when the applied voltage ≥ 0 (SET); `Rs_reset` (default 0) applies when < 0 | In a 1T1R the transistor limits only SET current; during RESET the gate is fully on (sample decks: RESET pulse with no transistor). With the same Rs in both directions, RESET does not happen. |
| A15 | Default `Rs` (per mode, user decision) | I-V sweep **18 kΩ** (`RS_SWEEP`), pulse **10 kΩ** (`RS_PULSE`) | Sweep: current saturates near 100 µA at 2.5 V. Pulse: ~85 µA at 2 V, similar in size to Fig. 4 (1T1R, ~100 µA). Both stand in for the sample deck's 1T1R (Vselect = 1.28 V). |
| A16 | CF width during RESET | Unchanged; **no width-shrink rule is invented** (user decision). **Multi-cycle behavior is approximate**, and the UI/README say so. To be revisited once [4] (EDL 2014) is available | [D] gives only gap equations for RESET (eqs. 3,4). Consequence: after RESET, w stays near WCF, so in the 2nd cycle the HRS hopping current is large and a larger voltage drop across Rs makes SET more gradual and V_SET higher (cycle 1: 1.24 V → cycle 2: 2.07 V). |
| A17 | Rate equations at V = 0 | SET equations for V_sw > 0, RESET equations for V_sw < 0, no change at 0 | Eq. (1) is nonzero even at V=0 (about 5 nm/s at 300 K), which would mean a retention drift on the order of a second. Ignored because the simulation windows here are ≤ 1 ms. |
| A18 | Variability reference | Implemented with [D] eqs. (8)–(11) | The manual's [5] (Guan EDL 2012) was not available; the user provided [D] in its place. |
| A19 | DC sweep waveform | Linear triangular ramp | The manual says "stair-like sweep", but no step size is given. The difference is small. |
| A20 | Units / constants | `Z = 1`, `e = 1.602176634e-19 C`, `k_B = 1.380649e-23 J/K`; `αa`, `αh` [m] × e × E [V/m] → energy [J] | Units as given in Table 3. |

## Numerical settings (Python reference)

- `solve_ivp(method="BDF")`, `rtol = 1e-6`, `atol = 1e-14 m` (x, w), `1e-7 V` (V_sw, CP mode)
- `max_step`: DC = `t_end / 2000`, pulse = 0.1 ns
- The integrator restarts at waveform corners and at each χ(t) update
- Inner solve (V_gap) and outer solve (V_sw, series resistance) both use `brentq`, `xtol = 1e-15`, `rtol = 1e-12`
- Inside the RHS, exponent arguments are capped at 700 to avoid overflow at far-off Newton trial points (no effect on physical points)

## Numerical settings (TypeScript core, `web/src/model/`)

- Integrator: Rosenbrock ROS2 (Verwer et al. 1999), L-stable, order 2 with an embedded order-1 error estimate. Time is autonomized as a state so ∂f/∂t is included via the Jacobian. Jacobian by forward differences
- `rtol = 1e-6`, `atol` same as Python. `maxStep`: DC `t_end/2000`, pulse 0.1 ns
- **Step cap in the switching region:** x and w may change by at most `a/10 = 0.025 nm` per step (the step is rejected and shrunk if exceeded)
- Restarts at waveform corners and χ(t) updates, same as Python
- Inner and outer solves: safeguarded Newton (analytic derivative, falls back to bisection when it leaves the bracket), relative tolerance ~1e-13
- Random numbers: mulberry32 + Box–Muller. Not identical to Python's numpy sequence, so variability results are compared only statistically and for seed reproducibility, not against golden values
- Golden tolerances (rationale in the test-file comments): algebraic parts relative 1e-8; transient relative 1e-3 within a ±1 output-sample window. A 0.1% change to Ea fails 6 of the 8 golden cases (sensitivity check)
