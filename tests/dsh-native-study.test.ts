// The DSH native-attachment study (research/dsh-native/, docs/dsh-native-attachment.md): the deterministic parts. The real-runtime
// captures are committed only as sanitised fixtures (research/dsh-native/fixtures/real/); the raw captures live outside the
// repository. Three kinds of evidence are kept apart and the tests name which one they use:
//   RUNTIME  the fixtures/real files: output of a real DSH 0.2.1-rc.2 runtime (the model is a local Qwen, or a deterministic stub
//            provider for the retry case), sanitised by research/dsh-native/sanitise.ts;
//   SYNTHETIC  bytes built by research/dsh-native/synthetic.ts from a RUNTIME fixture, to show how a cold reader treats damage;
//   SOURCE   claims about DSH source, checked against the pinned provenance (and against a checkout when ENDO_DSH_CHECKOUT is set).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { endoSecretScanV0 } from "../cli/secret-scan.ts";
import { researchDataRoot } from "../research/data.ts";
import {
	buildProvenance,
	buildVocabulary,
	type DshProvenance,
	type DshVocabularyFile,
} from "../research/dsh-native/inventory.ts";
import {
	checkDshLog,
	DSH_LOG_MAX_DECODED_BYTES,
	type DshLogRead,
	type DshSessionEvent,
	type DshSessionHeader,
	dshLogAcceptable,
	readDshLog,
	scanZstdFrames,
} from "../research/dsh-native/log.ts";
import { reproduce, SCENARIOS } from "../research/dsh-native/reproduce.ts";
import { FIXTURE_EPOCH, findLeaks, Sanitiser } from "../research/dsh-native/sanitise.ts";
import {
	compactionLog,
	corruptFrame,
	encodeFrames,
	encodeRaw,
	forkChild,
	tornFrame,
	withUnknownType,
} from "../research/dsh-native/synthetic.ts";

const STUDY = fileURLToPath(new URL("../research/dsh-native/", import.meta.url));
const FIXTURES = join(STUDY, "fixtures", "real");
const json = <T>(file: string): T => JSON.parse(readFileSync(join(STUDY, file), "utf8")) as T;

const vocabulary = json<DshVocabularyFile>("vocabulary.json");
const provenance = json<DshProvenance>("provenance.json");
const matrix = json<{
	vocabulary: Record<string, string[]>;
	rows: {
		id: string;
		eventTypes: string[];
		verdict: string;
		basis: string[];
		confidence: string;
		native: { stability: string };
		endophasia: { status: string };
		acp: { fidelityVsNative: string };
		hazards: string[];
	}[];
}>("matrix.json");
const comparison = json<Record<string, any>>("fixtures/real/comparison.json");

const rows = (name: string): { header: DshSessionHeader; events: DshSessionEvent[]; read: DshLogRead } => {
	const read = readDshLog(readFileSync(join(FIXTURES, `${name}.events.jsonl`)));
	return { header: read.header!, events: read.events, read };
};
const check = (name: string) => checkDshLog(rows(name).read, vocabulary);

const checkout = process.env.ENDO_DSH_CHECKOUT;

