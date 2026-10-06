// ACP v1 semantic coverage against the deterministic fake agent: update mappings, optional session methods behind their
// capability gates, configuration and usage as the agent reported them, and the redaction line. No OMP, no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AcpClientOptionsV0,
	AcpClientV0,
	AcpRefusedErrorV0,
	AcpUnavailableErrorV0,
	acpEndoSessionIdV0,
} from "../adapters/acp/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");

let scratch: string;
let out: string;
let live: AcpClientV0[];
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "endo-acp-sem-"));
	out = join(scratch, "agent-notes.jsonl");
	live = [];
});
afterEach(async () => {
	await Promise.all(live.map((client) => client.close()));
	rmSync(scratch, { recursive: true, force: true });
});

type Session = Parameters<typeof AcpClientV0.connect>[1];
const env = (mode: string, extra: Record<string, string>) => ({
	command: process.execPath,
	args: [FAKE],
	cwd: scratch,
	env: { FAKE_ACP_MODE: mode, FAKE_ACP_OUT: out, ...extra },
});

async function attach(
	mode: string,
	extra: Record<string, string> = {},
	session: Partial<Session> = {},
	options: Partial<AcpClientOptionsV0> = {},
) {
	const events: EndoEventV0[] = [];
	const client = await AcpClientV0.connect(
		{
			launch: env(mode, extra),
			attachment: "fake.default",
			onEvent: (event) => events.push(event),
			closeGraceMs: 300,
			...options,
		},
		{ cwd: scratch, ...session },
	);
	live.push(client);
	return { client, events };
}

