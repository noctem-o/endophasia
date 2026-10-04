// Asynchronous durable appends, for writers that must never block their event loop (the recording proxy relays bytes on
// it). Each operation runs on libuv's threadpool, in the order it was queued: a frame is appended exactly as the
// synchronous frame log appends it (storage/log.ts: one write of the frame, then fsync), and a blob is written as the
// blob store writes it (storage/blob-store.ts: tmp file, fsync, rename, directory fsync). A reader opening the same files
// with the synchronous stores sees the same bytes.
//
// A crash leaves at most a torn final frame (the frame log's recovery handles it) or a `.tmp` blob file (never listed or
// served). Everything queued before a completed `idle()` is on disk.

import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { endoFrameBytesV0 } from "./log.ts";

export class EndoAsyncDurableQueueV0 {
	#chain: Promise<void> = Promise.resolve();
	#failures = 0;
	#lastError: Error | null = null;

	/** Append one frame (payload: the canonical JSON bytes of a record) to the frame log at `path`, then fsync. */
	appendFrame(path: string, payload: Uint8Array): void {
		const frame = endoFrameBytesV0(payload);
		this.#queue(async () => {
			await this.beforeWrite();
			await mkdir(dirname(path), { recursive: true });
			const handle = await open(path, "a");
			try {
				const { bytesWritten } = await handle.write(frame, 0, frame.length);
				if (bytesWritten !== frame.length)
					throw new Error(`short write to ${path}: ${bytesWritten} of ${frame.length}`);
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
	}

	/** Write `bytes` to `file` (created; an existing file is left as it is), atomically and durably. */
	writeFileOnce(file: string, bytes: Uint8Array): void {
		const copy = Buffer.from(bytes);
		this.#queue(async () => {
			await this.beforeWrite();
			await mkdir(dirname(file), { recursive: true });
			try {
				const existing = await open(file, "r");
				await existing.close();
				return;
			} catch {
				// Missing: write it.
			}
			const tmp = `${file}.tmp`;
			const handle = await open(tmp, "w");
			try {
				const { bytesWritten } = await handle.write(copy, 0, copy.length);
				if (bytesWritten !== copy.length) throw new Error(`short write to ${tmp}`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(tmp, file);
			const dir = await open(dirname(file), "r");
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		});
	}

	/** Runs before each queued write, inside the queue. A no-op; tests override it to model a slow disk. */
	protected async beforeWrite(): Promise<void> {}

	/** Resolves once everything queued so far is on disk (or has failed: see `failures`). */
	idle(): Promise<void> {
		return this.#chain;
	}

	/** Operations that failed, and the last error. A failure never stops the queue. */
	get failures(): number {
		return this.#failures;
	}
	get lastError(): Error | null {
		return this.#lastError;
	}

	#queue(operation: () => Promise<void>): void {
		this.#chain = this.#chain.then(operation).catch((error: unknown) => {
			this.#failures += 1;
			this.#lastError = error as Error;
		});
	}
}
