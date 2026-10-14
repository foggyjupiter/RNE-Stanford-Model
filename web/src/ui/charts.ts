// Plotly 차트 래퍼. 색은 CSS 변수(라이트/다크 테마)에서 읽는다.
// 색 역할: series-1(파랑) = 전류, x, LRS / series-2(주황) = w, HRS. 이중 y축은 쓰지 않는다.

import Plotly from "plotly.js-dist-min";
import { siFormat } from "./format";

interface Theme {
	text: string;
	text2: string;
	muted: string;
	grid: string;
	axis: string;
	s1: string;
	s2: string;
	font: string;
}

function theme(): Theme {
	const cs = getComputedStyle(document.documentElement);
	const v = (n: string): string => cs.getPropertyValue(n).trim();
	return {
		text: v("--text"),
		text2: v("--text-2"),
		muted: v("--text-3"),
		grid: v("--grid"),
		axis: v("--axis"),
		s1: v("--series-1"),
		s2: v("--series-2"),
		font: v("--font"),
	};
}

const CONFIG: Partial<Plotly.Config> = {
	displaylogo: false,
	responsive: true,
	modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines", "hoverClosestCartesian", "hoverCompareCartesian", "toImage"],
};

interface AxisOpt {
	title: string;
	log?: boolean;
	range?: [number, number];
	tickvals?: number[];
	ticktext?: string[];
	integer?: boolean;	// 개수 축: 정수 눈금만
	dtick?: number;
}

function axis(t: Theme, o: AxisOpt): Partial<Plotly.LayoutAxis> {
	return {
		title: { text: o.title, font: { size: 12, color: t.text2 }, standoff: 8 },
		type: o.log ? "log" : "linear",
		range: o.range,
		tickvals: o.tickvals,
		ticktext: o.ticktext,
		dtick: o.dtick,
		tickformat: o.integer ? "d" : undefined,
		rangemode: o.integer ? "tozero" : undefined,
		exponentformat: "power",
		gridcolor: t.grid,
		zeroline: false,
		linecolor: t.axis,
		tickcolor: t.axis,
		ticks: "outside",
		ticklen: 4,
		tickfont: { size: 11, color: t.muted },
		automargin: true,
	};
}

function layout(t: Theme, x: AxisOpt, y: AxisOpt, extra: Partial<Plotly.Layout> = {}): Partial<Plotly.Layout> {
	return {
		paper_bgcolor: "rgba(0,0,0,0)",
		plot_bgcolor: "rgba(0,0,0,0)",
		font: { family: t.font, color: t.text, size: 12 },
		margin: { l: 56, r: 16, t: 12, b: 44 },
		xaxis: axis(t, x),
		yaxis: axis(t, y),
		showlegend: false,
		hoverlabel: { bgcolor: t.text, font: { color: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(), family: t.font, size: 12 }, bordercolor: t.text },
		legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { size: 12, color: t.text2 } },
		...extra,
	};
}

function draw(div: HTMLElement, data: Plotly.Data[], lay: Partial<Plotly.Layout>): void {
	void Plotly.react(div, data, lay, CONFIG);
}

export function purge(div: HTMLElement): void {
	Plotly.purge(div);
}

export function downloadPng(div: HTMLElement, filename: string): void {
	void Plotly.downloadImage(div, { format: "png", filename, width: div.clientWidth || 800, height: div.clientHeight || 400, scale: 2 } as Plotly.DownloadImgopts);
}

// 로그 축 범위: 0 V 근처의 0에 가까운 전류 때문에 축이 수십 자릿수로 늘어나지 않도록
// 하한을 하위 2% 값보다 반 자릿수 아래로 (단, 최댓값에서 9자릿수 아래보다 내려가지 않게)
function logRange(values: number[]): [number, number] | undefined {
	const pos = values.filter((z) => z > 0 && Number.isFinite(z)).sort((a, b) => a - b);
	if (pos.length === 0) return undefined;
	const hi = Math.log10(pos[pos.length - 1]);
	const p2 = Math.log10(pos[Math.floor(0.02 * (pos.length - 1))]);
	return [Math.max(p2 - 0.5, hi - 9), hi + 0.3];
}

