// 입력 컨트롤: 슬라이더 + 숫자 입력 한 줄, 선택 버튼, 스위치.

import { shortNumber } from "./format";

export interface FieldSpec {
	id: string;
	symbol: string;	// HTML
	label: string;
	unit: string;
	min: number;	// 표시 단위
	max: number;	// 표시 단위
	log?: boolean;
	fixed?: boolean;	// 슬라이더 없이 숫자 입력만
	integer?: boolean;
	note?: string;
	get: () => number;	// 표시 단위 값
	set: (v: number) => void;	// 표시 단위 값
}

export interface Field {
	el: HTMLElement;
	refresh: () => void;	// 상태가 바깥에서 바뀌었을 때 화면 갱신
}

const SLIDER_STEPS = 1000;

function toSlider(v: number, s: FieldSpec): number {
	if (s.log) {
		const lo = Math.log10(s.min);
		const hi = Math.log10(s.max);
		return Math.round((Math.log10(Math.max(v, s.min)) - lo) / (hi - lo) * SLIDER_STEPS);
	}
	return Math.round((v - s.min) / (s.max - s.min) * SLIDER_STEPS);
}

function fromSlider(pos: number, s: FieldSpec): number {
	const u = pos / SLIDER_STEPS;
	let v = s.log ? 10 ** (Math.log10(s.min) + u * (Math.log10(s.max) - Math.log10(s.min))) : s.min + u * (s.max - s.min);
	if (s.integer) v = Math.round(v);
	else v = Number(v.toPrecision(4));
	return v;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (html !== undefined) e.innerHTML = html;
	return e;
}

export function makeField(s: FieldSpec): Field {
	const row = el("div", "field");
	const head = el("div", "field-head");
	const name = el("label", "field-name");
	name.htmlFor = `in-${s.id}`;
	name.innerHTML = `<span class="sym">${s.symbol}</span><span class="desc">${s.label}</span>`;
	head.append(name);
	if (s.note) head.append(el("span", "tag", s.note));
	row.append(head);

	const body = el("div", "field-body");
	let slider: HTMLInputElement | null = null;
	if (!s.fixed) {
		slider = el("input", "slider");
		slider.type = "range";
		slider.min = "0";
		slider.max = String(SLIDER_STEPS);
		slider.step = "1";
		slider.setAttribute("aria-label", s.label);
		body.append(slider);
	} else {
		body.append(el("span", "fixed-hint", "Table 3 권장값"));
	}
	const numWrap = el("div", "num");
	const num = el("input", "num-input");
	num.id = `in-${s.id}`;
	num.type = "text";
	num.inputMode = "decimal";
	num.spellcheck = false;
	numWrap.append(num);
	if (s.unit) numWrap.append(el("span", "unit", s.unit));
	body.append(numWrap);
	row.append(body);

	const range = el("div", "field-range", s.fixed ? "" : `${shortNumber(s.min)} – ${shortNumber(s.max)}`);
	row.append(range);

	const refresh = (): void => {
		const v = s.get();
		if (slider) slider.value = String(toSlider(v, s));
		if (document.activeElement !== num) num.value = shortNumber(v);
		row.classList.toggle("out", v < s.min * (1 - 1e-9) || v > s.max * (1 + 1e-9));
	};

	slider?.addEventListener("input", () => {
		s.set(fromSlider(Number(slider!.value), s));
		refresh();
	});
	const commit = (): void => {
		const v = Number(num.value.trim());
		if (num.value.trim() === "" || !Number.isFinite(v) || (s.log && v <= 0)) {
			num.value = shortNumber(s.get());
			return;
		}
		s.set(s.integer ? Math.round(v) : v);
		refresh();
	};
	num.addEventListener("change", commit);
	num.addEventListener("keydown", (e) => {
		if (e.key === "Enter") num.blur();
	});
	num.addEventListener("blur", () => {
		num.value = shortNumber(s.get());
	});
	refresh();
	return { el: row, refresh };
}

export function makeSegmented<T extends string>(name: string, options: [T, string][], get: () => T, set: (v: T) => void): Field {
	const wrap = el("div", "segmented");
	wrap.setAttribute("role", "radiogroup");
	wrap.setAttribute("aria-label", name);
	const buttons = options.map(([v, label]) => {
		const b = el("button", "seg", label);
		b.type = "button";
		b.setAttribute("role", "radio");
		b.addEventListener("click", () => {
			set(v);
			refresh();
		});
		wrap.append(b);
		return [v, b] as const;
	});
	const refresh = (): void => {
		for (const [v, b] of buttons) {
			b.classList.toggle("on", v === get());
			b.setAttribute("aria-checked", String(v === get()));
		}
	};
	refresh();
	return { el: wrap, refresh };
}

export function makeSwitch(label: string, get: () => boolean, set: (v: boolean) => void): Field {
	const wrap = el("label", "switch");
	const input = el("input");
	input.type = "checkbox";
	input.setAttribute("role", "switch");
	const track = el("span", "track");
	wrap.append(input, track, el("span", "switch-label", label));
	input.addEventListener("change", () => set(input.checked));
	const refresh = (): void => {
		input.checked = get();
	};
	refresh();
	return { el: wrap, refresh };
}

export { el };
