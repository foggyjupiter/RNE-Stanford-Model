// 적응형 Rosenbrock 적분기 (ROS2, L-stable, 2차 + 내장 1차 오차 추정).
// 참고: J.G. Verwer, E.J. Spee, J.G. Blom, W. Hundsdorfer, "A second-order Rosenbrock method
// applied to photochemical dispersion problems", SIAM J. Sci. Comput. 20 (1999) 1456-1480.
//
// 비자율계 y' = f(t, y)를 자율화해서 (t를 t' = 1인 상태 변수로 추가)
// f의 시간 미분이 야코비안의 df/dt 열로 들어가게 한다.
// 야코비안은 전진 차분. 작은 밀집 시스템 전용 (여기서는 n <= 4).

export type Rhs = (t: number, y: Float64Array, out: Float64Array) => void;

export interface IntegrateOptions {
	rtol: number;	// 상대 허용오차 [-]
	atol: readonly number[];	// 성분별 절대 허용오차 [상태 단위]
	maxStep: number;	// 스텝 상한 [s]
	maxDelta?: readonly number[];	// 한 스텝에서 각 성분의 |변화량| 상한, 스위칭 중 스텝을 제한 [상태 단위]
	breakpoints?: readonly number[];	// f가 불연속인 시점, 여기서 적분을 다시 시작 [s]
	onSegment?: (tStart: number, tEnd: number) => void;	// 각 구간 시작 전에 호출 (예: 잡음 설정)
	onSegmentEnd?: (y: Float64Array) => void;	// 구간 끝에서 y를 직접 수정 가능 (예: 범위 자르기)
	maxStepsPerSegment?: number;
}

export interface IntegrateResult {
	y: Float64Array[];	// 요청한 출력 시점마다의 상태
	steps: number;	// 채택된 스텝 수
	rejected: number;	// 버려진 스텝 수
	nfev: number;	// 우변 계산 횟수
}

const GAMMA = 1 + 1 / Math.SQRT2;
const SQRT_EPS = Math.sqrt(Number.EPSILON);

// 부분 피벗 가우스 소거로 A*x = b를 제자리에서 푼다 (b <- x). A는 n*n 행 우선 배열이며 값이 망가진다.
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

// tOut[0] (초기 시각, y0)부터 모든 tOut 점까지 적분한다. tOut은 순증가해야 한다.
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
			if (++stepsHere > maxSteps) throw new Error(`integrate: [${ta}, ${tb}] 구간에서 스텝이 너무 많음`);
			const tNext = Math.min(tb, iOut < tOut.length ? tOut[iOut] : tb);
			let hTry = Math.min(h, opt.maxStep, tNext - t);
			// 다음 정지점 직전에 스텝의 1%보다 작은 자투리를 남기지 않는다
			if (tNext - (t + hTry) < 0.01 * hTry) hTry = tNext - t;

			// (t, y)에서의 야코비안 df/dy, df/dt (전진 차분)
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
				// 1단: (I - g h J) k1 = f0 + g h f_t
				for (let i = 0; i < n * n; i++) M[i] = -gh * J[i];
				for (let i = 0; i < n; i++) M[i * n + i] += 1;
				for (let i = 0; i < n; i++) k1[i] = f0[i] + gh * ft[i];
				luSolveInPlace(M, k1, n);
				// 2단: (I - g h J) k2 = f(t + h, y + h k1) - 2 k1 - g h f_t
				for (let i = 0; i < n; i++) yp[i] = y[i] + hTry * k1[i];
				evalF(t + hTry, yp, fp);
				for (let i = 0; i < n * n; i++) M[i] = -gh * J[i];
				for (let i = 0; i < n; i++) M[i * n + i] += 1;
				for (let i = 0; i < n; i++) k2[i] = fp[i] - 2 * k1[i] - gh * ft[i];
				luSolveInPlace(M, k2, n);

				// y_{n+1} = y + h (3/2 k1 + 1/2 k2), 오차 = y_{n+1} - (y + h k1) = h/2 (k1 + k2)
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
					// 다음 스텝 제안, 스텝당 변화량 상한을 지킨다
					h = hTry * (deltaRatio > 0 ? Math.min(fac, 0.9 / deltaRatio) : fac);
				} else {
					rejected++;
					hTry *= Math.min(fac, deltaRatio > 1 ? 0.9 / deltaRatio : 1);
					if (hTry < 1e-12 * Math.max(Math.abs(t), 1e-30)) throw new Error(`integrate: t = ${t}에서 스텝 크기 언더플로`);
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
