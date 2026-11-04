// 측정 데이터 작업: 분류된 측정 스윕에서 특징값을 뽑고 역산한다 (정적, 수 초).
// 시뮬레이션 겹쳐 보기 작업: 역산값으로 RESET → SET을 같은 조건으로 계산한다 (과도, 수십 초).

import { DEFAULT_GRID, EV, type GridSpec, type Params } from "./params";
import {
	fitEa, fitGap, fitKappaEl, fitLrs, fitNeck, gapProfile, geomspace, lowFieldResistance, modelLrsCurve, modelVSet, oxideResistivity, resetFeatures,
	russoExtraction, setFeatures, uniformCf, type LrsCurve,
} from "./inverse";
import { rampWaveform, readResistance, simulate, type SimResult } from "./simulate";
import type { SweepKind } from "./measurement";
import { qualityNumbers, type QualityNumbers } from "./quality";

export interface MeasureSweepIn {
	file: string;
	index: number;
	kind: SweepKind;
	v: number[];	// [V]
	i: number[];	// [A]
	cc: number;	// [A]
	firstForming: boolean;	// 파일의 첫 forming이고 포밍 전 저항 > 1e8 ohm (산화막 비저항용)
}

export interface MeasureJob {
	kind: "measure";
	sweeps: MeasureSweepIn[];	// 한 두께의 스윕만
	params: Params;	// L0, aCell은 측정 소자 값으로 넣어서 보낸다
	alpha: number;	// 필라멘트 저항 온도 계수 [1/K] ([C] 식 (1))
	rlList: number[];	// 직렬 저항 민감도 [ohm]. params.RL이 기준
	grid?: GridSpec;
}

export interface ResetRow {
	file: string;
	index: number;
	R0: number;	// 저전계 저항 (R_L 뺀 값) [ohm]
	vReset: number;	// [V]
	iReset: number;	// [A]
	tCrit: number;	// [K]
	rth: number;	// [K/W]
	P: number[];	// RESET 전 전력 [W]
	T: number[];	// [C] 식 (5) 온도 [K]
}

export interface SetRow {
	file: string;
	index: number;
	vSet: number;	// [V]
	rHrs: number;	// (R_L 뺀 값) [ohm]
	cc: number;	// [A]
}

export interface SensRow {
	RL: number;	// [ohm]
	R0: number;	// 중앙값 [ohm]
	rth: number;	// 중앙값 [K/W]
	tCrit: number;	// 중앙값 [K]
	ratio: number;	// Rth/R0
	phi: number;	// [m]
	N: number;
	separable: boolean;
}

export interface MeasureOutput {
	kind: "measure";
	rPristine: number[];	// 포밍 전 저전계 저항 [ohm]
	rhoOx: number;	// 산화막 비저항 [ohm·m] (A44)
	resets: ResetRow[];	// 기준 R_L
	sets: SetRow[];
	sens: SensRow[];	// R_L마다
	main: number;	// sens에서 기준 R_L의 위치
	curve: LrsCurve;	// 모델 Rth/R0 대 지름 (필라멘트 1개)
	kappaEl: number;	// 열 보정 (A56): 측정 Rth에 맞춘 전극 열전도도 [W/(K·m)] (NaN이면 못 맞춤)
	phiK: number;	// 그때의 필라멘트 지름 [m]
	gap: number;	// HRS 중앙값으로 본 끊긴 갭 길이 [m] (호핑 전도가 켜져 있을 때, A55)
	rNeck: number;	// HRS 중앙값으로 본 잘록 반경 [m] (NaN이면 연속체 모델 범위 밖)
	neckLen: number;	// [m]
	quality: QualityNumbers;	// 데이터 품질 지표 (A58)
	vResetMed: number;
	iResetMed: number;
	vSetMed: number;
	rHrsMed: number;
}

