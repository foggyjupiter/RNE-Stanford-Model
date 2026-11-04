// 앱 진입점: 화면 구성, 상태 → 작업 변환, 계산 예약, 결과 렌더링.

import "./styles.css";
import {
	DEFAULT, DEFAULT_MC, DEFAULT_VARIABILITY, HFO2_TIN, KIND_LABELS, OUR_DEVICE, concatResults, filamentCount, median as medianOf, parseSession, readXlsx,
	qualityRows, stateMetrics, type FixedOutput, type Grade, type Grid, type Job, type JobOutput, type MeasureJob, type MeasureOutput, type MeasureSimJob, type MeasureSimOutput,
	type MeasureSweepIn, type Params, type Session, type SimResult, type StateMetrics, type SweepKind, type TransientOutput,
} from "./model";
import { ModelClient, SupersededError } from "./model/client";
import {
	downloadPng, histogramChart, ivChart, measuredIvChart, pointsChart, ratioChart, russoChart, stateProfileChart, stateTrendChart, sweepIvChart,
	mcHistogramChart, mcScatterChart, profileMapChart, purge, readChart, timeChart, type MeasuredIv, type MeasuredRole,
} from "./ui/charts";
import { el, makeField, makeSegmented, makeSwitch, type Field } from "./ui/controls";
import { downloadCsv, resultCsv, stateCsv, summaryCsv } from "./ui/export";
import { meanStd, median, siFormat, timeUnit } from "./ui/format";
import { PARAM_GROUPS, VAR_FIELDS, type ParamMeta } from "./ui/meta";
import { DEFAULT_FIXED, DEFAULT_MEASURE, DEFAULT_PULSE, DEFAULT_SEQUENCE, DEFAULT_SWEEP, MAX_CYCLES, MODE_LABELS, VARIABILITY_CYCLES, initialState, type Limit, type Mode } from "./ui/state";

const state = initialState();
const client = new ModelClient();
let lastOut: JobOutput | null = null;
let lastMode: Mode = state.mode;
let timer: number | undefined;
const DEBOUNCE_MS = 400;	// 입력 후 재계산까지 기다리는 시간 [ms]. 2차원 계산이 수 초 걸려 길게 잡음

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------- 테마
type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "rram-theme";

function loadTheme(): ThemeChoice {
	try {
		const v = localStorage.getItem(THEME_KEY);
		if (v === "light" || v === "dark") return v;
	} catch {
		// 저장소를 못 쓰는 환경이면 시스템 설정을 따른다
	}
	return "system";
}

function applyTheme(t: ThemeChoice): void {
	if (t === "system") document.documentElement.removeAttribute("data-theme");
	else document.documentElement.setAttribute("data-theme", t);
	const labels: Record<ThemeChoice, string> = { system: "시스템", light: "라이트", dark: "다크" };
	$("theme").textContent = labels[t];
	$("theme").setAttribute("aria-label", `테마: ${labels[t]} (눌러서 바꾸기)`);
}

function setupTheme(): void {
	let current = loadTheme();
	applyTheme(current);
	$("theme").addEventListener("click", () => {
		const order: ThemeChoice[] = ["system", "light", "dark"];
		current = order[(order.indexOf(current) + 1) % order.length];
		try {
			localStorage.setItem(THEME_KEY, current);
		} catch {
			// 무시: 다음 방문 때 기억하지 못할 뿐
		}
		applyTheme(current);
		if (lastOut) render(lastOut);
	});
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (lastOut) render(lastOut);
	});
}

// ---------------------------------------------------------------- 모드 선택
function buildModes(): void {
	const seg = makeSegmented<Mode>("시뮬레이션 모드", (Object.keys(MODE_LABELS) as Mode[]).map((m) => [m, MODE_LABELS[m]]), () => state.mode, (m) => {
		state.mode = m;
		buildWave();
		buildVariability();
		schedule(0);
	});
	$("modes").replaceChildren(seg.el);
}

// ---------------------------------------------------------------- 파형 설정
let waveFields: Field[] = [];

function section(title: string, hint?: string): HTMLElement {
	const s = el("div", "panel");
	const h = el("div", "panel-head");
	h.append(el("h2", "panel-title", title));
	if (hint) h.append(el("p", "panel-hint", hint));
	s.append(h);
	return s;
}

function numField(id: string, symbol: string, label: string, unit: string, min: number, max: number, scale: number, get: () => number, set: (v: number) => void, opt: { log?: boolean; integer?: boolean; note?: string } = {}): Field {
	return makeField({
		id, symbol, label, unit, min, max, ...opt,
		get: () => get() / scale,
		set: (v) => {
			set(v * scale);
			schedule();
		},
	});
}

function cyclesField(get: () => number, set: (v: number) => void): Field {
	return numField("cycles", "N<sub>cyc</sub>", "사이클 수", "", 1, MAX_CYCLES, 1, get, (v) => set(Math.max(1, Math.min(MAX_CYCLES, Math.round(v)))), { integer: true, note: "사이클당 수 초" });
}

// 고정 상태 모드의 소자 간 몬테카를로 설정 (교수님 요청: 갭, 두께, 밀도를 현실처럼 무작위로)
function mcPanel(): HTMLElement {
	const w = state.fixed;
	const box = el("div", "subpanel");
	box.append(el("h3", "subpanel-title", "무작위성 (소자 간 몬테카를로)"));
	box.append(el("p", "panel-hint", "소자마다 필라멘트 개수(포아송, 평균 = n_f·A_cell), 필라멘트마다 지름·잘록 반경·잘록 길이(로그정규, 평균 = 위 값)를 뽑아 읽기 저항 분포를 본다 (A38, A39)"));
	const body = el("div", "panel-body");
	const sw = makeSwitch("무작위성 켜기", () => w.mcOn, (on) => {
		w.mcOn = on;
		body.hidden = !on;
		schedule(0);
	});
	box.append(sw.el);
	body.hidden = !w.mcOn;
	const m = w.mc;
	const fields = [
		numField("mcN", "M", "소자 수", "", 10, 500, 1, () => m.devices, (v) => (m.devices = Math.max(1, Math.round(v))), { integer: true, log: true }),
		numField("mcPhi", "σ(φ)/φ", "필라멘트 지름 산포 (상대)", "", 0, 1, 1, () => m.sigmaPhi, (v) => (m.sigmaPhi = Math.max(0, v)), { note: "가정 (A39)" }),
		numField("mcNeck", "σ(r)/r", "잘록 반경(갭) 산포 (상대)", "", 0, 1.5, 1, () => m.sigmaNeck, (v) => (m.sigmaNeck = Math.max(0, v)), { note: "가정 (A39)" }),
		numField("mcLen", "σ(L)/L", "잘록 길이 산포 (상대)", "", 0, 1.5, 1, () => m.sigmaLen, (v) => (m.sigmaLen = Math.max(0, v)), { note: "가정 (A39)" }),
	];
	for (const f of fields) {
		waveFields.push(f);
		body.append(f.el);
	}
	const row = el("div", "btn-row");
	const reroll = el("button", "btn", "다시 뽑기");
	reroll.type = "button";
	reroll.addEventListener("click", () => {
		state.seed = (state.seed * 1103515245 + 12345) >>> 0 || 1;
		schedule(0);
	});
	const reset = el("button", "link-btn", "기본값");
	reset.type = "button";
	reset.addEventListener("click", () => {
		w.mc = { ...DEFAULT_MC };
		buildWave();
		schedule(0);
	});
	row.append(reroll, reset);
	body.append(row);
	box.append(body);
	return box;
}

function waveHint(): string {
	if (state.mode === "sweep") return "unipolar: 0 → +V_RESET → 0 (제한 없음) → +V_SET → 0 (R_s 직렬). 포밍된 LRS에서 시작";
	if (state.mode === "pulse") return state.pulse.op === "reset" ? "RESET 펄스: 포밍된 LRS에서 시작, 제한 없음, C_P 포함" : "SET 펄스: RESET 스윕 뒤 HRS에서 시작, R_s 직렬, C_P 포함";
	if (state.mode === "sequence") return "사이클마다 RESET 펄스 → 읽기 → SET 펄스 → 읽기. 같은 극성 (A21)";
	if (state.mode === "measure") return "측정 프로그램 엑셀을 올리면 스윕을 forming / SET / RESET / 읽기로 나누고 역산한다 (A50). 데이터는 브라우저 밖으로 나가지 않는다";
	return "가운데 잘록 구간의 반경과 길이를 정하고 스위칭 없이 읽기 I-V를 본다";
}