// 여러 사이클을 겹칠 때의 불투명도: 사이클이 많을수록 옅게 해서 겹친 정도가 밀도로 보이게
function overlayOpacity(n: number): number {
	return n <= 1 ? 1 : Math.max(0.18, Math.min(0.6, 2.5 / n));
}

// ---------------------------------------------------------------- I-V (log y)
export interface IvSeries {
	v: ArrayLike<number>;	// [V]
	i: ArrayLike<number>;	// [A]
}

export function ivChart(div: HTMLElement, series: IvSeries[], yFloor = 1e-12): void {
	const t = theme();
	const op = overlayOpacity(series.length);
	const data: Plotly.Data[] = series.map((s, k) => ({
		type: "scattergl",
		mode: "lines",
		x: Array.from(s.v),
		y: Array.from(s.i, (z) => Math.max(Math.abs(z), yFloor)),
		line: { color: t.s1, width: series.length > 1 ? 1.25 : 2 },
		opacity: op,
		name: series.length > 1 ? `사이클 ${k + 1}` : "|I|",
		hovertemplate: `V = %{x:.3f} V<br>|I| = %{customdata}<extra>${series.length > 1 ? `사이클 ${k + 1}` : ""}</extra>`,
		customdata: Array.from(s.i, (z) => siFormat(Math.abs(z), "A")),
	}));
	const all: number[] = [];
	for (const s of series) for (let k = 0; k < s.i.length; k++) all.push(Math.abs(s.i[k]));
	draw(div, data, layout(t, { title: "전압 (V)" }, { title: "|전류| (A)", log: true, range: logRange(all) }, { hovermode: "closest" }));
}

// unipolar 스윕 I-V: RESET 구간과 SET 구간을 색으로 나눠 겹쳐 그린다 (측정 I-V 그림 형식)
export interface SweepIvSeries extends IvSeries {
	split: number;	// SET 구간이 시작하는 인덱스
}

export function sweepIvChart(div: HTMLElement, series: SweepIvSeries[], yFloor = 1e-12): void {
	const t = theme();
	const op = overlayOpacity(series.length);
	const data: Plotly.Data[] = [];
	const part = (s: SweepIvSeries, k: number, a: number, b: number, name: string, color: string): Plotly.Data => ({
		type: "scattergl",
		mode: "lines",
		x: Array.from(s.v).slice(a, b),
		y: Array.from(s.i, (z) => Math.max(Math.abs(z), yFloor)).slice(a, b),
		line: { color, width: series.length > 1 ? 1.25 : 2 },
		opacity: op,
		name,
		legendgroup: name,
		showlegend: k === 0,
		hovertemplate: `V = %{x:.3f} V<br>|I| = %{customdata}<extra>${name}${series.length > 1 ? ` · 사이클 ${k + 1}` : ""}</extra>`,
		customdata: Array.from(s.i, (z) => siFormat(Math.abs(z), "A")).slice(a, b),
	});
	series.forEach((s, k) => {
		data.push(part(s, k, 0, s.split + 1, "RESET", t.s2));
		data.push(part(s, k, s.split, s.v.length, "SET", t.s1));
	});
	const all: number[] = [];
	for (const s of series) for (let k = 0; k < s.i.length; k++) all.push(Math.abs(s.i[k]));
	draw(div, data, layout(t, { title: "전압 (V)" }, { title: "|전류| (A)", log: true, range: logRange(all) }, { hovermode: "closest", showlegend: true, margin: { l: 56, r: 16, t: 28, b: 44 } }));
}

// ---------------------------------------------------------------- 시간축, 단일 계열
export interface TimeOpt {
	tScale: number;
	tLabel: string;
	yTitle: string;
	yLog?: boolean;
	yScale?: number;	// 표시값 = SI × yScale
	unit: string;	// 툴팁 단위 (SI)
	color?: 1 | 2;
	absolute?: boolean;
}

