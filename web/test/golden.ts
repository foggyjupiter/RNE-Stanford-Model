// python/golden/*.csv 로더 (헤더 한 줄 + 숫자 행). 환경 변수 GOLDEN_DIR로 다른 폴더를 쓸 수 있다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GOLDEN_DIR = process.env.GOLDEN_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "python", "golden");

export function loadCsv(name: string): Record<string, number[]> {
	const lines = readFileSync(join(GOLDEN_DIR, name), "utf8").trim().split(/\r?\n/);
	const cols = lines[0].split(",");
	const data: Record<string, number[]> = {};
	for (const c of cols) data[c] = [];
	for (let k = 1; k < lines.length; k++) {
		const v = lines[k].split(",").map(Number);
		for (let j = 0; j < cols.length; j++) data[cols[j]].push(v[j]);
	}
	return data;
}
