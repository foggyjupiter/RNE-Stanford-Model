// 파라미터 패널 메타데이터: 그룹, 슬라이더 범위, 표시 단위.
// 값의 근거: [R] Russo et al. TED 2009 Table I (기본값과 참고문헌 열의 문헌값), [M] 매뉴얼 Table 3.
// 근거가 없는 범위는 note에 가정 번호를 단다 (A37).

import { EV, TIN_ELECTRODE, type Params, type Variability } from "../model";

export interface FieldMeta<K extends string> {
	key: K;
	symbol: string;	// 표시 기호 (HTML 허용)
	label: string;	// 설명
	unit: string;	// 표시 단위
	scale: number;	// 표시 단위 1이 SI로 얼마인지
	min: number;	// 표시 단위 기준 하한
	max: number;	// 표시 단위 기준 상한
	log?: boolean;
	fixed?: boolean;	// 근거 자료가 한 값만 줌 → 숫자 입력만
	note?: string;
}

export type ParamMeta = FieldMeta<keyof Params>;
export type VarMeta = FieldMeta<keyof Variability>;

export interface ParamPreset {
	label: string;	// 버튼 글자
	values: Partial<Params>;
	note: string;	// 출처
}

export interface ParamGroup {
	id: string;
	title: string;
	hint?: string;
	items: ParamMeta[];
	presets?: ParamPreset[];
}

