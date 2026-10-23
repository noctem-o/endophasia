// Read-only inspection of a DeepSeek Harness (DSH) Session log, Session format version 4. A STUDY utility: it exists to state,
// executably, what a cold reader can and cannot establish from a persisted DSH log. It is not an adapter. Nothing here
// imports DSH or Cordis, opens a file, takes a lock or repairs anything: it is given bytes (or decoded rows) and reports.
//
// The physical format is DSH's own (packages/session/session-persistence-jsonl): one header row, then one JSON row per durable
// event, either raw newline-delimited UTF-8 (`session.v4.jsonl`) or a sequence of checksummed Zstandard frames
// (`session.v4.jsonl.zstd`), each frame holding whole rows. A log that is still being written, or whose writer crashed, may end in
// a torn frame or a torn row. DSH repairs that only through a WRITE handle; this reader never does, so it reports a torn tail as a
// fact about the bytes (`tail`) and returns the complete prefix.

import { zstdDecompressSync } from "node:zlib";

/** The Session format this study covers. DSH's `SESSION_FORMAT_VERSION` (packages/core/session/src/types.ts). */
export const DSH_SESSION_FORMAT_V4 = 4;

export interface DshSessionHeader {
	type: "session";
	version: number;
	id: string;
	createdAt: number;
	cwd?: string;
	parentSession?: string;
	isSeeded: boolean;
	origin?: "subagent";
	delegationDepth?: number;
	agentPreset?: string;
}

/** One durable event row, as DSH's `SessionEvent` envelope. `data` is whatever the event type declares. */
export interface DshSessionEvent {
	type: string;
	seq: number;
	time: number;
	data: unknown;
	ignorable?: true;
	surfaceOp?: unknown;
	sourceEventSeqs?: number[];
}

/** What the end of the bytes looked like. `clean`: every frame/row complete. The others lose nothing before them. */
export type DshTail =
	| { kind: "clean" }
	| { kind: "torn-frame"; completeBytes: number; trailingBytes: number }
	| { kind: "torn-row"; trailingBytes: number }
	| { kind: "unreadable"; reason: string };

export interface DshLogRead {
	physical: "zstd" | "jsonl";
	/** Complete zstd frames found (0 for a raw log). */
	frames: number;
	header: DshSessionHeader | null;
	events: DshSessionEvent[];
	tail: DshTail;
	/** Reasons the read stopped before the end of the bytes, other than a torn tail. */
	problems: string[];
}

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
/** The most decoded bytes a read will hold. A hostile frame can declare an enormous output from a few KiB. */
export const DSH_LOG_MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * Walk the frame structure of a Zstandard stream WITHOUT decompressing it (RFC 8878 section 3): magic, frame header descriptor,
 * block headers. Returns the byte ranges of the complete frames and where the first incomplete one starts. This is how a reader
 * with no write handle can tell "a frame was cut off" from "a frame is corrupt".
 */
