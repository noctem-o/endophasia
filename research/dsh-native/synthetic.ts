// SYNTHETIC fixtures for the cases the study could not or should not provoke in the real runtime: a cut-off write, corruption, a log
// from a newer harness, a fork, a compaction. Everything here is DERIVED BY CODE from a real sanitised fixture or declared in this
// file, and says so: none of it is DSH output. What it can show is how a cold reader treats bytes of that shape; it cannot show
// that DSH produces them (the crash case is the exception, and is real: fixtures/real/crash-*.events.jsonl).
//
// The physical frames are written with Node's own Zstandard encoder, so their boundaries are the encoder's, one frame per batch of
// rows as DSH's writer does ("each subsequent batch appends one compressed frame"), but DSH's encoder level and parameters differ.

import { constants, zstdCompressSync } from "node:zlib";
import type { DshSessionEvent, DshSessionHeader } from "./log.ts";

/** Marks a derived value so it cannot be mistaken for runtime output when read in a test or a report. */
export const SYNTHETIC = "synthetic" as const;

const rowsText = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const frame = (text: string): Buffer =>
	zstdCompressSync(Buffer.from(text, "utf8"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

/** Rows as a sequence of checksummed frames, `batch` rows per frame, the header with the first batch. */
export function encodeFrames(header: DshSessionHeader, events: readonly DshSessionEvent[], batch = 4): Buffer {
	const parts: Buffer[] = [frame(rowsText([header, ...events.slice(0, batch)]))];
	for (let at = batch; at < events.length; at += batch) parts.push(frame(rowsText(events.slice(at, at + batch))));
	return Buffer.concat(parts);
}

/** The rows as raw newline-delimited text, the form `compression: none` writes. */
export const encodeRaw = (header: DshSessionHeader, events: readonly DshSessionEvent[]): Buffer =>
	Buffer.from(rowsText([header, ...events]), "utf8");

/** Cut the bytes `bytes` into the last frame: a write that was interrupted part-way. */
export const tornFrame = (full: Buffer, keepOfLastFrame: number, frames: { start: number; end: number }[]): Buffer => {
	const last = frames.at(-1)!;
	return full.subarray(0, last.start + keepOfLastFrame);
};

/** Flip one byte inside a complete frame's payload: corruption, not a torn tail. */
export function corruptFrame(full: Buffer, frames: { start: number; end: number }[], which: number): Buffer {
	const copy = Buffer.from(full);
	const target = frames[which]!;
	const at = target.end - 6;
	copy[at] = copy[at]! ^ 0xff;
	return copy;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A log from a newer harness: one event type this vocabulary does not know. `ignorable` is the envelope marker that lets a reader skip it. */
export function withUnknownType(events: readonly DshSessionEvent[], at: number, ignorable: boolean): DshSessionEvent[] {
	const out = clone([...events]);
	out.splice(at, 0, {
		type: "future/record",
		seq: 0,
		time: events[at]!.time,
		data: { note: SYNTHETIC },
		...(ignorable ? { ignorable: true as const } : {}),
	});
	return out.map((event, index) => ({ ...event, seq: index }));
}

/**
 * A fork child: the parent's events up to `cut` as the inherited prefix, DSH's tagged `{ inherited: true }` end-seed marker at the
 * cut, then `own` events. Sequence numbers continue the parent's, so the prefix is byte-identical to the parent's. Header and
 * marker agree (isSeeded true) unless `agree` is false, which is the broken case a reader must flag.
 */
export function forkChild(
	parentHeader: DshSessionHeader,
	parentEvents: readonly DshSessionEvent[],
	cut: number,
	own: readonly DshSessionEvent[],
	agree = true,
): { header: DshSessionHeader; events: DshSessionEvent[] } {
	const prefix = clone(parentEvents.slice(0, cut));
	const marker: DshSessionEvent = {
		type: "session/end-seed",
		seq: prefix.length,
		time: prefix.at(-1)?.time ?? parentHeader.createdAt,
		data: agree ? { inherited: true } : {},
	};
	const events = [...prefix, marker, ...clone([...own])].map((event, index) => ({ ...event, seq: index }));
	return {
		header: { ...clone(parentHeader), id: "synthetic-fork-child", parentSession: parentHeader.id, isSeeded: true },
		events,
	};
}

/** A minimal compaction: the lock, the summary with its shadowed range, then the surface replacement that carries the summary. */
export function compactionLog(header: DshSessionHeader): { header: DshSessionHeader; events: DshSessionEvent[] } {
	const time = header.createdAt;
	const text = (value: string) => [{ type: "text", text: value }];
	const rows: Omit<DshSessionEvent, "seq">[] = [
		{ type: "turn/start", time, data: { turn: 1 } },
		{ type: "step/start", time, data: { turn: 1, step: 1 } },
		{
			type: "user/message",
			time,
			data: { role: "user", content: text("first"), source: { kind: "user" } },
			surfaceOp: "append",
		},
		{
			type: "assistant/message",
			time,
			data: { turn: 1, step: 1, message: { role: "assistant", content: text("reply") }, stream: [] },
			surfaceOp: "append",
		},
		{ type: "step/end", time, data: { turn: 1, step: 1 } },
		{ type: "turn/end", time, data: { turn: 1, reason: { kind: "completed" } } },
		{ type: "compaction/start", time, data: { compactionId: "synthetic-compaction", turn: null } },
		{
			type: "compaction/summary",
			time,
			data: {
				compactionId: "synthetic-compaction",
				summary: text(SYNTHETIC),
				shadowedRange: { start: 2, end: 3 },
				shadowedSeqs: [2, 3],
				shadowedTokenCount: 10,
				provider: "synthetic",
				model: "synthetic",
			},
		},
		{
			type: "user/message",
			time,
			data: { role: "user", content: text(SYNTHETIC), source: { kind: "compaction-summary" } },
			surfaceOp: { op: "replace", startSeq: 2, endSeq: 3 },
			sourceEventSeqs: [2, 3],
		},
		{ type: "compaction/end", time, data: { compactionId: "synthetic-compaction", turn: null } },
	];
	return { header: clone(header), events: rows.map((row, seq) => ({ ...row, seq })) as DshSessionEvent[] };
}
