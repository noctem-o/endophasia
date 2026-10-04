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
 *
 * A torn tail cannot be told apart from a damaged length prefix: a flipped bit that makes a
 * complete frame's length exceed the rest of the file reads exactly like a torn append, and
 * everything after it looks like torn bytes. So truncateTo never destroys what it cuts: the
 * bytes after the kept prefix are first written, fsynced, to `<path>.discarded-<sha256 prefix>`
 * and that path is returned, so an operator can inspect and recover them.
 *
 * Writes are exact: a write that reports fewer bytes than the frame throws (writeExactSyncV0), so a short write is never
 * reported as an append. The bytes it did write read back as a torn tail, and the log refuses further appends until
 * that tail is recovered.
 *
 * A log opened read-only (`{ readOnly: true }`) reads and classifies exactly like a writable one, but append and
 * truncateTo throw before touching the file: the read-only path for commands that only report.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const DIGEST_LENGTH = 32;

/** sha256 over the raw bytes, as a 32-byte buffer. */
function digestOf(bytes: Uint8Array): Buffer {
	return createHash("sha256").update(bytes).digest();
}

/**
 * Write all of `bytes` to `fd` in one writeSync call, or throw. A short write leaves whatever it wrote on disk, so the
 * caller must treat the file as damaged; it is never reported as complete.
 */
export function writeExactSyncV0(fd: number, bytes: Uint8Array, what: string): void {
	const written = writeSync(fd, bytes);
	if (written !== bytes.length) {
		throw new Error(`short write to ${what}: ${written} of ${bytes.length} byte(s) written`);
	}
}

/** The length and sha256 of bytes that are not a frame. */
function tailOf(bytes: Uint8Array): EndoFrameLogTailV0 {
	return { bytes: bytes.length, sha256: digestOf(bytes).toString("hex") };
}

/** Serialize one frame: the 4-byte big-endian length, the payload, the 32-byte digest. */
/** The frame bytes for `payload`, exactly as append writes them (for writers that append asynchronously). */
export function endoFrameBytesV0(payload: Uint8Array): Buffer {
	return frameOf(payload);
}

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
	/** The torn bytes after the valid prefix when `truncated`, else null. */
	tail: EndoFrameLogTailV0 | null;
}

/** A run of bytes that is not a frame: its length and its full sha256. */
export interface EndoFrameLogTailV0 {
	bytes: number;
	sha256: string;
}

/** What truncateTo cut from the log, and the file the cut bytes were preserved in first. */
export interface EndoFrameLogDiscardV0 extends EndoFrameLogTailV0 {
	preservedAt: string;
}

/**
 * How a store's open classified its frame log, and what (if anything) the open changed. Every store built on the frame
 * log reports this from recovery(), so recovery is evidence rather than a silent repair.
 */
export interface EndoFrameLogRecoveryV0 {
	/** True when the store was opened read-only: open created and changed nothing on disk. */
	readOnly: boolean;
	/** True when the log ends in a torn tail, whether or not this open cut it. */
	truncated: boolean;
	/** The torn tail as found on open (length and sha256), or null. */
	tail: EndoFrameLogTailV0 | null;
	/** True when this open cut the torn tail (a writable open only). */
	recovered: boolean;
	/** What this open cut and where it was preserved, or null when it cut nothing. */
	discarded: EndoFrameLogDiscardV0 | null;
	/** True when a complete frame failed verification: the valid prefix is readable, writes are refused. */
	sealed: boolean;
	/** The 1-based index of the first frame that failed verification, or null. */
	corruptAt: number | null;
}

/** The recovery report of one open: the read's classification plus what truncation (if any) discarded. */
export function endoFrameLogRecoveryV0(
	read: EndoFrameLogReadV0,
	readOnly: boolean,
	discarded: EndoFrameLogDiscardV0 | null,
): EndoFrameLogRecoveryV0 {
	return {
		readOnly,
		truncated: read.truncated,
		tail: read.tail === null ? null : { ...read.tail },
		recovered: discarded !== null,
		discarded: discarded === null ? null : { ...discarded },
		sealed: read.corruptAt !== null,
		corruptAt: read.corruptAt,
	};
}

/** Options for opening a frame log. */
export interface EndoFrameLogOptionsV0 {
	/** Refuse append and truncateTo: the log is only read. */
	readOnly?: boolean;
}

/**
 * Options for opening a store built on the frame log (the event store, harness registry and ledger) or the artifact
 * store. `readOnly`: create no directory, cut nothing, and refuse every write.
 */
export type EndoDurableStoreOptionsV0 = EndoFrameLogOptionsV0;

