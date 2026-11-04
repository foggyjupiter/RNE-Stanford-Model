// 측정 데이터 품질 지표 (A58). python/measurement.py의 data_quality와 같은 계산.
// 분류된 스윕(한 두께)만 보고 계산한다. 모델·역산과 무관한 측정 자체의 지표와, 역산값이 가정에 따라 흔들리는 폭.

import type { MeasureSweepIn } from "./measureJob";
import { resetFeatures, setFeatures } from "./inverse";

export type Grade = "good" | "ok" | "low" | "info";

export interface QualityRow {
	key: string;
	label: string;	// 지표 이름
	value: string;	// 보여 줄 값
	grade: Grade;
	note: string;	// 판단 근거·설명
}

function median(a: number[]): number {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (s.length === 0) return NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

// numpy.percentile (선형 보간)
function percentile(a: number[], q: number): number {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (s.length === 0) return NaN;
	const h = (s.length - 1) * q / 100;
	const lo = Math.floor(h);
	return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
}

function mean(a: number[]): number {
	return a.reduce((x, y) => x + y, 0) / a.length;
}

// 모집단 표준편차 (numpy.std 기본값)
function std(a: number[]): number {
	const m = mean(a);
	return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
}

// 2차 다항식 최소제곱 잔차 (numpy.polyfit 2차와 같은 해, 정규방정식)
function quadResiduals(x: number[], y: number[]): number[] {
	const S = [0, 0, 0, 0, 0];
	const T = [0, 0, 0];
	for (let k = 0; k < x.length; k++) {
		let p = 1;
		for (let e = 0; e <= 4; e++) {
			S[e] += p;
			if (e <= 2) T[e] += p * y[k];
			p *= x[k];
		}
	}
	// [S0 S1 S2; S1 S2 S3; S2 S3 S4] c = [T0 T1 T2] (c0 + c1 x + c2 x²), 크래머 공식
	const det3 = (a: number[][]): number => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
	const d = det3(M);
	const c = [0, 1, 2].map((j) => det3(M.map((row, r) => row.map((v, col) => (col === j ? T[r] : v)))) / d);
	return x.map((xi, k) => y[k] - (c[0] + c[1] * xi + c[2] * xi * xi));
}

export interface QualityNumbers {
	nSweeps: number;
	nUsable: number;	// 깨끗한 RESET + HRS에서 시작한 SET
	counts: Record<string, number>;
	resetsPerDevice: number;	// 소자당 깨끗한 RESET 수 (중앙)
	nPreReset: number;	// RESET 전까지 점 수 (중앙)
	nPreResetMin: number;
	step: number;	// 측정 계단 (RESET 스윕 전압 간격 중앙) [V]
	vResetQuant: number;	// 계단 반폭 / V_reset 중앙 [-]
	vSetQuant: number;	// 계단 반폭 / V_set 중앙 [-]
	snr: number;	// RESET 직전 ΔR/R0 ÷ 점 잡음 (중앙)
	snrP25: number;
	nonMono: number;	// forming·SET 스윕에서 전압을 올리는데 전류가 줄어든 점 비율 (중앙) [-]
	cvReset: number;	// V_reset 변동계수
	cvSet: number;
	sLogLrs: number;	// σ(log10 R_LRS)
	sLogHrs: number;
	overshoot: number;	// RESET 전류 / 앞 SET의 CC (중앙)
	overshootMin: number;
	overshootMax: number;
}

export function qualityNumbers(sweeps: MeasureSweepIn[]): QualityNumbers {
	const counts: Record<string, number> = {};
	for (const s of sweeps) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
	const resets = sweeps.filter((s) => s.kind === "reset");
	const sets = sweeps.filter((s) => s.kind === "set");
	const files = [...new Set(sweeps.map((s) => s.file))];
	const kPeak = (s: MeasureSweepIn): number => {
		let k = 0;
		for (let j = 1; j < s.i.length; j++) if (Math.abs(s.i[j]) > Math.abs(s.i[k])) k = j;
		return k;
	};
	const npre = resets.map(kPeak);
	const vr = resets.map((s, j) => Math.abs(s.v[npre[j]]));
	const steps: number[] = [];
	for (const s of resets) for (let k = 1; k < s.v.length; k++) steps.push(Math.abs(s.v[k] - s.v[k - 1]));
	const step = median(steps);
	const vs = sets.map((s) => setFeatures(s.v.map(Math.abs), s.i.map(Math.abs), s.cc).vSet);
	const snr: number[] = [];
	resets.forEach((s, j) => {
		const k = npre[j];
		const R: number[] = [];
		const P: number[] = [];
		for (let q = 1; q <= k; q++) {
			const v = Math.abs(s.v[q]);
			const i = Math.abs(s.i[q]);
			R.push(v / i);
			P.push(v * i);
		}
		if (R.length < 4) return;
		const sig = R[R.length - 1] / R[0] - 1;
		const noise = std(quadResiduals(P, R)) / mean(R);
		snr.push(sig / Math.max(noise, 1e-6));
	});
	const nonMono: number[] = [];
	for (const s of sweeps) {
		if (s.kind !== "forming" && s.kind !== "set") continue;
		let n = 0;
		for (let k = 2; k < s.i.length; k++) if (Math.abs(s.i[k]) < Math.abs(s.i[k - 1])) n++;
		nonMono.push(s.i.length > 2 ? n / (s.i.length - 2) : 0);
	}
	const rl = resets.map((s) => resetFeatures(s.v.map(Math.abs), s.i.map(Math.abs)).R0);
	const rh = sets.map((s) => setFeatures(s.v.map(Math.abs), s.i.map(Math.abs), s.cc).rHrs).filter((r) => r > 0);
	// RESET 전류 / 같은 파일에서 바로 앞 SET(또는 forming)의 CC
	const ratios: number[] = [];
	let prevCc = NaN;
	let prevFile = "";
	for (const s of sweeps) {
		if (s.file !== prevFile) {
			prevCc = NaN;
			prevFile = s.file;
		}
		if (s.kind === "set" || s.kind === "forming") prevCc = s.cc;
		else if (s.kind === "reset" && Number.isFinite(prevCc)) {
			let im = 0;
			for (const x of s.i) im = Math.max(im, Math.abs(x));
			ratios.push(im / prevCc);
			prevCc = NaN;
		}
	}
	const cv = (a: number[]): number => (a.length > 1 ? std(a) / mean(a) : NaN);
	const sLog = (a: number[]): number => (a.length > 1 ? std(a.map(Math.log10)) : NaN);
	return {
		nSweeps: sweeps.length,
		nUsable: resets.length + sets.length,
		counts,
		resetsPerDevice: median(files.map((f) => resets.filter((s) => s.file === f).length)),
		nPreReset: median(npre),
		nPreResetMin: npre.length ? Math.min(...npre) : NaN,
		step,
		vResetQuant: 0.5 * step / median(vr),
		vSetQuant: 0.5 * step / median(vs),
		snr: median(snr),
		snrP25: percentile(snr, 25),
		nonMono: median(nonMono),
		cvReset: cv(vr),
		cvSet: cv(vs.filter(Number.isFinite)),
		sLogLrs: sLog(rl.filter((r) => r > 0)),
		sLogHrs: sLog(rh),
		overshoot: median(ratios),
		overshootMin: ratios.length ? Math.min(...ratios) : NaN,
		overshootMax: ratios.length ? Math.max(...ratios) : NaN,
	};
}

// 판단 기준 (A58): 경험적 기준. 값이 기준 경계에 걸치면 둘 중 나쁜 쪽
function grade(x: number, good: number, ok: number, higherBetter: boolean): Grade {
	if (!Number.isFinite(x)) return "low";
	if (higherBetter) return x >= good ? "good" : x >= ok ? "ok" : "low";
	return x <= good ? "good" : x <= ok ? "ok" : "low";
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "—");
const num = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : "—");

