// 앱 상태와 모드별 기본값.

import { DEFAULT, DEFAULT_MC, DEFAULT_VARIABILITY, RS_SET, type MonteCarloSpec, type Params, type Variability } from "../model";

export type Mode = "sweep" | "pulse" | "sequence" | "fixed";

// SET 동작의 전류 제한 방식: 직렬 저항 R_s 또는 측정기 전류 제한 CC (A40)
export type Limit = "rs" | "cc";

export const MODE_LABELS: Record<Mode, string> = {
	sweep: "I-V 스윕",
	pulse: "펄스",
	sequence: "쓰기-읽기 시퀀스",
	fixed: "고정 상태",
};

// unipolar 스윕: 0 → +V_RESET → 0 (compliance 없음) → +V_SET → 0 (R_s 직렬). 포밍된 LRS에서 시작
export interface SweepSettings {
	vReset: number;	// [V]
	vSet: number;	// [V]
	tRamp: number;	// 구간당 램프 시간 [s]
	rs: number;	// SET compliance 저항 [ohm]
	limit: Limit;
	icc: number;	// SET 전류 제한 [A]
	cycles: number;
}

export interface PulseSettings {
	op: "set" | "reset";
	amplitude: number;	// [V], 양의 극성
	width: number;	// 평탄부 [s]
	tEdge: number;	// [s]
	rs: number;	// [ohm]
	limit: Limit;
	icc: number;	// [A]
}

// 쓰기-읽기 기본 펄스 (A21): RESET 3 V / 10 µs → 약 19 kΩ, SET 2.5 V / 1 µs (R_s 3 kΩ) → 약 1 kΩ 이하.
// 1 µs RESET은 3 V에서도 3.6 kΩ까지만 올라가 창이 작다
export interface SequenceSettings {
	resetV: number;	// [V]
	resetWidth: number;	// [s]
	setV: number;	// [V]
	setWidth: number;	// [s]
	vRead: number;	// [V]
	tEdge: number;	// [s]
	rs: number;	// [ohm]
	limit: Limit;
	icc: number;	// [A]
	cycles: number;
}

export interface FixedSettings {
	rNeck: number;	// 잘록 구간 반경 [m]
	neckLen: number;	// 잘록 구간 길이 [m]
	vMax: number;	// 스윕 범위 ±vMax [V]
	mcOn: boolean;	// 소자 간 몬테카를로 (교수님 요청, A38)
	mc: MonteCarloSpec;
}

export interface AppState {
	mode: Mode;
	params: Params;
	variabilityOn: boolean;
	variability: Variability;
	seed: number;
	sweep: SweepSettings;
	pulse: PulseSettings;
	sequence: SequenceSettings;
	fixed: FixedSettings;
}

// CC 기본값 [A]: 기본 소자(φ 80 nm, [R] Table I)의 R_s 3 kΩ 스윕에서 SET 최대 전류(약 1.2 mA)와 같은 자릿수 (A40)
export const ICC_DEFAULT = 1e-3;

export const DEFAULT_SWEEP: SweepSettings = { vReset: 1.6, vSet: 4.0, tRamp: 0.25, rs: RS_SET, limit: "rs", icc: ICC_DEFAULT, cycles: 1 };
export const DEFAULT_PULSE: PulseSettings = { op: "reset", amplitude: 3.0, width: 10e-6, tEdge: 10e-9, rs: RS_SET, limit: "rs", icc: ICC_DEFAULT };
export const DEFAULT_SEQUENCE: SequenceSettings = {
	resetV: 3.0,
	resetWidth: 10e-6,
	setV: 2.5,
	setWidth: 1e-6,
	vRead: 0.1,
	tEdge: 10e-9,
	rs: RS_SET,
	limit: "rs",
	icc: ICC_DEFAULT,
	cycles: 2,
};
export const DEFAULT_FIXED: FixedSettings = { rNeck: 4e-9, neckLen: 8e-9, vMax: 0.5, mcOn: false, mc: { ...DEFAULT_MC } };

// 변동성을 켤 때 사이클 수가 1이면 이 값으로 올린다. 2차원 계산이라 사이클당 수 초가 걸려 낮게 잡음
export const VARIABILITY_CYCLES = 3;
export const MAX_CYCLES = 20;

export function initialState(): AppState {
	return {
		mode: "sweep",
		params: { ...DEFAULT },
		variabilityOn: false,
		variability: { ...DEFAULT_VARIABILITY },
		seed: 1,
		sweep: { ...DEFAULT_SWEEP },
		pulse: { ...DEFAULT_PULSE },
		sequence: { ...DEFAULT_SEQUENCE },
		fixed: { ...DEFAULT_FIXED, mc: { ...DEFAULT_MC } },
	};
}
