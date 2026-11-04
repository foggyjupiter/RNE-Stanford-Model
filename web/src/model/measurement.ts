// 측정 프로그램 엑셀을 스윕 단위로 읽어 분류한다. python/measurement.py를 옮긴 것 (A50).
//
// 엑셀 형식 (파일 하나 = 소자 하나, 시트 하나 = 측정 순서대로 한 스윕)
//   Sweep Name            "Sweep 3 (0.0V~5.0V, Step 0.1V) (Compliance Stop)"
//   Sweep Range           "0.0V to 5.0V (step 0.1V)"
//   Area Constant (um^2)  20800
//   Compliance I (A)      1e-05
//   Voltage (V) | Current I (A) | Current Density J (A/cm^2)
// 멈춘 방식: Compliance Stop = CC에 닿아 측정기가 멈춤 (SET), Early Stop = 전류가 떨어진 뒤 손으로 멈춤 (RESET),
// 표시 없음 = 끝까지 (0-1 V 읽기 등).

import type { Cell, Sheet } from "./xlsx";

export type SweepKind =
	| "forming"	// 파일에서 첫 RESET 전에 CC에 닿은 스윕 (포밍 전 상태에서 시작)
	| "set"	// 첫 RESET 뒤 CC에 닿은 스윕, HRS(0.1 V 전류 < CC/100)에서 시작
	| "set_low"	// 첫 RESET 뒤 CC에 닿았지만 HRS에서 시작하지 않음
	| "set_at_lrs"	// 0.1 V에서 바로 CC (이미 LRS)
	| "reset"	// LRS에서 시작해 전류가 무너진 스윕
	| "reset_neg"	// 위와 같고 음전압
	| "set_reset"	// 제한 없는 RESET 스윕 중 먼저 SET이 일어난 뒤 RESET
	| "stopped_hrs"	// Early Stop, 최대 전류 < 1 µA (RESET할 것이 없던 스윕)
	| "read"	// 표시 없음, |V| <= 1 V
	| "other";

export const KIND_LABELS: Record<SweepKind, string> = {
	forming: "forming",
	set: "SET",
	set_low: "SET (HRS 아님)",
	set_at_lrs: "SET (이미 LRS)",
	reset: "RESET",
	reset_neg: "RESET (음)",
	set_reset: "SET→RESET",
	stopped_hrs: "중단 (HRS)",
	read: "읽기",
	other: "기타",
};

export interface MeasuredSweep {
	file: string;	// 파일 이름 (확장자 없음)
	index: number;	// 파일 안 순서 (1부터)
	title: string;	// 시트 이름
	kind: SweepKind;
	v: number[];	// [V]
	i: number[];	// [A], 부호 그대로
	cc: number;	// 전류 제한 [A]
	stop: "Compliance Stop" | "Early Stop" | "";
	step: number;	// 계단 [V]
	r01: number;	// 0.1 V 점의 저항 [ohm] (없으면 NaN)
}

export interface Session {
	file: string;
	thickness: number;	// 파일 이름의 "6nm" 등 [m] (없으면 NaN)
	area: number;	// Area Constant [m^2] (없으면 NaN)
	sweeps: MeasuredSweep[];
}

function rAt(v: number[], i: number[], vq = 0.1): number {
	for (let k = 0; k < v.length; k++) {
		if (Math.abs(Math.abs(v[k]) - vq) <= 1e-6 && i[k] !== 0) return Math.abs(v[k] / i[k]);
	}
	return NaN;
}

const isNum = (c: Cell): c is number => typeof c === "number" && Number.isFinite(c);

