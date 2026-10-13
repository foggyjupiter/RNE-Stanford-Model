// 앱 진입점: 화면 구성, 상태 → 작업 변환, 계산 예약, 결과 렌더링.

import "./styles.css";
import { DEFAULT, DEFAULT_VARIABILITY, cfWidthFromArea, filamentCount, readResistance, type Job, type JobOutput, type Params, type SimResult, type TransientOutput } from "./model";
import { ModelClient, SupersededError } from "./model/client";
import { downloadPng, histogramChart, ivChart, purge, readChart, stateChart, timeChart } from "./ui/charts";
import { el, makeField, makeSegmented, makeSwitch, type Field } from "./ui/controls";
import { downloadCsv, resultCsv, summaryCsv } from "./ui/export";
import { meanStd, median, siFormat, timeUnit } from "./ui/format";
import { NOISE_FIELDS, PARAM_GROUPS, VAR_FIELDS, type ParamMeta } from "./ui/meta";
import { DEFAULT_FIXED, DEFAULT_PULSE, DEFAULT_SEQUENCE, DEFAULT_SWEEP, MAX_CYCLES, MODE_LABELS, VARIABILITY_CYCLES, initHrs, initLrs, initialState, type Mode } from "./ui/state";

const state = initialState();
const client = new ModelClient();
let lastOut: JobOutput | null = null;
let lastMode: Mode = state.mode;
let timer: number | undefined;
const DEBOUNCE_MS = 200;	// 슬라이더 드래그 중 재계산 간격 [ms]

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
	const nav = $("modes");
	const seg = makeSegmented<Mode>("시뮬레이션 모드", (Object.keys(MODE_LABELS) as Mode[]).map((m) => [m, MODE_LABELS[m]]), () => state.mode, (m) => {
		state.mode = m;
		buildWave();
		buildVariability();
		schedule(0);
	});
	nav.replaceChildren(seg.el);
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
	return numField("cycles", "N<sub>cyc</sub>", "사이클 수", "", 1, MAX_CYCLES, 1, get, (v) => set(Math.max(1, Math.min(MAX_CYCLES, Math.round(v)))), { integer: true, note: "2회째부터 근사 (A16)" });
}

