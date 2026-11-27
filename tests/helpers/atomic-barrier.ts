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
 */
export function waitForBarrierFile(filePath: string, timeoutMs = 10_000, pollMs = 10): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			try {
				resolve(readFileSync(filePath, "utf8"));
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				if (code !== "ENOENT") {
					reject(error);
					return;
				}
			}
			if (Date.now() > deadline) {
				reject(new Error(`Timed out waiting for barrier file ${filePath}`));
				return;
			}
			setTimeout(tick, pollMs);
		};
		tick();
	});
}

/** Wait for an atomically published JSON barrier file and parse its contents. */
export async function waitForJsonBarrier<T>(filePath: string, timeoutMs = 10_000, pollMs = 10): Promise<T> {
	const raw = await waitForBarrierFile(filePath, timeoutMs, pollMs);
	return JSON.parse(raw) as T;
}