export function scanZstdFrames(bytes: Uint8Array): { frames: { start: number; end: number }[]; trailing: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frames: { start: number; end: number }[] = [];
	let at = 0;
	while (at < bytes.length) {
		const start = at;
		if (bytes.length - at < 4) return { frames, trailing: bytes.length - start };
		const magic = view.getUint32(at, true);
		// DSH's own decoder rejects skippable frames (zstd.ts); a log containing one was not written by DSH.
		if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC)
			throw new RangeError(`byte ${at} is a skippable frame, which DSH does not write`);
		if (magic !== ZSTD_MAGIC) throw new RangeError(`byte ${at} is not a Zstandard frame`);
		at += 4;
		if (at >= bytes.length) return { frames, trailing: bytes.length - start };
		const descriptor = bytes[at]!;
		at += 1;
		// Bit 3 is reserved and must be zero (RFC 8878 section 3.1.1.1.1).
		if ((descriptor & 0x08) !== 0) throw new RangeError(`byte ${at - 1} sets a reserved frame header bit`);
		const contentSizeFlag = descriptor >> 6;
		const singleSegment = (descriptor & 0x20) !== 0;
		const checksum = (descriptor & 0x04) !== 0;
		const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]!;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]!;
		at += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		let last = false;
		while (!last) {
			if (at + 3 > bytes.length) return { frames, trailing: bytes.length - start };
			const header = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
			last = (header & 1) === 1;
			const type = (header >> 1) & 3;
			const size = header >> 3;
			if (type === 3) throw new RangeError(`byte ${at} holds a reserved Zstandard block type`);
			// An RLE block stores one byte and regenerates `size` of them.
			at += 3 + (type === 1 ? 1 : size);
			if (at > bytes.length) return { frames, trailing: bytes.length - start };
		}
		if (checksum) at += 4;
		if (at > bytes.length) return { frames, trailing: bytes.length - start };
		frames.push({ start, end: at });
	}
	return { frames, trailing: 0 };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseRows(text: string, problems: string[]): { rows: unknown[]; unterminated: string } {
	const rows: unknown[] = [];
	const lines = text.split("\n");
	// A final element without a newline after it is an incomplete row.
	const unterminated = lines.pop() ?? "";
	for (const [index, line] of lines.entries()) {
		if (line === "") {
			problems.push(`row ${index + 1} is an empty physical row`);
			break;
		}
		try {
			rows.push(JSON.parse(line));
		} catch {
			problems.push(`row ${index + 1} is not valid JSON`);
			break;
		}
	}
	return { rows, unterminated };
}

/**
 * Decode a DSH v4 log from its bytes. Compression is told from the first bytes (a Zstandard magic), never from a file name.
 * Complete rows before a torn tail are returned; a torn tail is reported, not repaired. Throws nothing for damaged input: damage
 * is a `problems` entry or an `unreadable` tail, because "the log could not be read to the end" is a finding, not a crash.
 */
