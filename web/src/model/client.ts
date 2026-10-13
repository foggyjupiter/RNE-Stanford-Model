// Promise wrapper around the model Web Worker.
// Only the latest request matters (slider drags): a new run() terminates a busy worker,
// and the superseded promise rejects with SupersededError.

import { type Job, type JobOutput } from "./jobs";
import { type WorkerRequest, type WorkerResponse } from "./worker";

export class SupersededError extends Error {
	constructor() {
		super("superseded by a newer request");
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
			// abandon the running computation: a worker cannot be interrupted mid-job
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