function buildWave(): void {
	const box = $("wave");
	const s = section("파형", waveHint());
	const add = (f: Field): void => {
		waveFields.push(f);
		s.append(f.el);
	};
	waveFields = [];
	if (state.mode === "sweep") {
		const w = state.sweep;
		add(numField("vSet", "V<sub>SET,max</sub>", "양의 최대 전압", "V", 0.5, 3.5, 1, () => w.vSet, (v) => (w.vSet = v)));
		add(numField("vReset", "V<sub>RESET,max</sub>", "음의 최대 전압", "V", -3.5, -0.5, 1, () => w.vReset, (v) => (w.vReset = v)));
		add(numField("tRamp", "t<sub>ramp</sub>", "구간당 램프 시간", "µs", 1, 10000, 1e-6, () => w.tRamp, (v) => (w.tRamp = v), { log: true }));
		add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항 (RESET 방향은 0 Ω)", "kΩ", 1, 100, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
		add(cyclesField(() => w.cycles, (v) => (w.cycles = v)));
	} else if (state.mode === "pulse") {
		const w = state.pulse;
		const pol = makeSegmented<"set" | "reset">("펄스 극성", [["set", "SET (+)"], ["reset", "RESET (−)"]], () => w.polarity, (v) => {
			w.polarity = v;
			const hint = s.querySelector(".panel-hint");
			if (hint) hint.textContent = waveHint();
			schedule(0);
		});
		pol.el.classList.add("seg-block");
		add(pol);
		add(numField("amp", "|V<sub>p</sub>|", "펄스 진폭", "V", 0.5, 3.5, 1, () => w.amplitude, (v) => (w.amplitude = v)));
		add(numField("width", "t<sub>w</sub>", "펄스 폭 (평탄부)", "ns", 1, 10000, 1e-9, () => w.width, (v) => (w.width = v), { log: true }));
		add(numField("edge", "t<sub>edge</sub>", "상승/하강 시간", "ns", 1, 50, 1e-9, () => w.tEdge, (v) => (w.tEdge = v)));
		add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항 (RESET 방향은 0 Ω)", "kΩ", 1, 100, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
	} else if (state.mode === "sequence") {
		const w = state.sequence;
		add(numField("setV", "V<sub>SET</sub>", "SET 펄스 진폭", "V", 0.5, 3.5, 1, () => w.setV, (v) => (w.setV = v)));
		add(numField("setW", "t<sub>SET</sub>", "SET 펄스 폭", "ns", 1, 10000, 1e-9, () => w.setWidth, (v) => (w.setWidth = v), { log: true }));
		add(numField("resetV", "V<sub>RESET</sub>", "RESET 펄스 진폭", "V", -3.5, -0.5, 1, () => w.resetV, (v) => (w.resetV = v)));
		add(numField("resetW", "t<sub>RESET</sub>", "RESET 펄스 폭", "ns", 1, 10000, 1e-9, () => w.resetWidth, (v) => (w.resetWidth = v), { log: true }));
		add(numField("readV", "V<sub>read</sub>", "읽기 전압", "V", 0.05, 0.5, 1, () => w.readV, (v) => (w.readV = v)));
		add(numField("readW", "t<sub>read</sub>", "읽기 펄스 폭", "ns", 10, 1000, 1e-9, () => w.readWidth, (v) => (w.readWidth = v), { log: true }));
		add(numField("edge", "t<sub>edge</sub>", "상승/하강 시간", "ns", 1, 50, 1e-9, () => w.tEdge, (v) => (w.tEdge = v)));
		add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항 (RESET·읽기는 0 Ω)", "kΩ", 1, 100, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
		add(cyclesField(() => w.cycles, (v) => (w.cycles = v)));
	} else {
		const w = state.fixed;
		add(numField("fx", "x", "갭 크기", "nm", 0, state.params.L0 * 1e9, 1e-9, () => w.x, (v) => (w.x = Math.max(0, v))));
		const aMax = Math.PI * state.params.WCF ** 2 / 4;	// w = WCF일 때의 면적 [m^2]
		add(numField("fa", "A<sub>CF</sub>", "필라멘트 면적 (π w²/4, A1)", "nm²", 0.1, aMax * 1e18, 1e-18, () => w.aCf, (v) => (w.aCf = Math.max(1e-21, v))));
		add(numField("fv", "V<sub>max</sub>", "스윕 범위 ±", "V", 0.1, 1.5, 1, () => w.vMax, (v) => (w.vMax = v)));
	}
	const reset = el("button", "link-btn", "파형 기본값");
	reset.type = "button";
	reset.addEventListener("click", () => {
		if (state.mode === "sweep") state.sweep = { ...DEFAULT_SWEEP };
		else if (state.mode === "pulse") state.pulse = { ...DEFAULT_PULSE };
		else if (state.mode === "sequence") state.sequence = { ...DEFAULT_SEQUENCE };
		else state.fixed = { ...DEFAULT_FIXED };
		buildWave();
		schedule(0);
	});
	s.querySelector(".panel-head")!.append(reset);
	box.replaceChildren(s);
}