export function readDshLog(bytes: Uint8Array, maxDecodedBytes = DSH_LOG_MAX_DECODED_BYTES): DshLogRead {
	const problems: string[] = [];
	const magic = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) : 0;
	// A skippable-frame magic is a Zstandard stream too (the scanner then refuses it), never raw text.
	const shortMagic =
		bytes.length > 0 && bytes.length < 4 && bytes.every((byte, index) => byte === [0x28, 0xb5, 0x2f, 0xfd][index]);
	const zstd = shortMagic || magic === ZSTD_MAGIC || (magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC;
	const unreadable = (reason: string): DshLogRead => ({
		physical: zstd ? "zstd" : "jsonl",
		frames: 0,
		header: null,
		events: [],
		tail: { kind: "unreadable", reason },
		problems,
	});
	if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) {
		problems.push("invalid decoded byte limit");
		return unreadable("invalid decoded byte limit");
	}
	let text = "";
	let frames = 0;
	let tail: DshTail = { kind: "clean" };
	if (zstd) {
		let scan: ReturnType<typeof scanZstdFrames>;
		try {
			scan = scanZstdFrames(bytes);
		} catch (error) {
			return {
				physical: "zstd",
				frames: 0,
				header: null,
				events: [],
				tail: { kind: "unreadable", reason: (error as Error).message },
				problems,
			};
		}
		frames = scan.frames.length;
		const parts: string[] = [];
		let decoded = 0;
		for (const { start, end } of scan.frames) {
			try {
				// The bound is per read, not per frame: each frame may only use what the earlier ones left.
				const part = zstdDecompressSync(bytes.subarray(start, end), {
					maxOutputLength: Math.max(1, maxDecodedBytes - decoded),
				});
				if (part.length > maxDecodedBytes - decoded)
					throw Object.assign(new RangeError("decoded size bound"), { code: "ERR_BUFFER_TOO_LARGE" });
				// Never reconstruct one row by joining independent frames. A final unfinished row retains the existing
				// torn-row/prefix report below; an unfinished non-final frame is invalid framing.
				if (part.length > 0 && part[part.length - 1] !== 0x0a && end !== scan.frames.at(-1)!.end)
					throw new RangeError("a non-final Zstandard frame ends inside a row");
				decoded += part.length;
				parts.push(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part));
			} catch (error) {
				// A complete frame that does not decode (checksum, structure) is corruption, not a torn tail.
				const over = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
				problems.push(
					over
						? `decoded output would exceed ${maxDecodedBytes} bytes (frame at byte ${start})`
						: `a complete frame at byte ${start} failed to decode: ${(error as Error).message}`,
				);
				return {
					physical: "zstd",
					frames: parts.length,
					header: null,
					events: [],
					tail: {
						kind: "unreadable",
						reason: over ? "the decoded size bound was exceeded" : "a complete frame failed to decode",
					},
					problems,
				};
			}
		}
		text = parts.join("");
		if (scan.trailing > 0) {
			const completeBytes = bytes.length - scan.trailing;
			tail = { kind: "torn-frame", completeBytes, trailingBytes: scan.trailing };
		}
	} else {
		if (bytes.length > maxDecodedBytes) {
			problems.push(`decoded output would exceed ${maxDecodedBytes} bytes`);
			return unreadable("the decoded size bound was exceeded");
		}
		// Only newline-terminated rows are evidence. A cut inside a UTF-8 codepoint in the unfinished row stays a torn tail.
		const end = Buffer.from(bytes).lastIndexOf(0x0a) + 1;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
		} catch {
			problems.push("raw JSONL contains invalid UTF-8");
			return unreadable("invalid UTF-8");
		}
		if (end < bytes.length) tail = { kind: "torn-row", trailingBytes: bytes.length - end };
	}
	const parsed = parseRows(text, problems);
	if (parsed.unterminated !== "") {
		// A row with no newline after it. In a raw log that is a cut-off write; in a zstd log a COMPLETE frame ended inside a row,
		// which DSH's writer never produces. Either way the complete rows before it are kept and the cut is reported.
		const trailing = zstd
			? Buffer.byteLength(parsed.unterminated)
			: bytes.length - (Buffer.from(bytes).lastIndexOf(0x0a) + 1);
		if (tail.kind === "clean") tail = { kind: "torn-row", trailingBytes: trailing };
	}
	const [first, ...rest] = parsed.rows;
	const header = isRecord(first) && first.type === "session" ? (first as unknown as DshSessionHeader) : null;
	if (parsed.rows.length > 0 && header === null) problems.push("the first row is not a session header");
	const events: DshSessionEvent[] = [];
	for (const row of rest) {
		if (!isRecord(row) || typeof row.type !== "string" || typeof row.seq !== "number") {
			problems.push("a row after the header is not an event envelope");
			break;
		}
		events.push(row as unknown as DshSessionEvent);
	}
	return { physical: zstd ? "zstd" : "jsonl", frames, header, events, tail, problems };
}

/** The pinned vocabulary and fingerprints a check is made against (research/dsh-native/vocabulary.json). */
export interface DshVocabulary {
	knownEventTypes: readonly string[];
}

export type DshFindingSeverity = "error" | "warning" | "info";

export interface DshFinding {
	code: string;
	severity: DshFindingSeverity;
	seq?: number;
	detail: string;
}

/** DSH event types whose events produce model messages (and so carry `surfaceOp`). packages/core/session/src/types.ts. */
const PLUGIN_RECORD = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

const SURFACE_TYPES = new Set([
	"system/message",
	"developer/message",
	"user/message",
	"assistant/message",
	"tool/result",
]);

export interface DshLogSummary {
	events: number;
	byType: Record<string, number>;
	turns: { turn: number; steps: number; end: string | null; endSynthesised: boolean }[];
	toolCalls: { callId: string; name: string; resultSeq: number | null; isError: boolean | null }[];
	assistantAttempts: number;
	retries: number;
	/** Position of the last tagged `session/end-seed` marker, which cuts inherited history from the session's own. */
	inheritedCut: number | null;
}

export interface DshLogCheck {
	findings: DshFinding[];
	summary: DshLogSummary;
}