// 표로 보여 줄 줄. sens: 직렬 저항 가정에 따른 T_crit·지름 범위 (역산 결과)
export function qualityRows(q: QualityNumbers, sens: { tCrit: number; phi: number }[]): QualityRow[] {
	const usable = q.nUsable / Math.max(q.nSweeps, 1);
	const c = q.counts;
	const tc = sens.map((s) => s.tCrit).filter(Number.isFinite);
	const ph = sens.map((s) => s.phi).filter(Number.isFinite);
	const tSpread = tc.length > 1 ? (Math.max(...tc) - Math.min(...tc)) / mean(tc) : NaN;
	const pSpread = ph.length > 1 ? (Math.max(...ph) - Math.min(...ph)) / mean(ph) : NaN;
	return [
		{
			key: "usable", label: "쓸 수 있는 스윕 비율", value: `${q.nUsable} / ${q.nSweeps} (${pct(usable)})`, grade: grade(usable, 0.5, 0.25, true),
			note: `SET 유지 안 됨 ${c.stopped_hrs ?? 0}, HRS 아닌 곳에서 SET ${c.set_low ?? 0}, RESET 중 먼저 SET ${c.set_reset ?? 0}, 기타 ${c.other ?? 0}`,
		},
		{
			key: "perDevice", label: "소자당 깨끗한 RESET 수", value: `중앙 ${num(q.resetsPerDevice, 1)}개`, grade: grade(q.resetsPerDevice, 5, 2, true),
			note: "같은 소자의 사이클 간 거동을 보려면 여러 번 필요",
		},
		{
			key: "quant", label: "전압 분해능", value: `계단 ${num(q.step, 2)} V → V_reset ±${pct(q.vResetQuant)}, V_set ±${pct(q.vSetQuant)}`,
			grade: grade(Math.max(q.vResetQuant, q.vSetQuant), 0.05, 0.1, false), note: "계단 반폭 ÷ 스위칭 전압 중앙값",
		},
		{
			key: "npre", label: "RESET 직전 점 수", value: `중앙 ${num(q.nPreReset, 1)}개 (최소 ${num(q.nPreResetMin)})`, grade: grade(q.nPreReset, 8, 4, true),
			note: "[C] 식 (5)의 온도 추출에 쓰는 점",
		},
		{
			key: "snr", label: "RESET 직전 저항 변화 대 잡음", value: `중앙 ${num(q.snr)} (하위 25% ${num(q.snrP25)})`, grade: grade(q.snrP25, 30, 10, true),
			note: "ΔR/R0 ÷ (R 대 P 2차 맞춤 잔차/평균 R). 필라멘트 발열 신호의 선명도",
		},
		{
			key: "noise", label: "저전류 잡음", value: `전압을 올리는데 전류가 준 점 ${pct(q.nonMono)}`, grade: grade(q.nonMono, 0.05, 0.2, false),
			note: "forming·SET 스윕 중앙값. 깨끗하면 0%",
		},
		{
			key: "spread", label: "사이클·소자 간 산포",
			value: `V_reset CV ${pct(q.cvReset)}, V_set CV ${pct(q.cvSet)}, LRS ${num(q.sLogLrs, 2)} · HRS ${num(q.sLogHrs, 2)} 자릿수`,
			grade: grade(q.sLogHrs, 0.5, 1.0, false), note: "판단은 HRS 산포(σ log10 R) 기준. 갭 크기 추정의 불확실성으로 이어짐",
		},
		{
			key: "overshoot", label: "RESET 전류 / 앞 SET의 CC", value: `중앙 ${num(q.overshoot)}배 (${num(q.overshootMin)}–${num(q.overshootMax)}배)`, grade: "info",
			note: "측정 결함이 아니라 소자 특성 (패드 정전용량 방전, A51)",
		},
		{
			key: "assume", label: "가정에 따른 흔들림 (R_L)", value: `T_crit ±${pct(0.5 * tSpread)}, 지름 ±${pct(0.5 * pSpread)}`,
			grade: grade(0.5 * Math.max(tSpread, pSpread), 0.1, 0.3, false), note: "직렬 저항 민감도 표의 범위. 프로브 단락 저항을 재면 줄어듦",
		},
	];
}
