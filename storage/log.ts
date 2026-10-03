/**
 * Phase 12 — the durable append log (README "## Phase 12 — Operational substrate &
 * integration", work item: "storage/ durable append store"). One file, one stream,
 * synchronous node:fs only: every append is ONE write of a self-describing frame plus an
 * fsync, so a crash mid-append leaves a torn tail — detectable on reopen, never silently
 * accepted.
 *
 * Frame layout: `<u32be payload-length><payload><sha256(len-bytes ++ payload)>`. The digest
 * covers the length prefix as well as the payload, so a byte flipped anywhere in a frame —
 * in the length, the payload, or the digest — is detected on read.
 *
 * Read classifies the file into exactly one of: a run of valid frames (optionally followed
 * by a torn tail, `truncated`), or a run of valid frames followed by the first frame whose
 * digest does not verify (`corruptAt`, 1-based index). The valid prefix is the only part
 * ever trusted: `truncateTo(count)` rewrites the file with the first `count` frames via an
 * atomic tmp+rename+directory-fsync — the crash-tail recovery path, and nothing else.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const DIGEST_LENGTH = 32;

/** sha256 over the raw bytes, as a 32-byte buffer. */
function digestOf(bytes: Uint8Array): Buffer {
	return createHash("sha256").update(bytes).digest();
}

/** Serialize one frame: the 4-byte big-endian length, the payload, the 32-byte digest. */
function frameOf(payload: Uint8Array): Buffer {
	const frame = Buffer.alloc(4 + payload.length + DIGEST_LENGTH);
	frame.writeUInt32BE(payload.length, 0);
	frame.set(payload, 4);
	frame.set(digestOf(frame.subarray(0, 4 + payload.length)), 4 + payload.length);
	return frame;
}

/**
 * The classification of one read of an append log.
 */
export interface EndoFrameLogReadV0 {
	/** The valid frames, in append order, copied out of the file buffer. */
	frames: Uint8Array[];
	/** True when the file ends mid-frame (a torn append); the torn bytes are not a frame. */
	truncated: boolean;
	/** The 1-based index of the first frame whose digest does not verify, or null when every complete frame verified. */
	corruptAt: number | null;
}

/**
 * A durable append log at one file path. All operations are synchronous; the file is
 * opened, written, and closed per operation (no handle is held between calls).
 */
export interface EndoFrameLogV0 {
	/** Append one payload as a single framed write and fsync it. Returns the 1-based index of the new frame. */
	append(payload: Uint8Array): number;
	/** Read and classify the whole file: the valid prefix, a torn tail, or a digest mismatch. */
	read(): EndoFrameLogReadV0;
	/**
	 * Rewrite the log with exactly its first `count` frames (tmp+rename+directory fsync).
	 * Only for crash-tail recovery: `count` must be within the current valid prefix.
	 */
	truncateTo(count: number): void;
	/** The number of frames known from the last read or append. */
	length: number;
}

/** Create the durable frame log at `path` (the file is created on first append). */
export function createEndoFrameLogV0(path: string): EndoFrameLogV0 {
	let loaded = false;
	let count = 0;

	const read = (): EndoFrameLogReadV0 => {
		const frames: Uint8Array[] = [];
		let truncated = false;
		let corruptAt: number | null = null;
		let buffer: Buffer;
		try {
			buffer = readFileSync(path);
		} catch {
			buffer = Buffer.alloc(0);
		}
		let offset = 0;
		let index = 0;
		while (offset < buffer.length) {
			index += 1;
			if (buffer.length - offset < 4) {
				truncated = true;
				break;
			}
			const length = buffer.readUInt32BE(offset);
			offset += 4;
			if (buffer.length - offset < length + DIGEST_LENGTH) {
				truncated = true;
				break;
			}
			const lengthStart = offset;
			const payload = buffer.subarray(offset, offset + length);
			offset += length + DIGEST_LENGTH;
			const check = digestOf(Buffer.concat([buffer.subarray(lengthStart - 4, lengthStart), payload]));
			if (!timingSafeEqual(check, buffer.subarray(offset - DIGEST_LENGTH, offset))) {
				corruptAt = index;
				break;
			}
			frames.push(Uint8Array.from(payload));
		}
		count = frames.length;
		loaded = true;
		return { frames, truncated, corruptAt };
	};

	return {
		append(payload: Uint8Array): number {
			if (!loaded) read();
			const frame = frameOf(payload);
			const fd = openSync(path, "a");
			try {
				writeSync(fd, frame);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			count += 1;
			return count;
		},
		read,
		truncateTo(cut: number): void {
			if (!Number.isInteger(cut) || cut < 0) throw new TypeError("truncateTo count must be a non-negative integer");
			const { frames, corruptAt } = read();
			const valid = frames.length;
			if (corruptAt !== null)
				throw new TypeError("the log has a corrupt frame; it cannot be truncated until it is sealed");
			if (cut > valid) throw new TypeError(`cannot truncate to ${cut}; the log has ${valid} valid frame(s)`);
			const out = Buffer.concat(frames.slice(0, cut).map(frameOf));
			const tmp = `${path}.tmp`;
			const fd = openSync(tmp, "w");
			try {
				writeSync(fd, out);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, path);
			const dirFd = openSync(dirname(path), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
			loaded = true;
			count = cut;
		},
		get length(): number {
			if (!loaded) read();
			return count;
		},
	};
}