/**
 * Structural checks a cold reader can make with no DSH code: the version, contiguous sequence numbers, the pinned vocabulary,
 * surface metadata, turn/step bracketing, tool call/result pairing and the fork cut. Content is never inspected beyond the fields
 * named here. A finding is evidence about the LOG; it is not a claim about what the agent did.
 */
export function checkDshLog(read: DshLogRead, vocabulary: DshVocabulary): DshLogCheck {
	const findings: DshFinding[] = [];
	const add = (code: string, severity: DshFindingSeverity, detail: string, seq?: number): void => {
		findings.push(seq === undefined ? { code, severity, detail } : { code, severity, detail, seq });
	};
	const known = new Set(vocabulary.knownEventTypes);
	const summary: DshLogSummary = {
		events: read.events.length,
		byType: {},
		turns: [],
		toolCalls: [],
		assistantAttempts: 0,
		retries: 0,
		inheritedCut: null,
	};
	for (const problem of read.problems) add("read-problem", "error", problem);
	if (read.tail.kind !== "clean") add(`tail-${read.tail.kind}`, "warning", JSON.stringify(read.tail));
	if (read.header === null) {
		add("no-header", "error", "the log has no readable session header");
		return { findings, summary };
	}
	if (read.header.version !== DSH_SESSION_FORMAT_V4)
		add(
			"format-version",
			"error",
			`header version ${String(read.header.version)}, this study covers ${DSH_SESSION_FORMAT_V4}`,
		);
	const openTurns: number[] = [];
	const openSteps = new Set<string>();
	const calls = new Map<string, DshLogSummary["toolCalls"][number]>();
	const turnIndex = new Map<number, DshLogSummary["turns"][number]>();
	let previousTime: number | null = null;
	let lastTaggedEndSeed: number | null = null;
	for (const [index, event] of read.events.entries()) {
		const data = isRecord(event.data) ? event.data : {};
		summary.byType[event.type] = (summary.byType[event.type] ?? 0) + 1;
		if (event.seq !== index) add("seq-not-contiguous", "error", `expected ${index}, found ${event.seq}`, event.seq);
		// A `plugin:` record is skippable only when it is BOTH well formed and stamped ignorable (DSH's envelope rule).
		const pluginRecord = PLUGIN_RECORD.test(event.type) && event.ignorable === true;
		if (!known.has(event.type) && !pluginRecord) {
			if (event.ignorable === true)
				add("unknown-ignorable-type", "info", `${event.type} is unknown and marked ignorable`, event.seq);
			else
				add(
					"unknown-required-type",
					"error",
					`${event.type} is unknown and not ignorable: a reader must refuse the log`,
					event.seq,
				);
		}
		const surface = SURFACE_TYPES.has(event.type);
		if (surface && event.surfaceOp === undefined)
			add("surface-op-missing", "error", `${event.type} is a surface event without surfaceOp`, event.seq);
		if (known.has(event.type) && !surface && event.surfaceOp !== undefined)
			add("surface-op-unexpected", "error", `${event.type} is a log-only event carrying surfaceOp`, event.seq);
		if (previousTime !== null && event.time < previousTime)
			add("time-went-backwards", "info", "event time is earlier than the previous event's", event.seq);
		previousTime = event.time;
		switch (event.type) {
			case "turn/start": {
				const turn = data.turn as number;
				if (openTurns.length > 0)
					add("turn-nested", "error", `turn ${turn} began inside turn ${openTurns.at(-1)}`, event.seq);
				openTurns.push(turn);
				const entry = { turn, steps: 0, end: null, endSynthesised: false };
				turnIndex.set(turn, entry);
				summary.turns.push(entry);
				break;
			}
			case "turn/end": {
				const turn = data.turn as number;
				const reason = isRecord(data.reason) ? (data.reason.kind as string) : "unknown";
				const entry = turnIndex.get(turn);
				if (entry === undefined)
					add("turn-end-without-start", "error", `turn ${turn} ended without a start`, event.seq);
				else {
					if (entry.end !== null)
						add("turn-ended-twice", "error", `turn ${turn} has more than one turn/end`, event.seq);
					entry.end = reason;
					// `interrupted` and `forked` are written by DSH after the fact (a resumed crash, a fork seed), not by the live turn.
					entry.endSynthesised = reason === "interrupted" || reason === "forked";
				}
				const at = openTurns.indexOf(turn);
				if (at >= 0) openTurns.splice(at, 1);
				for (const key of [...openSteps]) {
					if (key.startsWith(`${turn}:`)) {
						add(
							"step-open-at-turn-end",
							"warning",
							`step ${key} was still open when turn ${turn} ended`,
							event.seq,
						);
						openSteps.delete(key);
					}
				}
				if (reason === "interrupted" || reason === "forked")
					add(
						"closer-synthesised-by-dsh",
						"info",
						`turn ${turn} was closed by DSH after the fact (${reason})`,
						event.seq,
					);
				break;
			}
			case "step/start": {
				const key = `${data.turn}:${data.step}`;
				if (!openTurns.includes(data.turn as number))
					add("step-outside-turn", "error", `step ${key} has no open turn`, event.seq);
				if (openSteps.has(key)) {
					add("step-started-twice", "error", `step ${key} started while already open`, event.seq);
					break;
				}
				openSteps.add(key);
				const entry = turnIndex.get(data.turn as number);
				if (entry !== undefined) entry.steps += 1;
				break;
			}
			case "step/end": {
				const key = `${data.turn}:${data.step}`;
				if (!openSteps.delete(key))
					add("step-end-without-start", "error", `step ${key} ended without a start`, event.seq);
				break;
			}
			case "tool/call": {
				const callId = String(data.callId);
				if (calls.has(callId)) add("duplicate-call-id", "error", "a tool call id repeats", event.seq);
				calls.set(callId, { callId, name: String(data.name), resultSeq: null, isError: null });
				break;
			}
			case "tool/result": {
				const message = isRecord(data.message) ? data.message : {};
				const callId = String(message.toolCallId);
				const call = calls.get(callId);
				if (call === undefined)
					add("result-without-call", "error", "a tool result names no recorded call", event.seq);
				else if (call.resultSeq !== null)
					add("duplicate-tool-result", "error", "a tool call already has a recorded result", event.seq);
				else {
					call.resultSeq = event.seq;
					call.isError = message.isError === true;
				}
				break;
			}
			case "assistant/attempt":
				summary.assistantAttempts += 1;
				break;
			case "llm/retry":
				summary.retries += 1;
				break;
			case "session/end-seed":
				if (data.inherited === true) lastTaggedEndSeed = event.seq;
				break;
			default:
		}
	}
	summary.toolCalls = [...calls.values()];
	for (const call of summary.toolCalls)
		if (call.resultSeq === null)
			add("call-without-result", "warning", `tool call ${call.name} has no recorded result`);
	for (const turn of openTurns) add("turn-open", "warning", `turn ${turn} has no end in the log`);
	for (const key of openSteps) add("step-open", "warning", `step ${key} has no end in the log`);
	if (read.header.isSeeded) {
		// The header says the log begins with inherited history; the cut is the last TAGGED end-seed marker. Both must be present.
		if (lastTaggedEndSeed === null)
			add(
				"fork-cut-unestablished",
				"error",
				"the header says the log is seeded but no tagged end-seed marker exists",
			);
		else summary.inheritedCut = lastTaggedEndSeed;
	} else if (lastTaggedEndSeed !== null) {
		add(
			"fork-cut-unexpected",
			"warning",
			"a tagged end-seed marker exists but the header says the log is not seeded",
		);
		summary.inheritedCut = lastTaggedEndSeed;
	}
	return { findings, summary };
}

/** Whether a check found nothing a reader must refuse the log for. */
export const dshLogAcceptable = (check: DshLogCheck): boolean =>
	check.findings.every((finding) => finding.severity !== "error");

/** Write rows back as the canonical raw form (header, then events), for building fixtures. Not DSH's writer. */
export function encodeDshJsonl(header: unknown, events: readonly unknown[]): string {
	return `${[header, ...events].map((row) => JSON.stringify(row)).join("\n")}\n`;
}
