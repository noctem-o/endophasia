import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
	type HarnessEventType,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session, UsageRow } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import {
	attachMissionTraceV0,
	captureContinuityV0,
	captureRuntimeMetricsV0,
	captureSessionOverviewV0,
	captureSteeringStateV0,
	queueFollowUpV0,
	readUsageLedgerV0,
	stopV0,
	type UsageLedgerRowV0,
} from "../src/index.ts";
import { exactUsageProvider, usage } from "./exact-usage-provider.ts";

const sessions: Session[] = [];

const ALL_EVENT_TYPES: HarnessEventType[] = [
	"compaction_end",
	"compaction_start",
	"config_update",
	"entry_added",
	"fault",
	"handler_error",
	"lane_created",
	"message_end",
	"message_start",
	"message_update",
	"navigation_end",
	"navigation_start",
	"operation_abort",
	"queue_update",
	"retry_end",
	"retry_scheduled",
	"retry_start",
	"run_end",
	"run_resume",
	"run_start",
	"run_suspend",
	"tool_end",
	"tool_start",
	"tool_update",
	"turn_end",
	"turn_start",
	"usage",
	"value_update",
];

const A = usage(11, 7, 13, 5, 41, [0.5, 0.25, 0.125, 0.0625, 0.9375]);
const B = usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125]);
const C = usage(29, 23, 31, 37, 120, [2, 4, 8, 16, 30]);
const ROW_KEYS = ["adjustment", "id", "sequence", "usage"];

