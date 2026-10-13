// 2차원 원통 좌표 (r, z) 정상 상태 전위·온도 풀이와 CF 경계 이동 속도. python/rram_model.py를 옮긴 것.
// [R] 식 (1) 전위, (2) 열, (4) 저항의 온도 의존, (5) 열 용해. [D] 식 (2) SET 측면 성장.

import { K_B, Q_E, type GridSpec, type Params } from "./params";

export interface Grid {
	rFaces: Float64Array;	// 반경 방향 셀 경계 [m]
	zFaces: Float64Array;	// 길이 방향 셀 경계 [m]
	rc: Float64Array;	// 셀 중심 반경 [m]
	zc: Float64Array;	// 셀 중심 높이 [m]
	nr: number;
	nz: number;
}

// 반경: CF 근처(0.75*phi0까지) 균일 drFine, 그 밖은 등비로 Rdom까지. 길이: 균일 nz칸.
export function makeGrid(p: Params, gs: GridSpec): Grid {
	const rFine = Math.min(0.75 * p.phi0, p.Rdom);
	const faces: number[] = [];
	for (let k = 0; k * gs.drFine <= rFine + 1e-15; k++) faces.push(k * gs.drFine);
	if (faces[faces.length - 1] < rFine - 1e-15) faces.push(rFine);
	let d = gs.drFine;
	while (faces[faces.length - 1] < p.Rdom - 1e-15) {
		d *= gs.growth;
		faces.push(Math.min(faces[faces.length - 1] + d, p.Rdom));
	}
	const nr = faces.length - 1;
	const nz = gs.nz;
	const rFaces = Float64Array.from(faces);
	const zFaces = new Float64Array(nz + 1);
	for (let k = 0; k <= nz; k++) zFaces[k] = p.L0 * k / nz;
	const rc = new Float64Array(nr);
	const zc = new Float64Array(nz);
	for (let i = 0; i < nr; i++) rc[i] = 0.5 * (rFaces[i] + rFaces[i + 1]);
	for (let j = 0; j < nz; j++) zc[j] = 0.5 * (zFaces[j] + zFaces[j + 1]);
	return { rFaces, zFaces, rc, zc, nr, nz };
}

// 셀별 CF 단면적 비율 (nz*nr, 행 우선). 경계가 걸친 셀은 면적 비율로 섞는다 (A30)
export function cfFraction(g: Grid, rb: ArrayLike<number>): Float64Array {
	const out = new Float64Array(g.nz * g.nr);
	for (let j = 0; j < g.nz; j++) {
		const rb2 = rb[j] * rb[j];
		for (let i = 0; i < g.nr; i++) {
			const r0 = g.rFaces[i];
			const r1 = g.rFaces[i + 1];
			const fr = (rb2 - r0 * r0) / (r1 * r1 - r0 * r0);
			out[j * g.nr + i] = Math.min(Math.max(fr, 0), 1);
		}
	}
	return out;
}

// ---------------------------------------------------------------- 대역 대칭 양정치 행렬
// 미지수 순서는 (z, r) 행 우선이라 이웃은 ±1(r), ±nr(z): 반대역폭 = nr
class BandSPD {
	readonly a: Float64Array;	// a[i*(b+1) + k] = A(i, i-k), k = 0..b

	constructor(readonly n: number, readonly b: number) {
		this.a = new Float64Array(n * (b + 1));
	}

	add(i: number, j: number, v: number): void {
		this.a[i * (this.b + 1) + (i - j)] += v;	// j <= i 만 저장
	}

	// 제자리 Cholesky 분해 (A = L L^T). 양정치가 아니면 false
	factor(): boolean {
		const { n, b, a } = this;
		const w = b + 1;
		for (let i = 0; i < n; i++) {
			const j0 = Math.max(0, i - b);
			for (let j = j0; j <= i; j++) {
				let s = a[i * w + (i - j)];
				const k0 = Math.max(j0, j - b);
				for (let k = k0; k < j; k++) s -= a[i * w + (i - k)] * a[j * w + (j - k)];
				if (i === j) {
					if (!(s > 0)) return false;
					a[i * w] = Math.sqrt(s);
				} else {
					a[i * w + (i - j)] = s / a[j * w];
				}
			}
		}
		return true;
	}

	// 분해된 행렬로 A x = rhs를 푼다 (rhs를 덮어씀)
	solve(x: Float64Array): void {
		const { n, b, a } = this;
		const w = b + 1;
		for (let i = 0; i < n; i++) {
			let s = x[i];
			for (let k = Math.max(0, i - b); k < i; k++) s -= a[i * w + (i - k)] * x[k];
			x[i] = s / a[i * w];
		}
		for (let i = n - 1; i >= 0; i--) {
			let s = x[i];
			for (let k = i + 1; k <= Math.min(n - 1, i + b); k++) s -= a[k * w + (k - i)] * x[k];
			x[i] = s / a[i * w];
		}
	}
}

