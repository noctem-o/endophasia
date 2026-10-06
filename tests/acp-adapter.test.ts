// The ACP v1 adapter against a deterministic fake agent (tests/fixtures/fake-acp-agent.ts, built on the official SDK).
// No OMP, network, model or credentials. Real OMP is the opt-in tests/acp-omp-real.test.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AcpClientOptionsV0,
	AcpClientV0,
	AcpClosedErrorV0,
	AcpProcessExitedErrorV0,
	AcpProtocolErrorV0,
	AcpRefusedErrorV0,
	AcpTimeoutErrorV0,
} from "../adapters/acp/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");

let scratch: string;
let out: string;
let live: AcpClientV0[];
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "endo-acp-"));
	out = join(scratch, "agent-notes.jsonl");
	live = [];
});
afterEach(async () => {
	await Promise.all(live.map((client) => client.close()));
	rmSync(scratch, { recursive: true, force: true });
});

function launch(mode: string, extra: Record<string, string> = {}) {
	return {
		command: process.execPath,
		args: [FAKE],
		cwd: scratch,
		env: { FAKE_ACP_MODE: mode, FAKE_ACP_OUT: out, ...extra },
	};
}

async function attach(mode: string, options: Partial<AcpClientOptionsV0> = {}, env: Record<string, string> = {}) {
	const events: EndoEventV0[] = [];
	const client = await AcpClientV0.connect(
		{
			launch: launch(mode, env),
			attachment: "fake.default",
			onEvent: (event) => events.push(event),
			closeGraceMs: 300,
			...options,
		},
		{ cwd: scratch },
	);
	live.push(client);
	return { client, events };
}

/** connect() that is expected to fail: the events seen so far come back with the error. */
async function attachFailing(mode: string) {
	const events: EndoEventV0[] = [];
	const error = await AcpClientV0.connect(
		{ launch: launch(mode), attachment: "fake.default", onEvent: (event) => events.push(event), closeGraceMs: 300 },
		{ cwd: scratch },
	).then(
		() => null,
		(caught: unknown) => caught,
	);
	return { error, events };
}

/** The process instance an attachment's events carry. */
const instanceOf = (events: readonly EndoEventV0[]) =>
	(events.find((event) => event.kind === "harness.attached")!.payload as { instance: string }).instance;