async function fixture(options: { tools?: AgentHarnessTool<undefined>[]; retries?: number } = {}): Promise<{
	session: StorageBackedSession;
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	reported: Usage[];
}> {
	const session = new StorageBackedSession(
		{ id: `usage-ledger-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const reported: Usage[] = [];
	const models = createModels();
	models.setProvider(exactUsageProvider(faux, reported));
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			tools: options.tools ?? [],
			retry: { enabled: options.retries !== undefined, maxRetries: options.retries ?? 0, baseDelayMs: 0 },
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { session, harness, lane, faux, reported };
}

/** Independent reference projection of raw public scan rows. */
function expectedRow(row: UsageRow): UsageLedgerRowV0 {
	return {
		id: row.id,
		sequence: row.seq,
		adjustment: row.adjustment,
		...(row.entryId === undefined ? {} : { entryId: row.entryId }),
		usage: structuredClone(row.usage),
	};
}

async function rawRows(session: Session): Promise<UsageRow[]> {
	return structuredClone(await session.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT));
}

async function prompt(lane: AgentLane, text: string) {
	const result = await lane.prompt(text, undefined, BACKGROUND_CONTEXT);
	if (!result.ok) throw result.error;
	return result.value;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Usage Ledger Inspector v0", () => {
	it("reads an empty ledger with an unmoved cursor", async () => {
		const { session } = await fixture();
		expect(await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "usage-ledger.v0",
			scope: "session",
			order: "ascending",
			rows: [],
			nextAfterSequence: 0,
		});
	});

	it("projects a successful provider row exactly from the public session scan", async () => {
		const { session, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("answer-sentinel")]);
		reported.push(A);
		await prompt(lane, "prompt-sentinel");
		const raw = await rawRows(session);
		expect(raw).toHaveLength(1);
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows).toEqual(raw.map(expectedRow));
		expect(page.rows[0]).toMatchObject({ adjustment: false, usage: A });
		expect(page.nextAfterSequence).toBe(raw[0]!.seq);
		expect(JSON.stringify(page)).not.toMatch(/answer-sentinel|prompt-sentinel|faux/);
	});

	it("preserves optional usage fields' absence and presence, and copies totalTokens", async () => {
		const { session, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const withExtras = usage(1, 2, 3, 4, 99, [0, 0, 0, 0, 0], { cacheWrite1h: 3, reasoning: 1 });
		reported.push(A, withExtras);
		await prompt(lane, "p");
		await prompt(lane, "q");
		const [plain, extras] = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		expect(plain?.usage).not.toHaveProperty("cacheWrite1h");
		expect(plain?.usage).not.toHaveProperty("reasoning");
		expect(extras?.usage).toEqual(withExtras);
		expect(A.input + A.output + A.cacheRead + A.cacheWrite).not.toBe(A.totalTokens);
		expect(plain?.usage.totalTokens).toBe(A.totalTokens);
		expect(extras?.usage.totalTokens).toBe(99);
	});

	it("preserves session-global sequence gaps and uses an exclusive cursor", async () => {
		const { session, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		reported.push(A, B);
		await prompt(lane, "p");
		await prompt(lane, "q");
		const [first, second] = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		if (first === undefined || second === undefined) throw new Error("Expected two rows");
		// Entries and values committed between the rows consume the shared sequence.
		expect(second.sequence).toBeGreaterThan(first.sequence + 1);
		expect([first.sequence, second.sequence]).toEqual((await rawRows(session)).map(({ seq }) => seq));

		const after = await readUsageLedgerV0(session, { afterSequence: first.sequence }, BACKGROUND_CONTEXT);
		expect(after.rows.map(({ id }) => id)).toEqual([second.id]);
		const gap = await readUsageLedgerV0(session, { afterSequence: first.sequence + 1 }, BACKGROUND_CONTEXT);
		expect(gap.rows.map(({ id }) => id)).toEqual([second.id]);
	});

	it("pages forward without duplicates and matches a one-shot raw scan", async () => {
		const { session, lane } = await fixture();
		for (let index = 0; index < 7; index++) {
			await lane.recordUsage(usage(index, 0, 0, 0, index, [0, 0, 0, 0, 0]), undefined, BACKGROUND_CONTEXT);
			await lane.appendMessage({ role: "user", content: `gap ${index}`, timestamp: 1 }, BACKGROUND_CONTEXT);
		}
		const pages: UsageLedgerRowV0[][] = [];
		let cursor = 0;
		for (;;) {
			const page = await readUsageLedgerV0(session, { afterSequence: cursor, limit: 3 }, BACKGROUND_CONTEXT);
			if (page.rows.length === 0) {
				expect(page.nextAfterSequence).toBe(cursor);
				break;
			}
			pages.push(page.rows);
			cursor = page.nextAfterSequence;
		}
		expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
		const rows = pages.flat();
		expect(new Set(rows.map(({ id }) => id)).size).toBe(7);
		expect(rows.every((row, index) => index === 0 || row.sequence > rows[index - 1]!.sequence)).toBe(true);
		expect(rows).toEqual((await rawRows(session)).map(expectedRow));
	});

	it("keeps the cursor unchanged on an empty page and never overflows at MAX_SAFE_INTEGER", async () => {
		const { session, lane } = await fixture();
		await lane.recordUsage(A, undefined, BACKGROUND_CONTEXT);
		const last = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).nextAfterSequence;
		expect(await readUsageLedgerV0(session, { afterSequence: last }, BACKGROUND_CONTEXT)).toMatchObject({
			rows: [],
			nextAfterSequence: last,
		});
		const scanUsage = vi.fn(session.scanUsage.bind(session));
		expect(
			await readUsageLedgerV0({ scanUsage }, { afterSequence: Number.MAX_SAFE_INTEGER }, BACKGROUND_CONTEXT),
		).toMatchObject({ rows: [], nextAfterSequence: Number.MAX_SAFE_INTEGER });
		expect(scanUsage).not.toHaveBeenCalled();
	});

	it("rejects malformed cursors and limits without coercion", async () => {
		const scanUsage = vi.fn(async () => []);
		for (const afterSequence of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(readUsageLedgerV0({ scanUsage }, { afterSequence }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
				RangeError,
			);
		}
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
			await expect(readUsageLedgerV0({ scanUsage }, { limit }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
				RangeError,
			);
		}
		expect(scanUsage).not.toHaveBeenCalled();
	});

	it("bounds every read: default 1000, maximum 10000, with an inclusive fromSeq one past the cursor", async () => {
		const scanUsage = vi.fn(async () => []);
		await readUsageLedgerV0({ scanUsage }, undefined, BACKGROUND_CONTEXT);
		await readUsageLedgerV0({ scanUsage }, { afterSequence: 41, limit: 10_000 }, BACKGROUND_CONTEXT);
		expect(scanUsage.mock.calls).toEqual([
			[{ fromSeq: 1, order: "asc", limit: 1000 }, BACKGROUND_CONTEXT],
			[{ fromSeq: 42, order: "asc", limit: 10_000 }, BACKGROUND_CONTEXT],
		]);
	});

	it("reports adjustments exactly, including negative and zero rows, without details", async () => {
		const { session, lane } = await fixture();
		const correction = usage(-9, -3, -1, -7, -20, [-1, -2, -4, -8, -15]);
		const zero = usage(0, 0, 0, 0, 0, [0, 0, 0, 0, 0]);
		await lane.recordUsage(C, { details: { sentinel: "private-adjustment-details-sentinel" } }, BACKGROUND_CONTEXT);
		await lane.recordUsage(correction, undefined, BACKGROUND_CONTEXT);
		await lane.recordUsage(zero, undefined, BACKGROUND_CONTEXT);
		const raw = await rawRows(session);
		expect(raw[0]?.details).toEqual({ sentinel: "private-adjustment-details-sentinel" });
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows.map((row) => [row.adjustment, row.usage])).toEqual([
			[true, C],
			[true, correction],
			[true, zero],
		]);
		expect(page.rows.every((row) => !("entryId" in row))).toBe(true);
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain("private-adjustment-details-sentinel");
		expect(serialized).not.toContain("details");
	});

	it("reports non-adjustment rows only as non-adjustments, with no inferred cause or provenance", async () => {
		const { session, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await prompt(lane, "p");
		const [row] = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		expect(row?.adjustment).toBe(false);
		const raw = (await rawRows(session))[0]!;
		expect(Object.keys(row!).sort()).toEqual(raw.entryId === undefined ? ROW_KEYS : [...ROW_KEYS, "entryId"].sort());
		for (const forbidden of ["cause", "providerReported", "tool", "summary", "runId", "lane", "timestamp"]) {
			expect(row).not.toHaveProperty(forbidden);
		}
	});

	it("copies entryId without resolving it, through a scanUsage-only capability", async () => {
		const source: UsageRow = {
			id: "opaque-usage-id",
			seq: 7,
			usage: structuredClone(A),
			entryId: "entry-that-may-not-exist",
			adjustment: false,
			details: { secret: "fake-details-sentinel" },
		};
		const scanUsage = vi.fn(async () => [source]);
		const page = await readUsageLedgerV0({ scanUsage }, undefined, BACKGROUND_CONTEXT);
		expect(page).toEqual({
			schemaVersion: "usage-ledger.v0",
			scope: "session",
			order: "ascending",
			rows: [
				{ id: "opaque-usage-id", sequence: 7, adjustment: false, entryId: "entry-that-may-not-exist", usage: A },
			],
			nextAfterSequence: 7,
		});
		expect(Object.keys(page.rows[0]!).sort()).toEqual([...ROW_KEYS, "entryId"].sort());
		expect(JSON.stringify(page)).not.toContain("fake-details-sentinel");

		page.rows[0]!.usage.input = 999;
		page.rows[0]!.usage.cost.total = 999;
		page.rows.push(page.rows[0]!);
		expect(source.usage).toEqual(A);
		expect(page.rows[0]!.usage).not.toBe(source.usage);
		expect(page.rows[0]!.usage.cost).not.toBe(source.usage.cost);
	});

	it("is session-scoped: rows from two lanes share one sequence-ordered ledger", async () => {
		const { session, harness, lane, faux, reported } = await fixture();
		const other = await harness.lane("other", BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		reported.push(A, B);
		await prompt(lane, "on main");
		await prompt(other, "on other");
		await other.recordUsage(C, undefined, BACKGROUND_CONTEXT);
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows.map(({ usage: row }) => row)).toEqual([A, B, C]);
		expect(page.rows.every((row) => !("lane" in row))).toBe(true);
		expect(page).not.toHaveProperty("lane");
		expect(page.scope).toBe("session");
	});

	it("keeps rows from a failed attempt and its successful retry, in ledger order", async () => {
		const { session, lane, faux, reported } = await fixture({ retries: 1 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable: overloaded" }),
			fauxAssistantMessage("final"),
		]);
		reported.push(A, B);
		expect(await prompt(lane, "p")).toMatchObject({ status: "completed" });
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows.map(({ adjustment, usage: row }) => [adjustment, row])).toEqual([
			[false, A],
			[false, B],
		]);
		expect(JSON.stringify(page)).not.toContain("overloaded");
	});

	it("keeps a committed row after the enclosing operation aborts", async () => {
		const started = deferred();
		const release = deferred();
		const schema = Type.Object({ value: Type.String() });
		const slow: AgentHarnessTool<undefined, typeof schema> = {
			name: "slow",
			label: "slow",
			description: "slow",
			parameters: schema,
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "late" }], details: {} };
			},
		};
		const { session, lane, faux, reported } = await fixture({ tools: [slow] });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", { value: "v" }), { stopReason: "toolUse" })]);
		reported.push(A);
		const running = lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			expect(await stopV0(lane, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "aborted" } });
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows.map(({ usage: row }) => row)).toEqual([A]);
	});

	it("includes tool-reported and compaction summary rows as ordinary rows", async () => {
		const toolUsage = usage(3, 5, 0, 0, 8, [0.25, 0.5, 0, 0, 0.75]);
		const schema = Type.Object({ value: Type.String() });
		const nested: AgentHarnessTool<undefined, typeof schema> = {
			name: "nested",
			label: "nested",
			description: "nested",
			parameters: schema,
			execute: async () => ({
				content: [{ type: "text", text: "tool-output-sentinel" }],
				details: {},
				usage: toolUsage,
			}),
		};
		const { session, lane, faux, reported } = await fixture({ tools: [nested] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("nested", { value: "tool-input-sentinel" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary-sentinel"),
		]);
		reported.push(A, B, C);
		await prompt(lane, "p");
		const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
		if (!compaction.ok) throw compaction.error;
		const page = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		expect(page.rows.map(({ usage: row }) => row)).toEqual([A, toolUsage, B, C]);
		expect(page.rows.every(({ adjustment }) => adjustment === false)).toBe(true);
		expect(page.rows.every((row) => Object.keys(row).every((key) => [...ROW_KEYS, "entryId"].includes(key)))).toBe(
			true,
		);
		expect(JSON.stringify(page)).not.toMatch(/tool-input-sentinel|tool-output-sentinel|summary-sentinel|nested/);
	});

	it("detaches every returned object from the memory backend's stored rows", async () => {
		const { session, lane } = await fixture();
		await lane.recordUsage(A, undefined, BACKGROUND_CONTEXT);
		const first = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		const expected = structuredClone(first);
		first.rows[0]!.usage.input = 999;
		first.rows[0]!.usage.cost.total = 999;
		first.rows[0]!.sequence = 999;
		first.rows.length = 0;
		expect(await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).toEqual(expected);
		expect((await rawRows(session))[0]?.usage).toEqual(A);
	});

	it("catches up rows committed after an earlier page from that page's cursor", async () => {
		const { session, lane } = await fixture();
		await lane.recordUsage(A, undefined, BACKGROUND_CONTEXT);
		const first = await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		await lane.recordUsage(B, undefined, BACKGROUND_CONTEXT);
		const next = await readUsageLedgerV0(session, { afterSequence: first.nextAfterSequence }, BACKGROUND_CONTEXT);
		expect(next.rows.map(({ usage: row }) => row)).toEqual([B]);
		expect(next.nextAfterSequence).toBeGreaterThan(first.nextAfterSequence);
	});

	it("agrees with Pi's maintained Runtime Metrics aggregate when no writes intervene", async () => {
		const { session, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await prompt(lane, "p");
		await lane.recordUsage(C, undefined, BACKGROUND_CONTEXT);
		const rows = (await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows;
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(rows.reduce((total, row) => total + row.usage.totalTokens, 0)).toBe(metrics.usage.totalTokens);
		expect(rows.reduce((total, row) => total + row.usage.cost.total, 0)).toBe(metrics.usage.cost.total);
	});

	it("is read-only: no rows, stats, entries, lanes, operations, queues, or events change", async () => {
		const { session, harness, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await prompt(lane, "p");
		const admitted = await lane.accept({ kind: "prompt", operationId: "open", prompt: "q" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		await queueFollowUpV0(lane, "queued", BACKGROUND_CONTEXT);
		const trace = attachMissionTraceV0(harness);
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const observe = async () => ({
			rows: await rawRows(session),
			stats: await session.getStats(BACKGROUND_CONTEXT),
			entries: await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT),
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
		});
		const before = await observe();
		await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT);
		await readUsageLedgerV0(session, { afterSequence: 1, limit: 1 }, BACKGROUND_CONTEXT);
		expect(await observe()).toEqual(before);
		// Mission Trace sequences are attachment-local and unrelated to ledger sequences; none were produced.
		expect(trace.sinceSequence(0)).toEqual([]);
		expect(anyEvent).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
		trace.detach();
	});

	it("propagates a closed-session failure instead of returning an empty page", async () => {
		const { session } = await fixture();
		await session.close(BACKGROUND_CONTEXT);
		await expect(readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
	});
});
