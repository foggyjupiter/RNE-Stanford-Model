// 모델 파라미터와 물리 상수. 모든 값은 SI 단위.
// 근거: [R] Russo et al., IEEE TED 56(2) 193-200 (2009) Table I (NiO 소자, RESET)
//       [D] H. Li et al., DATE 2015 식 (2) (SET 측면 성장), [M] 매뉴얼 Table 3 (SET 파라미터, RL, CP)
// (A#) 표시는 ASSUMPTIONS.md에 정리한 가정.

export const Q_E = 1.602176634e-19;	// 기본 전하량 [C]
export const K_B = 1.380649e-23;	// 볼츠만 상수 [J/K]
export const EV = Q_E;	// 1 eV [J]

export interface Params {
	L0: number;	// 산화막 두께 = CF 길이 [m]
	phi0: number;	// 포밍된 CF 지름 [m]
	rhoCf: number;	// T0에서의 CF 비저항 [ohm*m]
	rhoOx: number;	// 산화막 비저항 [ohm*m]
	kappaCf: number;	// CF 열전도도 [W/(K m)]
	kappaOx: number;	// 산화막 열전도도 [W/(K m)]
	alphaT: number;	// CF 비저항 온도 계수 [1/K], [R] 식 (4)
	Ed: number;	// 열 용해 활성화 에너지 [J], [R] 식 (5)
	vD0: number;	// 용해 속도 전인자 [m/s], [R] 식 (5)
	T0: number;	// 소자 온도 [K]
	Rdom: number;	// 계산 영역 반경 [m] (A31)
	Ea: number;	// SET: VO 평균 활성화 에너지 [J], [D] 식 (2)
	alphaA: number;	// SET: 에너지 증강 계수 [m]
	f: number;	// SET: VO 진동 주파수 [Hz]
	dr: number;	// SET: 측면 성장 단위 Delta_r [m] (A4)
	Z: number;	// 전하수 [-]
	RL: number;	// 전극 접촉 저항 [ohm]
	CP: number;	// 전극 기생 정전용량 [F]
	nF: number;	// 단위면적당 필라멘트 수 [1/m^2] (A10, A22)
	aCell: number;	// 셀 면적 [m^2] (A10)
}

export const DEFAULT: Readonly<Params> = Object.freeze({
	L0: 160e-9,	// [m], [R] Table I
	phi0: 80e-9,	// [m], [R] Table I
	rhoCf: 810e-8,	// [ohm*m] (810 uOhm*cm), [R] Table I
	rhoOx: 80e6 * 1e-8,	// [ohm*m] (80e6 uOhm*cm), [R] Table I
	kappaCf: 21.4,	// [W/(K m)], [R] Table I
	kappaOx: 20,	// [W/(K m)], [R] Table I
	alphaT: 1.7e-3,	// [1/K], [R] Table I
	Ed: 1.2 * EV,	// [J], [R] Table I
	vD0: 200,	// [m/s], [R] Table I (피팅값)
	T0: 300,	// [K]
	Rdom: 53.3e-9,	// [m], [R] Fig. 4 B점(0.78 V, 530 K)에 맞춤 (A31)
	Ea: 0.7 * EV,	// [J], [M] Table 3
	alphaA: 0.75e-9,	// [m], [M] Table 3
	f: 1e13,	// [Hz], [M] Table 3
	dr: 0.25e-9,	// [m] (A4)
	Z: 1,	// [-]
	RL: 20,	// [ohm], [M] Table 3
	CP: 20e-15,	// [F], [M] Table 3
	nF: 1e14,	// [1/m^2] (A22)
	aCell: 1e-14,	// [m^2], 100 nm x 100 nm → N = 1
});

// 병렬로 놓인 동일 필라멘트 수, round(nF*aCell) >= 1 (A10)
export function filamentCount(p: Params): number {
	return Math.max(1, Math.round(p.nF * p.aCell));
}

export const RS_SET = 3e3;	// SET 동작 compliance 저항 기본값 [ohm] (A15)

export interface GridSpec {
	drFine: number;	// CF 근처 반경 방향 칸 [m]
	growth: number;	// 바깥쪽 칸 증가 비율 [-]
	nz: number;	// 길이 방향 칸 수
}

export const DEFAULT_GRID: Readonly<GridSpec> = Object.freeze({ drFine: 4e-9, growth: 1.15, nz: 40 });	// (A35)