const kinds = (events: readonly EndoEventV0[]) => events.map((event) => event.kind);
const find = (events: readonly EndoEventV0[], kind: string) => events.filter((event) => event.kind === kind);
const notes = (): Array<Record<string, unknown>> => {
	try {
		return readFileSync(out, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const observed = (events: readonly EndoEventV0[], update: string) =>
	find(events, "session.update-observed")
		.map((event) => event.payload as Record<string, unknown>)
		.filter((payload) => payload.update === update);

describe("ACP v1 update semantics", () => {
	it("maps every stable update at its honest level and never stores private content", async () => {
		const { client, events } = await attach("semantics", { FAKE_ACP_CONFIG: "1" });
		const result = await client.prompt("SECRET-PROMPT");
		expect(result.stopReason).toBe("end_turn");

		// Streaming chunks (message, thought, user) are counted, never stored.
		expect(result.updates.agent_thought_chunk).toBe(1);
		expect(result.updates.user_message_chunk).toBe(1);
		expect(result.updates.agent_message_chunk).toBe(2);

		const tool = observed(events, "tool_call")[1]!;
		expect(tool).toEqual({
			update: "tool_call",
			toolCallId: "call_s",
			toolName: "bash",
			toolKind: "execute",
			status: "in_progress",
			contentItems: 1,
			locations: 1,
			rawInputPresent: true,
		});
		// A partial update names only what it carried: absent is absent, not false.
		expect(observed(events, "tool_call_update")[1]).toEqual({
			update: "tool_call_update",
			toolCallId: "call_s",
			status: "completed",
			rawOutputPresent: true,
		});
		expect(observed(events, "plan")[0]).toEqual({
			update: "plan",
			entries: 3,
			byStatus: { pending: 1, in_progress: 0, completed: 2 },
		});
		expect(observed(events, "available_commands_update")[0]).toEqual({
			update: "available_commands_update",
			commands: 1,
		});
		expect(observed(events, "current_mode_update")[0]).toEqual({ update: "current_mode_update", modeId: "plan" });
		expect(observed(events, "session_info_update")[0]).toEqual({ update: "session_info_update", titled: true });

		// An unstable variant is observed by name, not translated and not malformed.
		const unrecognized = find(events, "runtime.unrecognized-event").map((event) => event.payload);
		expect(unrecognized).toEqual([
			{ runtimeEvent: "notice", method: "session/update", schemaStatus: "unstable" },
			{ runtimeEvent: "plan_update", method: "session/update", schemaStatus: "unstable" },
		]);
		expect(find(events, "runtime.malformed-event")).toEqual([]);

		// Nothing private reaches any event, recorded or derived.
		const everything = JSON.stringify(events);
		expect(everything).not.toMatch(/SECRET/);
		expect(everything).not.toContain("/secret/path");
	});

	it("reports usage as session context-window state, with cost only when reported and its currency attached", async () => {
		const { client, events } = await attach("semantics");
		await client.prompt("go");
		const usage = observed(events, "usage_update");
		expect(usage).toEqual([
			{ update: "usage_update", contextTokensUsed: 53000, contextWindowSize: 200000 },
			{
				update: "usage_update",
				contextTokensUsed: 54000,
				contextWindowSize: 200000,
				cost: { amount: 0.25, currency: "USD" },
			},
			// cost: null is no cost, not a zero cost.
			{ update: "usage_update", contextTokensUsed: 55000, contextWindowSize: 200000 },
		]);
		// No per-message ledger is invented: no input/output/cache/reasoning category, no usage event.
		const text = JSON.stringify(events);
		expect(text).not.toMatch(/inputTokens|outputTokens|cacheRead|cacheWrite|reasoningTokens/);
		expect(kinds(events).some((kind) => kind.includes("usage"))).toBe(false);
		const started = find(events, "lifecycle.session-started")[0]!.payload as {
			unavailable: Array<{ field: string; reason: string }>;
		};
		expect(started.unavailable.find((field) => field.field === "usage")?.reason).toMatch(/context-window/);
	});

	it("records configuration as the agent advertised and later reported it, not as verified identity", async () => {
		const { client, events } = await attach("semantics", { FAKE_ACP_CONFIG: "1" });
		await client.prompt("go");
		const [atOpen, afterUpdate] = find(events, "session.config-observed").map((event) => event.payload);
		const options = [
			{ id: "model", type: "select", category: "model", current: "m1", choices: 2 },
			{ id: "thinking", type: "select", category: "thought_level", current: "low", choices: 2 },
			{ id: "verbose", type: "boolean", current: false },
		];
		expect(atOpen).toEqual({ origin: "session/new", optionCount: 3, options });
		expect(afterUpdate).toEqual({ origin: "config_option_update", optionCount: 3, options });
		// Counted as update activity once, and no option label or value name was kept.
		expect(client.updateCounts.config_option_update).toBe(1);
		expect(JSON.stringify(events)).not.toMatch(/SECRET-M|SECRET-OPTION/);
	});

	it("does not count hostile nested values of known variants, and keeps the run going", async () => {
		const { client, events } = await attach("hostile-nested");
		const result = await client.prompt("go");
		expect(result.stopReason).toBe("end_turn");
		const malformed = find(events, "runtime.malformed-event").map((event) => event.payload);
		expect(malformed).toHaveLength(13);
		for (const payload of malformed) expect(payload).toMatchObject({ problem: "schema-invalid" });
		expect(
			find(events, "session.config-observed").filter(
				(event) => (event.payload as { origin: string }).origin === "config_option_update",
			),
		).toEqual([]);
		// Only the common prefix's chunks and tool call count; none of the 13 malformed updates.
		expect(result.updates.config_option_update).toBeUndefined();
		expect(result.updates.usage_update).toBeUndefined();
		expect(result.updates.plan).toBeUndefined();
	});
});

describe("ACP v1 optional session methods are capability gated", () => {
	it("calls nothing the agent did not advertise, and says so", async () => {
		const { client, events } = await attach("normal");
		expect(client.sessionCapabilities).toEqual({ list: false, resume: false, close: false });
		await expect(client.listSessions()).rejects.toBeInstanceOf(AcpUnavailableErrorV0);
		await expect(client.closeSession()).rejects.toBeInstanceOf(AcpUnavailableErrorV0);
		expect(find(events, "control.unavailable").map((event) => event.payload)).toEqual([
			{ capability: "session.list", reason: "not-advertised" },
			{ capability: "session.close", reason: "not-advertised" },
		]);
		expect(notes().filter((note) => "called" in note)).toEqual([]);
		// Not advertised is not an attachment failure: the session still runs.
		expect((await client.prompt("go")).stopReason).toBe("end_turn");
	});

	it("treats a null capability as not advertised", async () => {
		const { client } = await attach("normal", { FAKE_ACP_CAPS: "null-list" });
		expect(client.sessionCapabilities.list).toBe(false);
		await expect(client.listSessions()).rejects.toBeInstanceOf(AcpUnavailableErrorV0);
		expect(notes().filter((note) => "called" in note)).toEqual([]);
	});

	it("refuses to resume when resume was not advertised, before sending anything, and leaves no process", async () => {
		const events: EndoEventV0[] = [];
		const error = await AcpClientV0.connect(
			{ launch: env("normal", {}), attachment: "fake.default", onEvent: (e) => events.push(e), closeGraceMs: 300 },
			{ cwd: scratch, resume: { sessionId: "fake-session-1" } },
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(AcpUnavailableErrorV0);
		expect(kinds(events)).toContain("control.unavailable");
		expect(kinds(events)).not.toContain("harness.attached");
		expect(notes().filter((note) => "called" in note)).toEqual([]);
	});

	it("lists sessions when advertised, returning agent data to the caller and keeping counts in the record", async () => {
		const { client, events } = await attach("list-more", { FAKE_ACP_CAPS: "list" });
		const page = await client.listSessions({ cwd: scratch });
		expect(page.sessions.map((entry) => entry.sessionId)).toEqual(["fake-session-1", "other id with spaces"]);
		expect(page.sessions[0]).toMatchObject({ cwd: "/work/one", title: "SECRET-SESSION-TITLE" });
		expect(page.nextCursor).toBe("page-2");
		expect(find(events, "session.listed").map((event) => event.payload)).toEqual([{ count: 2, hasNextCursor: true }]);
		expect(JSON.stringify(events)).not.toMatch(/SECRET|other id|\/work\//);
		expect(notes().find((note) => note.called === "session/list")).toMatchObject({ params: { cwd: scratch } });
	});

	it("resumes without claiming replay, under a coordinate of the new process instance", async () => {
		const { client, events } = await attach(
			"normal",
			{ FAKE_ACP_CAPS: "resume", FAKE_ACP_CONFIG: "1" },
			{
				resume: { sessionId: "fake-session-1" },
			},
		);
		expect(notes().find((note) => note.called === "session/resume")).toEqual({
			called: "session/resume",
			sessionId: "fake-session-1",
		});
		expect(kinds(events)).not.toContain("session.listed");
		const attached = find(events, "harness.attached")[0]!.payload;
		expect(attached).toMatchObject({
			openedBy: "session/resume",
			historyReplayed: false,
			acpSessionId: "fake-session-1",
		});
		const started = find(events, "lifecycle.session-started")[0]!;
		expect(started.payload).toMatchObject({ openedBy: "session/resume" });
		// session/resume is a reattachment the record cannot relate to an earlier coordinate: not lifecycle.session-resumed.
		expect(kinds(events)).not.toContain("lifecycle.session-resumed");
		expect(find(events, "session.config-observed")[0]!.payload).toMatchObject({
			origin: "session/resume",
			optionCount: 3,
		});
		expect((await client.prompt("go")).stopReason).toBe("end_turn");
	});

	it("reports a refused resume as the agent's refusal and tears the process down", async () => {
		const events: EndoEventV0[] = [];
		const error = await AcpClientV0.connect(
			{
				launch: env("normal", { FAKE_ACP_CAPS: "resume" }),
				attachment: "fake.default",
				onEvent: (e) => events.push(e),
				closeGraceMs: 300,
			},
			{ cwd: scratch, resume: { sessionId: "unknown-session" } },
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(AcpRefusedErrorV0);
		expect(kinds(events)).not.toContain("harness.attached");
		expect(kinds(events)).toContain("harness.process-exited");
	});

	it("closes the session when advertised: acceptance only, no more prompts, late traffic not counted", async () => {
		const { client, events } = await attach("normal", { FAKE_ACP_CAPS: "close" });
		await client.closeSession();
		expect(notes().find((note) => note.called === "session/close")).toEqual({
			called: "session/close",
			sessionId: "fake-session-1",
		});
		expect(find(events, "session.close-accepted").map((event) => event.payload)).toEqual([
			{ basis: "jsonrpc-response" },
		]);
		await expect(client.prompt("go")).rejects.toBeInstanceOf(TypeError);
		await expect(client.closeSession()).rejects.toBeInstanceOf(TypeError);
		// The process is the attachment's own to end.
		expect((await client.close()).spawnFailed).toBe(false);
	});

	it("treats closing the session during a turn as a cancellation of it", async () => {
		const { client, events } = await attach("cancellable", { FAKE_ACP_CAPS: "close" });
		const turn = client.prompt("go");
		for (let waited = 0; !find(events, "session.update-observed").length && waited < 200; waited++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await client.closeSession();
		const result = await turn;
		expect(result.stopReason).toBe("cancelled");
		expect(find(events, "lifecycle.stop-requested")).toHaveLength(1);
		expect(find(events, "lifecycle.run-aborted")[0]!.payload).toMatchObject({ stopRequested: true });
	});
});

describe("agent-local session ids", () => {
	it("keeps two process instances that issue the same session id apart", async () => {
		const first = await attach("normal");
		const second = await attach("normal");
		const idOf = (events: EndoEventV0[]) => find(events, "harness.attached")[0]!.payload as { acpSessionId: string };
		expect(idOf(first.events).acpSessionId).toBe(idOf(second.events).acpSessionId);
		const coordinate = (events: EndoEventV0[]) => find(events, "harness.attached")[0]!.coordinates.sessionId;
		expect(coordinate(first.events)).not.toBe(coordinate(second.events));
		expect(acpEndoSessionIdV0("a", "x")).not.toBe(acpEndoSessionIdV0("b", "x"));
	});
});
