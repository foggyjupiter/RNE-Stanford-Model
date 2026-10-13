// 앱 상태와 모드별 기본값.

import { DEFAULT, DEFAULT_VARIABILITY, RS_PULSE, RS_SWEEP, type Params, type Variability } from "../model";

export type Mode = "sweep" | "pulse" | "sequence" | "fixed";

export const MODE_LABELS: Record<Mode, string> = {
	sweep: "I-V 스윕",
	pulse: "펄스",
	sequence: "쓰기-읽기 시퀀스",
	fixed: "고정 상태",
};

export interface SweepSettings {
	vSet: number;	// [V]
	vReset: number;	// [V], 음수
	tRamp: number;	// 구간당 램프 시간 [s]
	rs: number;	// SET compliance 저항 [ohm]
	cycles: number;
}

export interface PulseSettings {
	polarity: "set" | "reset";
	amplitude: number;	// 진폭 크기 [V], 부호는 polarity가 정함
	width: number;	// 평탄부 폭 [s]
	tEdge: number;	// 상승/하강 시간 [s]
	rs: number;	// SET compliance 저항 [ohm]
}

// 쓰기-읽기 기본 펄스: 파라미터 기본값에서 4사이클 반복해 확인한 조건.
// SET +2 V/80 ns (Fig. 4와 같음) → 약 15 kΩ, RESET −2.5 V/1 µs → 약 1.1 MΩ (창 ~70배, 최고 온도 566 K).
// RESET −2 V/80 ns는 34 kΩ까지만 올라가 창이 2.4배뿐이라 기본값으로 쓰지 않는다 (A21).
export interface SequenceSettings {
	setV: number;	// [V]
	setWidth: number;	// [s]
	resetV: number;	// [V], 음수
	resetWidth: number;	// [s]
	readV: number;	// [V]
	readWidth: number;	// [s]
	tEdge: number;	// [s]
	rs: number;	// [ohm]
	cycles: number;
}

export interface FixedSettings {
	x: number;	// 갭 [m]
	aCf: number;	// CF 면적 [m^2]
	vMax: number;	// 스윕 범위 ±vMax [V]
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

export const DEFAULT_SWEEP: SweepSettings = { vSet: 2.5, vReset: -2.5, tRamp: 100e-6, rs: RS_SWEEP, cycles: 1 };
export const DEFAULT_PULSE: PulseSettings = { polarity: "set", amplitude: 2, width: 80e-9, tEdge: 10e-9, rs: RS_PULSE };
export const DEFAULT_SEQUENCE: SequenceSettings = {
	setV: 2,
	setWidth: 80e-9,
	resetV: -2.5,
	resetWidth: 1e-6,
	readV: 0.2,
	readWidth: 50e-9,
	tEdge: 10e-9,
	rs: RS_PULSE,
	cycles: 3,
};
export const DEFAULT_FIXED: FixedSettings = { x: 1e-9, aCf: 10e-18, vMax: 0.5 };

// 변동성을 켤 때 사이클 수가 1이면 이 값으로 올린다. 스윕 1사이클 ≈ 0.25 s라 낮게 잡음
export const VARIABILITY_CYCLES = 5;
export const MAX_CYCLES = 50;

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
		fixed: { ...DEFAULT_FIXED },
	};
}

// Table 3 초기 상태를 현재 파라미터로: HRS = (x0 = L0, w0 = 0.5 nm), LRS = (x0 = 0, w0 = WCF)
export function initHrs(p: Params): [number, number] {
	return [p.L0, Math.min(0.5e-9, p.WCF)];
}

export function initLrs(p: Params): [number, number] {
	return [0, p.WCF];
}
