// CSV 내보내기. PNG는 charts.ts의 downloadPng.

import { type CycleSummary, type JobOutput } from "../model";

function download(name: string, text: string): void {
	const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 결과 전체를 SI 단위 CSV로. 과도 응답은 사이클 번호 열을 붙여 모든 사이클을 이어 쓴다
export function resultCsv(out: JobOutput): string {
	if (out.kind === "fixed" && out.mc) {
		// 몬테카를로: 소자마다 필라멘트 형상과 읽기 저항
		const rows = ["device,filament,phi_m,r_neck_m,neck_len_m,R_device_ohm"];
		out.mc.devices.forEach((fil, d) => {
			fil.forEach((fg, k) => rows.push(`${d + 1},${k + 1},${fg.phi},${fg.rNeck},${fg.neckLen},${out.mc!.R[d]}`));
		});
		return rows.join("\n");
	}
	if (out.kind === "fixed") {
		const rows = ["v_V,i_A"];
		for (let k = 0; k < out.v.length; k++) rows.push(`${out.v[k]},${out.i[k]}`);
		return rows.join("\n");
	}
	// op: 이어 붙인 결과(스윕·시퀀스)에서 RESET / SET 구간 구분. 펄스 하나면 빈칸
	const rows = ["cycle,op,t_s,v_app_V,v_cell_V,i_A,r_min_m,T_max_K"];
	out.cycles.forEach((r, c) => {
		for (let k = 0; k < r.t.length; k++) {
			const op = r.split === undefined ? "" : k < r.split ? "reset" : "set";
			rows.push(`${c + 1},${op},${r.t[k]},${r.vApp[k]},${r.vCell[k]},${r.i[k]},${r.rMin[k]},${r.T[k]}`);
		}
	});
	return rows.join("\n");
}

export function summaryCsv(summary: CycleSummary[]): string {
	const rows = ["cycle,r_hrs_ohm,r_lrs_ohm,v_reset_V,i_reset_A,v_set_V"];
	summary.forEach((s, c) => rows.push(`${c + 1},${s.rHrs},${s.rLrs},${s.vReset},${s.iReset},${s.vSet}`));
	return rows.join("\n");
}

export function downloadCsv(name: string, text: string): void {
	download(name, text);
}
