// 모델 Web Worker를 감싼 Promise 래퍼.
// 마지막 요청만 의미가 있다(슬라이더 드래그): 계산 중에 run()이 새로 오면 워커를 종료하고,
// 밀려난 Promise는 SupersededError로 reject된다.

import { type Job, type JobOutput } from "./jobs";
import { type WorkerRequest, type WorkerResponse } from "./worker";

export class SupersededError extends Error {
	constructor() {
		super("더 새로운 요청으로 대체됨");
	}
}

export class ModelClient {
	private worker: Worker | null = null;
	private nextId = 1;
	private pending: { id: number; resolve: (o: JobOutput) => void; reject: (e: Error) => void } | null = null;

	private spawn(): Worker {
		const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
		w.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
			const msg = ev.data;
			const p = this.pending;
			if (!p || p.id !== msg.id) return;
			this.pending = null;
			if (msg.ok) p.resolve(msg.out);
			else p.reject(new Error(msg.error));
		};
		w.onerror = (ev: ErrorEvent): void => {
			const p = this.pending;
			this.pending = null;
			p?.reject(new Error(ev.message));
		};
		return w;
	}

	run(job: Job): Promise<JobOutput> {
		if (this.pending) {
			// 진행 중인 계산을 버린다: 워커는 작업 도중에 중단시킬 수 없다
			this.worker?.terminate();
			this.worker = null;
			this.pending.reject(new SupersededError());
			this.pending = null;
		}
		if (!this.worker) this.worker = this.spawn();
		const id = this.nextId++;
		const req: WorkerRequest = { id, job };
		return new Promise<JobOutput>((resolve, reject) => {
			this.pending = { id, resolve, reject };
			this.worker!.postMessage(req);
		});
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
		this.pending?.reject(new SupersededError());
		this.pending = null;
	}
}
