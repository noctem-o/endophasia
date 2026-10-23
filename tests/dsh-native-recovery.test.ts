// Regression tests for two corrections to the DSH native importer (adapters/dsh-native/):
//   1. what a step's committed output establishes, and how a step DSH closed retrospectively (recovery, fork seed) is reported;
//   2. the historical-header check, which must notice a changed working directory without ever storing it.
// Inputs: the REAL crash-resumed fixture of the PR #70 study, and SYNTHETIC variants built by code from the real tool-read fixture
// (the variants say so). DSH recovery appends, with the last real event's time: error results for unanswered calls, a step/end for an
// open step, and a turn/end of reason `interrupted` or `forked` (packages/core/session/src/repair.ts at the pinned commit).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	DSH_NATIVE_MAPPING_VERSION_V0,
	type DshSessionEvent,
	type DshSessionHeader,
	importDshSessionBytesV0,
	projectDshTrajectoryV0,
	readDshLog,
	recordDshHeader,
} from "../adapters/dsh-native/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { encodeFrames, encodeRaw } from "../research/dsh-native/synthetic.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";

const FIXTURES = join(fileURLToPath(new URL("../", import.meta.url)), "research", "dsh-native", "fixtures", "real");
const KEY = endoDigestKeyV0(Buffer.alloc(32, 0x51), "recovery-test");
const options = { digestKey: KEY, now: () => "2026-10-23T00:00:00Z" };
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string): { header: DshSessionHeader; events: DshSessionEvent[] } => {
	const read = readDshLog(readFileSync(join(FIXTURES, `${name}.events.jsonl`)));
	return { header: read.header!, events: read.events };
};
const newStore = () => createEndoEventStoreV0();
const all = (store: ReturnType<typeof newStore>): EndoEventV0[] => store.page({ limit: 10000 }).events;
const importBytes = (store: ReturnType<typeof newStore>, bytes: Uint8Array) =>
	importDshSessionBytesV0(bytes, store, options);
const lifecycle = (store: ReturnType<typeof newStore>) =>
	all(store).filter((event) => event.kind.startsWith("lifecycle."));
const trajectory = (store: ReturnType<typeof newStore>) =>
	projectDshTrajectoryV0(all(store), { session: "session-1", store: "s" });

const { header, events: base } = fixture("tool-read");
// tool-read: seq 0-12 open the turn and step 1 (up to the derived title), 13 is step 1's assistant message (with a tool call),
// 14 the call, 15 its result, 16 the step end.
const PRE = base.slice(0, 13);
const MESSAGE = base[13]!;