export function timeChart(div: HTMLElement, t: ArrayLike<number>, y: ArrayLike<number>, o: TimeOpt): void {
	const th = theme();
	const ys = o.yScale ?? 1;
	const raw = Array.from(y, (z) => (o.absolute ? Math.abs(z) : z));
	const data: Plotly.Data[] = [{
		type: "scattergl",
		mode: "lines",
		x: Array.from(t, (z) => z * o.tScale),
		y: raw.map((z) => (o.yLog ? Math.max(z, 1e-15) : z * ys)),
		line: { color: o.color === 2 ? th.s2 : th.s1, width: 2 },
		customdata: raw.map((z) => siFormat(z, o.unit)),
		hovertemplate: `%{x:.4g} ${o.tLabel}<br>%{customdata}<extra></extra>`,
	}];
	draw(div, data, layout(th, { title: `시간 (${o.tLabel})` }, { title: o.yTitle, log: o.yLog, range: o.yLog ? logRange(raw) : undefined }, { hovermode: "x" }));
}

// ---------------------------------------------------------------- CF 형상과 온도 분포 (cf. [R] Fig. 2)
// 단일 색상(파랑) 순차 색 척도: 밝음 = 차가움, 어두움 = 뜨거움
const SEQ_BLUE: [number, string][] = [[0, "#cde2fb"], [0.25, "#86b6ef"], [0.5, "#3987e5"], [0.75, "#1c5cab"], [1, "#0d366b"]];

export function profileMapChart(div: HTMLElement, rFaces: ArrayLike<number>, zFaces: ArrayLike<number>, T: ArrayLike<number>, rb: ArrayLike<number>, zc: ArrayLike<number>): void {
	const th = theme();
	const nr = rFaces.length - 1;
	const nz = zFaces.length - 1;
	const rcs: number[] = [];
	for (let i = 0; i < nr; i++) rcs.push(0.5 * (rFaces[i] + rFaces[i + 1]) * 1e9);
	const zcs = Array.from(zc, (z) => z * 1e9);
	const z2: number[][] = [];
	for (let j = 0; j < nz; j++) z2.push(Array.from({ length: nr }, (_, i) => T[j * nr + i]));
	const heat: Plotly.Data = {
		type: "heatmap",
		x: rcs,
		y: zcs,
		z: z2,
		colorscale: SEQ_BLUE as unknown as Plotly.ColorScale,
		colorbar: { title: "T (K)", thickness: 10, outlinewidth: 0, tickfont: { color: th.muted, size: 11 } } as Partial<Plotly.ColorBar>,
		hovertemplate: "r = %{x:.0f} nm, z = %{y:.0f} nm<br>T = %{z:.0f} K<extra></extra>",
	};
	const edge: Plotly.Data = {
		type: "scatter",
		mode: "lines",
		name: "CF 경계",
		x: Array.from(rb, (r) => r * 1e9),
		y: zcs,
		line: { color: th.s2, width: 2.5 },
		hovertemplate: "CF 반경 %{x:.1f} nm<extra></extra>",
	};
	draw(div, [heat, edge], layout(th, { title: "반경 r (nm)" }, { title: "높이 z (nm)" }, { hovermode: "closest" }));
}

// ---------------------------------------------------------------- LRS/HRS 분포 (log10 R 구간)
// 10^d Ω를 "10 kΩ", "1 MΩ" 꼴로
function decadeLabel(d: number): string {
	const prefixes: Record<number, string> = { 0: "", 3: "k", 6: "M", 9: "G" };
	const e3 = Math.max(0, Math.min(9, 3 * Math.floor(d / 3)));
	return `${10 ** (d - e3)} ${prefixes[e3]}Ω`;
}

function decadeTicks(lo: number, hi: number): { vals: number[]; text: string[] } {
	const vals: number[] = [];
	const text: string[] = [];
	for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) {
		vals.push(d);
		text.push(decadeLabel(d));
	}
	return { vals, text };
}

