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

// ---------------------------------------------------------------- 상태 변수 x, w (nm)
export function stateChart(div: HTMLElement, t: ArrayLike<number>, x: ArrayLike<number>, w: ArrayLike<number>, tScale: number, tLabel: string): void {
	const th = theme();
	const tt = Array.from(t, (z) => z * tScale);
	const xs = Array.from(x, (z) => z * 1e9);
	const ws = Array.from(w, (z) => z * 1e9);
	const line = (name: string, ys: number[], color: string): Plotly.Data => ({
		type: "scattergl",
		mode: "lines",
		name,
		x: tt,
		y: ys,
		line: { color, width: 2 },
		hovertemplate: `${name} = %{y:.3f} nm<extra></extra>`,
	});
	const last = tt.length - 1;
	// 직접 라벨: 선 오른쪽 끝에 이름 (색만으로 구분하지 않도록)
	const annotations: Partial<Plotly.Annotations>[] = [
		{ x: tt[last], y: xs[last], text: "x", showarrow: false, xanchor: "left", xshift: 6, font: { color: th.text2, size: 12 } },
		{ x: tt[last], y: ws[last], text: "w", showarrow: false, xanchor: "left", xshift: 6, font: { color: th.text2, size: 12 } },
	];
	draw(div, [line("갭 x", xs, th.s1), line("CF 폭 w", ws, th.s2)], layout(th, { title: `시간 (${tLabel})` }, { title: "길이 (nm)", range: [-0.2, Math.max(...xs, ...ws) * 1.08 + 0.1] }, {
		hovermode: "x unified",
		showlegend: true,
		annotations,
		margin: { l: 56, r: 28, t: 28, b: 44 },
	}));
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
