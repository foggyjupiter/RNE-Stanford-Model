// 앱 진입점: 화면 구성, 상태 → 작업 변환, 계산 예약, 결과 렌더링.

import "./styles.css";
import { DEFAULT, DEFAULT_VARIABILITY, filamentCount, type Job, type JobOutput, type FixedOutput, type Params, type SimResult, type TransientOutput } from "./model";
import { ModelClient, SupersededError } from "./model/client";
import { downloadPng, histogramChart, ivChart, profileMapChart, purge, readChart, timeChart } from "./ui/charts";
import { el, makeField, makeSegmented, makeSwitch, type Field } from "./ui/controls";
import { downloadCsv, resultCsv, summaryCsv } from "./ui/export";
import { meanStd, median, siFormat, timeUnit } from "./ui/format";
import { PARAM_GROUPS, VAR_FIELDS, type ParamMeta } from "./ui/meta";
import { DEFAULT_FIXED, DEFAULT_PULSE, DEFAULT_SEQUENCE, DEFAULT_SWEEP, MAX_CYCLES, MODE_LABELS, VARIABILITY_CYCLES, initialState, type Mode } from "./ui/state";

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

function waveHint(): string {
	if (state.mode === "sweep") return "unipolar: 0 → +V_RESET → 0 (제한 없음) → +V_SET → 0 (R_s 직렬). 포밍된 LRS에서 시작";
	if (state.mode === "pulse") return state.pulse.op === "reset" ? "RESET 펄스: 포밍된 LRS에서 시작, 제한 없음, C_P 포함" : "SET 펄스: RESET 스윕 뒤 HRS에서 시작, R_s 직렬, C_P 포함";
	if (state.mode === "sequence") return "사이클마다 RESET 펄스 → 읽기 → SET 펄스 → 읽기. 같은 극성 (A21)";
	return "가운데 잘록 구간의 반경과 길이를 정하고 스위칭 없이 읽기 I-V를 본다";
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
		add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항 (RESET 구간은 0 Ω)", "kΩ", 0.1, 30, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
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
		if (w.op === "set") add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항", "kΩ", 0.1, 30, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
	} else if (state.mode === "sequence") {
		const w = state.sequence;
		add(numField("resetV", "V<sub>RESET</sub>", "RESET 펄스 진폭", "V", 0.5, 5, 1, () => w.resetV, (v) => (w.resetV = v)));
		add(numField("resetW", "t<sub>RESET</sub>", "RESET 펄스 폭", "µs", 0.01, 100, 1e-6, () => w.resetWidth, (v) => (w.resetWidth = v), { log: true }));
		add(numField("setV", "V<sub>SET</sub>", "SET 펄스 진폭", "V", 0.5, 5, 1, () => w.setV, (v) => (w.setV = v)));
		add(numField("setW", "t<sub>SET</sub>", "SET 펄스 폭", "µs", 0.01, 100, 1e-6, () => w.setWidth, (v) => (w.setWidth = v), { log: true }));
		add(numField("readV", "V<sub>read</sub>", "읽기 전압", "V", 0.02, 0.3, 1, () => w.vRead, (v) => (w.vRead = v)));
		add(numField("edge", "t<sub>edge</sub>", "상승/하강 시간", "ns", 1, 100, 1e-9, () => w.tEdge, (v) => (w.tEdge = v)));
		add(numField("rs", "R<sub>s</sub>", "SET 직렬 저항 (RESET은 0 Ω)", "kΩ", 0.1, 30, 1e3, () => w.rs, (v) => (w.rs = v), { log: true, note: "A14" }));
		add(cyclesField(() => w.cycles, (v) => (w.cycles = v)));
	} else {
		const w = state.fixed;
		const p = state.params;
		add(numField("fr", "r<sub>neck</sub>", "잘록 구간 반경", "nm", 0.5, p.phi0 / 2 * 1e9, 1e-9, () => w.rNeck, (v) => (w.rNeck = Math.max(0, v))));
		add(numField("fl", "L<sub>neck</sub>", "잘록 구간 길이", "nm", 0, p.L0 * 1e9, 1e-9, () => w.neckLen, (v) => (w.neckLen = Math.max(0, v))));
		add(numField("fv", "V<sub>max</sub>", "스윕 범위 ±", "V", 0.05, 1, 1, () => w.vMax, (v) => (w.vMax = v)));
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
		return { kind: "sweep", vReset: w.vReset, vSet: w.vSet, tRamp: w.tRamp, rs: w.rs, params: p, cycles: w.cycles, variability, seed: state.seed };
	}
	if (state.mode === "pulse") {
		const w = state.pulse;
		return { kind: "pulse", op: w.op, v: w.amplitude, width: w.width, tEdge: w.tEdge, rs: w.rs, params: p };
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
			params: p,
			cycles: w.cycles,
			variability,
			seed: state.seed,
		};
	}
	const f = state.fixed;
	const n = 41;
	const v = Array.from({ length: n }, (_, k) => -f.vMax + 2 * f.vMax * k / (n - 1));
	return { kind: "fixed", v, rNeck: Math.min(f.rNeck, p.phi0 / 2), neckLen: Math.min(f.neckLen, p.L0), params: p };
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
	const job = currentJob();
	const mode = state.mode;
	const cycles = job.kind === "sweep" || job.kind === "sequence" ? job.cycles : 1;
	const t0 = performance.now();
	setStatus("계산 중…", true, 0);
	try {
		const out = await client.run(job, (done, total) => {
			const label = cycles > 1 ? ` · ${Math.min(Math.floor(done) + 1, total)} / ${total} 사이클` : "";
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
	if (out.kind === "fixed") {
		renderFixed(out, stats);
		return;
	}
	if (lastMode === "sweep") renderSweep(out, stats);
	else if (lastMode === "pulse") renderPulse(out, stats);
	else renderSequence(out, stats);
}

function renderSweep(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "iv", title: "I-V", sub: multi ? `${n}개 사이클 겹침` : "|I|, 로그 눈금", wide: true, tall: true }];
	if (multi) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: "0.1 V 읽기", wide: true });
	specs.push(...timeCards(multi ? "마지막 사이클" : undefined));
	ensureCards(specs);
	ivChart(cards.get("iv")!, out.cycles.map((r) => ({ v: r.vApp, i: r.i })));
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
		);
	} else {
		const c = s[0];
		stats.append(
			stat("V_RESET", `${c.vReset.toFixed(2)} V`, `I_RESET ${siFormat(Math.abs(c.iReset), "A")}`),
			stat("V_SET", Number.isFinite(c.vSet) ? `${c.vSet.toFixed(2)} V` : "—", "R이 1/10로"),
			stat("R_HRS", siFormat(c.rHrs, "Ω"), "RESET 후, 0.1 V"),
			stat("R_LRS", siFormat(c.rLrs, "Ω"), "SET 후, 0.1 V"),
			stat("HRS / LRS", ratio(c.rHrs / c.rLrs)),
			stat("T_max", `${maxOf(last.T).toFixed(0)} K`),
		);
	}
}