describe("provenance and pinned vocabulary (SOURCE)", () => {
	it("pins one DSH commit, a released Session format 4 and the audited files by sha256", () => {
		expect(provenance.dsh.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(provenance.dsh.describe).toBe("dsh-v0.2.1-rc.2");
		expect(provenance.dsh.workingTreeClean).toBe(true);
		expect(vocabulary.sessionFormatVersion).toBe(4);
		for (const [file, entry] of Object.entries(provenance.files)) {
			expect(file, file).toMatch(/^(packages|docs|apps)\//);
			expect(entry.sha256, file).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("pins the type fingerprints that are DSH's real compatibility contract: header, envelope and one root per event type", () => {
		const keys = vocabulary.roots.map((root) => root.key);
		expect(keys).toEqual(expect.arrayContaining(["SessionHeader", "JsonlHeaderLine", "SessionEventEnvelope"]));
		const events = vocabulary.roots
			.filter((root) => root.kind === "event")
			.map((root) => root.key.replace(/^event:/, ""));
		expect([...events].sort()).toEqual([...vocabulary.knownEventTypes].sort());
		for (const root of vocabulary.roots) expect(root.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	// Without a checkout vitest reports this as skipped, not green.
	it.skipIf(!checkout || !existsSync(checkout))(
		"describes the checkout when ENDO_DSH_CHECKOUT points at one (opt-in)",
		() => {
			const current = buildProvenance(checkout!);
			// A moved checkout is a signal to re-audit, not a failure of the code: say so in the message.
			expect(
				current.dsh.commit,
				"the DSH checkout moved: re-run research/dsh-native/inventory.ts and re-read the audit",
			).toBe(provenance.dsh.commit);
			expect(current.dsh).toEqual(provenance.dsh);
			expect(current.files).toEqual(provenance.files);
			expect(buildVocabulary(checkout!)).toEqual(vocabulary);
		},
	);
});

describe("the fidelity matrix covers the vocabulary exactly", () => {
	it("assigns every DSH event type to exactly one row, and no unknown type to any", () => {
		const assigned = matrix.rows.flatMap((row) => row.eventTypes);
		expect(new Set(assigned).size).toBe(assigned.length);
		expect([...assigned].sort()).toEqual([...vocabulary.knownEventTypes].sort());
	});

	it("uses only the closed vocabularies, and every row carries its basis, confidence and hazards", () => {
		const closed = matrix.vocabulary;
		for (const row of matrix.rows) {
			expect(closed.verdicts, row.id).toContain(row.verdict);
			expect(closed.verdicts, row.id).toContain(row.acp.fidelityVsNative);
			expect(closed.confidence, row.id).toContain(row.confidence);
			expect(closed.stability, row.id).toContain(row.native.stability);
			expect(closed.endophasiaStatus, row.id).toContain(row.endophasia.status);
			expect(row.basis.length, row.id).toBeGreaterThan(0);
			for (const basis of row.basis) expect(closed.bases, row.id).toContain(basis);
			expect(row.hazards.length, row.id).toBeGreaterThan(0);
		}
		expect(matrix.rows.map((row) => row.id)).toEqual(
			expect.arrayContaining([
				"run-structure",
				"step-structure",
				"tools",
				"attempts-retries",
				"ancestry",
				"live-only",
				"restored-history",
				"durability",
			]),
		);
	});

	it("never claims runtime evidence for what the experiment could not provoke", () => {
		const byId = new Map(matrix.rows.map((row) => [row.id, row]));
		// Compaction and ancestry were not produced by the runtime experiment; orchestration is experimental source only.
		for (const id of ["compaction", "ancestry", "orchestration", "interaction", "workspace"])
			expect(byId.get(id)!.basis, id).not.toContain("runtime-observed");
		for (const id of ["run-structure", "tools", "attempts-retries", "assistant-message", "envelope", "durability"])
			expect(byId.get(id)!.basis, id).toContain("runtime-observed");
	});
});

describe("RUNTIME fixtures are sanitised", () => {
	const files = readdirSync(FIXTURES);
	it("contain no home path, user name, provider response id, unmapped uuid or system prompt text", () => {
		expect(files.length).toBeGreaterThanOrEqual(11);
		for (const file of files) {
			const text = readFileSync(join(FIXTURES, file), "utf8");
			expect(
				// The canaries are taken from the machine running the test (its absolute home path), plus fixed markers: no personal data is
				// written into the repository to search for it.
				findLeaks(text, [homedir(), "endophasia-research", "You are a coding agent"]),
				file,
			).toEqual([]);
			expect(endoSecretScanV0([{ where: file, text }], ["/fixture"]).findings, file).toEqual([]);
		}
	});

	it("keep the system prompt and injected context only as length, and the study's own prompt verbatim", () => {
		const { events } = rows("tool-read");
		const system = events.find((event) => event.type === "system/message")!;
		expect(JSON.stringify(system.data)).toMatch(/\[withheld: \d+ chars\]/);
		const users = events.filter((event) => event.type === "user/message");
		expect(users).toHaveLength(2);
		expect(JSON.stringify(users[0]!.data)).toContain("read the file notes.txt");
		expect(JSON.stringify(users[1]!.data)).not.toContain("Current working directory");
	});

	it("map every random id consistently: the call id is one ordinal in the event, the result and the content part", () => {
		const { events } = rows("tool-read");
		const call = events.find((event) => event.type === "tool/call")!.data as { callId: string };
		const result = events.find((event) => event.type === "tool/result")!.data as {
			message: { toolCallId: string; source: { callId: string } };
		};
		const message = events.find((event) => event.type === "assistant/message")!.data as {
			message: { content: { type: string; id?: string }[] };
		};
		expect(call.callId).toBe("call-1");
		expect(result.message.toolCallId).toBe("call-1");
		expect(result.message.source.callId).toBe("call-1");
		expect(message.message.content.find((part) => part.type === "tool-call")!.id).toBe("call-1");
	});

	it("keep time DIFFERENCES and lose the date", () => {
		const { header, events } = rows("tool-read");
		expect(header.createdAt).toBe(FIXTURE_EPOCH);
		expect(events[0]!.time - FIXTURE_EPOCH).toBeLessThan(100);
		const assistant = events.find((event) => event.type === "assistant/message")!;
		expect(assistant.time - events[0]!.time).toBeGreaterThan(100);
	});
});

describe("RUNTIME: what a real DSH 0.2.1-rc.2 run demonstrated", () => {
	it("tool-read: a complete turn of two steps with one paired read call, usage on both messages, and no findings that refuse the log", () => {
		const result = check("tool-read");
		expect(dshLogAcceptable(result)).toBe(true);
		expect(result.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
		expect(result.summary.turns).toEqual([{ turn: 1, steps: 2, end: "completed", endSynthesised: false }]);
		expect(result.summary.toolCalls).toEqual([{ callId: "call-1", name: "read", resultSeq: 15, isError: false }]);
		const usage = rows("tool-read")
			.events.filter((event) => event.type === "assistant/message")
			.map((event) => (event.data as { usage?: Record<string, number> }).usage);
		// Per-call usage as DSH reported it; the model's text and counts vary from run to run, the shape does not.
		for (const entry of usage) {
			expect(Object.keys(entry!)).toEqual(expect.arrayContaining(["inputTokens", "outputTokens", "totalTokens"]));
			// A count DSH did not report is absent, not 0.
			expect(entry).not.toHaveProperty("cacheWriteTokens");
			expect(entry).not.toHaveProperty("reasoningTokens");
		}
		expect(usage[1]).toHaveProperty("cacheReadTokens");
		expect(
			rows("tool-read")
				.events.slice(0, 3)
				.map((event) => event.type),
		).toEqual(["permission/preset", "sandbox/mode", "approval/policy"]);
	});

	it("tool-read: there is no tool START event, and the call is committed right after the assistant message that requested it", () => {
		const { events } = rows("tool-read");
		const types = events.map((event) => event.type);
		expect(types.filter((type) => type.startsWith("tool/"))).toEqual(["tool/call", "tool/result"]);
		const message = events.find((event) => event.type === "assistant/message")!;
		const call = events.find((event) => event.type === "tool/call")!;
		expect(call.seq).toBe(message.seq + 1);
		expect(call.time - message.time).toBeLessThan(50);
	});

	it("no-key-error: a failed turn is a structured reason on turn/end plus a committed attempt, with no assistant message", () => {
		const result = check("no-key-error");
		expect(result.summary.turns).toEqual([{ turn: 1, steps: 1, end: "error", endSynthesised: false }]);
		expect(result.summary.assistantAttempts).toBe(1);
		expect(result.summary.byType["assistant/message"]).toBeUndefined();
		const end = rows("no-key-error").events.find((event) => event.type === "turn/end")!.data as {
			reason: { kind: string; error: { code: string } };
		};
		expect(end.reason).toMatchObject({ kind: "error", error: { code: "PI_AI_ERROR" } });
		expect(readFileSync(join(FIXTURES, "no-key-error.stream.ndjson"), "utf8")).toContain('"kind":"error"');
	});

	it("crash-killed: SIGKILL mid-stream leaves the turn and step open, and the partial assistant output exists nowhere", () => {
		const result = check("crash-killed");
		expect(result.findings.map((finding) => finding.code).sort()).toEqual(["step-open", "turn-open"]);
		expect(result.summary.byType["assistant/message"]).toBeUndefined();
		expect(result.summary.byType["assistant/attempt"]).toBeUndefined();
		expect(comparison["crash-killed"].transientAssistantStreamFrames.chunk).toBeGreaterThan(40);
		expect(comparison["crash-killed"].persistedEvents).toBe(13);
		expect(comparison["crash-killed"].liveEvents).toBe(13);
	});

	it("crash-resumed: the resume appends interrupted closers whose time is COPIED from the last event, then an untagged end-seed", () => {
		const { events } = rows("crash-resumed");
		const result = check("crash-resumed");
		expect(result.summary.turns).toEqual([
			{ turn: 1, steps: 1, end: "interrupted", endSynthesised: true },
			{ turn: 2, steps: 1, end: "completed", endSynthesised: false },
		]);
		expect(result.findings.map((finding) => finding.code)).toEqual(["closer-synthesised-by-dsh"]);
		const [title, stepEnd, turnEnd, endSeed] = events.slice(12, 16);
		expect([title!.type, stepEnd!.type, turnEnd!.type, endSeed!.type]).toEqual([
			"session/title",
			"step/end",
			"turn/end",
			"session/end-seed",
		]);
		// The invented timestamp: the closers carry the title's time, not the time of the resume (the end-seed's is much later).
		expect(stepEnd!.time).toBe(title!.time);
		expect(turnEnd!.time).toBe(title!.time);
		expect(endSeed!.time - title!.time).toBeGreaterThan(1000);
		// The end-seed written at resume is NOT the fork marker: untagged, so there is no inherited cut.
		expect(endSeed!.data).toEqual({});
		expect(result.summary.inheritedCut).toBeNull();
	});

	it("stub-retry: a real runtime logs the failed attempt, the retry decision and the restart, which the --json stream never shows", () => {
		const { events } = rows("stub-retry");
		const order = events
			.map((event) => event.type)
			.filter((type) => ["assistant/attempt", "llm/retry", "llm/retry-started", "assistant/message"].includes(type));
		expect(order).toEqual(["assistant/attempt", "llm/retry", "llm/retry-started", "assistant/message"]);
		const retry = events.find((event) => event.type === "llm/retry")!.data as {
			retryId: string;
			failure: { code: string; status: number };
			retry: number;
		};
		const started = events.find((event) => event.type === "llm/retry-started")!.data as { retryId: string };
		expect(retry).toMatchObject({ retryId: "retry-1", retry: 1, failure: { code: "RATE_LIMIT", status: 429 } });
		expect(started.retryId).toBe(retry.retryId);
		const stream = readFileSync(join(FIXTURES, "stub-retry.stream.ndjson"), "utf8");
		expect(stream).not.toMatch(/retry|attempt|RATE_LIMIT/);
	});
});

describe("RUNTIME: the live feed against the persisted log", () => {
	it("is byte-equal to the persisted log when the observer is attached from the start", () => {
		for (const name of ["tool-read", "no-key-error", "crash-killed", "stub-retry"]) {
			expect(comparison[name].liveEqualsPersisted, name).toBe(true);
			expect(comparison[name].liveOnlyTypes, name).toEqual([]);
		}
	});

	it("never announces restored history, resume closers or the resume marker: only appends after attach", () => {
		const resumed = comparison["crash-resumed"];
		expect(resumed.liveEqualsPersisted).toBe(false);
		expect(resumed.liveFirstSeq).toBe(16);
		expect(resumed.liveIsExactlyThePersistedSuffixFromThere).toBe(true);
		expect(resumed.persistedEventsNeverAnnouncedLive).toHaveLength(16);
		expect(resumed.persistedEventsNeverAnnouncedLive).toEqual(
			expect.arrayContaining(["13:step/end", "14:turn/end", "15:session/end-seed"]),
		);
	});

	it("shows the streaming frames only live: dozens of chunk frames, none stored as such", () => {
		expect(comparison["tool-read"].transientAssistantStreamFrames.chunk).toBeGreaterThan(30);
		for (const name of Object.keys(comparison))
			expect(
				rows(name).events.some((event) => event.type === "agent/assistant-stream"),
				name,
			).toBe(false);
	});
});

describe("SYNTHETIC: a cold reader's behaviour on damaged or unfamiliar bytes", () => {
	const { header, events } = rows("tool-read");
	const full = encodeFrames(header, events, 4);
	const frames = scanZstdFrames(full).frames;

	it("scans the frames without decompressing and agrees with the encoder", () => {
		expect(frames.length).toBe(Math.ceil(events.length / 4));
		expect(frames.at(-1)!.end).toBe(full.length);
		expect(scanZstdFrames(full).trailing).toBe(0);
		const read = readDshLog(full);
		expect(read).toMatchObject({ physical: "zstd", frames: frames.length, tail: { kind: "clean" }, problems: [] });
		expect(read.events).toEqual(events);
	});

	it("reports a torn final frame at EVERY cut offset, keeps the complete frames before it, and repairs nothing", () => {
		const last = frames.at(-1)!;
		const kept = events.slice(0, (frames.length - 1) * 4);
		for (let keep = 1; keep < last.end - last.start; keep += 1) {
			const cut = tornFrame(full, keep, frames);
			const before = Buffer.from(cut);
			const read = readDshLog(cut);
			expect(read.tail, `keep ${keep}`).toEqual({
				kind: "torn-frame",
				completeBytes: last.start,
				trailingBytes: keep,
			});
			expect(read.events, `keep ${keep}`).toEqual(kept);
			expect(read.problems).toEqual([]);
			expect(Buffer.compare(cut, before), "the input was not modified").toBe(0);
		}
	});

	it("cannot tell a log cut exactly at a frame boundary from a shorter log (a stated limit)", () => {
		const cut = full.subarray(0, frames.at(-1)!.start);
		const read = readDshLog(cut);
		expect(read.tail).toEqual({ kind: "clean" });
		expect(read.events.length).toBe((frames.length - 1) * 4);
	});

	it("treats a complete frame that does not decode as corruption, never as a torn tail", () => {
		const read = readDshLog(corruptFrame(full, frames, 1));
		expect(read.tail.kind).toBe("unreadable");
		expect(read.events).toEqual([]);
		expect(read.problems.join(" ")).toMatch(/failed to decode/);
	});

	it("reports a torn raw row and keeps the complete rows", () => {
		const raw = encodeRaw(header, events);
		const read = readDshLog(raw.subarray(0, raw.length - 20));
		expect(read.physical).toBe("jsonl");
		expect(read.tail.kind).toBe("torn-row");
		expect(read.events.length).toBe(events.length - 1);
	});

	it("refuses an unknown event type unless it is marked ignorable, and counts the ignorable one", () => {
		const required = checkDshLog(readDshLog(encodeRaw(header, withUnknownType(events, 6, false))), vocabulary);
		expect(required.findings.map((finding) => finding.code)).toContain("unknown-required-type");
		expect(dshLogAcceptable(required)).toBe(false);
		const skippable = checkDshLog(readDshLog(encodeRaw(header, withUnknownType(events, 6, true))), vocabulary);
		expect(skippable.findings.map((finding) => finding.code)).toEqual(["unknown-ignorable-type"]);
		expect(dshLogAcceptable(skippable)).toBe(true);
	});

	it("refuses a sequence gap, a stale format version and a surface event without placement", () => {
		const gap = events.map((event, index) => (index > 5 ? { ...event, seq: event.seq + 1 } : event));
		expect(checkDshLog(readDshLog(encodeRaw(header, gap)), vocabulary).findings.map((f) => f.code)).toContain(
			"seq-not-contiguous",
		);
		const old = checkDshLog(readDshLog(encodeRaw({ ...header, version: 3 }, events)), vocabulary);
		expect(old.findings.map((finding) => finding.code)).toContain("format-version");
		const bare = events.map((event) => {
			const { surfaceOp: _surfaceOp, ...rest } = event;
			return rest as DshSessionEvent;
		});
		expect(checkDshLog(readDshLog(encodeRaw(header, bare)), vocabulary).findings.map((f) => f.code)).toContain(
			"surface-op-missing",
		);
	});

	it("establishes a fork cut only when the header and the last TAGGED end-seed agree", () => {
		const child = forkChild(header, events, 9, events.slice(9, 12));
		const read = readDshLog(encodeRaw(child.header, child.events));
		const ok = checkDshLog(read, vocabulary);
		expect(ok.summary.inheritedCut).toBe(9);
		expect(ok.findings.filter((finding) => finding.severity === "error")).toEqual([]);
		// Header says seeded, marker untagged: the cut is unestablished, not guessed.
		const broken = forkChild(header, events, 9, events.slice(9, 12), false);
		const bad = checkDshLog(readDshLog(encodeRaw(broken.header, broken.events)), vocabulary);
		expect(bad.findings.map((finding) => finding.code)).toContain("fork-cut-unestablished");
		expect(bad.summary.inheritedCut).toBeNull();
		// A tagged marker under an unseeded header is flagged too.
		const contradicting = checkDshLog(
			readDshLog(encodeRaw({ ...child.header, isSeeded: false }, child.events)),
			vocabulary,
		);
		expect(contradicting.findings.map((finding) => finding.code)).toContain("fork-cut-unexpected");
		// The inherited prefix is byte-identical to the parent's: counting both double-counts it.
		expect(child.events.slice(0, 9)).toEqual(events.slice(0, 9));
	});

	it("reads a compaction log whose replaced events remain in the log, with the surface replacement placed", () => {
		const log = compactionLog(header);
		const result = checkDshLog(readDshLog(encodeRaw(log.header, log.events)), vocabulary);
		expect(dshLogAcceptable(result)).toBe(true);
		expect(result.summary.byType["compaction/summary"]).toBe(1);
		const replaced = log.events.filter((event) => event.seq === 2 || event.seq === 3);
		expect(replaced.map((event) => event.type)).toEqual(["user/message", "assistant/message"]);
	});

	it("reads garbage and an empty input as findings, not exceptions", () => {
		expect(readDshLog(Buffer.alloc(0))).toMatchObject({ header: null, events: [], tail: { kind: "clean" } });
		expect(checkDshLog(readDshLog(Buffer.alloc(0)), vocabulary).findings.map((f) => f.code)).toContain("no-header");
		const garbage = readDshLog(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0xff, 0xff, 0xff]));
		expect(["unreadable", "torn-frame"]).toContain(garbage.tail.kind);
		expect(readDshLog(Buffer.from("not json\n")).problems.length).toBeGreaterThan(0);
	});
});

describe("the study utility is read-only by construction", () => {
	it("imports nothing but node:zlib, opens no file, spawns nothing and holds no write path", () => {
		const source = readFileSync(join(STUDY, "log.ts"), "utf8");
		const code = source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		expect([...code.matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((match) => match[1])).toEqual(["node:zlib"]);
		expect(code).not.toMatch(
			/\b(readFileSync|writeFileSync|openSync|createWriteStream|appendFile|child_process|lockfile|flock)\b/,
		);
	});

	it("does not depend on DSH or Cordis anywhere in the study's code", () => {
		for (const file of readdirSync(STUDY).filter((name) => name.endsWith(".ts"))) {
			const source = readFileSync(join(STUDY, file), "utf8");
			expect(source, file).not.toMatch(/from "@deepseek-ai|from "cordis|from "@cordisjs/);
		}
	});

	it("keeps harness-neutral code free of DSH: nothing outside research/ and the study's tests names it", () => {
		for (const dir of ["protocol", "runtime", "storage", "cockpit", "cockpit-http", "studio-ui/src", "adapters"]) {
			const root = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
			const walk = (path: string): string[] =>
				readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
					entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
				);
			for (const file of walk(root).filter((name) => /\.(ts|tsx)$/.test(name))) {
				const source = readFileSync(file, "utf8");
				expect(source, file).not.toMatch(/dsh-native|DeepSeek Harness|@deepseek-ai\/dsh/i);
			}
		}
	});
});

describe("the sanitiser", () => {
	const raw = {
		header: {
			type: "session",
			version: 4,
			id: "session-1111aaaa-0000-4000-8000-000000000001",
			createdAt: 1_792_000_000_000,
			cwd: "/home/someone/proj/ws",
			isSeeded: false,
		},
		events: [
			{
				type: "system/message",
				seq: 0,
				time: 1_792_000_000_010,
				surfaceOp: "append",
				data: {
					turn: 1,
					step: 1,
					message: {
						role: "system",
						content: [{ type: "text", text: "SECRET SYSTEM PROMPT /home/someone" }],
						id: "11111111-2222-4333-8444-555555555555",
					},
				},
			},
			{
				type: "user/message",
				seq: 1,
				time: 1_792_000_000_020,
				surfaceOp: "append",
				data: {
					content: [{ type: "text", text: "the study prompt" }],
					source: { kind: "user" },
					id: "22222222-2222-4333-8444-555555555555",
				},
			},
			{
				type: "user/message",
				seq: 2,
				time: 1_792_000_000_021,
				surfaceOp: "append",
				data: {
					content: [{ type: "text", text: "injected /home/someone/env" }],
					source: { kind: "runtime-context", sections: [{ name: "a", text: "cwd /home/someone/proj" }] },
					id: "33333333-2222-4333-8444-555555555555",
				},
			},
			{
				type: "tool/call",
				seq: 3,
				time: 1_792_000_000_030,
				data: { turn: 1, step: 1, callId: "AbCdEf123", name: "read", arguments: "{}" },
			},
		],
	};
	const make = () =>
		new Sanitiser({
			paths: [
				{ prefix: "/home/someone/proj/ws", label: "workspace" },
				{ prefix: "/home/someone", label: "home" },
			],
			keepUserTexts: ["the study prompt"],
			canaries: [],
		});

	it("withholds system and injected text, keeps the study prompt, maps ids and paths, and shifts time without changing differences", () => {
		const out = make().sanitiseLog(raw.header, raw.events) as { header: any; events: any[] };
		const text = JSON.stringify(out);
		expect(findLeaks(text, ["someone", "SECRET", "AbCdEf123", "injected"])).toEqual([]);
		expect(out.header).toMatchObject({ id: "session-1", createdAt: FIXTURE_EPOCH, cwd: "/fixture/workspace" });
		expect(out.events[1].data.content[0].text).toBe("the study prompt");
		expect(out.events[2].data.source.sections[0].text).toMatch(/^\[withheld: \d+ chars\]$/);
		expect(out.events[3].data.callId).toBe("call-1");
		expect(out.events.map((event) => event.time - FIXTURE_EPOCH)).toEqual([10, 20, 21, 30]);
	});

	it("is deterministic and does not modify its input", () => {
		const before = JSON.stringify(raw);
		const a = JSON.stringify(make().sanitiseLog(raw.header, raw.events));
		const b = JSON.stringify(make().sanitiseLog(raw.header, raw.events));
		expect(a).toBe(b);
		expect(JSON.stringify(raw)).toBe(before);
	});

	it("flags a leak the sanitiser missed", () => {
		expect(findLeaks('{"p":"/home/zed/x"}', [])).toEqual([expect.stringContaining("home path")]);
		expect(findLeaks("chatcmpl-abc123", [])).toEqual([expect.stringContaining("provider response id")]);
		expect(findLeaks("owner: zed", ["zed"])).toHaveLength(1);
	});
});

describe("reproduction against a real DSH checkout (opt-in: ENDO_DSH_CHECKOUT)", () => {
	const enabled = checkout !== undefined && existsSync(checkout);
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	// Without a checkout this is reported as skipped by vitest, not silently green.
	it.skipIf(!enabled)(
		"re-runs the deterministic stub-provider scenario and reproduces the committed retry fixture, ignoring only timing",
		async () => {
			// Raw captures hold the real system prompt: they go to the research-data directory, never to the system temp directory.
			const base = join(researchDataRoot(), "dsh-native", "test-runs");
			mkdirSync(base, { recursive: true });
			const out = mkdtempSync(join(base, 'run- # " [quoted]-'));
			dirs.push(out);
			const result = await reproduce({ dsh: checkout!, out, scenario: "stub-retry" });
			expect(result.code).toBe(0);
			const read = readDshLog(readFileSync(join(result.dir, "session.v4.jsonl.zstd")));
			const sanitiser = new Sanitiser({
				paths: [
					{ prefix: join(out, "stub-retry", "ws"), label: "workspace" },
					{ prefix: out, label: "study" },
				],
				keepUserTexts: ["hello"],
				canaries: [],
			});
			const clean = sanitiser.sanitiseLog(read.header, read.events) as {
				header: DshSessionHeader;
				events: DshSessionEvent[];
			};
			const strip = (value: unknown): unknown => {
				if (Array.isArray(value)) return value.map(strip);
				if (value !== null && typeof value === "object")
					return Object.fromEntries(
						Object.entries(value as Record<string, unknown>)
							.filter(([key]) => key !== "time" && key !== "time0" && key !== "dt" && key !== "createdAt")
							.map(([key, item]) => [key, strip(item)]),
					);
				// A withheld injected context embeds the working directory: its length and digest depend on where the run happened.
				return typeof value === "string" ? value.replace(/\[withheld: \d+ chars\]/g, "[withheld]") : value;
			};
			const committed = rows("stub-retry");
			expect(strip(clean.events)).toEqual(strip(committed.events));
			expect(strip(clean.header)).toEqual(strip(committed.header));
		},
		120_000,
	);
});

/** A Zstandard frame built byte by byte (RFC 8878 section 3), to test the scanner on every header shape without an encoder. */
function rawFrame(options: {
	descriptor: number;
	window?: number;
	dictionary?: number[];
	contentSize?: number[];
	blocks: { last: boolean; type: 0 | 1 | 2; size: number; body: number }[];
	checksum?: boolean;
}): Buffer {
	const bytes = [0x28, 0xb5, 0x2f, 0xfd, options.descriptor];
	if (options.window !== undefined) bytes.push(options.window);
	bytes.push(...(options.dictionary ?? []), ...(options.contentSize ?? []));
	for (const block of options.blocks) {
		const header = (block.last ? 1 : 0) | (block.type << 1) | (block.size << 3);
		bytes.push(header & 255, (header >> 8) & 255, (header >> 16) & 255);
		for (let i = 0; i < block.body; i += 1) bytes.push(0);
	}
	if (options.checksum) bytes.push(1, 2, 3, 4);
	return Buffer.from(bytes);
}

describe("the frame scanner on every header shape (SYNTHETIC bytes)", () => {
	const frameLength = (buffer: Buffer): number[] =>
		scanZstdFrames(buffer).frames.map((frame) => frame.end - frame.start);

	it("skips the window descriptor, but not in single-segment mode", () => {
		const normal = rawFrame({ descriptor: 0x00, window: 0x10, blocks: [{ last: true, type: 0, size: 3, body: 3 }] });
		const single = rawFrame({
			descriptor: 0x20 | 0x00,
			contentSize: [3],
			blocks: [{ last: true, type: 0, size: 3, body: 3 }],
		});
		expect(frameLength(normal)).toEqual([normal.length]);
		expect(frameLength(single)).toEqual([single.length]);
	});

	it("reads each dictionary-id width (0, 1, 2 and 4 bytes)", () => {
		for (const [flag, width] of [
			[0, 0],
			[1, 1],
			[2, 2],
			[3, 4],
		] as const) {
			const frame = rawFrame({
				descriptor: flag,
				window: 1,
				dictionary: Array(width).fill(7),
				blocks: [{ last: true, type: 0, size: 2, body: 2 }],
			});
			expect(frameLength(frame), `dictionary flag ${flag}`).toEqual([frame.length]);
		}
	});

	it("reads each frame-content-size width (none, 1 in single-segment mode, 2, 4 and 8 bytes)", () => {
		for (const [flag, single, width] of [
			[0, true, 1],
			[1, false, 2],
			[2, false, 4],
			[3, false, 8],
		] as const) {
			const frame = rawFrame({
				descriptor: (flag << 6) | (single ? 0x20 : 0),
				...(single ? {} : { window: 1 }),
				contentSize: Array(width).fill(1),
				blocks: [{ last: true, type: 0, size: 1, body: 1 }],
			});
			expect(frameLength(frame), `content size flag ${flag}`).toEqual([frame.length]);
		}
	});

	it("counts an RLE block as one stored byte however large its regenerated size, and a raw block as its size", () => {
		const rle = rawFrame({ descriptor: 0x00, window: 1, blocks: [{ last: true, type: 1, size: 100_000, body: 1 }] });
		expect(frameLength(rle)).toEqual([rle.length]);
		const mixed = rawFrame({
			descriptor: 0x00,
			window: 1,
			blocks: [
				{ last: false, type: 0, size: 4, body: 4 },
				{ last: true, type: 2, size: 5, body: 5 },
			],
		});
		expect(frameLength(mixed)).toEqual([mixed.length]);
	});

	it("includes the content checksum, finds the boundary of the next frame, and reports a cut anywhere inside one", () => {
		const a = rawFrame({
			descriptor: 0x04,
			window: 1,
			blocks: [{ last: true, type: 0, size: 2, body: 2 }],
			checksum: true,
		});
		const b = rawFrame({ descriptor: 0x00, window: 1, blocks: [{ last: true, type: 0, size: 2, body: 2 }] });
		const both = Buffer.concat([a, b]);
		expect(frameLength(both)).toEqual([a.length, b.length]);
		for (let keep = 1; keep < b.length; keep += 1) {
			const scan = scanZstdFrames(both.subarray(0, a.length + keep));
			expect(scan.frames).toHaveLength(1);
			expect(scan.trailing).toBe(keep);
		}
	});

	it("refuses a skippable frame, a reserved header bit, a reserved block type and non-frame bytes: DSH writes none of them", () => {
		const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
		expect(() => scanZstdFrames(skippable)).toThrow(/skippable/);
		expect(() =>
			scanZstdFrames(rawFrame({ descriptor: 0x08, window: 1, blocks: [{ last: true, type: 0, size: 0, body: 0 }] })),
		).toThrow(/reserved frame header bit/);
		const reserved = rawFrame({ descriptor: 0x00, window: 1, blocks: [{ last: true, type: 0, size: 0, body: 0 }] });
		reserved[6] = (reserved[6]! & ~0b110) | 0b110;
		expect(() => scanZstdFrames(reserved)).toThrow(/reserved Zstandard block type/);
		expect(() => scanZstdFrames(Buffer.from("not a frame at all"))).toThrow(/not a Zstandard frame/);
		expect(readDshLog(skippable).tail.kind).toBe("unreadable");
	});
});

describe("a hostile or odd log is bounded and classified (SYNTHETIC)", () => {
	const { header, events } = rows("tool-read");

	it("stops at a decoded-size bound instead of holding a decompression bomb in memory", () => {
		// 8 MiB of zeroes is a few hundred bytes compressed; the bound is far below it.
		const bomb = encodeFrames(header, events, 4);
		const huge = zstdCompressSync(Buffer.alloc(8 * 1024 * 1024), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
		expect(huge.length).toBeLessThan(2000);
		const read = readDshLog(Buffer.concat([bomb, huge]), 1024 * 1024);
		expect(read.tail).toEqual({ kind: "unreadable", reason: "the decoded size bound was exceeded" });
		expect(read.problems.join(" ")).toMatch(/exceed 1048576 bytes/);
		expect(DSH_LOG_MAX_DECODED_BYTES).toBe(64 * 1024 * 1024);
		expect(readDshLog(bomb).events).toEqual(events);
	});

	it("reports a complete zstd frame that ends inside a row as a torn row, not as a clean log", () => {
		const text = encodeRaw(header, events).toString("utf8");
		const cut = Buffer.from(text.slice(0, text.length - 25), "utf8");
		const read = readDshLog(zstdCompressSync(cut, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
		expect(read.tail.kind).toBe("torn-row");
		expect(read.events.length).toBe(events.length - 1);
	});

	it("counts the torn bytes of a raw log in bytes, also when the cut falls inside a multibyte character", () => {
		const row = { ...events[0]!, data: { note: "é" } };
		const raw = encodeRaw(header, [row]);
		const cutAt = raw.lastIndexOf(0xc3) + 1;
		const read = readDshLog(raw.subarray(0, cutAt));
		expect(read.tail).toEqual({ kind: "torn-row", trailingBytes: cutAt - (raw.indexOf(0x0a) + 1) });
	});

	it("skips a plugin record only when it is well formed AND ignorable", () => {
		const record = (type: string, ignorable: boolean): DshSessionEvent[] => [
			...events.slice(0, 4),
			{ type, seq: 4, time: events[3]!.time, data: {}, ...(ignorable ? { ignorable: true as const } : {}) },
		];
		const codes = (list: DshSessionEvent[]) =>
			checkDshLog(readDshLog(encodeRaw(header, list)), vocabulary).findings.map((f) => f.code);
		expect(codes(record("plugin:acme/state", true))).toEqual([]);
		expect(codes(record("plugin:acme/state", false))).toContain("unknown-required-type");
		// Malformed but ignorable falls under the generic envelope rule (skippable, counted); malformed and required is refused.
		expect(codes(record("plugin:Bad Name", true))).toEqual(["unknown-ignorable-type"]);
		expect(codes(record("plugin:Bad Name", false))).toContain("unknown-required-type");
	});

	it("flags nesting, a repeated call id, a result without a call, and a surface placement on a log-only event", () => {
		const base = events.map((event) => ({ ...event }));
		const code = (list: DshSessionEvent[]) =>
			checkDshLog(readDshLog(encodeRaw(header, list)), vocabulary).findings.map((f) => f.code);
		const at = (type: string) => base.findIndex((event) => event.type === type);
		const nested = base.map((event) => ({ ...event }));
		nested.splice(at("step/start"), 0, { type: "turn/start", seq: 0, time: 1, data: { turn: 9 } });
		expect(code(nested.map((event, seq) => ({ ...event, seq })))).toContain("turn-nested");
		const duplicate = base.map((event) => ({ ...event }));
		duplicate.splice(at("tool/call") + 1, 0, { ...base[at("tool/call")]!, seq: 0 });
		expect(code(duplicate.map((event, seq) => ({ ...event, seq })))).toContain("duplicate-call-id");
		const orphan = base.filter((event) => event.type !== "tool/call").map((event, seq) => ({ ...event, seq }));
		expect(code(orphan)).toContain("result-without-call");
		const placed = base.map((event) => (event.type === "step/start" ? { ...event, surfaceOp: "append" } : event));
		expect(code(placed)).toContain("surface-op-unexpected");
		const outside = base.filter((event) => event.type !== "turn/start").map((event, seq) => ({ ...event, seq }));
		expect(code(outside)).toContain("step-outside-turn");
		const twice = [...base, { ...base[at("turn/end")]!, seq: base.length }];
		expect(code(twice)).toContain("turn-ended-twice");
		const leftOpen = base
			.filter((event) => !(event.type === "step/end" && (event.data as { step: number }).step === 2))
			.map((event, seq) => ({ ...event, seq }));
		expect(code(leftOpen)).toContain("step-open-at-turn-end");
		const backwards = base.map((event, index) => (index === 8 ? { ...event, time: 0 } : event));
		expect(code(backwards)).toContain("time-went-backwards");
	});
});

describe("the reproduction harness refuses what it could delete", () => {
	it("accepts only its own scenario names, before anything is removed", async () => {
		expect(SCENARIOS).toEqual(["stub-retry", "tool-read", "no-key-error", "crash"]);
		for (const scenario of ["raw", "..", "../..", "stub-retry/../raw", ""])
			await expect(
				reproduce({ dsh: "/nonexistent", out: "/nonexistent-out", scenario: scenario as never }),
			).rejects.toThrow(/unknown scenario/);
		expect(existsSync("/nonexistent-out")).toBe(false);
	});
});