// 엑셀 하나의 시트 목록 → Session. fileName은 두께("6nm") 추출에 쓴다
export function parseSession(fileName: string, sheets: Sheet[]): Session {
	// 일부 압축 도구가 한글 파일 이름을 "#Uac00"처럼 바꿔 놓는 것을 되살린다
	const file = fileName.replace(/\.xlsx$/i, "").replace(/#U([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
	const tm = /(\d+(?:\.\d+)?)\s*nm/.exec(file);
	const ses: Session = { file, thickness: tm ? Number(tm[1]) * 1e-9 : NaN, area: NaN, sweeps: [] };
	let resetSeen = false;
	sheets.forEach((sh, si) => {
		const meta = new Map<string, Cell>();
		let start = -1;
		for (let j = 0; j < sh.rows.length; j++) {
			const r = sh.rows[j];
			if (!r || r.length === 0) continue;
			if (r[0] === "Voltage (V)") {
				start = j + 1;
				break;
			}
			if (r[0] !== null && r[0] !== undefined) meta.set(String(r[0]).trim(), r[1] ?? null);
		}
		if (start < 0) return;
		const v: number[] = [];
		const i: number[] = [];
		for (let j = start; j < sh.rows.length; j++) {
			const r = sh.rows[j];
			if (r && isNum(r[0]) && isNum(r[1])) {
				v.push(r[0]);
				i.push(r[1]);
			}
		}
		if (v.length === 0) return;
		const name = String(meta.get("Sweep Name") ?? sh.name);
		const stop = name.includes("Compliance Stop") ? "Compliance Stop" : name.includes("Early Stop") ? "Early Stop" : "";
		const st = /[Ss]tep\s*([\d.]+)\s*V/.exec(String(meta.get("Sweep Range") ?? name));
		const step = st ? Number(st[1]) : NaN;
		const cc = Number(meta.get("Compliance I (A)") ?? NaN);
		const area = meta.get("Area Constant (um^2)");
		if (Number.isNaN(ses.area) && area !== undefined && area !== null) ses.area = Number(area) * 1e-12;
		const ai = i.map(Math.abs);
		let kmax = 0;
		for (let k = 1; k < ai.length; k++) if (ai[k] > ai[kmax]) kmax = k;
		const imax = ai[kmax];
		let after = Infinity;
		for (let k = kmax; k < ai.length; k++) after = Math.min(after, ai[k]);
		const vabsMax = Math.max(...v.map(Math.abs));
		let kind: SweepKind;
		if (stop === "" && vabsMax <= 1.0 + 1e-9) {
			kind = "read";
		} else if (stop === "Compliance Stop" && imax >= 0.98 * cc) {
			if (v.length <= 2) {
				kind = "set_at_lrs";
			} else if (!resetSeen) {
				kind = "forming";
			} else {
				const k01 = v.findIndex((x) => Math.abs(Math.abs(x) - 0.1) <= 1e-6);
				kind = k01 >= 0 && ai[k01] < cc / 100 ? "set" : "set_low";
			}
		} else if (stop === "Early Stop" && imax > 1e-4 && after < 0.5 * imax) {
			// 최대 전류점까지 저항이 처음 점의 0.9배 아래로 떨어지지 않아야 LRS에서 시작한 RESET
			let fromLrs = true;
			const r0 = kmax >= 1 ? Math.abs(v[1]) / Math.max(ai[1], 1e-30) : NaN;
			for (let k = 1; k <= kmax; k++) if (Math.abs(v[k]) / Math.max(ai[k], 1e-30) < 0.9 * r0) fromLrs = false;
			kind = fromLrs ? (Math.min(...v) < 0 ? "reset_neg" : "reset") : "set_reset";
			resetSeen = true;
		} else if (stop === "Early Stop" && imax < 1e-6) {
			kind = "stopped_hrs";
		} else {
			kind = "other";
		}
		ses.sweeps.push({ file, index: si + 1, title: sh.name, kind, v, i, cc, stop, step, r01: rAt(v, i) });
	});
	return ses;
}

// 파일마다 첫 forming 스윕 (포밍 전 누설로 산화막 비저항을 볼 때). 0.1 V 저항이 1e8 ohm 넘는 것만
export function firstForming(sessions: Session[]): MeasuredSweep[] {
	const out: MeasuredSweep[] = [];
	for (const s of sessions) {
		const f = s.sweeps.find((x) => x.kind === "forming");
		if (f && f.r01 > 1e8) out.push(f);
	}
	return out;
}