const kinds = (events: readonly EndoEventV0[]) => events.map((event) => event.kind);
const find = (events: readonly EndoEventV0[], kind: string) => events.filter((event) => event.kind === kind);
const notes = () =>
	readFileSync(out, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("ACP v1 vertical slice, fake agent", () => {
	it("negotiates v1, records what the agent reported, runs one prompt, and closes cleanly", async () => {
		const { client, events } = await attach("normal");
		expect(client.initialize.protocolVersion).toBe(1);
		expect(client.initialize.agentInfo).toMatchObject({ name: "fake-acp-agent", version: "9.9.9" });
		expect(client.initialize.agentCapabilities).toMatchObject({ loadSession: false });
		const initialized = find(events, "harness.acp-initialized")[0]!;
		expect(initialized.payload).toMatchObject({
			protocolVersion: 1,
			agentInfo: { name: "fake-acp-agent" },
			authMethodIds: ["none"],
		});
		expect(find(events, "lifecycle.session-started")[0]!.payload).toMatchObject({
			runtime: "acp",
			runtimeSessionId: "fake-session-1",
		});

		const result = await client.prompt("hello");
		expect(result.stopReason).toBe("end_turn");
		expect(result.updates).toEqual({ agent_message_chunk: 2, tool_call: 1, tool_call_update: 1 });

		// Chunks are counted, not stored; tool updates are minimal observations.
		expect(find(events, "session.update-observed").map((event) => event.payload)).toEqual([
			{ update: "tool_call", toolCallId: "call_1", toolKind: "read", status: "pending" },
			{ update: "tool_call_update", toolCallId: "call_1", status: "completed" },
		]);
		const lifecycle = events.filter((event) => event.source === "interpretation").map((event) => event.kind);
		expect(lifecycle).toEqual(["lifecycle.session-started", "lifecycle.run-started", "lifecycle.run-completed"]);
		expect(find(events, "lifecycle.run-started")[0]!.payload).toMatchObject({ basis: "client-sent-session-prompt" });
		expect(find(events, "lifecycle.run-completed")[0]!.payload).toMatchObject({
			stopReason: { status: "reported", value: "end_turn" },
		});
		// No text the agent or the prompt carried reaches evidence.
		const all = JSON.stringify(events);
		expect(all).not.toContain("SECRET");
		expect(all).not.toContain("hello");
		// Session coordinate and derivation.
		expect(new Set(events.slice(2).map((event) => event.coordinates.sessionId))).toEqual(
			new Set([`endo.session.acp.${instanceOf(events)}.fake-session-1`]),
		);
		const responded = find(events, "agent.prompt-responded")[0]!;
		expect(find(events, "lifecycle.run-completed")[0]!.derivedFrom).toEqual([responded.id]);
		expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

		const exit = await client.close();
		expect(exit).toMatchObject({ code: 0, signal: null, spawnFailed: false });
		expect(client.liveProcessMembers()).toBe(false);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ expected: true });
		expect(kinds(events).at(-1)).toBe("lifecycle.detached");
	});

	it("reduces, through the existing session-overview reducer, to what the agent reported and no more", async () => {
		const { client, events } = await attach("normal");
		await client.prompt("go");
		await client.close();
		// The lifecycle carries the same session reference the recording does.
		expect(find(events, "lifecycle.session-started")[0]!.payload).toMatchObject({
			runtimeSessionId: (find(events, "harness.attached")[0]!.payload as { acpSessionId: string }).acpSessionId,
		});
		const overview = reduceEndoSessionOverviewV0(events);
		expect(overview.anomalies).toEqual([]);
		expect(overview.unrecognized).toEqual([]);
		expect(overview.state).toBe("detached");
		expect(overview.counts).toMatchObject({ runs: 1, completed: 1, aborted: 0, failed: 0, interrupted: 0 });
		expect(overview.session).toEqual({
			status: "reported",
			value: { runtime: "acp", runtimeSessionId: "fake-session-1" },
		});
		expect(overview.lastRun?.stopReason).toEqual({ status: "reported", value: "end_turn" });
		// What ACP v1 does not report is declared, including the turn count the overview can only show as 0.
		expect(overview.unavailable.map((entry) => entry.field)).toEqual(
			expect.arrayContaining(["run.id", "turns", "operation.outcome"]),
		);
	});

	it("gives the agent only the declared environment", async () => {
		process.env.ENDO_ACP_LEAK_PROBE = "leaked";
		try {
			await attach("normal");
		} finally {
			delete process.env.ENDO_ACP_LEAK_PROBE;
		}
		expect(notes()[0]).toEqual({ leakProbe: null });
	});

	it("rejects an agent that negotiates protocol version 2, and leaves no child", async () => {
		const { error, events } = await attachFailing("version-2");
		expect(error).toBeInstanceOf(AcpProtocolErrorV0);
		expect(String((error as Error).message)).toMatch(/version 2.*only 1/);
		// What the agent reported is kept even though the version is refused.
		expect(find(events, "harness.protocol-fault")[0]!.payload).toMatchObject({
			fault: "unsupported-protocol-version",
			protocolVersion: 2,
			agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
		});
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")).toHaveLength(1);
	});

	it("reports an agent that exits right after initialize, not a session", async () => {
		const { error, events } = await attachFailing("exit-after-init");
		expect(error).toBeInstanceOf(AcpProcessExitedErrorV0);
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ code: 3, expected: false });
		// No session ever started: no lifecycle event names one.
		expect(events.filter((event) => event.source === "interpretation")).toEqual([]);
	});

	it("reports a command that cannot start", async () => {
		const events: EndoEventV0[] = [];
		const error = await AcpClientV0.connect(
			{
				launch: { command: join(scratch, "no-such-agent"), args: [], cwd: scratch, env: {} },
				attachment: "fake.default",
				onEvent: (event) => events.push(event),
				closeGraceMs: 300,
			},
			{ cwd: scratch },
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ spawnFailed: true });
		expect(events.filter((event) => event.source === "interpretation")).toEqual([]);
	});

	it("refuses relative paths", async () => {
		await expect(
			AcpClientV0.connect(
				{ launch: { ...launch("normal"), cwd: "rel" }, attachment: "x", onEvent: () => {} },
				{ cwd: scratch },
			),
		).rejects.toThrow(/absolute/);
		await expect(
			AcpClientV0.connect({ launch: launch("normal"), attachment: "x", onEvent: () => {} }, { cwd: "rel" }),
		).rejects.toThrow(/absolute/);
	});

	it("keeps unknown and malformed session updates visible", async () => {
		const { client, events } = await attach("unknown-update");
		const result = await client.prompt("go");
		expect(result.stopReason).toBe("end_turn");
		expect(find(events, "runtime.unrecognized-event")[0]!.payload).toEqual({
			runtimeEvent: "future_variant_from_v9",
			method: "session/update",
			schemaStatus: "unknown",
		});
		expect(find(events, "lifecycle.unrecognized-runtime-event")[0]!.payload).toEqual({
			runtimeEvent: "future_variant_from_v9",
		});
		expect(find(events, "runtime.malformed-event")[0]!.payload).toMatchObject({ runtimeEvent: "session/update" });
		expect(result.updates.future_variant_from_v9).toBe(1);
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	describe("permissions fail closed", () => {
		it("rejects with the agent's own reject_once option by default", async () => {
			const { client, events } = await attach("permission");
			await client.prompt("go");
			expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
				permissionOutcome: { outcome: "selected", optionId: "reject" },
			});
			const decided = find(events, "permission.decided")[0]!;
			expect(decided.source).toBe("authority-decision");
			expect(decided.payload).toEqual({
				decidedBy: "adapter-default",
				handlerConsulted: false,
				decision: "selected",
				optionKind: "reject_once",
			});
			expect(decided.derivedFrom).toEqual([find(events, "permission.requested")[0]!.id]);
			expect(JSON.stringify(events)).not.toContain("SECRET");
		});

		it("cancels when the agent offered nothing to reject with", async () => {
			const { client } = await attach("permission-only-allow");
			await client.prompt("go");
			expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
				permissionOutcome: { outcome: "cancelled" },
			});
		});

		it("honors an explicit handler only for an offered option, and cancels otherwise", async () => {
			const allowed = await attach("permission", {
				permissionHandler: () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
			});
			await allowed.client.prompt("go");
			expect(find(allowed.events, "permission.decided")[0]!.payload).toMatchObject({
				decidedBy: "handler",
				decision: "selected",
				optionKind: "allow_once",
			});
			await allowed.client.close();

			for (const handler of [
				() => ({ outcome: { outcome: "selected" as const, optionId: "not-offered" } }),
				() => {
					throw new Error("boom");
				},
				() => ({}) as never,
			]) {
				const { client, events } = await attach("permission", { permissionHandler: handler });
				await client.prompt("go");
				expect(find(events, "permission.decided")[0]!.payload).toMatchObject({
					decision: "cancelled",
					optionKind: null,
				});
				await client.close();
			}
			expect(
				notes()
					.filter((note) => "permissionOutcome" in note)
					.slice(1)
					.map((note) => note.permissionOutcome),
			).toEqual([{ outcome: "cancelled" }, { outcome: "cancelled" }, { outcome: "cancelled" }]);
		});
	});

	it("never consults the handler, or approves, for a stale or foreign-session permission request", async () => {
		let consulted = 0;
		const handler = () => {
			consulted += 1;
			return { outcome: { outcome: "selected" as const, optionId: "allow" } };
		};
		for (const [index, mode] of ["permission-wrong-session", "permission-late"].entries()) {
			const { client, events } = await attach(mode, { permissionHandler: handler });
			await client.prompt("go");
			await until(() => notes().filter((note) => "permissionOutcome" in note).length > index);
			expect(find(events, "permission.decided").at(-1)!.payload).toMatchObject({ decision: "cancelled" });
			await client.close();
		}
		expect(consulted).toBe(0);
		expect(notes().filter((note) => "permissionOutcome" in note)).toEqual([
			{ permissionOutcome: { outcome: "cancelled" } },
			{ permissionOutcome: { outcome: "cancelled" } },
		]);
	});

	it("counts variants named like Object.prototype members as themselves", async () => {
		const { client, events } = await attach("weird-variants");
		const result = await client.prompt("go");
		for (const name of ["__proto__", "constructor"]) {
			expect(Object.hasOwn(result.updates, name), name).toBe(true);
			expect(Object.getOwnPropertyDescriptor(result.updates, name)!.value).toBe(1);
			expect(Object.getOwnPropertyDescriptor(client.updateCounts, name)!.value).toBe(1);
		}
		expect(find(events, "runtime.unrecognized-event").map((event) => event.payload)).toEqual([
			{ runtimeEvent: "__proto__", method: "session/update", schemaStatus: "unknown" },
			{ runtimeEvent: "constructor", method: "session/update", schemaStatus: "unknown" },
		]);
	});

	it("never reports an attachment whose agent died before it was returned", async () => {
		const { error, events } = await attachFailing("exit-after-session-new");
		// Either order of the two independent channels: a failed connect, or an attachment that was then detached,
		// never a detach recorded before the session started.
		if (error !== null) expect(error).toBeInstanceOf(AcpProcessExitedErrorV0);
		await until(() => kinds(events).includes("lifecycle.detached"));
		const order = kinds(events);
		if (order.includes("lifecycle.session-started")) {
			expect(order.indexOf("lifecycle.session-started")).toBeLessThan(order.indexOf("lifecycle.detached"));
		}
	});

	it("does not approve a request whose turn ended while the handler was still deciding", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let consulted = 0;
		const { client, events } = await attach("permission-unawaited", {
			permissionHandler: async () => {
				consulted += 1;
				await gate;
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
		});
		await client.prompt("go");
		await until(() => consulted === 1);
		release();
		await until(() => notes().some((note) => "permissionOutcome" in note));
		expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
			permissionOutcome: { outcome: "cancelled" },
		});
		expect(find(events, "permission.decided")[0]!.payload).toMatchObject({
			decidedBy: "adapter-default",
			handlerConsulted: true,
			decision: "cancelled",
		});
	});

	it("records a recognized variant missing its required fields as malformed, uncounted", async () => {
		const { client, events } = await attach("malformed-known");
		const result = await client.prompt("go");
		expect(find(events, "runtime.malformed-event").map((event) => event.payload)).toEqual([
			{ runtimeEvent: "session/update", variant: "agent_message_chunk", problem: "schema-invalid" },
			{ runtimeEvent: "session/update", variant: "tool_call", problem: "schema-invalid" },
			{ runtimeEvent: "session/update", variant: "usage_update", problem: "schema-invalid" },
		]);
		// Only valid updates count: the common prefix plus three session_info_update (the malformed three are not).
		expect(result.updates).toEqual({
			agent_message_chunk: 2,
			tool_call: 1,
			tool_call_update: 1,
			session_info_update: 3,
		});
		// `titled` is absent when no title was reported, false for a reported null, true for a string.
		expect(
			find(events, "session.update-observed")
				.filter((event) => (event.payload as { update: string }).update === "session_info_update")
				.map((event) =>
					"titled" in (event.payload as object) ? (event.payload as { titled: boolean }).titled : "absent",
				),
		).toEqual(["absent", false, true]);
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	it("namespaces the session coordinate by launch, so two launches of one agent do not merge", async () => {
		const first = await attach("normal");
		const second = await attach("normal");
		const coordinate = (events: readonly EndoEventV0[]) => find(events, "harness.attached")[0]!.coordinates.sessionId;
		expect(coordinate(first.events)).not.toBe(coordinate(second.events));
		expect(coordinate(first.events)).toMatch(/^endo\.session\.acp\.[0-9a-f]{12}\.fake-session-1$/);
	});

	it("cancels a permission request whose options share an id, without consulting the handler", async () => {
		let consulted = 0;
		for (const permissionHandler of [
			undefined,
			() => {
				consulted += 1;
				return { outcome: { outcome: "selected" as const, optionId: "same" } };
			},
		]) {
			const { client, events } = await attach("permission-duplicate-ids", { permissionHandler });
			await client.prompt("go");
			expect(find(events, "permission.requested")[0]!.payload).toMatchObject({ duplicateOptionIds: true });
			expect(find(events, "permission.decided")[0]!.payload).toMatchObject({
				decision: "cancelled",
				optionKind: null,
			});
			await client.close();
		}
		expect(consulted).toBe(0);
		expect(notes().filter((note) => "permissionOutcome" in note)).toEqual([
			{ permissionOutcome: { outcome: "cancelled" } },
			{ permissionOutcome: { outcome: "cancelled" } },
		]);
	});

	it("bounds a handler by what was offered, not by what it did to the request", async () => {
		const { client, events } = await attach("permission", {
			permissionHandler: (request) => {
				request.options.push({ kind: "allow_always", name: "Injected", optionId: "injected" });
				return { outcome: { outcome: "selected", optionId: "injected" } };
			},
		});
		await client.prompt("go");
		expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
			permissionOutcome: { outcome: "cancelled" },
		});
		expect(find(events, "permission.decided")[0]!.payload).toMatchObject({ decision: "cancelled", optionKind: null });
	});

	it("approves nothing once close() has begun, even if the handler answers at that moment", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let consulted = 0;
		const { client, events } = await attach("permission", {
			permissionHandler: async () => {
				consulted += 1;
				await gate;
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
		});
		const turn = client.prompt("go").catch(() => null);
		await until(() => consulted === 1);
		const closing = client.close();
		release();
		await closing;
		await turn;
		expect(find(events, "permission.decided")[0]!.payload).toMatchObject({ decision: "cancelled" });
	});

	it("rejects nested-malformed content of a recognized update and counts only the valid one", async () => {
		const { client, events } = await attach("malformed-nested");
		const result = await client.prompt("go");
		expect(
			find(events, "runtime.malformed-event").map((event) => (event.payload as { variant: string }).variant),
		).toEqual([
			"agent_message_chunk",
			"agent_message_chunk",
			"agent_message_chunk",
			"plan",
			"available_commands_update",
			"config_option_update",
			"config_option_update",
			"agent_message_chunk",
		]);
		// The common prefix has two valid chunks; the valid one at the end is the third.
		expect(result.updates.agent_message_chunk).toBe(3);
		expect(result.updates.plan).toBeUndefined();
	});

	it("does not take an update without a JSON-RPC 2.0 envelope as activity", async () => {
		const { client } = await attach("bad-envelope");
		const result = await client.prompt("go");
		// Only the common prefix's two chunks; the envelope-less third is not counted.
		expect(result.updates.agent_message_chunk).toBe(2);
		expect(result.stopReason).toBe("end_turn");
	});

	it("attributes a handler's own explicit cancellation to the handler", async () => {
		const { client, events } = await attach("permission", {
			permissionHandler: () => ({ outcome: { outcome: "cancelled" } }),
		});
		await client.prompt("go");
		expect(find(events, "permission.decided")[0]!.payload).toMatchObject({
			decidedBy: "handler",
			handlerConsulted: true,
			decision: "cancelled",
		});
	});

	it("reports an agent that exited while a descendant holds its stdout, long before the prompt timeout", async () => {
		const { client, events } = await attach("exit-retaining-pipe", { promptTimeoutMs: 20_000 });
		const started = Date.now();
		await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(find(events, "harness.prompt-timeout")).toEqual([]);
		expect(find(events, "lifecycle.interrupted")).toHaveLength(1);
	});

	it("keeps an opaque tool call id correlatable when it is not short printable ASCII", async () => {
		const { client, events } = await attach("odd-tool-id");
		await client.prompt("go");
		const ids = find(events, "session.update-observed")
			.map((event) => (event.payload as { toolCallId?: string }).toolCallId)
			.filter((id) => id !== "call_1");
		expect(ids).toHaveLength(3);
		expect(ids[0]).toMatch(/^sha256-[0-9a-f]{48}$/);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).toMatch(/^sha256-[0-9a-f]{48}$/);
		expect(ids[2]).not.toBe(ids[0]);
	});

	it("refuses work as soon as the ACP stream has closed, before the fault is classified", async () => {
		const { client, events } = await attach("close-stdout");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(find(events, "harness.protocol-fault")).toEqual([]);
		await expect(client.prompt("early")).rejects.toThrow(/closed/);
		expect(await client.cancel()).toBe(false);
	});

	it("does not count an update that a descendant writes after the agent has exited", async () => {
		const { client, events } = await attach("late-update-after-exit", { promptTimeoutMs: 20_000 });
		await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
		await until(() => kinds(events).includes("harness.late-message"), 5_000);
		expect(find(events, "harness.late-message")[0]!.payload).toEqual({ method: "session/update", after: "exit" });
		// The common prefix's two chunks; the late one is not counted, and nothing follows the interruption.
		expect(client.updateCounts.agent_message_chunk).toBe(2);
		const lateAt = kinds(events).indexOf("harness.late-message");
		expect(kinds(events).slice(lateAt)).not.toContain("session.update-observed");
	});

	it.skipIf(process.platform === "win32")(
		"neither records, consults a handler for, nor approves a permission request from a dead agent's descendant",
		async () => {
			let consulted = 0;
			const { client, events } = await attach("permission-after-exit", {
				promptTimeoutMs: 20_000,
				permissionHandler: () => {
					consulted += 1;
					return { outcome: { outcome: "selected", optionId: "allow" } };
				},
			});
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
			await until(() => kinds(events).includes("harness.late-message"), 5_000);
			await until(() => notes().some((note) => "lateAnswer" in note), 5_000);
			expect(find(events, "harness.late-message")[0]!.payload).toEqual({
				method: "session/request_permission",
				after: "exit",
			});
			expect(kinds(events).filter((kind) => kind.startsWith("permission."))).toEqual([]);
			expect(consulted).toBe(0);
			// What went over the wire to the descendant: a cancellation, never a selection.
			const answer = JSON.parse((notes().find((note) => "lateAnswer" in note) as { lateAnswer: string }).lateAnswer);
			expect(answer).toMatchObject({ id: 9001, result: { outcome: { outcome: "cancelled" } } });
		},
	);

	it("rejects status and kind values outside ACP v1, and keeps an opaque mode id correlatable", async () => {
		const { client, events } = await attach("bad-enums");
		const result = await client.prompt("go");
		expect(
			find(events, "runtime.malformed-event").map((event) => (event.payload as { variant: string }).variant),
		).toEqual(["tool_call_update", "tool_call"]);
		expect(result.updates.current_mode_update).toBe(1);
		const mode = find(events, "session.update-observed").find(
			(event) => (event.payload as { update: string }).update === "current_mode_update",
		)!;
		expect((mode.payload as { modeId: string }).modeId).toMatch(/^sha256-[0-9a-f]{48}$/);
	});

	it("returns a fresh response, so a handler that keeps its object cannot change an approval afterwards", async () => {
		let kept: { outcome: { outcome: string; optionId?: string } } | undefined;
		const { client } = await attach("permission", {
			permissionHandler: () => {
				kept = { outcome: { outcome: "selected", optionId: "reject" } };
				// Mutated after the handler returns, as a caller holding the object could.
				setTimeout(() => {
					if (kept) kept.outcome.optionId = "allow";
				}, 0);
				return kept as never;
			},
		});
		await client.prompt("go");
		expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
			permissionOutcome: { outcome: "selected", optionId: "reject" },
		});
	});

	it("treats a closed ACP stream under a living agent as a fault and ends the group", async () => {
		const { client, events } = await attach("close-stdout");
		await until(() => kinds(events).includes("harness.process-exited"), 8_000);
		expect(find(events, "harness.protocol-fault")[0]!.payload).toEqual({ fault: "connection-closed" });
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ expected: true });
		expect(client.liveProcessMembers()).toBe(false);
		await expect(client.prompt("late")).rejects.toThrow(/closed/);
	});

	it("serves no file system: an fs request gets an error response, not a hang", async () => {
		const { client } = await attach("fs");
		await client.prompt("go");
		expect(notes().find((note) => "fsReadError" in note)).toEqual({ fsReadError: -32601 });
	});

	describe("a turn that does not complete", () => {
		it("times out without claiming an outcome, and close() ends the child and the turn", async () => {
			const { client, events } = await attach("hang", { promptTimeoutMs: 200 });
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpTimeoutErrorV0);
			expect(find(events, "harness.prompt-timeout")).toHaveLength(1);
			expect(kinds(events).filter((kind) => /run-(completed|failed|aborted)/.test(kind))).toEqual([]);
			await client.close();
			expect(client.liveProcessMembers()).toBe(false);
			expect(find(events, "lifecycle.interrupted")[0]!.payload).toMatchObject({
				cause: "runtime-exited",
				runOpen: true,
			});
		});

		it("is ended by cancel(): the agent's cancelled stop reason is an abort, with the request recorded", async () => {
			const { client, events } = await attach("cancellable");
			const turn = client.prompt("go");
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			expect(await client.cancel()).toBe(true);
			expect((await turn).stopReason).toBe("cancelled");
			expect(find(events, "lifecycle.stop-requested")).toHaveLength(1);
			expect(find(events, "lifecycle.run-aborted")[0]!.payload).toMatchObject({ stopRequested: true });
			expect(await client.cancel()).toBe(false);
		});

		it("is a completion, not an abort, when completion wins the race against cancel()", async () => {
			const { client, events } = await attach("cancel-ignored");
			const turn = client.prompt("go");
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			await client.cancel();
			expect((await turn).stopReason).toBe("end_turn");
			expect(find(events, "lifecycle.run-aborted")).toEqual([]);
			expect(find(events, "lifecycle.run-completed")[0]!.payload).toMatchObject({ stopRequested: true });
		});

		it("is an interruption, never a completion, when the agent exits mid-turn", async () => {
			const { client, events } = await attach("exit-during-prompt");
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
			expect(find(events, "lifecycle.interrupted")).toHaveLength(1);
			expect(kinds(events)).not.toContain("agent.prompt-responded");
			expect(kinds(events).filter((kind) => /run-(completed|failed|aborted|unclassified)/.test(kind))).toEqual([]);
		});

		it("does not become success when the agent writes garbage and dies", async () => {
			const { client, events } = await attach("malformed");
			await expect(client.prompt("go")).rejects.toBeInstanceOf(Error);
			expect(kinds(events)).not.toContain("agent.prompt-responded");
			expect(kinds(events).filter((kind) => /run-completed/.test(kind))).toEqual([]);
		});
	});

	it("does not accept a stop reason outside ACP v1's set", async () => {
		const { client, events } = await attach("bad-stop");
		await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProtocolErrorV0);
		expect(find(events, "harness.protocol-fault")[0]!.payload).toEqual({ fault: "stop-reason-malformed" });
		expect(find(events, "lifecycle.run-unclassified")).toHaveLength(1);
		expect(kinds(events)).not.toContain("lifecycle.run-completed");
	});

	it("records a JSON-RPC refusal as a failed run by code, without its message", async () => {
		const { client, events } = await attach("refuse");
		const error = await client.prompt("go").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AcpRefusedErrorV0);
		expect((error as AcpRefusedErrorV0).code).toBe(-32000);
		expect(find(events, "lifecycle.run-failed")[0]!.payload).toMatchObject({
			cause: { source: "jsonrpc-error", code: -32000 },
		});
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	it("reports a non-completion stop reason as reported, not as success or failure", async () => {
		const { client, events } = await attach("max-tokens");
		expect((await client.prompt("go")).stopReason).toBe("max_tokens");
		expect(find(events, "lifecycle.run-unclassified")[0]!.payload).toMatchObject({
			reason: "acp-stop-reason:max_tokens",
			stopReason: { status: "reported", value: "max_tokens" },
		});
	});

	describe("teardown", () => {
		it.skipIf(process.platform === "win32")("ends a descendant of the agent", async () => {
			const { client } = await attach("grandchild");
			const pid = (notes().find((note) => "grandchildPid" in note) as { grandchildPid: number }).grandchildPid;
			expect(alive(pid)).toBe(true);
			await client.close();
			await until(() => !alive(pid));
			expect(client.liveProcessMembers()).toBe(false);
		});

		it.skipIf(process.platform === "win32")(
			"ends an agent that ignores SIGTERM and its descendant within bounds",
			async () => {
				const { client } = await attach("ignore-sigterm");
				const pid = (notes().find((note) => "grandchildPid" in note) as { grandchildPid: number }).grandchildPid;
				const started = Date.now();
				const exit = await client.close();
				expect(Date.now() - started).toBeLessThan(5_000);
				expect(exit.signal).toBe("SIGKILL");
				await until(() => !alive(pid));
				expect(client.liveProcessMembers()).toBe(false);
			},
		);

		it("is idempotent, and refuses work afterwards", async () => {
			const { client, events } = await attach("normal");
			const [first, second] = await Promise.all([client.close(), client.close()]);
			expect(second).toBe(first);
			await client.close();
			expect(find(events, "harness.process-exited")).toHaveLength(1);
			await expect(client.prompt("late")).rejects.toThrow(/closed/);
			expect(await client.cancel()).toBe(false);
		});

		it("records the agent's answer to a timed-out turn when cancel() makes it arrive late", async () => {
			const { client, events } = await attach("cancellable", { promptTimeoutMs: 200 });
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpTimeoutErrorV0);
			expect(find(events, "harness.prompt-timeout")).toHaveLength(1);
			expect(find(events, "lifecycle.run-aborted")).toEqual([]);
			expect(await client.cancel()).toBe(true);
			await until(() => find(events, "lifecycle.run-aborted").length === 1);
			expect(find(events, "lifecycle.run-aborted")[0]!.payload).toMatchObject({ stopRequested: true });
			await client.close();
			expect(find(events, "lifecycle.interrupted")).toEqual([]);
		});

		it("blames nobody when close() ends the connection under an awaited turn", async () => {
			const { client, events } = await attach("ignore-sigterm");
			const turn = client.prompt("go");
			const outcome = turn.then(
				() => null,
				(error: unknown) => error,
			);
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			await client.close();
			expect(await outcome).toBeInstanceOf(AcpClosedErrorV0);
			expect(find(events, "harness.protocol-fault")).toEqual([]);
			expect(find(events, "lifecycle.interrupted")).toHaveLength(1);
			expect(kinds(events).filter((kind) => /run-(completed|failed|aborted|unclassified)/.test(kind))).toEqual([]);
			expect(find(events, "lifecycle.detached")).toEqual([]);
		});

		it("allows one open turn at a time", async () => {
			const { client } = await attach("cancellable");
			const turn = client.prompt("one");
			await expect(client.prompt("two")).rejects.toThrow(/already open/);
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			await client.cancel();
			await turn;
		});
	});
});