/**
 * A durable append log at one file path. All operations are synchronous; the file is
 * opened, written, and closed per operation (no handle is held between calls).
 */
export interface EndoFrameLogV0 {
	/**
	 * Append one payload as a single framed write and fsync it. Returns the 1-based index of the new frame. Throws
	 * TypeError, writing nothing, when the file has a torn tail or a corrupt frame: a frame written after either would
	 * be unreachable by read(), so the append would report success for bytes no reader can see. Recover a torn tail
	 * with truncateTo first; a corrupt log is never appended to.
	 */
	append(payload: Uint8Array): number;
	/** Read and classify the whole file: the valid prefix, a torn tail, or a digest mismatch. */
	read(): EndoFrameLogReadV0;
	/**
	 * Rewrite the log with exactly its first `count` frames (tmp+rename+directory fsync).
	 * Only for crash-tail recovery: `count` must be within the current valid prefix. The cut
	 * bytes are preserved first; returns their length, sha256 and the path they were written to,
	 * or null when nothing was cut.
	 */
	truncateTo(count: number): EndoFrameLogDiscardV0 | null;
	/** The number of frames known from the last read or append. */
	length: number;
}

/** Create the durable frame log at `path` (the file is created on first append). */
export function createEndoFrameLogV0(path: string, options: EndoFrameLogOptionsV0 = {}): EndoFrameLogV0 {
	const readOnly = options.readOnly === true;
	const refuseReadOnly = (operation: string): void => {
		if (readOnly) throw new TypeError(`the log ${path} is open read-only; ${operation} is refused`);
	};
	let loaded = false;
	let count = 0;
	/** Set by a read that found a torn tail or a corrupt frame; cleared by truncateTo. */
	let damaged = false;
	/** The file size the last read, append or truncate left; a different size means someone else wrote. */
	let knownBytes = 0;

	const currentBytes = (): number => {
		try {
			return statSync(path).size;
		} catch {
			return 0;
		}
	};

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
		/** The end of the last valid frame: where a torn tail begins. */
		let validEnd = 0;
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
			validEnd = offset;
		}
		count = frames.length;
		loaded = true;
		damaged = truncated || corruptAt !== null;
		knownBytes = buffer.length;
		const tail = truncated ? tailOf(buffer.subarray(validEnd)) : null;
		return { frames, truncated, corruptAt, tail };
	};

	return {
		append(payload: Uint8Array): number {
			refuseReadOnly("append");
			if (!loaded || currentBytes() !== knownBytes) read();
			if (damaged) {
				throw new TypeError(
					"the log has a torn tail or a corrupt frame; recover it with truncateTo before appending",
				);
			}
			const frame = frameOf(payload);
			const fd = openSync(path, "a");
			try {
				writeExactSyncV0(fd, frame, path);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			count += 1;
			knownBytes += frame.length;
			return count;
		},
		read,
		truncateTo(cut: number): EndoFrameLogDiscardV0 | null {
			refuseReadOnly("truncateTo");
			if (!Number.isInteger(cut) || cut < 0) throw new TypeError("truncateTo count must be a non-negative integer");
			const { frames, corruptAt } = read();
			const valid = frames.length;
			if (corruptAt !== null)
				throw new TypeError("the log has a corrupt frame; it cannot be truncated until it is sealed");
			if (cut > valid) throw new TypeError(`cannot truncate to ${cut}; the log has ${valid} valid frame(s)`);
			const out = Buffer.concat(frames.slice(0, cut).map(frameOf));
			// The kept frames verified, and framing is deterministic, so `out` is byte-for-byte the file's prefix and
			// everything after it is what this call removes. Preserve it before the file is replaced.
			let original: Buffer;
			try {
				original = readFileSync(path);
			} catch {
				original = Buffer.alloc(0);
			}
			const cutBytes = original.subarray(out.length);
			let discarded: EndoFrameLogDiscardV0 | null = null;
			if (cutBytes.length > 0) {
				const cutTail = tailOf(cutBytes);
				discarded = { ...cutTail, preservedAt: `${path}.discarded-${cutTail.sha256.slice(0, 16)}` };
				const keepFd = openSync(discarded.preservedAt, "w");
				try {
					writeExactSyncV0(keepFd, cutBytes, discarded.preservedAt);
					fsyncSync(keepFd);
				} finally {
					closeSync(keepFd);
				}
			}
			const tmp = `${path}.tmp`;
			const fd = openSync(tmp, "w");
			try {
				writeExactSyncV0(fd, out, tmp);
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
			damaged = false;
			knownBytes = out.length;
			count = cut;
			return discarded;
		},
		get length(): number {
			if (!loaded) read();
			return count;
		},
	};
}
