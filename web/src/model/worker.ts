// Web Worker 진입점: 모델 작업을 UI 스레드 밖에서 실행한다.
// 입력 메시지: { id, job }. 출력 메시지: { id, ok: true, out } | { id, ok: false, error }.

import { runJob, type Job, type JobOutput } from "./jobs";

export interface WorkerRequest {
	id: number;
	job: Job;
}

export type WorkerResponse = { id: number; ok: true; out: JobOutput } | { id: number; ok: false; error: string };

function transferables(out: JobOutput): ArrayBuffer[] {
	if (out.kind === "fixed") return [out.v.buffer as ArrayBuffer, out.i.buffer as ArrayBuffer];
	const list: ArrayBuffer[] = [];
	for (const r of out.cycles) for (const a of [r.t, r.vApp, r.vSw, r.i, r.x, r.w, r.T]) list.push(a.buffer as ArrayBuffer);
	return list;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
	const { id, job } = ev.data;
	try {
		const out = runJob(job);
		const msg: WorkerResponse = { id, ok: true, out };
		(self as unknown as Worker).postMessage(msg, transferables(out));
	} catch (e) {
		const msg: WorkerResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
		(self as unknown as Worker).postMessage(msg);
	}
};
