// Atomic file-based synchronization helpers for multi-process tests.
//
// Publishing structured payloads with `writeFileSync(path, ...)` directly exposes the file entry to concurrent
// `existsSync(path)` / `readFileSync(path)` observers before the bytes are flushed (causing empty or truncated JSON reads).
// Writing to a unique sibling temporary file in the same directory and renaming atomically onto `filePath` guarantees that
// every reader observes either ENOENT or the complete payload.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Write `content` to `filePath` via a unique same-directory temp file and atomic rename. */
export function writeFileAtomicallySync(filePath: string, content: string): void {
	const dir = dirname(filePath);
	const temp = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	writeFileSync(temp, content, "utf8");
	renameSync(temp, filePath);
}

/** Write JSON payload atomically to `filePath`. */
export function writeJsonAtomicallySync(filePath: string, value: unknown): void {
	writeFileAtomicallySync(filePath, JSON.stringify(value));
}

/**
 * Poll until an atomically published file appears at `filePath`, then return its UTF-8 content.
 * Avoids the TOCTOU window of `existsSync` followed by `readFileSync` by reading directly and retrying on ENOENT.
 * Accepts an optional `AbortSignal` so losing branches of `Promise.any` stop polling immediately.
 */
export function waitForBarrierFile(
	filePath: string,
	timeoutMs = 10_000,
	pollMs = 10,
	signal?: AbortSignal,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(
				signal?.reason instanceof Error ? signal.reason : new Error(`Aborted waiting for barrier file ${filePath}`),
			);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		const tick = () => {
			if (signal?.aborted) return;
			try {
				const content = readFileSync(filePath, "utf8");
				cleanup();
				resolve(content);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code !== "ENOENT") {
					cleanup();
					reject(error);
					return;
				}
			}
			if (Date.now() > deadline) {
				cleanup();
				reject(new Error(`Timed out waiting for barrier file ${filePath}`));
				return;
			}
			timer = setTimeout(tick, pollMs);
		};
		tick();
	});
}

/** Wait for an atomically published JSON barrier file and parse its contents. */
export async function waitForJsonBarrier<T>(
	filePath: string,
	timeoutMs = 10_000,
	pollMs = 10,
	signal?: AbortSignal,
): Promise<T> {
	const raw = await waitForBarrierFile(filePath, timeoutMs, pollMs, signal);
	return JSON.parse(raw) as T;
}