function renderPulse(out: TransientOutput, stats: HTMLElement): void {
	const r = out.cycles[0];
	const isSet = state.pulse.op === "set";
	ensureCards(timeCards());
	drawTime(Array.from(r.t), Array.from(r.vApp), Array.from(r.i), Array.from(r.rMin), Array.from(r.T), r.hot, r.grid, false);
	stats.append(
		stat("R 펄스 전", siFormat(out.rStart, "Ω"), isSet ? "RESET 스윕 뒤 HRS" : "포밍된 LRS"),
		stat("R 펄스 후", siFormat(out.rEnd, "Ω"), "0.1 V 읽기"),
		stat("변화", ratio(isSet ? out.rStart / out.rEnd : out.rEnd / out.rStart), isSet ? "R 감소" : "R 증가"),
		stat("|I| 최대", siFormat(maxOf(Array.from(r.i, Math.abs)), "A")),
		stat("T_max", `${maxOf(r.T).toFixed(0)} K`),
	);
}

function renderSequence(out: TransientOutput, stats: HTMLElement): void {
	const n = out.cycles.length;
	const multi = n > 1;
	const specs: CardSpec[] = [{ id: "read", title: "읽기 저항", sub: `사이클마다 RESET 후 / SET 후, ${state.sequence.vRead} V`, wide: true }];
	if (multi && state.variabilityOn) specs.push({ id: "hist", title: "LRS / HRS 분포", sub: `${state.sequence.vRead} V 읽기`, wide: true });
	specs.push(...timeCards(multi ? `${n}개 사이클 연속` : undefined));
	ensureCards(specs);
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
		stat("T_max", `${Math.max(...out.cycles.map((c) => maxOf(c.T))).toFixed(0)} K`),
	);
}

function renderFixed(out: FixedOutput, stats: HTMLElement): void {
	ensureCards([
		{ id: "iv", title: "읽기 I-V", sub: "고정 상태, 스위칭 없음", wide: true, tall: true },
	]);
	ivChart(cards.get("iv")!, [{ v: out.v, i: out.i }], 1e-15);
	const f = state.fixed;
	stats.append(
		stat("R (0.1 V)", siFormat(out.r01, "Ω"), "R_L 포함"),
		stat("잘록 구간 면적", `${(Math.PI * f.rNeck * f.rNeck * 1e18).toFixed(1)} nm²`, "π r²"),
		stat("잘록 구간 길이", `${(f.neckLen * 1e9).toFixed(0)} nm`),
		stat("필라멘트 수 N", filamentCount(state.params).toLocaleString("ko-KR")),
	);
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