function waveHint(): string {
	if (state.mode === "sweep") return "0 → +V → 0 → −V → 0 삼각파. 초기 상태 HRS (x₀ = L₀, w₀ = 0.5 nm)";
	if (state.mode === "pulse") return state.pulse.polarity === "set" ? "사다리꼴 펄스. 초기 상태 HRS (x₀ = L₀, w₀ = 0.5 nm), C_P 포함" : "사다리꼴 펄스. 초기 상태 LRS (x₀ = 0, w₀ = W_CF), C_P 포함";
	if (state.mode === "sequence") return "사이클마다 SET → 읽기 → RESET → 읽기. 기본값은 창 ~70배가 나오는 조건 (A21)";
	return "갭과 필라멘트 면적을 직접 정하고 스위칭 없이 읽기 I-V를 본다";
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
	const s = section("변동성", state.mode === "sweep" ? "사이클마다 Ea·Ei·Eh 재추출 (식 10–11) + 갭·폭 잡음 χ(t) (식 8–9)" : "사이클마다 Ea·Ei·Eh 재추출 (식 10–11). 펄스에서 χ(t)는 생략 (A23)");
	const sw = makeSwitch("변동성 켜기", () => state.variabilityOn, (on) => {
		state.variabilityOn = on;
		const cyc = state.mode === "sweep" ? state.sweep : state.sequence;
		if (on && cyc.cycles < 2) cyc.cycles = VARIABILITY_CYCLES;
		for (const f of waveFields) f.refresh();
		body.hidden = !on;
		schedule(0);
	});
	s.append(sw.el);
	const body = el("div", "panel-body");
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
	if (state.mode === "sweep") {
		for (const m of NOISE_FIELDS) {
			const f = paramField(m);
			varFields.push(f);
			body.append(f.el);
		}
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
		state.params.deltaGap = DEFAULT.deltaGap;
		state.params.deltaCF = DEFAULT.deltaCF;
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

function paramField(m: ParamMeta): Field {
	return makeField({
		id: m.key, symbol: m.symbol, label: m.label, unit: m.unit, min: m.min, max: m.max, log: m.log, fixed: m.fixed, note: m.note,
		get: () => state.params[m.key] / m.scale,
		set: (v) => {
			state.params[m.key] = v * m.scale;
			if (m.key === "nF" || m.key === "aCell") updateCount();
			if (m.key === "L0" || m.key === "WCF") {
				if (state.mode === "fixed") buildWave();
			}
			schedule();
		},
	});
}

let countEl: HTMLElement | null = null;

function updateCount(): void {
	if (countEl) countEl.innerHTML = `N = <strong>${filamentCount(state.params).toLocaleString("ko-KR")}</strong>개`;
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
		for (const f of varFields) f.refresh();
		updateCount();
		if (state.mode === "fixed") buildWave();
		schedule(0);
	});
	head.append(resetAll);
	box.replaceChildren(head);
	paramFields.length = 0;
	PARAM_GROUPS.forEach((g, gi) => {
		const d = el("details", "group");
		d.open = gi < 2;
		const sum = el("summary");
		sum.append(el("span", "group-title", g.title));
		if (g.hint) sum.append(el("span", "group-hint", g.hint));
		d.append(sum);
		const fields = g.items.map((m) => {
			const f = paramField(m);
			paramFields.push(f);
			d.append(f.el);
			return f;
		});
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
function currentJob(): Job {
	const p: Params = { ...state.params };
	const variability = state.variabilityOn ? { ...state.variability } : undefined;
	if (state.mode === "sweep") {
		const w = state.sweep;
		const [x0, w0] = initHrs(p);
		const tEnd = 4 * w.tRamp;
		return {
			kind: "transient",
			wave: { kind: "sweep", vSet: w.vSet, vReset: w.vReset, tRamp: w.tRamp },
			x0, w0, params: p,
			// 잡음 유지 시간: 0.2 µs (A12), 단 긴 램프에서는 전체/2000으로 늘려 계산량을 묶는다
			opt: { rs: w.rs, rsReset: 0, noiseDt: variability ? Math.max(0.2e-6, tEnd / 2000) : undefined },
			cycles: w.cycles,
			variability,
			seed: state.seed,
		};
	}
	if (state.mode === "pulse") {
		const w = state.pulse;
		const [x0, w0] = w.polarity === "set" ? initHrs(p) : initLrs(p);
		const v = w.polarity === "set" ? w.amplitude : -w.amplitude;
		const tEnd = w.width + 2 * w.tEdge;
		return {
			kind: "transient",
			wave: { kind: "pulse", vPulse: v, tEdge: w.tEdge, tWidth: w.width, tTotal: tEnd },
			x0, w0, params: p,
			opt: { rs: w.rs, rsReset: 0, includeCp: true, maxStep: Math.max(0.1e-9, tEnd / 2000) },
			cycles: 1,
		};
	}
	if (state.mode === "sequence") {
		const w = state.sequence;
		const [x0, w0] = initHrs(p);
		return {
			kind: "sequence",
			set: { v: w.setV, width: w.setWidth },
			reset: { v: w.resetV, width: w.resetWidth },
			read: { v: w.readV, width: w.readWidth },
			tEdge: w.tEdge,
			rs: w.rs,
			x0, w0, params: p,
			cycles: w.cycles,
			variability,
			seed: state.seed,
		};
	}
	const f = state.fixed;
	const n = 201;
	const v = Array.from({ length: n }, (_, k) => -f.vMax + 2 * f.vMax * k / (n - 1));
	return { kind: "fixed", v, x: Math.min(f.x, p.L0), aCf: f.aCf, params: p };
}

// ---------------------------------------------------------------- 계산 예약 / 진행 표시
function schedule(delay = DEBOUNCE_MS): void {
	window.clearTimeout(timer);
	timer = window.setTimeout(compute, delay);
}

function setStatus(text: string, busy: boolean, progress?: number): void {
	const st = $("status");
	st.classList.toggle("busy", busy);
	$("status-text").textContent = text;
	const bar = $("progress");
	bar.hidden = progress === undefined;
	if (progress !== undefined) {
		bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
		($("progress-fill") as HTMLElement).style.width = `${(progress * 100).toFixed(1)}%`;
	}
	$("cancel").hidden = !busy;
}

async function compute(): Promise<void> {
	const job = currentJob();
	const mode = state.mode;
	const cycles = job.kind === "fixed" ? 1 : job.cycles;
	const t0 = performance.now();
	setStatus(cycles > 1 ? `계산 중… 0 / ${cycles} 사이클` : "계산 중…", true, cycles > 1 ? 0 : undefined);
	try {
		const out = await client.run(job, (done, total) => {
			setStatus(`계산 중… ${done} / ${total} 사이클`, true, done / total);
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

// 여러 사이클을 시간축으로 이어 붙인다 (쓰기-읽기 시퀀스 표시용)
function joinCycles(cs: SimResult[]): { t: number[]; v: number[]; i: number[]; x: number[]; w: number[] } {
	const o = { t: [] as number[], v: [] as number[], i: [] as number[], x: [] as number[], w: [] as number[] };
	let off = 0;
	for (const r of cs) {
		for (let k = 0; k < r.t.length; k++) {
			o.t.push(r.t[k] + off);
			o.v.push(r.vApp[k]);
			o.i.push(r.i[k]);
			o.x.push(r.x[k]);
			o.w.push(r.w[k]);
		}
		off += r.t[r.t.length - 1];
	}
	return o;
}

function render(out: JobOutput): void {
	const stats = $("stats");
	stats.replaceChildren();
	const note = $("note");
	note.hidden = true;
	$("csv-summary").hidden = out.kind === "fixed" || lastMode === "pulse";
	if (out.kind === "fixed") {
		renderFixed(out.v, out.i, stats);
		return;
	}
	if (lastMode === "sweep") renderSweep(out, stats);
	else if (lastMode === "pulse") renderPulse(out, stats);
	else renderSequence(out, stats);
	if (out.cycles.length > 1) {
		note.hidden = false;
		note.textContent = "RESET 중 필라멘트 폭 변화식이 근거 논문에 없어 폭이 유지됩니다. 2번째 사이클부터의 거동은 근사입니다 (A16).";
	}
}

function renderSweep(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "iv", title: "I-V", sub: multi ? `${n}개 사이클 겹침` : "|I|, 로그 눈금", wide: true, tall: true }];
	if (multi) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: "0.2 V 읽기", wide: true });
	specs.push({ id: "v", title: "인가 전압", sub: multi ? "마지막 사이클" : undefined }, { id: "i", title: "전류", sub: multi ? "마지막 사이클, |I| 로그" : "|I|, 로그 눈금" }, { id: "state", title: "상태 변수", sub: multi ? "마지막 사이클" : "갭 x, CF 폭 w", wide: true });
	ensureCards(specs);
	ivChart(cards.get("iv")!, out.cycles.map((r) => ({ v: r.vApp, i: r.i })));
	const last = out.cycles[n - 1];
	const tu = timeUnit(last.t[last.t.length - 1]);
	timeChart(cards.get("v")!, last.t, last.vApp, { tScale: tu.scale, tLabel: tu.label, yTitle: "전압 (V)", unit: "V" });
	timeChart(cards.get("i")!, last.t, last.i, { tScale: tu.scale, tLabel: tu.label, yTitle: "|전류| (A)", unit: "A", yLog: true, absolute: true });
	stateChart(cards.get("state")!, last.t, last.x, last.w, tu.scale, tu.label);
	const lrs = out.summary.map((s) => s.rLrs);
	const hrs = out.summary.map((s) => s.rEnd);
	const vset = out.summary.map((s) => s.vSet);
	const vreset = out.summary.map((s) => s.vReset);
	if (multi) {
		histogramChart(cards.get("hist")!, lrs, hrs);
		const [ms, ss] = meanStd(vset);
		const [mr, sr] = meanStd(vreset);
		stats.append(
			stat("V_SET", `${ms.toFixed(2)} ± ${ss.toFixed(2)} V`, "평균 ± 표준편차"),
			stat("V_RESET", `${mr.toFixed(2)} ± ${sr.toFixed(2)} V`, "|I| 최대 지점"),
			stat("R_LRS", siFormat(median(lrs), "Ω"), "중앙값"),
			stat("R_HRS", siFormat(median(hrs), "Ω"), "중앙값"),
			stat("HRS / LRS", ratio(median(hrs) / median(lrs))),
		);
	} else {
		const s = out.summary[0];
		stats.append(
			stat("V_SET", `${s.vSet.toFixed(2)} V`, "갭 < a 되는 전압"),
			stat("V_RESET", `${s.vReset.toFixed(2)} V`, "|I| 최대 지점"),
			stat("R_LRS", siFormat(s.rLrs, "Ω"), "0.2 V 읽기"),
			stat("R_HRS", siFormat(s.rEnd, "Ω"), "0.2 V 읽기"),
			stat("HRS / LRS", ratio(s.rEnd / s.rLrs)),
			stat("T_max", `${Math.max(...last.T).toFixed(0)} K`),
		);
	}
}

function renderPulse(out: TransientOutput, stats: HTMLElement): void {
	const r = out.cycles[0];
	const isSet = state.pulse.polarity === "set";
	ensureCards([
		{ id: "v", title: "인가 전압" },
		{ id: "i", title: "전류", sub: "단자 전류, C_P 충전 포함" },
		{ id: "state", title: "상태 변수", sub: "갭 x, CF 폭 w", wide: true },
	]);
	const tu = timeUnit(r.t[r.t.length - 1]);
	timeChart(cards.get("v")!, r.t, r.vApp, { tScale: tu.scale, tLabel: tu.label, yTitle: "전압 (V)", unit: "V" });
	timeChart(cards.get("i")!, r.t, r.i, { tScale: tu.scale, tLabel: tu.label, yTitle: "전류 (µA)", unit: "A", yScale: 1e6 });
	stateChart(cards.get("state")!, r.t, r.x, r.w, tu.scale, tu.label);
	const p = state.params;
	const before = readResistance(r.x[0], r.w[0], p);
	const after = out.summary[0].rEnd;
	let peak = 0;
	for (let k = 0; k < r.i.length; k++) peak = Math.max(peak, Math.abs(r.i[k]));
	stats.append(
		stat("R 펄스 전", siFormat(before, "Ω"), "0.2 V 읽기"),
		stat("R 펄스 후", siFormat(after, "Ω"), "0.2 V 읽기"),
		stat("변화", ratio(isSet ? before / after : after / before), isSet ? "R 감소" : "R 증가"),
		stat("|I| 최대", siFormat(peak, "A")),
		stat("T_max", `${Math.max(...r.T).toFixed(0)} K`),
	);
	if (isSet) {
		let k = 0;
		while (k < r.x.length && r.x[k] >= p.a) k++;
		stats.append(stat("갭 닫힘", k < r.x.length ? siFormat(r.t[k], "s") : "닫히지 않음", "x < a"));
	}
}

function renderSequence(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "read", title: "읽기 저항", sub: `사이클마다 SET 후 / RESET 후, ${state.sequence.readV} V`, wide: true }];
	if (multi && state.variabilityOn) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: `${state.sequence.readV} V 읽기`, wide: true });
	specs.push({ id: "v", title: "인가 전압", sub: multi ? `${n}개 사이클 연속` : undefined }, { id: "i", title: "전류", sub: "|I|, 로그 눈금" }, { id: "state", title: "상태 변수", sub: "갭 x, CF 폭 w", wide: true });
	ensureCards(specs);
	const lrs = out.summary.map((s) => s.rLrs);
	const hrs = out.summary.map((s) => s.rEnd);
	readChart(cards.get("read")!, lrs, hrs);
	if (cards.has("hist")) histogramChart(cards.get("hist")!, lrs, hrs);
	const j = joinCycles(out.cycles);
	const tu = timeUnit(j.t[j.t.length - 1]);
	timeChart(cards.get("v")!, j.t, j.v, { tScale: tu.scale, tLabel: tu.label, yTitle: "전압 (V)", unit: "V" });
	timeChart(cards.get("i")!, j.t, j.i, { tScale: tu.scale, tLabel: tu.label, yTitle: "|전류| (A)", unit: "A", yLog: true, absolute: true });
	stateChart(cards.get("state")!, j.t, j.x, j.w, tu.scale, tu.label);
	const mL = median(lrs);
	const mH = median(hrs);
	stats.append(
		stat("R_LRS", siFormat(mL, "Ω"), multi ? "중앙값" : "SET 후 읽기"),
		stat("R_HRS", siFormat(mH, "Ω"), multi ? "중앙값" : "RESET 후 읽기"),
		stat("HRS / LRS", ratio(mH / mL)),
		stat("T_max", `${Math.max(...out.cycles.map((c) => Math.max(...c.T))).toFixed(0)} K`),
	);
}