interface Assembled {
	A: BandSPD;
	gTop: Float64Array;	// 위 끝 셀 ↔ 위 전극 컨덕턴스 (nr)
	gBot: Float64Array;	// 아래 끝 셀 ↔ 아래 전극 (nr)
	gr: Float64Array;	// 반경 방향 면 컨덕턴스, (nz, nr-1)
	gz: Float64Array;	// 길이 방향 면 컨덕턴스, (nz-1, nr)
}

// -div(k grad u) 유한체적 행렬. 위/아래 전극은 Dirichlet, 축과 옆면은 Neumann [R]
function assemble(g: Grid, k: Float64Array): Assembled {
	const { nr, nz, rFaces: rf, rc } = g;
	const dz = g.zFaces[1] - g.zFaces[0];	// 균일 격자
	const gr = new Float64Array(nz * (nr - 1));
	const gz = new Float64Array((nz - 1) * nr);
	const gTop = new Float64Array(nr);
	const gBot = new Float64Array(nr);
	const A = new BandSPD(nz * nr, nr);
	for (let j = 0; j < nz; j++) {
		for (let i = 0; i < nr - 1; i++) {
			const area = 2 * Math.PI * rf[i + 1] * dz;
			const v = area / ((rf[i + 1] - rc[i]) / k[j * nr + i] + (rc[i + 1] - rf[i + 1]) / k[j * nr + i + 1]);
			gr[j * (nr - 1) + i] = v;
		}
	}
	for (let i = 0; i < nr; i++) {
		const ring = Math.PI * (rf[i + 1] * rf[i + 1] - rf[i] * rf[i]);
		for (let j = 0; j < nz - 1; j++) gz[j * nr + i] = ring / (0.5 * dz / k[j * nr + i] + 0.5 * dz / k[(j + 1) * nr + i]);
		gBot[i] = ring * k[i] / (0.5 * dz);
		gTop[i] = ring * k[(nz - 1) * nr + i] / (0.5 * dz);
	}
	for (let j = 0; j < nz; j++) {
		for (let i = 0; i < nr; i++) {
			const id = j * nr + i;
			let d = 0;
			if (i > 0) {
				const v = gr[j * (nr - 1) + i - 1];
				d += v;
				A.add(id, id - 1, -v);
			}
			if (i < nr - 1) d += gr[j * (nr - 1) + i];
			if (j > 0) {
				const v = gz[(j - 1) * nr + i];
				d += v;
				A.add(id, id - nr, -v);
			}
			if (j < nz - 1) d += gz[j * nr + i];
			if (j === 0) d += gBot[i];
			if (j === nz - 1) d += gTop[i];
			A.add(id, id, d);
		}
	}
	return { A, gTop, gBot, gr, gz };
}

export interface Fields {
	V: Float64Array;	// 전위 (nz*nr) [V]
	T: Float64Array;	// 온도 (nz*nr) [K]
	I: number;	// 필라멘트 1개 전류 [A]
	P: number;	// 소비 전력 [W]
	tMax: number;	// 최고 온도 [K]
}

// 한 CF 형상(rb)에 대해 정상 상태 전위·온도를 푸는 도우미. 열 행렬 분해를 재사용한다
export class FieldSolver {
	private readonly fr: Float64Array;
	private readonly th: Assembled;
	tLast: Float64Array | null = null;

	constructor(private readonly g: Grid, private readonly p: Params, rb: ArrayLike<number>) {
		this.fr = cfFraction(g, rb);
		const kappa = new Float64Array(this.fr.length);
		for (let m = 0; m < kappa.length; m++) kappa[m] = this.fr[m] * p.kappaCf + (1 - this.fr[m]) * p.kappaOx;
		this.th = assemble(g, kappa);
		if (!this.th.A.factor()) throw new Error("열 행렬 분해 실패");
	}

