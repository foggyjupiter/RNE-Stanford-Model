// 아주 작은 .xlsx 읽기 도구. 측정 프로그램이 내보낸 표(숫자·문자 칸)만 읽으면 되므로 외부 라이브러리 없이
// zip 목차를 직접 읽고 압축은 브라우저 내장 DecompressionStream("deflate-raw")으로 푼다.
// 수식 결과는 저장된 값(<v>)을 그대로 쓰고, 서식·날짜 변환은 하지 않는다.

export type Cell = string | number | null;

export interface Sheet {
	name: string;	// 시트 이름
	rows: Cell[][];	// 행 우선. 빈 칸은 null
}

interface ZipEntry {
	name: string;
	method: number;	// 0 저장, 8 deflate
	size: number;	// 압축된 크기 [byte]
	offset: number;	// 로컬 헤더 위치
}

function u16(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// 중앙 디렉터리 목록
function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
	let eocd = -1;
	for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 65535); o--) {
		if (u32(b, o) === 0x06054b50) {
			eocd = o;
			break;
		}
	}
	if (eocd < 0) throw new Error("xlsx(zip) 형식이 아닙니다");
	const count = u16(b, eocd + 10);
	let p = u32(b, eocd + 16);
	const dec = new TextDecoder();
	const out = new Map<string, ZipEntry>();
	for (let k = 0; k < count; k++) {
		if (u32(b, p) !== 0x02014b50) throw new Error("zip 목차가 손상되었습니다");
		const method = u16(b, p + 10);
		const size = u32(b, p + 20);
		const nameLen = u16(b, p + 28);
		const extraLen = u16(b, p + 30);
		const commentLen = u16(b, p + 32);
		const offset = u32(b, p + 42);
		const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
		out.set(name, { name, method, size, offset });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(b: Uint8Array, e: ZipEntry): Promise<string> {
	if (u32(b, e.offset) !== 0x04034b50) throw new Error(`zip 항목 ${e.name} 헤더가 손상되었습니다`);
	const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
	const raw = b.subarray(start, start + e.size);
	let data: Uint8Array;
	if (e.method === 0) data = raw;
	else if (e.method === 8) data = await inflateRaw(raw);
	else throw new Error(`지원하지 않는 압축 방식 ${e.method}`);
	return new TextDecoder().decode(data);
}

function unescapeXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, g: string) => {
		if (g === "amp") return "&";
		if (g === "lt") return "<";
		if (g === "gt") return ">";
		if (g === "quot") return '"';
		if (g === "apos") return "'";
		return String.fromCodePoint(g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
	});
}

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
	return m ? unescapeXml(m[1]) : null;
}

// <si> 안의 모든 <t> 글자를 이어 붙인다 (서식 있는 문자열 포함)
function textOf(xml: string): string {
	let s = "";
	for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += unescapeXml(m[1]);
	return s;
}

function colIndex(ref: string): number {
	let c = 0;
	for (const ch of ref) {
		const code = ch.charCodeAt(0);
		if (code < 65 || code > 90) break;
		c = c * 26 + (code - 64);
	}
	return c - 1;
}

function parseSheet(xml: string, shared: string[]): Cell[][] {
	const rows: Cell[][] = [];
	for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
		const rIdx = Number(attr(rm[1], "r") ?? rows.length + 1) - 1;
		const row: Cell[] = [];
		for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const ref = attr(cm[1], "r");
			const col = ref ? colIndex(ref) : row.length;
			const t = attr(cm[1], "t");
			const body = cm[2] ?? "";
			const v = /<v>([\s\S]*?)<\/v>/.exec(body);
			let val: Cell = null;
			if (t === "s" && v) val = shared[Number(v[1])] ?? null;
			else if (t === "inlineStr") val = textOf(body);
			else if (t === "str" && v) val = unescapeXml(v[1]);
			else if (t === "b" && v) val = Number(v[1]);
			else if (t === "e") val = null;
			else if (v) {
				const x = Number(v[1]);
				val = Number.isFinite(x) ? x : unescapeXml(v[1]);
			}
			while (row.length < col) row.push(null);
			row[col] = val;
		}
		while (rows.length < rIdx) rows.push([]);
		rows[rIdx] = row;
	}
	return rows;
}

// .xlsx 바이트 → 시트 목록 (통합 문서의 시트 순서)
export async function readXlsx(bytes: ArrayBuffer | Uint8Array): Promise<Sheet[]> {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const entries = zipEntries(b);
	const get = async (path: string): Promise<string | null> => {
		const e = entries.get(path);
		return e ? readEntry(b, e) : null;
	};
	const wb = await get("xl/workbook.xml");
	if (!wb) throw new Error("xl/workbook.xml이 없습니다 (엑셀 파일이 아님)");
	const rels = (await get("xl/_rels/workbook.xml.rels")) ?? "";
	const target = new Map<string, string>();
	for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
		const id = attr(m[1], "Id");
		const t = attr(m[1], "Target");
		if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t}`);
	}
	const ssXml = (await get("xl/sharedStrings.xml")) ?? "";
	const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
	const out: Sheet[] = [];
	for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
		const name = attr(m[1], "name") ?? `Sheet${out.length + 1}`;
		const rid = attr(m[1], "r:id");
		const path = rid ? target.get(rid) : undefined;
		const xml = path ? await get(path) : null;
		if (xml) out.push({ name, rows: parseSheet(xml, shared) });
	}
	return out;
}
