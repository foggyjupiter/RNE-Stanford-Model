// 파라미터 패널 메타데이터: 매뉴얼 Table 3 기준 그룹, 권장 범위, 표시 단위.
// 범위는 Table 3 'Suggested Range'. Table 3에 없는 항목은 note에 근거(ASSUMPTIONS.md 번호)를 단다.
// Table 3의 'Weff', 'crit_x'는 대응하는 식이 없어 UI에서 제외 (A9).

import { EV, type Params, type Variability } from "../model";

export interface FieldMeta<K extends string> {
	key: K;
	symbol: string;	// 표시 기호 (HTML 허용)
	label: string;	// 설명
	unit: string;	// 표시 단위
	scale: number;	// 표시 단위 1이 SI로 얼마인지
	min: number;	// 표시 단위 기준 하한
	max: number;	// 표시 단위 기준 상한
	log?: boolean;	// 슬라이더를 로그 눈금으로
	fixed?: boolean;	// Table 3이 범위 없이 한 값만 줌 → 슬라이더 없이 숫자 입력만
	note?: string;	// 짧은 꼬리표 (예: 피팅값)
}

export type ParamMeta = FieldMeta<keyof Params>;
export type VarMeta = FieldMeta<keyof Variability>;

export interface ParamGroup {
	id: string;
	title: string;
	hint?: string;
	items: ParamMeta[];
}

export const PARAM_GROUPS: ParamGroup[] = [
	{
		id: "hrs",
		title: "HRS 관련",
		hint: "갭을 지나는 호핑 전도 (식 6)",
		items: [
			{ key: "I0", symbol: "I<sub>0</sub>", label: "호핑 전류 밀도", unit: "A/m²", scale: 1, min: 1e10, max: 1e15, log: true },
			{ key: "gT", symbol: "g<sub>T</sub>", label: "호핑 감쇠 길이", unit: "nm", scale: 1e-9, min: 0.1, max: 1, note: "피팅값 (A3)" },
			{ key: "VT", symbol: "V<sub>T</sub>", label: "호핑 특성 전압", unit: "V", scale: 1, min: 0.1, max: 1, fixed: true },
			{ key: "L0", symbol: "L<sub>0</sub>", label: "스위칭층 두께", unit: "nm", scale: 1e-9, min: 1, max: 10 },
		],
	},
	{
		id: "lrs",
		title: "LRS 관련",
		hint: "필라멘트 옴 전도 (식 7)",
		items: [
			{ key: "rho", symbol: "ρ", label: "CF 비저항", unit: "µΩ·m", scale: 1e-6, min: 0.1, max: 1000, log: true },
			{ key: "WCF", symbol: "W<sub>CF</sub>", label: "스위칭층 폭 (CF 폭 최대)", unit: "nm", scale: 1e-9, min: 1, max: 10 },
		],
	},
	{
		id: "switch",
		title: "스위칭 전압",
		hint: "이온 이동의 에너지 장벽 (식 1–4)",
		items: [
			{ key: "Ea", symbol: "E<sub>a</sub>", label: "VO 평균 활성화 에너지", unit: "eV", scale: EV, min: 0.5, max: 1.2 },
			{ key: "Eh", symbol: "E<sub>h</sub>", label: "O²⁻ 호핑 장벽", unit: "eV", scale: EV, min: 0.8, max: 1.4 },
			{ key: "Ei", symbol: "E<sub>i</sub>", label: "전극/산화막 계면 장벽", unit: "eV", scale: EV, min: 0.6, max: 1.2 },
			{ key: "alphaA", symbol: "α<sub>a</sub>", label: "에너지 증강 계수 (생성)", unit: "nm", scale: 1e-9, min: 0.1, max: 2, fixed: true },
			{ key: "alphaH", symbol: "α<sub>h</sub>", label: "에너지 증강 계수 (O²⁻ 호핑)", unit: "nm", scale: 1e-9, min: 0.1, max: 2, fixed: true },
			{ key: "gamma", symbol: "γ", label: "전압 증강 계수", unit: "", scale: 1, min: 0.5, max: 3, fixed: true },
		],
	},
	{
		id: "speed",
		title: "속도",
		hint: "도약 빈도, 거리, 줄 발열 (식 1–5)",
		items: [
			{ key: "f", symbol: "f", label: "VO 진동 주파수", unit: "Hz", scale: 1, min: 0.8e13, max: 1.2e13 },
			{ key: "a", symbol: "a", label: "VO 사이 거리", unit: "nm", scale: 1e-9, min: 0.2, max: 0.4 },
			{ key: "dr", symbol: "Δr", label: "측면 성장 단위", unit: "nm", scale: 1e-9, min: 0.1, max: 0.5, note: "가정 (A4)" },
			{ key: "Rth", symbol: "R<sub>th</sub>", label: "유효 열저항", unit: "K/W", scale: 1, min: 2e5, max: 1e6, log: true },
			{ key: "T0", symbol: "T<sub>0</sub>", label: "주변 온도", unit: "K", scale: 1, min: 4, max: 500 },
		],
	},
	{
		id: "parasitic",
		title: "기생 성분",
		hint: "RL 직렬, RH·CP 병렬 (A11)",
		items: [
			{ key: "RH", symbol: "R<sub>H</sub>", label: "산화막 기생 저항", unit: "Ω", scale: 1, min: 1e6, max: 1e9, log: true },
			{ key: "RL", symbol: "R<sub>L</sub>", label: "전극 접촉 저항", unit: "Ω", scale: 1, min: 0.1, max: 25 },
			{ key: "CP", symbol: "C<sub>P</sub>", label: "전극 기생 정전용량", unit: "fF", scale: 1e-15, min: 0.1, max: 25 },
		],
	},
	{
		id: "density",
		title: "필라멘트 밀도",
		hint: "동일 필라멘트 N = n_f·A_cell 개 병렬, 경쟁 무시 (A10)",
		items: [
			{ key: "nF", symbol: "n<sub>f</sub>", label: "단위면적당 필라멘트 수", unit: "/µm²", scale: 1e12, min: 1e2, max: 1e6, log: true, note: "범위 가정 (A22)" },
			{ key: "aCell", symbol: "A<sub>cell</sub>", label: "셀 면적", unit: "nm²", scale: 1e-18, min: 25, max: 1e10, log: true },
		],
	},
];

export const VAR_FIELDS: VarMeta[] = [
	{ key: "sigmaEa", symbol: "σ(E<sub>a</sub>)", label: "사이클 간 산포", unit: "eV", scale: EV, min: 0, max: 0.1, note: "가정 (A13)" },
	{ key: "sigmaEi", symbol: "σ(E<sub>i</sub>)", label: "사이클 간 산포", unit: "eV", scale: EV, min: 0, max: 0.1, note: "가정 (A13)" },
	{ key: "sigmaEh", symbol: "σ(E<sub>h</sub>)", label: "사이클 간 산포", unit: "eV", scale: EV, min: 0, max: 0.1, note: "가정 (A13)" },
];

// 식 (8),(9)의 잡음 진폭은 Params 안에 있지만 변동성 묶음에 함께 보여 준다
export const NOISE_FIELDS: ParamMeta[] = [
	{ key: "deltaGap", symbol: "δ<sub>g</sub>", label: "갭 변동 속도", unit: "m/s", scale: 1, min: 0, max: 1e-4 },
	{ key: "deltaCF", symbol: "δ<sub>r</sub>", label: "CF 폭 변동 속도", unit: "m/s", scale: 1, min: 0, max: 5e-4 },
];