type Closer = "interrupted" | "forked" | { aborted: "user" | "parent" };
/** SYNTHETIC: step 1 of the real log, cut after `committed`, then closed the way DSH recovery (or a live cancel) closes it. */
function closedStep(options: {
	committed: "none" | "message" | "cancelled-message" | "attempt";
	closer: Closer;
	recoveredResult?: boolean;
}): DshSessionEvent[] {
	const rows: DshSessionEvent[] = [...PRE];
	const time = PRE.at(-1)!.time;
	const push = (type: string, data: unknown, extra: Partial<DshSessionEvent> = {}) =>
		rows.push({ type, seq: rows.length, time, data, ...extra });
	if (options.committed === "attempt") push("assistant/attempt", { turn: 1, step: 1, stream: [] });
	if (options.committed === "message" || options.committed === "cancelled-message") {
		const data = JSON.parse(JSON.stringify(MESSAGE.data)) as Record<string, unknown>;
		if (options.committed === "cancelled-message") data.interrupted = true;
		rows.push({ ...MESSAGE, seq: rows.length, data });
	}
	if (options.recoveredResult) {
		push("tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{"file_path":"notes.txt"}' });
		push(
			"tool/result",
			{
				turn: 1,
				step: 1,
				message: {
					role: "tool",
					toolCallId: "call-1",
					isError: true,
					content: [{ type: "text", text: "RECOVERY-TEXT" }],
				},
				error: { name: "Recovery", code: "TOOL_OUTCOME_UNKNOWN" },
			},
			{ surfaceOp: "append" },
		);
	}
	push("step/end", { turn: 1, step: 1 });
	const reason =
		typeof options.closer === "string"
			? { kind: options.closer }
			: { kind: "aborted", reason: { kind: options.closer.aborted } };
	push("turn/end", { turn: 1, reason });
	return rows;
}

describe("what a step's committed output establishes (REAL crash-resumed fixture)", () => {
	it("a step DSH closed retrospectively with no assistant output gets no turn-completed, and the closer says what it closed", () => {
		const store = newStore();
		importBytes(store, readFileSync(join(FIXTURES, "crash-resumed.events.jsonl")));
		const closer = lifecycle(store).find((event) => event.kind === "lifecycle.run-unclassified")!;
		expect(closer.payload).toMatchObject({
			provenance: "dsh-written-closer",
			reportedReason: "interrupted",
			finalStep: { turn: 1, output: "none", recoveredToolResults: 0, stepEndWritten: true },
		});
		// Turn 1's step never completed; turn 2's step did.
		const completed = lifecycle(store).filter((event) => event.kind === "lifecycle.turn-completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]!.payload).toMatchObject({ output: "committed" });
	});
});

describe("closers and committed output (SYNTHETIC variants of the real tool-read step)", () => {
	const importVariant = (rows: DshSessionEvent[]) => {
		const store = newStore();
		const report = importBytes(store, encodeRaw(header, rows));
		expect(report.status, JSON.stringify(report.refusals)).toBe("imported");
		return store;
	};
	const ended = (store: ReturnType<typeof newStore>) =>
		lifecycle(store).filter((event) => event.kind === "lifecycle.turn-completed");
	const closerOf = (store: ReturnType<typeof newStore>) =>
		lifecycle(store).find((event) => event.kind === "lifecycle.run-unclassified")!;

	it.each([
		["no assistant message", "none", "interrupted", "none"],
		["an assistant message, then an interrupted closer", "message", "interrupted", "committed"],
		["an assistant message, then a forked closer", "message", "forked", "committed"],
		[
			"a cancelled-stream message (interrupted: true), then an interrupted closer",
			"cancelled-message",
			"interrupted",
			"cancelled-prefix",
		],
		["an attempt that committed no message, then a forked closer", "attempt", "forked", "attempt-only"],
	] as const)(
		"%s: no completion is claimed, and the closer records %s output",
		(_label, committed, closer, output) => {
			const store = importVariant(closedStep({ committed, closer }));
			expect(ended(store)).toHaveLength(0);
			expect(closerOf(store).payload).toMatchObject({
				provenance: "dsh-written-closer",
				reportedReason: closer,
				finalStep: { turn: 1, output, stepEndWritten: true },
			});
			// Not an Endophasia observation, whatever the committed output was.
			expect(lifecycle(store).map((event) => event.kind)).not.toContain("lifecycle.interrupted");
			expect(all(store).some((event) => event.kind === "lifecycle.session-resumed")).toBe(false);
			const outcome = (trajectory(store).layers.outcome as unknown as { entries: { outcome: string }[] }).entries;
			expect(outcome.map((entry) => entry.outcome)).toEqual(["unclassified"]);
		},
	);

	it("a cancelled stream finalised by a LIVE cancel is an ordinary step end carrying its output kind, with an aborted run", () => {
		const store = importVariant(closedStep({ committed: "cancelled-message", closer: { aborted: "user" } }));
		expect(ended(store).map((event) => event.payload)).toEqual([
			expect.objectContaining({ turn: 1, output: "cancelled-prefix" }),
		]);
		const run = lifecycle(store).find((event) => event.kind === "lifecycle.run-aborted")!;
		expect(run.payload).toMatchObject({ stopRequested: true, abortCause: "user" });
		expect(lifecycle(store).some((event) => event.kind === "lifecycle.run-unclassified")).toBe(false);
	});

	it("an ordinarily completed step (the real tool-read run) says completed with its output kind and stop reason", () => {
		const store = newStore();
		importBytes(store, readFileSync(join(FIXTURES, "tool-read.events.jsonl")));
		const completed = ended(store);
		expect(completed.map((event) => (event.payload as { output: string }).output)).toEqual([
			"committed",
			"committed",
		]);
		for (const event of completed) expect(event.payload).toMatchObject({ stopReason: { status: "reported" } });
		expect(lifecycle(store).some((event) => JSON.stringify(event.payload).includes("finalStep"))).toBe(false);
	});

	it("a result DSH wrote itself during recovery is flagged, offers no digest, and is not a tool outcome in the trajectory", () => {
		const store = importVariant(closedStep({ committed: "message", closer: "interrupted", recoveredResult: true }));
		const recorded = all(store).find((event) => event.kind === "dsh.tool-result-recorded")!;
		expect(recorded.payload).toMatchObject({ dshRecovery: "TOOL_OUTCOME_UNKNOWN", isError: true });
		expect(recorded.payload).not.toHaveProperty("resultDigest");
		expect(closerOf(store).payload).toMatchObject({ finalStep: { output: "committed", recoveredToolResults: 1 } });
		const result = (
			trajectory(store).layers.toolResults as unknown as {
				entries: { status: { status: string }; resultDigest: { status: string } }[];
			}
		).entries[0]!;
		expect(result.status.status).toBe("UNAVAILABLE");
		expect(result.resultDigest.status).toBe("UNAVAILABLE");
		expect(JSON.stringify(all(store))).not.toContain("RECOVERY-TEXT");
	});

	it.each([
		["no message, interrupted", { committed: "none", closer: "interrupted" }],
		["message, interrupted", { committed: "message", closer: "interrupted" }],
		["message, forked", { committed: "message", closer: "forked" }],
		["cancelled message, live abort", { committed: "cancelled-message", closer: { aborted: "user" } }],
	] as const)("incremental import across the step/end boundary equals a one-shot import (%s)", (_label, spec) => {
		const rows = closedStep(spec as Parameters<typeof closedStep>[0]);
		const oneShot = newStore();
		importBytes(oneShot, encodeRaw(header, rows));
		const stepEnd = rows.findIndex((row) => row.type === "step/end");
		const incremental = newStore();
		for (const upTo of [stepEnd, stepEnd + 1, rows.length]) {
			const report = importBytes(incremental, encodeRaw(header, rows.slice(0, upTo)));
			expect(report.refusals, `prefix ${upTo}`).toEqual([]);
			if (upTo === stepEnd + 1) {
				// The log ends exactly at step/end: no verdict on the step yet, in any variant.
				expect(ended(incremental), "undecided at the last row").toHaveLength(0);
			}
		}
		const withoutAt = (store: ReturnType<typeof newStore>) =>
			new Map(
				all(store)
					.filter((event) => event.kind !== "dsh.import-checkpoint")
					.map((event) => [event.id, canonicalEndoJsonV0({ ...event, at: "" })] as const),
			);
		expect(withoutAt(incremental)).toEqual(withoutAt(oneShot));
		expect(trajectory(incremental).digest).toBe(trajectory(oneShot).digest);
	});
});

describe("the historical header is verified, including the working directory, without storing it", () => {
	const CWD = "/CANARY-WORKDIR/project";
	const withCwd = { ...header, cwd: CWD };

	it("an identical header is idempotent", () => {
		const store = newStore();
		importBytes(store, encodeRaw(withCwd, base));
		const before = all(store).length;
		expect(importBytes(store, encodeRaw(withCwd, base))).toMatchObject({
			status: "unchanged",
			appended: { header: 0, recorded: 0, lifecycle: 0, checkpoint: 0 },
		});
		expect(all(store)).toHaveLength(before);
	});

	it("a change to the working directory alone is history-changed, appends nothing, and the path appears nowhere", () => {
		const store = newStore();
		importBytes(store, encodeRaw(withCwd, base.slice(0, 12)));
		const before = canonicalEndoJsonV0(all(store));
		const moved = { ...header, cwd: "/CANARY-OTHER/place" };
		const report = importBytes(store, encodeRaw(moved, base));
		expect(report.status).toBe("refused");
		expect(report.refusals.map((refusal) => refusal.code)).toEqual(["history-changed"]);
		expect(report.refusals[0]!.detail).toMatch(/header/);
		expect(canonicalEndoJsonV0(all(store))).toBe(before);
		for (const text of [before, JSON.stringify(report), canonicalEndoJsonV0(trajectory(store))])
			for (const path of [CWD, "/CANARY-OTHER/place", "CANARY-WORKDIR", "CANARY-OTHER"])
				expect(text).not.toContain(path);
	});

	it("never writes the working directory to the durable store either", () => {
		const root = mkdtempSync(join(tmpdir(), "endo-dsh-header-"));
		dirs.push(root);
		const durable = createEndoDurableEventStoreV0(root);
		importDshSessionBytesV0(encodeFrames(withCwd, base, 4), durable, options);
		expect(readFileSync(join(root, "events", "events.log")).toString("latin1")).not.toContain("CANARY-WORKDIR");
		durable.close();
	});

	it.each([
		["createdAt", { createdAt: header.createdAt + 7 }],
		["delegationDepth", { delegationDepth: 3 }],
		["parentSession", { parentSession: "another-session" }],
		["origin", { origin: "subagent" as const }],
		["agentPreset", { agentPreset: "other-preset" }],
	])("a change to %s alone is still detected", (_field, change) => {
		const store = newStore();
		importBytes(store, encodeRaw(header, base));
		const before = all(store).length;
		const report = importBytes(store, encodeRaw({ ...header, ...change }, base));
		expect(report.refusals.map((refusal) => refusal.code)).toEqual(["history-changed"]);
		expect(all(store)).toHaveLength(before);
	});

	it("the format generation is metadata: it does not enter the header commitment or any event id", () => {
		const a = recordDshHeader(header, 0, KEY).headerDigest;
		const b = recordDshHeader({ ...header, version: 5 }, 0, KEY).headerDigest;
		expect(b).toEqual(a);
		// A different generation is its own refusal (unsupported-format), never a changed history.
		const store = newStore();
		importBytes(store, encodeRaw(header, base));
		expect(
			importBytes(store, encodeRaw({ ...header, version: 5 }, base)).refusals.map((refusal) => refusal.code),
		).toEqual(["unsupported-format"]);
	});

	it("a store imported under the previous mapping is refused explicitly, not reinterpreted", () => {
		const store = newStore();
		importBytes(store, encodeRaw(header, base));
		const old = newStore();
		for (const event of all(store))
			old.ingest(
				event.kind === "dsh.session-imported"
					? { ...event, payload: { ...(event.payload as object), mapping: "dsh-native-mapping.2" } }
					: event,
			);
		const report = importBytes(old, encodeRaw(header, base));
		expect(report.status).toBe("refused");
		expect(report.refusals.map((refusal) => refusal.code)).toContain("mapping-changed");
		expect(DSH_NATIVE_MAPPING_VERSION_V0).toBe("dsh-native-mapping.3");
	});
});