export function median(a: number[]): number {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (s.length === 0) return NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export function runMeasure(job: MeasureJob, onProgress?: (done: number, total: number) => void): MeasureOutput {
	const gs = job.grid ?? DEFAULT_GRID;
	let p = job.params;
	const rPristine = job.sweeps.filter((s) => s.firstForming).map((s) => lowFieldResistance(s.v.map(Math.abs), s.i.map(Math.abs)));
	const rhoOx = rPristine.length ? oxideResistivity(median(rPristine), p) : NaN;
	if (Number.isFinite(rhoOx)) p = { ...p, rhoOx };
	const resetIn = job.sweeps.filter((s) => s.kind === "reset");
	const setIn = job.sweeps.filter((s) => s.kind === "set");
	const rows = (RL: number): ResetRow[] => resetIn.map((s) => {
		const f = resetFeatures(s.v, s.i, RL);
		const rr = russoExtraction(f, job.alpha, p.T0);
		return { file: s.file, index: s.index, R0: f.R0, vReset: f.vReset, iReset: f.iReset, tCrit: rr.tCrit, rth: rr.rthFit, P: f.P, T: rr.T };
	});
	const resets = rows(p.RL);
	const sets: SetRow[] = setIn.map((s) => {
		const f = setFeatures(s.v, s.i, s.cc, p.RL);
		return { file: s.file, index: s.index, vSet: f.vSet, rHrs: f.rHrs, cc: s.cc };
	});
	onProgress?.(0.1, 1);
	// 모델 곡선은 기준 R_L의 T_crit 중앙값에서 한 번만 만들고 민감도 계산에 같이 쓴다 (Rth/R0는 T_target에 약하게만 의존)
	const tMain = median(resets.map((r) => r.tCrit));
	const curve = modelLrsCurve(p, geomspace(3e-9, 1.9 * p.Rdom, 24), Number.isFinite(tMain) && tMain > p.T0 + 20 ? tMain : 600, job.alpha, gs);
	onProgress?.(0.7, 1);
	const rls = [...new Set([...job.rlList, p.RL])].sort((a, b) => a - b);
	const sens: SensRow[] = rls.map((RL) => {
		const rs = RL === p.RL ? resets : rows(RL);
		const R0 = median(rs.map((r) => r.R0));
		const rth = median(rs.map((r) => r.rth));
		const fit = R0 > 0 && rth > 0 ? fitLrs(R0, rth, { ...p, RL }, 600, job.alpha, gs, 0.2, curve) : null;
		return {
			RL, R0, rth, tCrit: median(rs.map((r) => r.tCrit)), ratio: rth / R0,
			phi: fit ? fit.phi : NaN, N: fit ? fit.N : NaN, separable: fit ? fit.separable : false,
		};
	});
	const main = rls.indexOf(p.RL);
	const m0 = sens[main];
	// 열 보정: 기준 R_L에서 필라멘트 개수(나눌 수 없으면 1개)로 κ_el을 측정 Rth에 맞춘다. 갭 역산도 이 값으로
	let kappaEl = NaN;
	let phiK = NaN;
	if (m0.R0 > 0 && m0.rth > 0 && p.tEl > 0) {
		const k = fitKappaEl(m0.R0, m0.rth, p, Number.isFinite(tMain) && tMain > p.T0 + 20 ? tMain : 600, job.alpha, gs, m0.separable ? Math.max(1, m0.N) : 1);
		kappaEl = k.kappaEl;
		phiK = k.phi;
		if (Number.isFinite(kappaEl)) p = { ...p, kappaEl };
	}
	onProgress?.(0.9, 1);
	const rHrsMed = median(sets.map((s) => s.rHrs));
	let rNeck = NaN;
	let neckLen = NaN;
	let gap = NaN;
	const phiUse = Number.isFinite(phiK) ? phiK : m0.phi;
	if (Number.isFinite(phiUse) && Number.isFinite(rHrsMed)) {
		const nk = fitNeck(rHrsMed, phiUse, Math.max(1, m0.N), p, gs);
		rNeck = nk.rNeck;
		neckLen = nk.neckLen;
		// 갭 역산은 정적 계산이라 호핑을 켜서 푼다 (과도 계산의 호핑 설정과 무관, A55)
		gap = fitGap(rHrsMed, phiUse, Math.max(1, m0.N), { ...p, hop: 1 }, gs);
	}
	onProgress?.(1, 1);
	return {
		kind: "measure", rPristine, rhoOx, resets, sets, sens, main, curve, kappaEl, phiK, gap, rNeck, neckLen, quality: qualityNumbers(job.sweeps),
		vResetMed: median(resets.map((r) => r.vReset)), iResetMed: median(resets.map((r) => r.iReset)),
		vSetMed: median(sets.map((s) => s.vSet)), rHrsMed,
	};
}

export interface MeasureSimJob {
	kind: "measureSim";
	params: Params;	// 역산값(phi0, rhoOx, RL, Ea...)을 넣어서 보낸다
	rate: number;	// [V/s]
	vResetMax: number;	// RESET 램프 끝 전압 [V]
	vSetMax: number;	// SET 램프 끝 전압 [V]
	icc: number;	// SET 전류 제한 [A]
	includeCp: boolean;	// 패드 정전용량 (A51)
	fitEa: boolean;	// 측정 V_set에 E_a를 먼저 맞춤 (A54)
	vSetTarget: number;	// [V]
	hrsGap: number;	// > 0이면 SET을 이 길이의 끊긴 갭(측정 HRS에 맞춘 형상)에서 시작 [m]. 아니면 시뮬레이션 RESET 끝 상태
	grid?: GridSpec;
}

export interface MeasureSimOutput {
	kind: "measureSim";
	reset: SimResult;
	set: SimResult;
	eaEV: number;	// 쓴 E_a [eV]
	fitted: boolean;	// E_a를 맞췄는지 (실패하면 false, 입력값 그대로)
	vNoGrowth: number;	// 성장 없이(E_a 3 eV) 호핑·누설 전류만으로 CC에 닿는 전압 [V] (E_a 맞추기 실패 원인 진단)
	setFromHrs: boolean;	// SET을 측정 HRS 형상에서 시작했는지
	rHrs: number;	// RESET 뒤 읽기 저항 [ohm]
	rLrs: number;	// SET 뒤 읽기 저항 [ohm]
}

export function runMeasureSim(job: MeasureSimJob, onProgress?: (done: number, total: number) => void): MeasureSimOutput {
	const gs = job.grid ?? DEFAULT_GRID;
	let p = job.params;
	const reset = simulate(rampWaveform("reset", job.vResetMax, job.rate), uniformCf(p.phi0, p, gs), p, { grid: gs, onProgress: (f) => onProgress?.(0.2 * f, 1) });
	const setFromHrs = job.hrsGap > 0;
	const rb0 = setFromHrs ? gapProfile(p.phi0, job.hrsGap, p, gs) : reset.rbEnd;
	let fitted = false;
	let vNoGrowth = NaN;
	if (job.fitEa && Number.isFinite(job.vSetTarget)) {
		let n = 0;
		const ea = fitEa(job.vSetTarget, rb0, p, job.rate, job.icc, gs, 0.4, 3.0, () => onProgress?.(0.2 + 0.6 * Math.min(1, ++n / 12), 1));
		if (Number.isFinite(ea)) {
			p = { ...p, Ea: ea };
			fitted = true;
		} else {
			vNoGrowth = modelVSet(rb0, { ...p, Ea: 3.0 * EV }, job.rate, 1.5 * job.vSetTarget + 0.5, job.icc, gs).vSet;
		}
	}
	const set = simulate(rampWaveform("set", job.vSetMax, job.rate), rb0, p, {
		iCc: job.icc, ccHold: 0.1 / job.rate, includeCp: job.includeCp, dvcMax: job.includeCp ? 0.05 : undefined, grid: gs,
		onProgress: (f) => onProgress?.(0.8 + 0.2 * f, 1),
	});
	return {
		kind: "measureSim", reset, set, eaEV: p.Ea / EV, fitted, vNoGrowth, setFromHrs,
		rHrs: readResistance(reset.rbEnd, p, 0.1, gs), rLrs: readResistance(set.rbEnd, p, 0.1, gs),
	};
}