function renderFixed(v: Float64Array, i: Float64Array, stats: HTMLElement): void {
	ensureCards([{ id: "iv", title: "읽기 I-V", sub: "고정 상태, 스위칭 없음", wide: true, tall: true }]);
	ivChart(cards.get("iv")!, [{ v, i }], 1e-15);
	const p = state.params;
	const f = state.fixed;
	const w = cfWidthFromArea(f.aCf);
	stats.append(
		stat("R (0.2 V)", siFormat(readResistance(Math.min(f.x, p.L0), w, p, 0.2), "Ω"), "R_L 포함"),
		stat("CF 지름 w", `${(w * 1e9).toFixed(2)} nm`, "√(4A/π)"),
		stat("필라멘트 수 N", filamentCount(p).toLocaleString("ko-KR")),
		stat(`I (${f.vMax} V)`, siFormat(i[i.length - 1], "A")),
	);
	if (w > p.WCF) stats.append(stat("주의", "w > W_CF", "면적이 스위칭층 폭보다 큼"));
}

// ---------------------------------------------------------------- 내보내기
function setupExport(): void {
	$("csv").addEventListener("click", () => {
		if (lastOut) downloadCsv(`rram_${lastMode}.csv`, resultCsv(lastOut));
	});
	$("csv-summary").addEventListener("click", () => {
		if (lastOut && lastOut.kind === "transient") downloadCsv(`rram_${lastMode}_summary.csv`, summaryCsv(lastOut.summary));
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