	// 셀 양단 전압 v [V]에서 V, T를 Picard 반복으로 푼다 ([R] 식 (1)-(4)). 부호 대칭
	solve(v: number, tol = 0.05, maxIter = 80, relax = 0.7): Fields {
		const { g, p, fr } = this;
		const { nr, nz } = g;
		const n = nr * nz;
		const s = v >= 0 ? 1 : -1;
		const va = Math.abs(v);
		let T = this.tLast ? Float64Array.from(this.tLast) : new Float64Array(n).fill(p.T0);
		let V = new Float64Array(n);
		let el: Assembled | null = null;
		const q = new Float64Array(n);
		const sigma = new Float64Array(n);
		for (let it = 0; it < maxIter; it++) {
			for (let m = 0; m < n; m++) {
				const rho = p.rhoCf * (1 + p.alphaT * (T[m] - p.T0));
				sigma[m] = fr[m] / rho + (1 - fr[m]) / p.rhoOx;
			}
			el = assemble(g, sigma);
			if (!el.A.factor()) throw new Error("전위 행렬 분해 실패");
			V = new Float64Array(n);
			for (let i = 0; i < nr; i++) V[(nz - 1) * nr + i] = el.gTop[i] * va;
			el.A.solve(V);
			// 줄 발열: 면 컨덕턴스 G*dV^2를 양쪽 셀에 반씩 (총합 = I*V)
			q.fill(0);
			for (let j = 0; j < nz; j++) {
				for (let i = 0; i < nr - 1; i++) {
					const dv = V[j * nr + i + 1] - V[j * nr + i];
					const pw = el.gr[j * (nr - 1) + i] * dv * dv;
					q[j * nr + i] += 0.5 * pw;
					q[j * nr + i + 1] += 0.5 * pw;
				}
			}
			for (let j = 0; j < nz - 1; j++) {
				for (let i = 0; i < nr; i++) {
					const dv = V[(j + 1) * nr + i] - V[j * nr + i];
					const pw = el.gz[j * nr + i] * dv * dv;
					q[j * nr + i] += 0.5 * pw;
					q[(j + 1) * nr + i] += 0.5 * pw;
				}
			}
			for (let i = 0; i < nr; i++) {
				q[i] += el.gBot[i] * V[i] * V[i];
				const dt = va - V[(nz - 1) * nr + i];
				q[(nz - 1) * nr + i] += el.gTop[i] * dt * dt;
			}
			const tNew = Float64Array.from(q);
			for (let i = 0; i < nr; i++) {
				tNew[i] += this.th.gBot[i] * p.T0;
				tNew[(nz - 1) * nr + i] += this.th.gTop[i] * p.T0;
			}
			this.th.A.solve(tNew);
			let dT = 0;
			for (let m = 0; m < n; m++) dT = Math.max(dT, Math.abs(tNew[m] - T[m]));
			if (it === 0) {
				T = tNew;
			} else {
				for (let m = 0; m < n; m++) T[m] += relax * (tNew[m] - T[m]);
			}
			if (dT < tol) break;
		}
		this.tLast = T;
		let I = 0;
		let P = 0;
		let tMax = -Infinity;
		for (let i = 0; i < nr; i++) I += el!.gTop[i] * (va - V[(nz - 1) * nr + i]);
		for (let m = 0; m < n; m++) {
			P += q[m];
			tMax = Math.max(tMax, T[m]);
		}
		if (s < 0) for (let m = 0; m < n; m++) V[m] = -V[m];
		return { V, T, I: s * I, P, tMax };
	}
}

// np.interp와 같은 선형 보간 (양 끝 밖은 끝값)
function interpRow(x: number, xs: Float64Array, ys: Float64Array, off: number): number {
	const n = xs.length;
	if (x <= xs[0]) return ys[off];
	if (x >= xs[n - 1]) return ys[off + n - 1];
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= x) lo = mid;
		else hi = mid;
	}
	const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
	return ys[off + lo] + t * (ys[off + hi] - ys[off + lo]);
}

// 각 높이에서 CF 경계(r = rb)의 온도 [K]와 길이 방향 전계 크기 [V/m]
export function boundaryValues(g: Grid, fld: Fields, rb: ArrayLike<number>): { Tb: Float64Array; Eb: Float64Array } {
	const { nz, nr, rc, zc } = g;
	const Tb = new Float64Array(nz);
	const Eb = new Float64Array(nz);
	const Va = new Float64Array(fld.V.length);
	for (let m = 0; m < Va.length; m++) Va[m] = Math.abs(fld.V[m]);
	for (let j = 0; j < nz; j++) {
		Tb[j] = interpRow(rb[j], rc, fld.T, j * nr);
		const ju = Math.min(j + 1, nz - 1);
		const jd = Math.max(j - 1, 0);
		const up = interpRow(rb[j], rc, Va, ju * nr);
		const dn = interpRow(rb[j], rc, Va, jd * nr);
		const span = zc[ju] - zc[jd];
		Eb[j] = span > 0 ? Math.abs(up - dn) / span : 0;
	}
	return { Tb, Eb };
}

// [R] 식 (5): 열 용해로 CF 경계가 축 쪽으로 움직이는 속도 [m/s]
export function rateDissolve(T: number, p: Params): number {
	return p.vD0 * Math.exp(-p.Ed / (K_B * T));
}

// [D] 식 (2): SET 중 CF 경계가 바깥쪽으로 움직이는 속도 [m/s]. E는 경계의 국소 전계 (A33), r >= Delta_r/2 (A32)
export function rateGrow(r: number, E: number, T: number, p: Params): number {
	const re = Math.max(r, 0.5 * p.dr);
	const pref = p.dr + p.dr * p.dr / (2 * re);
	return pref * p.f * Math.exp(-(p.Ea - p.alphaA * p.Z * Q_E * E) / (K_B * T));
}

// 경계 반경의 시간 변화율 [m/s]. op = "set" (성장 + 용해) | "reset" (용해만) (A25)
export function boundaryVelocity(op: "set" | "reset", rb: ArrayLike<number>, g: Grid, fld: Fields, p: Params): Float64Array {
	const { Tb, Eb } = boundaryValues(g, fld, rb);
	const vel = new Float64Array(g.nz);
	for (let j = 0; j < g.nz; j++) {
		let v = rb[j] > 0 ? -rateDissolve(Tb[j], p) : 0;
		if (op === "set") v += rateGrow(rb[j], Eb[j], Tb[j], p);
		if (rb[j] >= 0.98 * p.Rdom && v > 0) v = 0;	// 영역 밖으로는 자라지 않는다
		vel[j] = v;
	}
	return vel;
}
