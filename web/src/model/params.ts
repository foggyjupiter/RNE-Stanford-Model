// 모델 파라미터와 물리 상수. 모든 값은 SI 단위.
// 이름 / 기본값: PKU-Stanford RRAM v2.0Beta Quick User Guide, Table 3.
// (A#) 표시는 ASSUMPTIONS.md에 정리한 가정.

export const Q_E = 1.602176634e-19;	// 기본 전하량 [C]
export const K_B = 1.380649e-23;	// 볼츠만 상수 [J/K]
export const EV = Q_E;	// 1 eV [J]

export interface Params {
	I0: number;	// 호핑 전류 밀도 [A/m^2]
	rho: number;	// CF 비저항 [ohm*m]
	a: number;	// VO 사이 거리 [m]
	f: number;	// VO 진동 주파수 [Hz]
	Ea: number;	// VO 평균 활성화 에너지 [J]
	Eh: number;	// O2- 호핑 장벽 [J]
	Ei: number;	// 전극/산화막 계면 장벽 [J]
	alphaA: number;	// 에너지 증강 계수, VO 생성 [m]
	alphaH: number;	// 에너지 증강 계수, O2- 호핑 [m]
	gamma: number;	// 전압 증강 계수 [-]
	Z: number;	// 전하수 [-]
	Rth: number;	// 유효 열저항 [K/W]
	RH: number;	// 산화막 기생 저항 [ohm]
	RL: number;	// 전극 접촉 저항 [ohm]
	CP: number;	// 전극 기생 정전용량 [F]
	L0: number;	// 스위칭층 두께 [m]
	WCF: number;	// 스위칭층 폭 = CF 폭 최댓값 [m]
	VT: number;	// 호핑 특성 전압 [V]
	T0: number;	// 주변 온도 [K]
	deltaGap: number;	// 갭 변동 속도, 식 (8)의 delta_g [m/s]
	deltaCF: number;	// CF 폭 변동 속도, 식 (9)의 delta_r [m/s]
	gT: number;	// 식 (6)의 호핑 감쇠 길이, 피팅값 [m] (A3)
	dr: number;	// 식 (2)의 측면 성장 단위 Delta_r [m] (A4)
	nF: number;	// 단위면적당 필라멘트 수 [1/m^2] (A10)
	aCell: number;	// 셀 면적 [m^2] (A10)
}

// Table 3의 'Weff', 'crit_x'는 근거 논문에 대응하는 식이 없어 쓰지 않는다 (A9).
export const DEFAULT: Readonly<Params> = Object.freeze({
	I0: 1e13,	// [A/m^2]
	rho: 19.64e-6,	// [ohm*m] (19.64 uOhm*m)
	a: 0.25e-9,	// [m]
	f: 1e13,	// [Hz]
	Ea: 0.7 * EV,	// [J]
	Eh: 1.12 * EV,	// [J]
	Ei: 0.82 * EV,	// [J]
	alphaA: 0.75e-9,	// [m]
	alphaH: 0.75e-9,	// [m]
	gamma: 1.5,	// [-]
	Z: 1,	// [-]
	Rth: 5e5,	// [K/W]
	RH: 200e6,	// [ohm]
	RL: 20,	// [ohm]
	CP: 20e-15,	// [F]
	L0: 3e-9,	// [m]
	WCF: 5e-9,	// [m]
	VT: 0.4,	// [V]
	T0: 300,	// [K]
	deltaGap: 4e-5,	// [m/s]
	deltaCF: 1e-4,	// [m/s]
	gT: 0.25e-9,	// [m] (A3)
	dr: 0.25e-9,	// [m] (A4)
	nF: 1e16,	// [1/m^2] (A10)
	aCell: 100e-18,	// [m^2], 10 nm x 10 nm (A10)
});

// 병렬로 놓인 동일 필라멘트 수, round(nF*aCell) >= 1 (A10)
export function filamentCount(p: Params): number {
	return Math.max(1, Math.round(p.nF * p.aCell));
}

export const RS_SWEEP = 18e3;	// SET compliance 저항 기본값, I-V 스윕 [ohm] (A15)
export const RS_PULSE = 10e3;	// SET compliance 저항 기본값, 펄스 [ohm] (A15)

// 초기 상태, Table 3: x0 ∈ {L0, 0}, w0 ∈ {0.5 nm, WCF}
export const INIT_HRS: readonly [number, number] = [3e-9, 0.5e-9];	// SET 전 [x0 m, w0 m]
export const INIT_LRS: readonly [number, number] = [0, 5e-9];	// RESET 전 [x0 m, w0 m]

export const W_MIN = 0.1e-9;	// CF 폭의 수치적 하한 [m] (A8)
export const EPS_X = 2.5e-12;	// 부드러운 벽 / 2단계 전환 혼합 길이, 0.01*a [m] (A7, A8)
