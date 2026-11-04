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
	setField: number;	// SET 성장식의 전계: 0 = 경계 국소 전계 (A33), 1 = 산화막 평균 전계 V_ox/L0 (A54)
	hop: number;	// 갭 호핑 전도 (A55): 0 = 끔, 1 = [D] 식 (6)을 끊긴 구간에 더함
	I0: number;	// 호핑 전류 밀도 [A/m^2], [M] Table 3
	VT: number;	// 특성 전압 [V], [M] Table 3
	gT: number;	// 호핑 감쇠 길이 [m], 피팅값 (A3, A55)
	RL: number;	// 전극 접촉 저항 [ohm]
	CP: number;	// 전극 기생 정전용량 [F]
	tEl: number;	// 전극 두께 [m]. 0이면 [R]의 이상적 전극 (A41)
	kappaEl: number;	// 전극 열전도도 [W/(K m)]
	rhoEl: number;	// 전극 비저항 [ohm*m], 온도 무관 (A41)
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
	setField: 0,	// 국소 전계 (A33)
	hop: 0,	// 끔
	I0: 1e13,	// [A/m^2], [M] Table 3
	VT: 0.4,	// [V], [M] Table 3
	gT: 0.25e-9,	// [m], 이전 bipolar 단계의 피팅값 (A3, A55)
	RL: 20,	// [ohm], [M] Table 3
	CP: 20e-15,	// [F], [M] Table 3
	tEl: 0,	// [m], 이상적 전극 [R]
	kappaEl: 11.9,	// [W/(K m)], TiN [Samani 2013, Thin Solid Films 537, 108]
	rhoEl: 125e-8,	// [ohm*m] (125 uOhm*cm), DC 반응성 스퍼터 TiN 전극 [doi:10.1007/s10854-018-9066-4]
	nF: 1e14,	// [1/m^2] (A22)
	aCell: 1e-14,	// [m^2], 100 nm x 100 nm → N = 1
});

// 병렬로 놓인 동일 필라멘트 수, round(nF*aCell) >= 1 (A10)
export function filamentCount(p: Params): number {
	return Math.max(1, Math.round(p.nF * p.aCell));
}

// TiN/HfO2/TiN 소자 프리셋 (A48). 산화막 6 nm는 실험 소자 값 (사용자 제공).
// HfO2·필라멘트(HfO2-x) 물성: Niraula & Karpov, IEEE TED 64(10) 4106 (2017)
// (HfO2 kappa 0.5 W/(K m), sigma 1e-2 S/m; HfO2-x kappa 20 W/(K m), sigma 1e5 S/m).
// phi0 5 nm는 가정 (측정에서 역산할 값). alphaT, Ed, vD0는 [R] 값 그대로 (역산 대상)
export const HFO2_TIN: Readonly<Partial<Params>> = Object.freeze({
	L0: 6e-9,	// [m]
	phi0: 5e-9,	// [m], 가정
	rhoCf: 1e-5,	// [ohm*m] (1000 uOhm*cm)
	kappaCf: 20,	// [W/(K m)]
	rhoOx: 100,	// [ohm*m]
	kappaOx: 0.5,	// [W/(K m)]
	tEl: 50e-9,	// [m], 가정 (A41)
	kappaEl: 11.9,	// [W/(K m)]
	rhoEl: 125e-8,	// [ohm*m]
});

// 실험 소자 프리셋 (A51, A53): TiN/HfO2/TiN 6 nm, 패드 20800 um^2 (측정 파일의 Area Constant, 사용자 확인).
// CP = eps0*eps_r*A/t, HfO2 eps_r 20 (ALD 박막, J. Mater. Res. 2005, doi:10.1557/JMR.2005.0394) → 0.61 nF.
// RL 30 ohm: 측정 RESET의 Rth/R0가 2차원 모델 범위에 들어오는 직렬 저항 (실측 LRS 최솟값 32 ohm과 비슷). 추정값
export const OUR_DEVICE: Readonly<Partial<Params>> = Object.freeze({
	...HFO2_TIN,
	aCell: 20800e-12,	// [m^2]
	nF: 1 / 20800e-12,	// [1/m^2], 필라멘트 1개 (A43)
	CP: 8.8541878128e-12 * 20 * 20800e-12 / 6e-9,	// [F]
	RL: 30,	// [ohm], 추정
	setField: 1,	// 평균 전계 (A54)
	hop: 0,	// 갭 호핑 전도: 과도 계산에서는 끔 (HRS 갭 가열이 수천 K가 되어 적분이 멈춤, A55). 갭 역산(정적)에서만 켬
	Ea: 1.661 * EV,	// [J], 실측 V_set 2.7 V (CC 10 uA, 1 V/s 가정)에 맞춘 값. Table 3 범위 [0.5, 1.2] eV 밖 (A54)
});

// TiN 전극 프리셋 (A41). 두께 50 nm는 가정값: 실험 소자의 전극 두께로 바꿔 쓸 것
export const TIN_ELECTRODE: Readonly<Pick<Params, "tEl" | "kappaEl" | "rhoEl">> = Object.freeze({ tEl: 50e-9, kappaEl: 11.9, rhoEl: 125e-8 });

export const RS_SET = 3e3;	// SET 동작 compliance 저항 기본값 [ohm] (A15)

export interface GridSpec {
	drFine: number;	// CF 근처 반경 방향 칸 [m]
	growth: number;	// 바깥쪽 칸 증가 비율 [-]
	nz: number;	// 길이 방향 칸 수
	elGrowth: number;	// 전극층 칸 증가 비율 [-] (A41)
}

export const DEFAULT_GRID: Readonly<GridSpec> = Object.freeze({ drFine: 4e-9, growth: 1.15, nz: 40, elGrowth: 1.6 });	// (A35, A41)