export function histogramChart(div: HTMLElement, lrs: number[], hrs: number[]): void {
	const th = theme();
	const l = lrs.filter((r) => r > 0 && Number.isFinite(r)).map(Math.log10);
	const h = hrs.filter((r) => r > 0 && Number.isFinite(r)).map(Math.log10);
	const all = [...l, ...h];
	const lo = Math.min(...all) - 0.25;
	const hi = Math.max(...all) + 0.25;
	const ticks = decadeTicks(lo, hi);
	const trace = (name: string, xs: number[], color: string): Plotly.Data => ({
		type: "histogram",
		name,
		x: xs,
		xbins: { start: Math.floor(lo * 10) / 10, end: Math.ceil(hi * 10) / 10, size: 0.1 },
		marker: { color, line: { color: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(), width: 1 } },
		opacity: 0.9,
		hovertemplate: `${name}<br>log₁₀R = %{x:.1f}<br>%{y}개 사이클<extra></extra>`,
	});
	draw(div, [trace("LRS", l, th.s1), trace("HRS", h, th.s2)], layout(th, { title: "읽기 저항", range: [lo, hi], tickvals: ticks.vals, ticktext: ticks.text }, { title: "사이클 수", integer: true, dtick: Math.max(l.length, h.length) <= 12 ? 1 : undefined }, {
		barmode: "overlay",
		bargap: 0.08,
		showlegend: true,
		hovermode: "closest",
		margin: { l: 56, r: 16, t: 28, b: 44 },
	}));
}

// ---------------------------------------------------------------- 사이클별 읽기 저항 (쓰기-읽기)
export function readChart(div: HTMLElement, lrs: number[], hrs: number[]): void {
	const th = theme();
	const idx = lrs.map((_, k) => k + 1);
	const pts = (name: string, ys: number[], color: string, symbol: string): Plotly.Data => ({
		type: "scatter",
		mode: idx.length > 1 ? "lines+markers" : "markers",
		name,
		x: idx,
		y: ys,
		line: { color, width: 1.5 },
		marker: { color, size: 9, symbol, line: { color: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(), width: 2 } },
		customdata: ys.map((r) => siFormat(r, "Ω")),
		hovertemplate: `${name} · 사이클 %{x}<br>%{customdata}<extra></extra>`,
	});
	draw(div, [pts("LRS (SET 후)", lrs, th.s1, "circle"), pts("HRS (RESET 후)", hrs, th.s2, "square")], layout(th, { title: "사이클", tickvals: idx.length <= 12 ? idx : undefined }, { title: "읽기 저항 (Ω)", log: true }, {
		showlegend: true,
		hovermode: "closest",
		margin: { l: 56, r: 16, t: 28, b: 44 },
	}));
}

// ---------------------------------------------------------------- 소자 간 몬테카를로
// 읽기 저항 분포 (단일 계열, log10 R 구간)
export function mcHistogramChart(div: HTMLElement, R: ArrayLike<number>): void {
	const th = theme();
	const l = Array.from(R).filter((r) => r > 0 && Number.isFinite(r)).map(Math.log10);
	const lo = Math.min(...l) - 0.15;
	const hi = Math.max(...l) + 0.15;
	const ticks = decadeTicks(lo, hi);
	const size = Math.max((hi - lo) / 30, 0.02);
	const data: Plotly.Data[] = [{
		type: "histogram",
		x: l,
		xbins: { start: lo, end: hi, size },
		marker: { color: th.s1, line: { color: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(), width: 1 } },
		hovertemplate: "log₁₀R = %{x:.2f}<br>%{y}개 소자<extra></extra>",
	}];
	draw(div, data, layout(th, { title: "읽기 저항 (0.1 V)", range: [lo, hi], tickvals: ticks.vals, ticktext: ticks.text }, { title: "소자 수", integer: true }, { bargap: 0.05, hovermode: "closest" }));
}

// 필라멘트 수와 읽기 저항의 관계 (점, 로그 y)
export function mcScatterChart(div: HTMLElement, N: ArrayLike<number>, R: ArrayLike<number>): void {
	const th = theme();
	const xs = Array.from(N);
	const ys = Array.from(R);
	const data: Plotly.Data[] = [{
		type: "scatter",
		mode: "markers",
		x: xs,
		y: ys,
		marker: { color: th.s1, size: 9, opacity: 0.55, line: { color: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(), width: 1 } },
		customdata: ys.map((r) => siFormat(r, "Ω")),
		hovertemplate: "필라멘트 %{x}개<br>%{customdata}<extra></extra>",
	}];
	draw(div, data, layout(th, { title: "소자당 필라멘트 수", integer: true, dtick: 1 }, { title: "읽기 저항 (Ω)", log: true }, { hovermode: "closest" }));
}
