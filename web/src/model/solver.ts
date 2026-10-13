// Adaptive Rosenbrock integrator (ROS2, L-stable, order 2 with embedded order-1 error estimate).
// Ref: J.G. Verwer, E.J. Spee, J.G. Blom, W. Hundsdorfer, "A second-order Rosenbrock method
// applied to photochemical dispersion problems", SIAM J. Sci. Comput. 20 (1999) 1456-1480.
//
// The non-autonomous system y' = f(t, y) is autonomized (t becomes a state with t' = 1),
// so the time derivative of f enters through the Jacobian column df/dt.
// Jacobian by forward differences. Small dense systems only (n <= 4 here).

export type Rhs = (t: number, y: Float64Array, out: Float64Array) => void;

export interface IntegrateOptions {
	rtol: number;	// relative tolerance [-]
	atol: readonly number[];	// absolute tolerance per component [state units]
	maxStep: number;	// upper bound on the step [s]
	maxDelta?: readonly number[];	// upper bound on |change| of each component per step, caps steps during switching [state units]
	breakpoints?: readonly number[];	// times where f is discontinuous; integration restarts there [s]
	onSegment?: (tStart: number, tEnd: number) => void;	// called before each segment (e.g. to set noise)
	onSegmentEnd?: (y: Float64Array) => void;	// may modify y in place at a segment end (e.g. clipping)
	maxStepsPerSegment?: number;
}

export interface IntegrateResult {
	y: Float64Array[];	// state at each requested output time
	steps: number;	// accepted steps
	rejected: number;	// rejected steps
	nfev: number;	// rhs evaluations
}

const GAMMA = 1 + 1 / Math.SQRT2;
const SQRT_EPS = Math.sqrt(Number.EPSILON);

// Gaussian elimination with partial pivoting; solves A*x = b in place (b <- x). A is n*n row-major, destroyed.
function luSolveInPlace(A: Float64Array, b: Float64Array, n: number): void {
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
		if (piv !== c) {
			for (let k = 0; k < n; k++) {
				const tmp = A[c * n + k];
				A[c * n + k] = A[piv * n + k];
				A[piv * n + k] = tmp;
			}
			const tb = b[c];
			b[c] = b[piv];
			b[piv] = tb;
		}
		const d = A[c * n + c];
		for (let r = c + 1; r < n; r++) {
			const m = A[r * n + c] / d;
			if (m === 0) continue;
			for (let k = c; k < n; k++) A[r * n + k] -= m * A[c * n + k];
			b[r] -= m * b[c];
		}
	}
	for (let r = n - 1; r >= 0; r--) {
		let s = b[r];
		for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
		b[r] = s / A[r * n + r];
	}
}