// SET 전류 제한: 직렬 저항 R_s 또는 측정기 전류 제한 CC (A40)
function limitFields(w: { rs: number; limit: Limit; icc: number }, hint: string): Field[] {
	const seg = makeSegmented<Limit>("SET 전류 제한 방식", [["rs", "직렬 저항 R_s"], ["cc", "전류 제한 CC"]], () => w.limit, (v) => {
		w.limit = v;
		buildWave();
		schedule(0);
	});
	seg.el.classList.add("seg-block");
	const suffix = hint ? ` (${hint})` : "";
	if (w.limit === "cc") return [seg, numField("icc", "I<sub>CC</sub>", `SET 전류 제한${suffix}`, "µA", 1, 1e4, 1e-6, () => w.icc, (v) => (w.icc = v), { log: true, note: "A40" })];
	return [seg, numField("rs", "R<sub>s</sub>", `SET 직렬 저항${suffix}`, "kΩ", 0.1, 30, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" })];
}

function buildWave(): void {
	const s = section("파형", waveHint());
	const add = (f: Field): void => {
		waveFields.push(f);
		s.append(f.el);
	};
	waveFields = [];
	if (state.mode === "sweep") {
		const w = state.sweep;
		add(numField("vReset", "V<sub>RESET,max</sub>", "RESET 구간 최대 전압", "V", 0.5, 3, 1, () => w.vReset, (v) => (w.vReset = v)));
		add(numField("vSet", "V<sub>SET,max</sub>", "SET 구간 최대 전압", "V", 0.5, 6, 1, () => w.vSet, (v) => (w.vSet = v)));
		add(numField("tRamp", "t<sub>ramp</sub>", "구간당 램프 시간", "ms", 1, 10000, 1e-3, () => w.tRamp, (v) => (w.tRamp = v), { log: true, note: "[R]: 4 V/s" }));
		limitFields(w, "RESET 구간은 제한 없음").forEach(add);
		if (w.limit === "cc") {
			add(makeSwitch("CC에 닿으면 멈춤 (측정처럼)", () => w.stopAtCc, (on) => {
				w.stopAtCc = on;
				schedule(0);
			}));
		}
		add(makeSwitch("C_P 포함 (SET 순간 방전)", () => w.includeCp, (on) => {
			w.includeCp = on;
			schedule(0);
		}));
		add(cyclesField(() => w.cycles, (v) => (w.cycles = v)));
	} else if (state.mode === "pulse") {
		const w = state.pulse;
		const op = makeSegmented<"reset" | "set">("펄스 동작", [["reset", "RESET"], ["set", "SET"]], () => w.op, (v) => {
			w.op = v;
			if (v === "set" && w.amplitude === DEFAULT_PULSE.amplitude && w.width === DEFAULT_PULSE.width) {
				w.amplitude = DEFAULT_SEQUENCE.setV;
				w.width = DEFAULT_SEQUENCE.setWidth;
			} else if (v === "reset" && w.amplitude === DEFAULT_SEQUENCE.setV && w.width === DEFAULT_SEQUENCE.setWidth) {
				w.amplitude = DEFAULT_PULSE.amplitude;
				w.width = DEFAULT_PULSE.width;
			}
			buildWave();
			schedule(0);
		});
		op.el.classList.add("seg-block");
		add(op);
		add(numField("amp", "V<sub>p</sub>", "펄스 진폭 (양의 극성)", "V", 0.5, 5, 1, () => w.amplitude, (v) => (w.amplitude = v)));
		add(numField("width", "t<sub>w</sub>", "펄스 폭 (평탄부)", "µs", 0.01, 100, 1e-6, () => w.width, (v) => (w.width = v), { log: true }));
		add(numField("edge", "t<sub>edge</sub>", "상승/하강 시간", "ns", 1, 100, 1e-9, () => w.tEdge, (v) => (w.tEdge = v)));
		if (w.op === "set") limitFields(w, "").forEach(add);
	} else if (state.mode === "sequence") {
		const w = state.sequence;
		add(numField("resetV", "V<sub>RESET</sub>", "RESET 펄스 진폭", "V", 0.5, 5, 1, () => w.resetV, (v) => (w.resetV = v)));
		add(numField("resetW", "t<sub>RESET</sub>", "RESET 펄스 폭", "µs", 0.01, 100, 1e-6, () => w.resetWidth, (v) => (w.resetWidth = v), { log: true }));
		add(numField("setV", "V<sub>SET</sub>", "SET 펄스 진폭", "V", 0.5, 5, 1, () => w.setV, (v) => (w.setV = v)));
		add(numField("setW", "t<sub>SET</sub>", "SET 펄스 폭", "µs", 0.01, 100, 1e-6, () => w.setWidth, (v) => (w.setWidth = v), { log: true }));
		add(numField("readV", "V<sub>read</sub>", "읽기 전압", "V", 0.02, 0.3, 1, () => w.vRead, (v) => (w.vRead = v)));
		add(numField("edge", "t<sub>edge</sub>", "상승/하강 시간", "ns", 1, 100, 1e-9, () => w.tEdge, (v) => (w.tEdge = v)));
		limitFields(w, "RESET은 제한 없음").forEach(add);
		add(cyclesField(() => w.cycles, (v) => (w.cycles = v)));
	} else if (state.mode === "measure") {
		measurePanel(s, add);
	} else {
		const w = state.fixed;
		const p = state.params;
		add(numField("fr", "r<sub>neck</sub>", "잘록 구간 반경", "nm", 0.5, p.phi0 / 2 * 1e9, 1e-9, () => w.rNeck, (v) => (w.rNeck = Math.max(0, v))));
		add(numField("fl", "L<sub>neck</sub>", "잘록 구간 길이", "nm", 0, p.L0 * 1e9, 1e-9, () => w.neckLen, (v) => (w.neckLen = Math.max(0, v))));
		add(numField("fv", "V<sub>max</sub>", "스윕 범위 ±", "V", 0.05, 1, 1, () => w.vMax, (v) => (w.vMax = v)));
		s.append(mcPanel());
	}
	const reset = el("button", "link-btn", "파형 기본값");
	reset.type = "button";
	reset.addEventListener("click", () => {
		if (state.mode === "sweep") state.sweep = { ...DEFAULT_SWEEP };
		else if (state.mode === "pulse") state.pulse = { ...DEFAULT_PULSE };
		else if (state.mode === "sequence") state.sequence = { ...DEFAULT_SEQUENCE };
		else if (state.mode === "measure") state.measure = { ...DEFAULT_MEASURE, thickness: state.measure.thickness };
		else state.fixed = { ...DEFAULT_FIXED, mc: { ...DEFAULT_MC } };
		buildWave();
		schedule(0);
	});
	s.querySelector(".panel-head")!.append(reset);
	$("wave").replaceChildren(s);
}

// ---------------------------------------------------------------- 변동성
let varFields: Field[] = [];

function buildVariability(): void {
	const box = $("var");
	varFields = [];
	if (state.mode !== "sweep" && state.mode !== "sequence") {
		box.replaceChildren();
		return;
	}
	const s = section("변동성", "사이클마다 SET 장벽 E_a, RESET 장벽 E_d를 다시 뽑는다 ([D] 식 10–11, A13)");
	const body = el("div", "panel-body");
	const sw = makeSwitch("변동성 켜기", () => state.variabilityOn, (on) => {
		state.variabilityOn = on;
		const cyc = state.mode === "sweep" ? state.sweep : state.sequence;
		if (on && cyc.cycles < 2) cyc.cycles = VARIABILITY_CYCLES;
		for (const f of waveFields) f.refresh();
		body.hidden = !on;
		schedule(0);
	});
	s.append(sw.el);
	body.hidden = !state.variabilityOn;
	for (const m of VAR_FIELDS) {
		const f = makeField({
			id: m.key, symbol: m.symbol, label: m.label, unit: m.unit, min: m.min, max: m.max, note: m.note,
			get: () => state.variability[m.key] / m.scale,
			set: (v) => {
				state.variability[m.key] = Math.max(0, v) * m.scale;
				schedule();
			},
		});
		varFields.push(f);
		body.append(f.el);
	}
	const row = el("div", "btn-row");
	const reroll = el("button", "btn", "다시 뽑기");
	reroll.type = "button";
	reroll.addEventListener("click", () => {
		state.seed = (state.seed * 1103515245 + 12345) >>> 0 || 1;
		schedule(0);
	});
	const reset = el("button", "link-btn", "기본값");
	reset.type = "button";
	reset.addEventListener("click", () => {
		state.variability = { ...DEFAULT_VARIABILITY };
		for (const f of varFields) f.refresh();
		schedule(0);
	});
	row.append(reroll, reset);
	body.append(row);
	s.append(body);
	box.replaceChildren(s);
}

// ---------------------------------------------------------------- 파라미터 패널
const paramFields: Field[] = [];
let countEl: HTMLElement | null = null;

function updateCount(): void {
	if (countEl) countEl.innerHTML = `N = <strong>${filamentCount(state.params).toLocaleString("ko-KR")}</strong>개`;
}

function paramField(m: ParamMeta): Field {
	return makeField({
		id: m.key, symbol: m.symbol, label: m.label, unit: m.unit, min: m.min, max: m.max, log: m.log, fixed: m.fixed, note: m.note,
		get: () => state.params[m.key] / m.scale,
		set: (v) => {
			let val = v * m.scale;
			// 계산 영역은 CF보다 커야 한다
			if (m.key === "Rdom") val = Math.max(val, 0.55 * state.params.phi0);
			if (m.key === "phi0") val = Math.min(val, 1.8 * state.params.Rdom);
			state.params = { ...state.params, [m.key]: val };
			if (m.key === "nF" || m.key === "aCell") updateCount();
			if ((m.key === "L0" || m.key === "phi0") && state.mode === "fixed") buildWave();
			schedule();
		},
	});
}

function buildParams(): void {
	const box = $("params");
	const head = el("div", "params-head");
	head.append(el("h2", "panel-title", "모델 파라미터"));
	const resetAll = el("button", "link-btn", "전체 기본값 복원");
	resetAll.type = "button";
	resetAll.addEventListener("click", () => {
		state.params = { ...DEFAULT };
		for (const f of paramFields) f.refresh();
		updateCount();
		if (state.mode === "fixed") buildWave();
		schedule(0);
	});
	head.append(resetAll);
	box.replaceChildren(head);
	// 소자 프리셋: 기본(NiO, [R]) / TiN/HfO2/TiN 6 nm (A48)
	const presets = el("div", "preset device-preset");
	const apply = (values: Partial<Params>): void => {
		state.params = { ...state.params, ...values };
		for (const f of paramFields) f.refresh();
		updateCount();
		buildWave();
		schedule(0);
	};
	const nio = el("button", "btn", "NiO 160 nm (Russo)");
	nio.type = "button";
	nio.addEventListener("click", () => {
		const back: Partial<Params> = {};
		for (const k of Object.keys(OUR_DEVICE) as (keyof Params)[]) (back as Record<string, number>)[k] = DEFAULT[k];
		apply(back);
	});
	const hfo = el("button", "btn", "TiN/HfO₂/TiN 6 nm");
	hfo.type = "button";
	hfo.addEventListener("click", () => apply(HFO2_TIN));
	const ours = el("button", "btn", "우리 소자 (6 nm, 20800 µm²)");
	ours.type = "button";
	ours.addEventListener("click", () => {
		apply(OUR_DEVICE);
		// 실험 조건: SET은 CC(기본 10 µA)에서 멈춤, 패드 정전용량 포함 (A51, A52)
		state.sweep = { ...state.sweep, limit: "cc", icc: 1e-5, stopAtCc: true, includeCp: true, vReset: 2.0, vSet: 4.0, tRamp: 3.0 };
		buildWave();
		schedule(0);
	});
	presets.append(el("span", "preset-note", "소자 프리셋"), nio, hfo, ours);
	box.append(presets);
	paramFields.length = 0;
	PARAM_GROUPS.forEach((g, gi) => {
		const d = el("details", "group");
		d.open = gi < 2;
		const sum = el("summary");
		sum.append(el("span", "group-title", g.title));
		if (g.hint) sum.append(el("span", "group-hint", g.hint));
		d.append(sum);
		// 0/1 스위치 파라미터: 갭 호핑 켜기 (A55), SET 전계 방식 (A54)
		const toggles: [string, keyof Params, string][] = [["hop", "hop", "갭 호핑 전도 켜기"], ["set", "setField", "SET 전계: 산화막 평균 전계 V/L0 (끄면 경계 국소 전계)"]];
		for (const [gid, key, label] of toggles) {
			if (g.id !== gid) continue;
			const sw = makeSwitch(label, () => state.params[key] === 1, (on) => {
				state.params = { ...state.params, [key]: on ? 1 : 0 };
				schedule(0);
			});
			paramFields.push(sw);
			d.append(sw.el);
		}
		const fields = g.items.map((m) => {
			const f = paramField(m);
			paramFields.push(f);
			d.append(f.el);
			return f;
		});
		for (const pr of g.presets ?? []) {
			const row = el("div", "preset");
			const btn = el("button", "btn", pr.label);
			btn.type = "button";
			btn.addEventListener("click", () => {
				state.params = { ...state.params, ...pr.values };
				for (const f of fields) f.refresh();
				schedule(0);
			});
			row.append(btn, el("span", "preset-note", pr.note));
			d.append(row);
		}
		if (g.id === "density") {
			countEl = el("p", "count");
			d.append(countEl);
			updateCount();
		}
		const reset = el("button", "link-btn", "이 그룹 기본값");
		reset.type = "button";
		reset.addEventListener("click", () => {
			for (const m of g.items) state.params = { ...state.params, [m.key]: DEFAULT[m.key] };
			for (const f of fields) f.refresh();
			updateCount();
			if (state.mode === "fixed") buildWave();
			schedule(0);
		});
		d.append(reset);
		box.append(d);
	});
}

// ---------------------------------------------------------------- 작업 만들기
function iccOf(w: { limit: Limit; icc: number }): number | undefined {
	return w.limit === "cc" ? w.icc : undefined;
}

function currentJob(): Job {
	if (state.mode === "measure") return measureJob();
	const p: Params = { ...state.params };
	const variability = state.variabilityOn ? { ...state.variability } : undefined;
	if (state.mode === "sweep") {
		const w = state.sweep;
		return {
			kind: "sweep", vReset: w.vReset, vSet: w.vSet, tRamp: w.tRamp, rs: w.rs, iCc: iccOf(w), stopAtCc: w.stopAtCc, includeCp: w.includeCp,
			params: p, cycles: w.cycles, variability, seed: state.seed,
		};
	}
	if (state.mode === "pulse") {
		const w = state.pulse;
		return { kind: "pulse", op: w.op, v: w.amplitude, width: w.width, tEdge: w.tEdge, rs: w.rs, iCc: iccOf(w), params: p };
	}
	if (state.mode === "sequence") {
		const w = state.sequence;
		return {
			kind: "sequence",
			reset: { v: w.resetV, width: w.resetWidth },
			set: { v: w.setV, width: w.setWidth },
			vRead: w.vRead,
			tEdge: w.tEdge,
			rs: w.rs,
			iCc: iccOf(w),
			params: p,
			cycles: w.cycles,
			variability,
			seed: state.seed,
		};
	}
	const f = state.fixed;
	const n = 41;
	const v = Array.from({ length: n }, (_, k) => -f.vMax + 2 * f.vMax * k / (n - 1));
	return {
		kind: "fixed", v, rNeck: Math.min(f.rNeck, p.phi0 / 2), neckLen: Math.min(f.neckLen, p.L0), params: p,
		mc: f.mcOn ? { ...f.mc } : undefined, seed: state.seed,
	};
}

// ---------------------------------------------------------------- 계산 예약 / 진행 표시
function schedule(delay = DEBOUNCE_MS): void {
	window.clearTimeout(timer);
	timer = window.setTimeout(compute, delay);
}

function setStatus(text: string, busy: boolean, progress?: number): void {
	$("status").classList.toggle("busy", busy);
	$("status-text").textContent = text;
	const bar = $("progress");
	bar.hidden = progress === undefined;
	if (progress !== undefined) {
		bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
		$("progress-fill").style.width = `${(progress * 100).toFixed(1)}%`;
	}
	$("cancel").hidden = !busy;
}

async function compute(): Promise<void> {
	if (state.mode === "measure" && measureSweeps().length === 0) {
		lastOut = null;
		lastMode = "measure";
		renderMeasureEmpty();
		setStatus("측정 엑셀(.xlsx)을 올려 주세요", false);
		return;
	}
	const job = currentJob();
	const mode = state.mode;
	const cycles = job.kind === "sweep" || job.kind === "sequence" ? job.cycles : 1;
	const isMc = job.kind === "fixed" && job.mc !== undefined;
	const t0 = performance.now();
	setStatus("계산 중…", true, 0);
	try {
		const out = await client.run(job, (done, total) => {
			const label = isMc ? ` · ${Math.floor(done)} / ${total} 소자` : cycles > 1 ? ` · ${Math.min(Math.floor(done) + 1, total)} / ${total} 사이클` : "";
			setStatus(`계산 중… ${Math.round(100 * done / total)}%${label}`, true, done / total);
		});
		lastOut = out;
		lastMode = mode;
		render(out);
		const ms = performance.now() - t0;
		setStatus(`${ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`}에 계산${cycles > 1 ? ` · ${cycles} 사이클` : ""}`, false);
	} catch (e) {
		if (e instanceof SupersededError) return;
		setStatus(`계산 실패: ${(e as Error).message}. 스텝·허용오차·직렬 저항 순으로 조정해 보세요.`, false);
	}
}

// ---------------------------------------------------------------- 결과 렌더링
interface CardSpec {
	id: string;
	title: string;
	sub?: string;
	wide?: boolean;
	tall?: boolean;
}

const cards = new Map<string, HTMLElement>();
let cardKey = "";

function ensureCards(specs: CardSpec[]): void {
	const key = specs.map((s) => `${s.id}|${s.title}|${s.sub ?? ""}|${s.wide ? 1 : 0}`).join(";");
	if (key === cardKey) return;
	for (const div of cards.values()) purge(div);
	cards.clear();
	const box = $("charts");
	box.replaceChildren();
	for (const s of specs) {
		const card = el("figure", `card${s.wide ? " wide" : ""}${s.tall ? " tall" : ""}`);
		const head = el("figcaption", "card-head");
		const titles = el("div");
		titles.append(el("span", "card-title", s.title));
		if (s.sub) titles.append(el("span", "card-sub", s.sub));
		const png = el("button", "link-btn", "PNG");
		png.type = "button";
		png.setAttribute("aria-label", `${s.title} PNG로 저장`);
		const plot = el("div", "plot");
		png.addEventListener("click", () => downloadPng(plot, `rram_${state.mode}_${s.id}`));
		head.append(titles, png);
		card.append(head, plot);
		box.append(card);
		cards.set(s.id, plot);
	}
	cardKey = key;
}

// 비율 표기: 10 미만은 소수 한 자리, 그 이상은 정수에 천 단위 구분
function ratio(r: number): string {
	if (!Number.isFinite(r)) return "—";
	return r < 10 ? `${r.toFixed(1)}×` : `${Math.round(r).toLocaleString("ko-KR")}×`;
}

function stat(label: string, value: string, hint?: string): HTMLElement {
	const d = el("div", "stat");
	d.append(el("span", "stat-label", label), el("span", "stat-value", value));
	if (hint) d.append(el("span", "stat-hint", hint));
	return d;
}

// 여러 사이클을 시간축으로 이어 붙인다
function joinCycles(cs: SimResult[]): { t: number[]; v: number[]; i: number[]; r: number[]; T: number[] } {
	const o = { t: [] as number[], v: [] as number[], i: [] as number[], r: [] as number[], T: [] as number[] };
	let off = 0;
	for (const c of cs) {
		for (let k = 0; k < c.t.length; k++) {
			o.t.push(c.t[k] + off);
			o.v.push(c.vApp[k]);
			o.i.push(c.i[k]);
			o.r.push(c.rMin[k]);
			o.T.push(c.T[k]);
		}
		off += c.t[c.t.length - 1];
	}
	return o;
}

function maxOf(a: ArrayLike<number>): number {
	let m = -Infinity;
	for (let k = 0; k < a.length; k++) m = Math.max(m, a[k]);
	return m;
}

// 시간 파형 카드 공통: 인가 전압, 전류, 가장 가는 곳 CF 반경, 최고 온도, 최고 온도 시점의 CF 형상
function timeCards(sub?: string): CardSpec[] {
	return [
		{ id: "v", title: "인가 전압", sub },
		{ id: "i", title: "전류", sub },
		{ id: "r", title: "가장 가는 곳 CF 반경", sub },
		{ id: "T", title: "최고 온도", sub },
		{ id: "map", title: "CF 형상과 온도 분포", sub: "최고 온도 시점 (cf. [R] Fig. 2)", wide: true, tall: true },
	];
}

function drawTime(t: number[], v: number[], i: number[], r: number[], T: number[], hot: SimResult["hot"], g: SimResult["grid"], iLog: boolean): void {
	const tu = timeUnit(t[t.length - 1]);
	timeChart(cards.get("v")!, t, v, { tScale: tu.scale, tLabel: tu.label, yTitle: "전압 (V)", unit: "V" });
	if (iLog) timeChart(cards.get("i")!, t, i, { tScale: tu.scale, tLabel: tu.label, yTitle: "|전류| (A)", unit: "A", yLog: true, absolute: true });
	else timeChart(cards.get("i")!, t, i, { tScale: tu.scale, tLabel: tu.label, yTitle: "전류 (mA)", unit: "A", yScale: 1e3 });
	timeChart(cards.get("r")!, t, r, { tScale: tu.scale, tLabel: tu.label, yTitle: "반경 (nm)", unit: "m", yScale: 1e9, color: 2 });
	timeChart(cards.get("T")!, t, T, { tScale: tu.scale, tLabel: tu.label, yTitle: "온도 (K)", unit: "K" });
	profileMapChart(cards.get("map")!, g.rFaces, g.zFaces, hot.T, hot.rb, g.zc);
}

function render(out: JobOutput): void {
	const stats = $("stats");
	stats.replaceChildren();
	$("csv-summary").hidden = out.kind === "fixed" || lastMode === "pulse";
	$("csv-state").hidden = out.kind === "fixed";
	if (out.kind === "measure") {
		$("csv-summary").hidden = true;
		$("csv-state").hidden = true;
		renderMeasure(out, stats);
		return;
	}
	if (out.kind === "measureSim") return;
	if (out.kind === "fixed") {
		renderFixed(out, stats);
		return;
	}
	if (lastMode === "sweep") renderSweep(out as TransientOutput, stats);
	else if (lastMode === "pulse") renderPulse(out as TransientOutput, stats);
	else renderSequence(out as TransientOutput, stats);
}

// 사이클 사이 상태 카드 (A46): RESET 후 / SET 후 형상, 여러 사이클이면 갭 추이
function stateCards(n: number): CardSpec[] {
	const specs: CardSpec[] = [{ id: "state", title: "RESET 후 / SET 후 필라멘트 형상", sub: n > 1 ? `${n}개 사이클 겹침, 진한 선이 마지막` : "r_b(z), 축 대칭" }];
	if (n > 1) specs.push({ id: "trend", title: "사이클별 갭", sub: "RESET 후 가장 가는 곳 / SET 후 평균 반경" });
	return specs;
}

function drawState(out: TransientOutput): StateMetrics {
	const g = out.cycles[out.cycles.length - 1].grid;
	const profiles = out.summary.flatMap((c, k) => [
		{ rb: c.rbHrs, kind: "hrs" as const, cycle: k + 1 },
		{ rb: c.rbLrs, kind: "lrs" as const, cycle: k + 1 },
	]);
	stateProfileChart(cards.get("state")!, g.zFaces, profiles);
	const mh = out.summary.map((c) => stateMetrics(c.rbHrs, g));
	const ml = out.summary.map((c) => stateMetrics(c.rbLrs, g));
	if (cards.has("trend")) stateTrendChart(cards.get("trend")!, mh.map((m) => m.rMin), ml.map((m) => m.rMean));
	return mh[mh.length - 1];
}

function gapStat(m: StateMetrics): HTMLElement {
	return stat("갭 (RESET 후)", `${(m.rMin * 1e9).toFixed(2)} nm`, `가장 가는 곳 반경, 잘록 길이 ${(m.neckLen * 1e9).toFixed(0)} nm`);
}

function renderSweep(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "iv", title: "I-V", sub: multi ? `${n}개 사이클 겹침` : "|I|, 로그 눈금", wide: true, tall: true }];
	if (multi) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: "0.1 V 읽기", wide: true });
	specs.push(...stateCards(n));
	specs.push(...timeCards(multi ? "마지막 사이클" : undefined));
	ensureCards(specs);
	const gm = drawState(out);
	sweepIvChart(cards.get("iv")!, out.cycles.map((r) => ({ v: r.vApp, i: r.i, split: r.split ?? r.t.length - 1 })));
	const last = out.cycles[n - 1];
	drawTime(Array.from(last.t), Array.from(last.vApp), Array.from(last.i), Array.from(last.rMin), Array.from(last.T), last.hot, last.grid, true);
	const s = out.summary;
	const lrs = s.map((c) => c.rLrs);
	const hrs = s.map((c) => c.rHrs);
	if (multi) {
		histogramChart(cards.get("hist")!, lrs, hrs);
		const [mr, sr] = meanStd(s.map((c) => c.vReset));
		const [ms, ss] = meanStd(s.map((c) => c.vSet));
		stats.append(
			stat("V_RESET", `${mr.toFixed(2)} ± ${sr.toFixed(2)} V`, "평균 ± 표준편차"),
			stat("V_SET", `${ms.toFixed(2)} ± ${ss.toFixed(2)} V`, "평균 ± 표준편차"),
			stat("R_HRS", siFormat(median(hrs), "Ω"), "중앙값"),
			stat("R_LRS", siFormat(median(lrs), "Ω"), "중앙값"),
			stat("HRS / LRS", ratio(median(hrs) / median(lrs))),
			gapStat(gm),
		);
	} else {
		const c = s[0];
		stats.append(
			stat("V_RESET", `${c.vReset.toFixed(2)} V`, `I_RESET ${siFormat(Math.abs(c.iReset), "A")}`),
			stat("V_SET", Number.isFinite(c.vSet) ? `${c.vSet.toFixed(2)} V` : "—", "R이 1/10로"),
			stat("R_HRS", siFormat(c.rHrs, "Ω"), "RESET 후, 0.1 V"),
			stat("R_LRS", siFormat(c.rLrs, "Ω"), "SET 후, 0.1 V"),
			stat("HRS / LRS", ratio(c.rHrs / c.rLrs)),
			gapStat(gm),
			stat("T_max", `${maxOf(last.T).toFixed(0)} K`),
		);
	}
}

function renderPulse(out: TransientOutput, stats: HTMLElement): void {
	const r = out.cycles[0];
	const isSet = state.pulse.op === "set";
	ensureCards([...stateCards(1), ...timeCards()]);
	const gm = drawState(out);
	drawTime(Array.from(r.t), Array.from(r.vApp), Array.from(r.i), Array.from(r.rMin), Array.from(r.T), r.hot, r.grid, false);
	stats.append(
		stat("R 펄스 전", siFormat(out.rStart, "Ω"), isSet ? "RESET 스윕 뒤 HRS" : "포밍된 LRS"),
		stat("R 펄스 후", siFormat(out.rEnd, "Ω"), "0.1 V 읽기"),
		stat("변화", ratio(isSet ? out.rStart / out.rEnd : out.rEnd / out.rStart), isSet ? "R 감소" : "R 증가"),
		stat("|I| 최대", siFormat(maxOf(Array.from(r.i, Math.abs)), "A")),
		gapStat(gm),
		stat("T_max", `${maxOf(r.T).toFixed(0)} K`),
	);
}

function renderSequence(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "read", title: "읽기 저항", sub: `사이클마다 RESET 후 / SET 후, ${state.sequence.vRead} V`, wide: true }];
	if (multi && state.variabilityOn) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: `${state.sequence.vRead} V 읽기`, wide: true });
	specs.push(...stateCards(n));
	specs.push(...timeCards(multi ? `${n}개 사이클 연속` : undefined));
	ensureCards(specs);
	const gm = drawState(out);
	const lrs = out.summary.map((c) => c.rLrs);
	const hrs = out.summary.map((c) => c.rHrs);
	readChart(cards.get("read")!, lrs, hrs);
	if (cards.has("hist")) histogramChart(cards.get("hist")!, lrs, hrs);
	const j = joinCycles(out.cycles);
	let hotC = out.cycles[0];
	for (const c of out.cycles) if (maxOf(c.T) > maxOf(hotC.T)) hotC = c;
	drawTime(j.t, j.v, j.i, j.r, j.T, hotC.hot, hotC.grid, true);
	const mL = median(lrs);
	const mH = median(hrs);
	stats.append(
		stat("R_HRS", siFormat(mH, "Ω"), multi ? "중앙값" : "RESET 후 읽기"),
		stat("R_LRS", siFormat(mL, "Ω"), multi ? "중앙값" : "SET 후 읽기"),
		stat("HRS / LRS", ratio(mH / mL)),
		gapStat(gm),
		stat("T_max", `${Math.max(...out.cycles.map((c) => maxOf(c.T))).toFixed(0)} K`),
	);
}

function renderFixed(out: FixedOutput, stats: HTMLElement): void {
	const f = state.fixed;
	if (out.mc) {
		const mc = out.mc;
		ensureCards([
			{ id: "hist", title: "읽기 저항 분포", sub: `${mc.R.length}개 소자, 0.1 V`, wide: true },
			{ id: "scatter", title: "필라멘트 수와 저항" },
			{ id: "iv", title: "읽기 I-V", sub: `소자 ${mc.ivSamples.length}개 겹침` },
		]);
		mcHistogramChart(cards.get("hist")!, mc.R);
		mcScatterChart(cards.get("scatter")!, mc.N, mc.R);
		ivChart(cards.get("iv")!, mc.ivSamples, 1e-15);
		const R = Array.from(mc.R).sort((a, b) => a - b);
		const pct = (q: number): number => R[Math.min(R.length - 1, Math.floor(q * (R.length - 1)))];
		const [, sl] = meanStd(R.map(Math.log10));
		const [nMean] = meanStd(Array.from(mc.N));
		stats.append(
			stat("R 중앙값", siFormat(median(R), "Ω"), "0.1 V 읽기"),
			stat("R 10–90%", `${siFormat(pct(0.1), "Ω")} – ${siFormat(pct(0.9), "Ω")}`),
			stat("σ(log₁₀R)", sl.toFixed(2), "분포 폭"),
			stat("필라멘트 수", `${nMean.toFixed(2)}개`, `평균 (n_f·A_cell = ${(state.params.nF * state.params.aCell).toFixed(2)})`),
			stat("기준 소자", siFormat(out.r01, "Ω"), "산포 없음, N = 1"),
		);
		return;
	}
	ensureCards([
		{ id: "iv", title: "읽기 I-V", sub: "고정 상태, 스위칭 없음", wide: true, tall: true },
	]);
	ivChart(cards.get("iv")!, [{ v: out.v, i: out.i }], 1e-15);
	stats.append(
		stat("R (0.1 V)", siFormat(out.r01, "Ω"), "R_L 포함"),
		stat("잘록 구간 면적", `${(Math.PI * f.rNeck * f.rNeck * 1e18).toFixed(1)} nm²`, "π r²"),
		stat("잘록 구간 길이", `${(f.neckLen * 1e9).toFixed(0)} nm`),
		stat("필라멘트 수 N", filamentCount(state.params).toLocaleString("ko-KR")),
	);
}

// ---------------------------------------------------------------- 측정 데이터 모드 (A50)
let sessions: Session[] = [];
const kindOverride = new Map<string, SweepKind>();	// "파일#순서" → 손으로 바꾼 분류
let lastSim: MeasureSimOutput | null = null;
let simKey = "";	// 시뮬레이션을 계산한 측정 분석 조건 (바뀌면 겹쳐 그리지 않음)
const EPS0 = 8.8541878128e-12;	// 진공 유전율 [F/m]
const EPS_HFO2 = 20;	// HfO2 비유전율 (ALD 박막, A51)
const RL_SENS = [0, 10, 20, 30];	// 직렬 저항 민감도 [ohm]

const swKey = (file: string, index: number): string => `${file}#${index}`;

function kindOf(s: Session["sweeps"][number]): SweepKind {
	return kindOverride.get(swKey(s.file, s.index)) ?? s.kind;
}

const groups0 = (): { t: number; n: number }[] => thicknessGroups();

function thicknessGroups(): { t: number; n: number }[] {
	const m = new Map<number, number>();
	for (const s of sessions) if (Number.isFinite(s.thickness)) m.set(s.thickness, (m.get(s.thickness) ?? 0) + 1);
	return [...m.entries()].map(([t, n]) => ({ t, n })).sort((a, b) => a.t - b.t);
}

function selectedSessions(): Session[] {
	const t = state.measure.thickness;
	return sessions.filter((s) => (Number.isFinite(t) ? Math.abs(s.thickness - t) < 1e-12 : true));
}

function measureSweeps(): MeasureSweepIn[] {
	const out: MeasureSweepIn[] = [];
	for (const ses of selectedSessions()) {
		const first = ses.sweeps.find((x) => kindOf(x) === "forming");
		for (const s of ses.sweeps) {
			out.push({ file: s.file, index: s.index, kind: kindOf(s), v: s.v, i: s.i, cc: s.cc, firstForming: s === first && s.r01 > 1e8 });
		}
	}
	return out;
}

// 측정 소자 값으로 바꾼 파라미터: 두께·면적은 파일에서, C_P = ε0·εr·A/t (A51), 필라멘트 1개
function measureParams(): Params {
	const ses = selectedSessions();
	const t = Number.isFinite(state.measure.thickness) ? state.measure.thickness : state.params.L0;
	const area = ses.find((s) => Number.isFinite(s.area))?.area ?? state.params.aCell;
	return { ...state.params, L0: t, aCell: area, nF: 1 / area, CP: EPS0 * EPS_HFO2 * area / t };
}

function measureJob(): MeasureJob {
	return { kind: "measure", sweeps: measureSweeps(), params: measureParams(), alpha: state.measure.alpha, rlList: RL_SENS };
}

async function loadFiles(files: File[]): Promise<void> {
	let n = 0;
	const errors: string[] = [];
	for (const f of files) {
		if (!/\.xlsx$/i.test(f.name) || f.name.startsWith("~$")) continue;
		try {
			const ses = parseSession(f.name, await readXlsx(await f.arrayBuffer()));
			sessions = sessions.filter((s) => s.file !== ses.file);
			sessions.push(ses);
			n++;
		} catch (e) {
			errors.push(`${f.name}: ${(e as Error).message}`);
		}
	}
	sessions.sort((a, b) => a.file.localeCompare(b.file, "ko"));
	const groups = thicknessGroups();
	if (groups.length && !groups.some((g) => g.t === state.measure.thickness)) {
		state.measure.thickness = groups.reduce((a, b) => (b.n > a.n ? b : a)).t;
	}
	// 물성이 아직 기본(NiO)이면 우리 소자 물성(TiN/HfO2)으로 바꾼다
	if (state.params.L0 === DEFAULT.L0) {
		state.params = { ...state.params, ...OUR_DEVICE };
		for (const fl of paramFields) fl.refresh();
	}
	lastSim = null;
	buildWave();
	setStatus(errors.length ? `읽지 못한 파일: ${errors.join(", ")}` : `파일 ${n}개를 읽었습니다`, false);
	schedule(0);
}

function measurePanel(s: HTMLElement, add: (f: Field) => void): void {
	const w = state.measure;
	const drop = el("label", "dropzone");
	const input = el("input");
	input.type = "file";
	input.multiple = true;
	input.accept = ".xlsx";
	input.addEventListener("change", () => {
		if (input.files) void loadFiles([...input.files]);
	});
	drop.append(input, el("span", "dropzone-text", sessions.length ? "엑셀 더 올리기 (같은 이름은 바꿔 넣음)" : "측정 엑셀(.xlsx)을 끌어다 놓거나 눌러서 고르기"));
	drop.addEventListener("dragover", (e) => {
		e.preventDefault();
		drop.classList.add("over");
	});
	drop.addEventListener("dragleave", () => drop.classList.remove("over"));
	drop.addEventListener("drop", (e) => {
		e.preventDefault();
		drop.classList.remove("over");
		if (e.dataTransfer?.files) void loadFiles([...e.dataTransfer.files]);
	});
	s.append(drop);
	if (sessions.length) {
		const nSw = sessions.reduce((a, x) => a + x.sweeps.length, 0);
		const row = el("div", "btn-row file-row");
		row.append(el("span", "panel-hint", `파일 ${sessions.length}개 · 스윕 ${nSw}개${groups0().length > 1 ? ` · 두께 ${groups0().map((g) => `${(g.t * 1e9).toFixed(0)} nm ${g.n}개`).join(", ")}` : ""}`));
		const clear = el("button", "link-btn", "모두 지우기");
		clear.type = "button";
		clear.addEventListener("click", () => {
			sessions = [];
			kindOverride.clear();
			lastSim = null;
			buildWave();
			schedule(0);
		});
		row.append(clear);
		s.append(row);
		const groups = thicknessGroups();
		if (groups.length > 1) {
			const seg = makeSegmented<string>("두께", groups.map((g) => [String(g.t), `${(g.t * 1e9).toFixed(0)} nm`]), () => String(w.thickness), (v) => {
				w.thickness = Number(v);
				lastSim = null;
				schedule(0);
			});
			seg.el.classList.add("seg-block");
			add(seg);
		}
	}
	add(numField("mRate", "dV/dt", "평균 램프 속도 (계단 / 머무는 시간)", "V/s", 0.01, 100, 1, () => w.rate, (v) => (w.rate = v), { log: true, note: "가정 (A50)" }));
	add(numField("mAlpha", "α", "필라멘트 저항 온도 계수", "10⁻³/K", 0.1, 5, 1e-3, () => w.alpha, (v) => (w.alpha = v), { log: true, note: "[C] NiO 1.7, HfOₓ 미확인" }));
	add(numField("mRL", "R<sub>L</sub>", "직렬 저항 (프로브·배선)", "Ω", 0, 60, 1, () => state.params.RL, (v) => {
		state.params = { ...state.params, RL: v };
		for (const fl of paramFields) fl.refresh();
	}, { note: "추정 30 (A53)" }));
	s.append(el("p", "panel-hint", "두께·면적은 파일에서, C_P는 ε₀·20·A/t로 자동. 물성은 아래 모델 파라미터 (A51)"));
	// 시뮬레이션 겹쳐 보기
	const box = el("div", "subpanel");
	box.append(el("h3", "subpanel-title", "시뮬레이션 겹쳐 보기"));
	box.append(el("p", "panel-hint", "역산한 지름·산화막 비저항·R_L로 RESET → SET을 측정과 같은 램프로 계산해 겹친다. 수십 초~수 분"));
	const icc = numField("mIcc", "I<sub>CC</sub>", "SET 전류 제한 (빈칸이면 측정 SET 중앙값)", "µA", 1, 1e4, 1e-6, () => (Number.isFinite(w.icc) ? w.icc : medianCc()), (v) => (w.icc = v), { log: true });
	waveFields.push(icc);
	box.append(icc.el);
	box.append(makeSwitch("패드 정전용량 C_P 포함 (A51)", () => w.includeCp, (on) => (w.includeCp = on)).el);
	box.append(makeSwitch("열 보정한 전극 열전도도 쓰기 (A56)", () => w.thermalFit, (on) => (w.thermalFit = on)).el);
	box.append(makeSwitch("SET을 측정 HRS에 맞춘 갭에서 시작 (A55)", () => w.setFromHrs, (on) => (w.setFromHrs = on)).el);
	box.append(makeSwitch("E_a를 측정 V_set에 먼저 맞추기 (A54)", () => w.fitEa, (on) => (w.fitEa = on)).el);
	const run = el("button", "btn", "시뮬레이션 실행");
	run.type = "button";
	run.disabled = sessions.length === 0;
	run.addEventListener("click", () => void runMeasureSim());
	box.append(run);
	s.append(box);
}

function medianCc(): number {
	const cc = measureSweeps().filter((x) => x.kind === "set").map((x) => x.cc);
	return cc.length ? medianOf(cc) : 1e-5;
}

function measureCondKey(): string {
	return JSON.stringify([state.measure.thickness, state.measure.rate, state.measure.alpha, state.params, [...kindOverride.entries()]]);
}

async function runMeasureSim(): Promise<void> {
	const out = lastOut && lastOut.kind === "measure" ? lastOut : null;
	if (!out) return;
	const m = out.sens[out.main];
	if (!Number.isFinite(m.phi)) {
		setStatus("필라멘트 지름을 정하지 못해 시뮬레이션을 할 수 없습니다 (R_L을 줄여 보세요)", false);
		return;
	}
	const p0 = measureParams();
	const n = m.separable ? Math.max(1, Math.round(m.N)) : 1;
	const thermal = state.measure.thermalFit && Number.isFinite(out.kappaEl);
	const params: Params = {
		...p0, phi0: thermal ? out.phiK : m.phi, nF: n / p0.aCell, rhoOx: Number.isFinite(out.rhoOx) ? out.rhoOx : p0.rhoOx,
		kappaEl: thermal ? out.kappaEl : p0.kappaEl,
	};
	const job: MeasureSimJob = {
		kind: "measureSim", params, rate: state.measure.rate,
		vResetMax: (Number.isFinite(out.vResetMed) ? out.vResetMed : 1.5) + 0.5,
		vSetMax: (Number.isFinite(out.vSetMed) ? out.vSetMed : 3) + 1.0,
		icc: Number.isFinite(state.measure.icc) ? state.measure.icc : medianCc(),
		includeCp: state.measure.includeCp, fitEa: state.measure.fitEa, vSetTarget: out.vSetMed,
		hrsGap: state.measure.setFromHrs && Number.isFinite(out.gap) ? out.gap : 0,
	};
	const t0 = performance.now();
	setStatus("시뮬레이션 중…", true, 0);
	try {
		const res = await client.run(job, (done, total) => setStatus(`시뮬레이션 중… ${Math.round(100 * done / total)}%${job.fitEa ? " (E_a 맞추는 중)" : ""}`, true, done / total));
		if (res.kind !== "measureSim") return;
		lastSim = res;
		simKey = measureCondKey();
		cardKey = "";
		render(out);
		setStatus(`시뮬레이션 ${((performance.now() - t0) / 1000).toFixed(1)} s`, false);
	} catch (e) {
		if (e instanceof SupersededError) return;
		setStatus(`시뮬레이션 실패: ${(e as Error).message}`, false);
	}
}

function renderMeasureEmpty(): void {
	$("stats").replaceChildren();
	cardKey = "";
	for (const div of cards.values()) purge(div);
	cards.clear();
	const box = $("charts");
	const card = el("div", "card wide empty");
	card.append(
		el("p", "empty-title", "측정 엑셀을 왼쪽에 올리면 여기에 결과가 나옵니다"),
		el("p", "panel-hint", "형식: 파일 하나 = 소자 하나, 시트 하나 = 측정 순서대로 한 스윕 (Sweep Name / Sweep Range / Area Constant / Compliance I, 그 아래 Voltage·Current 열). 파일 이름의 \"6nm\" 같은 글자로 두께를 읽습니다."),
	);
	box.replaceChildren(card);
}

function roleOf(k: SweepKind): MeasuredRole {
	if (k === "forming") return "forming";
	if (k === "set") return "set";
	if (k === "reset") return "reset";
	return "other";
}

function renderMeasure(out: MeasureOutput, stats: HTMLElement): void {
	const sim = lastSim && simKey === measureCondKey() ? lastSim : null;
	const specs: CardSpec[] = [
		{ id: "iv", title: "측정 I-V", sub: sim ? "점선: 역산값으로 계산한 시뮬레이션" : "forming 회색 · SET 파랑 · RESET 주황", wide: true, tall: true },
		{ id: "res", title: "사이클별 저항", sub: "RESET 시작 LRS / SET 시작 HRS, R_L 뺀 값" },
		{ id: "volt", title: "사이클별 스위칭 전압", sub: "V_set (0.9·CC) / V_reset (전류 최대점)" },
		{ id: "russo", title: "RESET 직전 필라멘트 온도", sub: "[C] 식 (5), α·R_L 가정" },
		{ id: "ratio", title: "열저항/저항: 측정 대 모델", sub: "N개 병렬이어도 같은 값 (A43)" },
		{ id: "form", title: "두께별 forming 전압", sub: "올린 모든 파일" },
		{ id: "sens", title: "직렬 저항 민감도", sub: "R_L 가정에 따라 바뀌는 값" },
	];
	specs.unshift({ id: "quality", title: "데이터 품질", sub: "측정 자체의 지표와 가정에 따른 흔들림 (A58)", wide: true });
	if (sim) specs.push({ id: "state", title: "시뮬레이션: RESET 후 / SET 후 필라멘트 형상", sub: "r_b(z)" }, ...timeCards("시뮬레이션 RESET → SET"));
	specs.push({ id: "table", title: "스윕 분류", sub: "분류를 바꾸면 다시 계산", wide: true });
	ensureCards(specs);
	// I-V
	const ivs: MeasuredIv[] = [];
	for (const ses of selectedSessions()) {
		for (const s of ses.sweeps) ivs.push({ v: s.v, i: s.i, role: roleOf(kindOf(s)), label: `${s.file} · ${s.index}번 (${KIND_LABELS[kindOf(s)]})` });
	}
	measuredIvChart(cards.get("iv")!, ivs, sim ? { reset: { v: sim.reset.vApp, i: sim.reset.i }, set: { v: sim.set.vApp, i: sim.set.i } } : undefined);
	// 사이클별 (측정 순서)
	const order = new Map<string, number>();
	let k = 0;
	for (const ses of selectedSessions()) for (const s of ses.sweeps) order.set(swKey(s.file, s.index), ++k);
	const ord = (f: string, i: number): number => order.get(swKey(f, i)) ?? NaN;
	pointsChart(cards.get("res")!, [
		{ name: "R_LRS", x: out.resets.map((r) => ord(r.file, r.index)), y: out.resets.map((r) => r.R0), color: 1, text: out.resets.map((r) => `${r.file} · ${r.index}번`) },
		{ name: "R_HRS", x: out.sets.map((r) => ord(r.file, r.index)), y: out.sets.map((r) => r.rHrs), color: 2, symbol: "square", text: out.sets.map((r) => `${r.file} · ${r.index}번`) },
	], "측정 순서", "저항 (Ω)", { yLog: true, unit: "Ω", xInteger: true });
	pointsChart(cards.get("volt")!, [
		{ name: "V_set", x: out.sets.map((r) => ord(r.file, r.index)), y: out.sets.map((r) => r.vSet), color: 1, text: out.sets.map((r) => `${r.file} · CC ${siFormat(r.cc, "A")}`) },
		{ name: "V_reset", x: out.resets.map((r) => ord(r.file, r.index)), y: out.resets.map((r) => r.vReset), color: 2, symbol: "square", text: out.resets.map((r) => r.file) },
	], "측정 순서", "전압 (V)", { unit: "V", xInteger: true });
	russoChart(cards.get("russo")!, out.resets.map((r) => ({ P: r.P, T: r.T, label: `${r.file} · ${r.index}번` })));
	ratioChart(cards.get("ratio")!, out.curve.phi, out.curve.ratio, out.sens.map((s) => ({ RL: s.RL, ratio: s.ratio })));
	// forming 대 두께 (모든 파일)
	const fx: number[] = [];
	const fy: number[] = [];
	const ft: string[] = [];
	for (const ses of sessions) {
		const f = ses.sweeps.find((x) => kindOf(x) === "forming" && x.r01 > 1e8);
		if (!f || !Number.isFinite(ses.thickness)) continue;
		const hit = f.i.findIndex((x) => Math.abs(x) >= 0.9 * f.cc);
		if (hit < 0) continue;
		fx.push(ses.thickness * 1e9);
		fy.push(Math.abs(f.v[hit]));
		ft.push(ses.file);
	}
	pointsChart(cards.get("form")!, [{ name: "V_forming", x: fx, y: fy, color: 0, text: ft }], "산화막 두께 (nm)", "forming 전압 (V)", { unit: "V" });
	// 데이터 품질 표
	const qdiv = cards.get("quality")!;
	const qt = el("table", "data-table quality-table");
	qt.innerHTML = "<thead><tr><th>지표</th><th>값</th><th>판단</th><th>설명</th></tr></thead>";
	const qb = el("tbody");
	const gradeText: Record<Grade, string> = { good: "좋음", ok: "보통", low: "낮음", info: "참고" };
	for (const row of qualityRows(out.quality, out.sens)) {
		const tr = el("tr");
		const badge = el("span", `grade grade-${row.grade}`, gradeText[row.grade]);
		const td = el("td");
		td.append(badge);
		tr.append(el("td", undefined, row.label), el("td", undefined, row.value), td, el("td", "q-note", row.note));
		qb.append(tr);
	}
	qt.append(qb);
	qdiv.replaceChildren(qt);
	qdiv.classList.add("table-host");
	// 민감도 표
	const sens = cards.get("sens")!;
	const tbl = el("table", "data-table");
	tbl.innerHTML = "<thead><tr><th>R_L (Ω)</th><th>R0 (Ω)</th><th>T_crit (K)</th><th>Rth (K/W)</th><th>Rth/R0</th><th>지름 φ</th><th>개수</th></tr></thead>";
	const tb = el("tbody");
	out.sens.forEach((s, j) => {
		const tr = el("tr", j === out.main ? "main-row" : undefined);
		const cells = [
			`${s.RL}`, s.R0.toFixed(1), s.tCrit.toFixed(0), s.rth.toExponential(2), s.ratio.toPrecision(3),
			Number.isFinite(s.phi) ? `${(s.phi * 1e9).toFixed(1)} nm` : "—", s.separable ? s.N.toFixed(2) : "1 (가정)",
		];
		for (const c of cells) tr.append(el("td", undefined, c));
		tb.append(tr);
	});
	tbl.append(tb);
	sens.replaceChildren(tbl, el("p", "panel-hint", out.sens.some((s) => !s.separable)
		? "측정 Rth/R0가 모델 범위 밖인 줄은 지름과 개수를 나눌 수 없어 필라멘트 1개로 보고 R0로만 지름을 정했습니다 (A43, A53)."
		: "지름은 Rth/R0, 개수는 R0로 정했습니다 (A43)."));
	// 분류 표
	const tdiv = cards.get("table")!;
	const t2 = el("table", "data-table");
	t2.innerHTML = "<thead><tr><th>파일</th><th>#</th><th>분류</th><th>점</th><th>V 끝</th><th>CC</th><th>R(0.1 V)</th></tr></thead>";
	const body = el("tbody");
	const kinds = Object.keys(KIND_LABELS) as SweepKind[];
	for (const ses of selectedSessions()) {
		for (const s of ses.sweeps) {
			const tr = el("tr");
			const sel = el("select");
			for (const kk of kinds) {
				const o = el("option", undefined, KIND_LABELS[kk]);
				o.value = kk;
				if (kk === kindOf(s)) o.selected = true;
				sel.append(o);
			}
			sel.addEventListener("change", () => {
				const v = sel.value as SweepKind;
				if (v === s.kind) kindOverride.delete(swKey(s.file, s.index));
				else kindOverride.set(swKey(s.file, s.index), v);
				schedule(0);
			});
			const td = el("td");
			td.append(sel);
			tr.append(el("td", undefined, s.file), el("td", undefined, String(s.index)), td, el("td", undefined, String(s.v.length)),
				el("td", undefined, `${s.v[s.v.length - 1]}`), el("td", undefined, siFormat(s.cc, "A")), el("td", undefined, Number.isFinite(s.r01) ? siFormat(s.r01, "Ω") : "—"));
			body.append(tr);
		}
	}
	t2.append(body);
	tdiv.replaceChildren(t2);
	tdiv.classList.add("table-scroll");
	sens.classList.add("table-host");
	// 시뮬레이션
	if (sim) {
		const g = sim.set.grid;
		stateProfileChart(cards.get("state")!, g.zFaces, [{ rb: sim.reset.rbEnd, kind: "hrs", cycle: 1 }, { rb: sim.set.rbEnd, kind: "lrs", cycle: 1 }]);
		const j = concatResults([sim.reset, sim.set]);
		drawTime(Array.from(j.t), Array.from(j.vApp), Array.from(j.iCell), Array.from(j.rMin), Array.from(j.T), j.hot, j.grid, true);
	}
	// 요약
	const m = out.sens[out.main];
	const nRes = out.resets.length;
	const nSet = out.sets.length;
	stats.append(
		stat("스윕", `RESET ${nRes} · SET ${nSet}`, `포밍 전 측정 ${out.rPristine.length}개`),
		stat("산화막 비저항", Number.isFinite(out.rhoOx) ? `${out.rhoOx.toExponential(2)} Ω·m` : "—", "포밍 전 0.1 V 저항 (A44)"),
		stat("V_RESET", `${out.vResetMed.toFixed(2)} V`, `I_RESET ${siFormat(out.iResetMed, "A")} (중앙값)`),
		stat("R_LRS", siFormat(m.R0, "Ω"), `R_L ${state.params.RL} Ω 뺀 값`),
		stat("T_crit", `${m.tCrit.toFixed(0)} K`, `Rth ${m.rth.toExponential(2)} K/W`),
		stat("V_SET", `${out.vSetMed.toFixed(2)} V`, "중앙값, HRS에서 시작한 SET"),
		stat("R_HRS", siFormat(out.rHrsMed, "Ω"), Number.isFinite(out.rNeck) ? `잘록 반경 ${(out.rNeck * 1e9).toFixed(2)} nm` : "금속 잘록 구간으로는 설명 안 됨"),
		stat("열 보정 κ_el", Number.isFinite(out.kappaEl) ? `${out.kappaEl.toFixed(0)} W/(K·m)` : "—",
			Number.isFinite(out.kappaEl) ? `측정 Rth에 맞춤${out.kappaEl > 27 || out.kappaEl < 7 ? " · TiN 문헌 7–27 밖 [8], [10]" : ""} (A56)` : "전극층이 없거나 맞출 수 없음"),
		stat("갭 (HRS)", Number.isFinite(out.gap) ? `${(out.gap * 1e9).toFixed(1)} nm` : "—",
			`호핑 [D] 식 (6), g_T ${(state.params.gT * 1e9).toFixed(2)} nm 가정, 굵은 필라멘트 끝 기준 (A55)`),
		stat("필라멘트", Number.isFinite(m.phi) ? `${(m.phi * 1e9).toFixed(0)} nm` : "—", m.separable ? `${m.N.toFixed(1)}개` : "1개로 가정 (개수 분리 불가)"),
	);
	if (sim) {
		let imax = 0;
		for (const x of sim.set.iCell) imax = Math.max(imax, Math.abs(x));
		const out1 = sim.eaEV > 1.2 || sim.eaEV < 0.5;
		let kr = 0;
		for (let q = 1; q < sim.reset.i.length; q++) if (Math.abs(sim.reset.i[q]) > Math.abs(sim.reset.i[kr])) kr = q;
		stats.append(
			stat("시뮬 V_RESET", `${sim.reset.vApp[kr].toFixed(2)} V`, `측정 ${out.vResetMed.toFixed(2)} V · I ${siFormat(Math.abs(sim.reset.i[kr]), "A")}`),
			stat("시뮬 E_a", `${sim.eaEV.toFixed(3)} eV`, sim.fitted ? `V_set에 맞춤${out1 ? " · Table 3 범위 밖" : ""}`
				: Number.isFinite(sim.vNoGrowth) ? `맞추기 실패: 성장 없이도 ${sim.vNoGrowth.toFixed(2)} V에서 CC 도달 (측정 ${out.vSetMed.toFixed(2)} V)` : `입력값${out1 ? " · Table 3 범위 밖" : ""}`),
			stat("시뮬 HRS / LRS", `${siFormat(sim.rHrs, "Ω")} / ${siFormat(sim.rLrs, "Ω")}`, "0.1 V 읽기 (R_L 포함)"),
			stat("SET 순간 필라멘트 전류", siFormat(imax, "A"), state.measure.includeCp ? "C_P 방전 포함" : "C_P 없음"),
		);
	}
}

// ---------------------------------------------------------------- 내보내기
function lastGrid(out: TransientOutput): Grid {
	return out.cycles[out.cycles.length - 1].grid;
}

function setupExport(): void {
	$("csv").addEventListener("click", () => {
		if (lastOut) downloadCsv(`rram_${lastMode}.csv`, resultCsv(lastOut));
	});
	$("csv-summary").addEventListener("click", () => {
		if (lastOut && lastOut.kind === "transient") downloadCsv(`rram_${lastMode}_summary.csv`, summaryCsv(lastOut.summary, lastGrid(lastOut)));
	});
	$("csv-state").addEventListener("click", () => {
		if (lastOut && lastOut.kind === "transient") downloadCsv(`rram_${lastMode}_state.csv`, stateCsv(lastOut.summary, lastGrid(lastOut)));
	});
	$("cancel").addEventListener("click", () => {
		client.cancel();
		setStatus("계산을 취소했습니다", false);
	});
}

// ---------------------------------------------------------------- 시작
setupTheme();
buildModes();
buildWave();
buildVariability();
buildParams();
setupExport();
schedule(0);
