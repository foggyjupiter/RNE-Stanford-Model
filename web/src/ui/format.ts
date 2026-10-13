// 숫자 표시 도우미.

const PREFIXES: [number, string][] = [
	[1e9, "G"],
	[1e6, "M"],
	[1e3, "k"],
	[1, ""],
	[1e-3, "m"],
	[1e-6, "µ"],
	[1e-9, "n"],
	[1e-12, "p"],
	[1e-15, "f"],
];

// SI 접두어를 붙인 문자열. 예: siFormat(1.1e6, "Ω") → "1.10 MΩ"
export function siFormat(v: number, unit: string, digits = 3): string {
	if (!Number.isFinite(v)) return "—";
	if (v === 0) return `0 ${unit}`;
	const a = Math.abs(v);
	for (const [f, p] of PREFIXES) {
		if (a >= f * 0.9995) return `${(v / f).toPrecision(digits)} ${p}${unit}`;
	}
	return `${v.toExponential(digits - 1)} ${unit}`;
}

// 입력 칸에 쓸 짧은 숫자 표기
export function shortNumber(v: number): string {
	if (!Number.isFinite(v)) return "";
	if (v === 0) return "0";
	const a = Math.abs(v);
	if (a >= 1e5 || a < 1e-3) return v.toExponential(3).replace(/\.?0+e/, "e");
	return String(Number(v.toPrecision(4)));
}

// 시간축 단위 선택: 전체 길이에 맞춰 s / ms / µs / ns
export function timeUnit(tEnd: number): { scale: number; label: string } {
	if (tEnd >= 1e-1) return { scale: 1, label: "s" };
	if (tEnd >= 1e-4) return { scale: 1e3, label: "ms" };
	if (tEnd >= 1e-7) return { scale: 1e6, label: "µs" };
	return { scale: 1e9, label: "ns" };
}

export function median(xs: number[]): number {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	if (s.length === 0) return NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export function meanStd(xs: number[]): [number, number] {
	const s = xs.filter(Number.isFinite);
	if (s.length === 0) return [NaN, NaN];
	const mu = s.reduce((a, b) => a + b, 0) / s.length;
	const v = s.reduce((a, b) => a + (b - mu) * (b - mu), 0) / s.length;
	return [mu, Math.sqrt(v)];
}