// Integrate from tOut[0] (initial time, y0) through every tOut point. tOut must be strictly increasing.
export function integrate(rhs: Rhs, y0: readonly number[], tOut: readonly number[], opt: IntegrateOptions): IntegrateResult {
	const n = y0.length;
	const tEnd = tOut[tOut.length - 1];
	const bps = Array.from(new Set([tOut[0], tEnd, ...(opt.breakpoints ?? [])]))
		.filter((t) => t >= tOut[0] && t <= tEnd)
		.sort((p, q) => p - q);
	const maxSteps = opt.maxStepsPerSegment ?? 2_000_000;

	const y = Float64Array.from(y0);
	const yNew = new Float64Array(n);
	const f0 = new Float64Array(n);
	const fp = new Float64Array(n);
	const ft = new Float64Array(n);
	const J = new Float64Array(n * n);
	const M = new Float64Array(n * n);
	const k1 = new Float64Array(n);
	const k2 = new Float64Array(n);
	const yp = new Float64Array(n);

	const out: Float64Array[] = [Float64Array.from(y)];
	let iOut = 1;
	let steps = 0;
	let rejected = 0;
	let nfev = 0;
	let h = Math.min(opt.maxStep, (tEnd - tOut[0]) * 1e-6 || opt.maxStep);

	const evalF = (t: number, yy: Float64Array, o: Float64Array): void => {
		rhs(t, yy, o);
		nfev++;
	};

	for (let s = 0; s < bps.length - 1; s++) {
		const ta = bps[s];
		const tb = bps[s + 1];
		if (tb <= ta) continue;
		opt.onSegment?.(ta, tb);
		let t = ta;
		let stepsHere = 0;
		h = Math.min(h, opt.maxStep);
		while (t < tb) {
			if (++stepsHere > maxSteps) throw new Error(`integrate: too many steps on [${ta}, ${tb}]`);
			const tNext = Math.min(tb, iOut < tOut.length ? tOut[iOut] : tb);
			let hTry = Math.min(h, opt.maxStep, tNext - t);
			// do not leave a sliver smaller than 1% of the step before the next stop
			if (tNext - (t + hTry) < 0.01 * hTry) hTry = tNext - t;

			// Jacobian df/dy and df/dt at (t, y) by forward differences
			evalF(t, y, f0);
			for (let j = 0; j < n; j++) {
				const dy = SQRT_EPS * Math.max(Math.abs(y[j]), opt.atol[j] / opt.rtol);
				yp.set(y);
				yp[j] += dy;
				evalF(t, yp, fp);
				for (let i = 0; i < n; i++) J[i * n + j] = (fp[i] - f0[i]) / dy;
			}
			const dt = SQRT_EPS * Math.max(Math.abs(t), hTry);
			evalF(t + dt, y, fp);
			for (let i = 0; i < n; i++) ft[i] = (fp[i] - f0[i]) / dt;

			let accepted = false;
			while (!accepted) {
				const gh = GAMMA * hTry;
				// stage 1: (I - g h J) k1 = f0 + g h f_t
				for (let i = 0; i < n * n; i++) M[i] = -gh * J[i];
				for (let i = 0; i < n; i++) M[i * n + i] += 1;
				for (let i = 0; i < n; i++) k1[i] = f0[i] + gh * ft[i];
				luSolveInPlace(M, k1, n);
				// stage 2: (I - g h J) k2 = f(t + h, y + h k1) - 2 k1 - g h f_t
				for (let i = 0; i < n; i++) yp[i] = y[i] + hTry * k1[i];
				evalF(t + hTry, yp, fp);
				for (let i = 0; i < n * n; i++) M[i] = -gh * J[i];
				for (let i = 0; i < n; i++) M[i * n + i] += 1;
				for (let i = 0; i < n; i++) k2[i] = fp[i] - 2 * k1[i] - gh * ft[i];
				luSolveInPlace(M, k2, n);

				// y_{n+1} = y + h (3/2 k1 + 1/2 k2); error = y_{n+1} - (y + h k1) = h/2 (k1 + k2)
				let err = 0;
				let deltaRatio = 0;
				for (let i = 0; i < n; i++) {
					yNew[i] = y[i] + hTry * (1.5 * k1[i] + 0.5 * k2[i]);
					const e = 0.5 * hTry * Math.abs(k1[i] + k2[i]);
					const sc = opt.atol[i] + opt.rtol * Math.max(Math.abs(y[i]), Math.abs(yNew[i]));
					err = Math.max(err, e / sc);
					if (opt.maxDelta) deltaRatio = Math.max(deltaRatio, Math.abs(yNew[i] - y[i]) / opt.maxDelta[i]);
				}
				if (!Number.isFinite(err)) err = 1e10;
				const fac = Math.min(4, Math.max(0.2, 0.9 / Math.sqrt(Math.max(err, 1e-10))));
				if (err <= 1 && deltaRatio <= 1) {
					accepted = true;
					t = hTry === tNext - t ? tNext : t + hTry;
					y.set(yNew);
					steps++;
					// next step proposal; respect the per-step change cap
					h = hTry * (deltaRatio > 0 ? Math.min(fac, 0.9 / deltaRatio) : fac);
				} else {
					rejected++;
					hTry *= Math.min(fac, deltaRatio > 1 ? 0.9 / deltaRatio : 1);
					if (hTry < 1e-12 * Math.max(Math.abs(t), 1e-30)) throw new Error(`integrate: step size underflow at t = ${t}`);
				}
			}
			if (t === tb) opt.onSegmentEnd?.(y);
			while (iOut < tOut.length && tOut[iOut] <= t) {
				out.push(Float64Array.from(y));
				iOut++;
			}
		}
	}
	return { y: out, steps, rejected, nfev };
}