export const PARAM_GROUPS: ParamGroup[] = [
	{
		id: "reset",
		title: "RESET (열 용해)",
		hint: "[R] 식 (5): v_D = v_D0·exp(−E_d/kT)",
		items: [
			{ key: "Ed", symbol: "E<sub>d</sub>", label: "용해 활성화 에너지", unit: "eV", scale: EV, min: 1.0, max: 1.4, note: "Table I: 1.1–1.2" },
			{ key: "vD0", symbol: "v<sub>D0</sub>", label: "용해 속도 전인자", unit: "m/s", scale: 1, min: 20, max: 2000, log: true, note: "피팅값 [R]" },
		],
	},
	{
		id: "set",
		title: "SET (측면 성장)",
		hint: "[D] 식 (2), 경계의 국소 전계·온도 사용",
		items: [
			{ key: "Ea", symbol: "E<sub>a</sub>", label: "VO 평균 활성화 에너지", unit: "eV", scale: EV, min: 0.5, max: 1.2 },
			{ key: "alphaA", symbol: "α<sub>a</sub>", label: "에너지 증강 계수", unit: "nm", scale: 1e-9, min: 0.1, max: 2, fixed: true },
			{ key: "f", symbol: "f", label: "VO 진동 주파수", unit: "Hz", scale: 1, min: 0.8e13, max: 1.2e13 },
			{ key: "dr", symbol: "Δr", label: "측면 성장 단위", unit: "nm", scale: 1e-9, min: 0.1, max: 0.5, note: "가정 (A4)" },
		],
	},
	{
		id: "geometry",
		title: "소자 형상",
		hint: "[R] Table I의 NiO 소자",
		items: [
			{ key: "L0", symbol: "t", label: "산화막 두께 = CF 길이", unit: "nm", scale: 1e-9, min: 40, max: 300, note: "범위 가정 (A37)" },
			{ key: "phi0", symbol: "φ", label: "포밍된 CF 지름", unit: "nm", scale: 1e-9, min: 10, max: 100, note: "문헌 10–30 nm" },
			{ key: "Rdom", symbol: "R<sub>dom</sub>", label: "계산 영역 반경", unit: "nm", scale: 1e-9, min: 30, max: 500, log: true, note: "보정값 (A31)" },
		],
	},
	{
		id: "material",
		title: "물성",
		hint: "전기·열 전도 ([R] 식 (1)–(4))",
		items: [
			{ key: "rhoCf", symbol: "ρ<sub>CF</sub>", label: "CF 비저항 (T₀)", unit: "µΩ·cm", scale: 1e-8, min: 31, max: 2000, log: true, note: "문헌 31–670" },
			{ key: "alphaT", symbol: "α", label: "CF 비저항 온도 계수", unit: "1/K", scale: 1, min: 0, max: 3e-3 },
			{ key: "rhoOx", symbol: "ρ<sub>ox</sub>", label: "산화막 비저항", unit: "Ω·m", scale: 1, min: 1, max: 1e5, log: true, note: "범위 가정 (A37)" },
			{ key: "kappaCf", symbol: "κ<sub>CF</sub>", label: "CF 열전도도", unit: "W/(K·m)", scale: 1, min: 1, max: 50 },
			{ key: "kappaOx", symbol: "κ<sub>ox</sub>", label: "산화막 열전도도", unit: "W/(K·m)", scale: 1, min: 1, max: 30, note: "문헌 1–10" },
			{ key: "T0", symbol: "T<sub>0</sub>", label: "소자 온도", unit: "K", scale: 1, min: 150, max: 450 },
		],
	},
	{
		id: "electrode",
		title: "전극",
		hint: "두께 0이면 이상적 열 배출 [6]. 두께를 주면 전극층까지 2차원으로 푼다 (A41, [11])",
		items: [
			{ key: "tEl", symbol: "t<sub>el</sub>", label: "전극 두께 (위·아래 각각)", unit: "nm", scale: 1e-9, min: 0, max: 200, note: "실험값 필요" },
			{ key: "kappaEl", symbol: "κ<sub>el</sub>", label: "전극 열전도도", unit: "W/(K·m)", scale: 1, min: 5, max: 30, note: "TiN 7–27 [8], [10]" },
			{ key: "rhoEl", symbol: "ρ<sub>el</sub>", label: "전극 비저항", unit: "µΩ·cm", scale: 1e-8, min: 25, max: 500, log: true, note: "TiN 125 [9]" },
		],
		presets: [
			{
				label: "TiN 전극 (문헌값)",
				values: { ...TIN_ELECTRODE },
				note: "κ 11.9 W/(K·m) [8], ρ 125 µΩ·cm [9]. 두께 50 nm는 가정 (실험값으로 바꿀 것)",
			},
		],
	},
	{
		id: "parasitic",
		title: "기생 성분",
		hint: "R_L 직렬, C_P 병렬 (A11)",
		items: [
			{ key: "RL", symbol: "R<sub>L</sub>", label: "전극 접촉 저항", unit: "Ω", scale: 1, min: 0.1, max: 25 },
			{ key: "CP", symbol: "C<sub>P</sub>", label: "전극 기생 정전용량", unit: "fF", scale: 1e-15, min: 0.1, max: 25 },
		],
	},
	{
		id: "density",
		title: "필라멘트 밀도",
		hint: "동일 필라멘트 N = n_f·A_cell 개 병렬, 경쟁 무시 (A10)",
		items: [
			{ key: "nF", symbol: "n<sub>f</sub>", label: "단위면적당 필라멘트 수", unit: "/µm²", scale: 1e12, min: 1, max: 1e4, log: true, note: "범위 가정 (A22)" },
			{ key: "aCell", symbol: "A<sub>cell</sub>", label: "셀 면적", unit: "µm²", scale: 1e-12, min: 1e-3, max: 1e4, log: true },
		],
	},
];

export const VAR_FIELDS: VarMeta[] = [
	{ key: "sigmaEa", symbol: "σ(E<sub>a</sub>)", label: "SET 장벽 산포", unit: "eV", scale: EV, min: 0, max: 0.1, note: "가정 (A13)" },
	{ key: "sigmaEd", symbol: "σ(E<sub>d</sub>)", label: "RESET 장벽 산포", unit: "eV", scale: EV, min: 0, max: 0.1, note: "가정 (A13)" },
];
