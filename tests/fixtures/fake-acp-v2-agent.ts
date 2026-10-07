// A deterministic fake ACP v2 (Draft, baseline) agent for the v2 conformance suite. It speaks raw newline-delimited
// JSON-RPC on stdio and imports nothing, not the SDK: the point is to control every byte, malformed and hostile ones
// included, which an SDK agent would refuse to send. It needs no model, network or credentials.
//
// Behaviour is chosen by `FAKE_V2_FLAGS` (comma separated). `FAKE_V2_OUT` (optional) is a file the agent appends JSON
// lines to, so a test can see what the agent itself observed. `FAKE_V2_STORE` (optional) is the file the agent retains
// its conversation in, which a second launched agent replays on `session/resume`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const flags = new Set((process.env.FAKE_V2_FLAGS ?? "").split(",").filter(Boolean));
const flagValue = (name: string): string | undefined => {
	for (const flag of flags) if (flag.startsWith(`${name}=`)) return flag.slice(name.length + 1);
	return undefined;
};
const out = process.env.FAKE_V2_OUT;
const storePath = process.env.FAKE_V2_STORE;
const note = (value: Record<string, unknown>): void => {
	if (out !== undefined) appendFileSync(out, `${JSON.stringify(value)}\n`);
};
const send = (message: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const reply = (id: unknown, result: unknown): void => send({ id, result });
const fail = (id: unknown, code: number, message: string): void => send({ id, error: { code, message } });
const update = (sessionId: string, body: Record<string, unknown>): void =>
	send({ method: "session/update", params: { sessionId, update: body } });
const text = (value: string) => ({ type: "text", text: value });

if (flags.has("ignore-sigterm")) process.on("SIGTERM", () => {});
// What the agent's environment holds: launch.env must be the whole of it.
note({ leakProbe: process.env.ENDO_ACP_V2_LEAK_PROBE ?? null });

interface Message {
	id: string;
	kind: "user" | "agent" | "thought";
	content: unknown[];
}
interface Store {
	sessionId: string;
	cwd: string;
	messages: Message[];
	toolCalls: Array<{ toolCallId: string; record: Record<string, unknown> }>;
}

const SESSION = "fake-v2-session-1";
let store: Store | null = null;
if (storePath !== undefined && existsSync(storePath)) store = JSON.parse(readFileSync(storePath, "utf8")) as Store;
const persist = (): void => {
	if (storePath !== undefined && store !== null) writeFileSync(storePath, JSON.stringify(store));
};

// ---- initialize -----------------------------------------------------------------------------------------------------
const version = flagValue("version");
function initializeResult(): unknown {
	if (version === "1") {
		// What a v1-only agent answers: the version it speaks, in the v1 shape.
		return {
			protocolVersion: 1,
			agentInfo: { name: "fake-v1-only", version: "1.0.0" },
			agentCapabilities: {},
			authMethods: [],
		};
	}
	if (version !== undefined && version !== "2")
		return {
			protocolVersion: Number(version) || version,
			info: { name: "fake", version: "9" },
			capabilities: { session: {} },
		};
	const caps = flagValue("caps") ?? "session";
	const capabilities: Record<string, unknown> =
		caps === "none"
			? {}
			: caps === "null"
				? { session: null }
				: caps === "extras"
					? {
							session: { delete: {}, additionalDirectories: {}, fork: {}, prompt: { image: {} } },
							providers: {},
							nes: {},
							positionEncoding: "utf-16",
						}
					: { session: {} };
	if (flags.has("incoherent")) return { protocolVersion: 2, capabilities };
	return {
		protocolVersion: 2,
		info: { name: process.env.FAKE_V2_NAME ?? "fake-acp-v2-agent", title: "Fake v2", version: "9.9.9" },
		capabilities,
		authMethods: [],
	};
}

// ---- prompt ---------------------------------------------------------------------------------------------------------
let promptCount = 0;
let cancelNow: (() => void) | undefined;
const pendingResponses = new Map<unknown, (message: Record<string, unknown>) => void>();
let nextRequestId = 9000;
const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
	new Promise((resolve) => {
		const id = nextRequestId++;
		pendingResponses.set(id, resolve);
		send({ id, method, params });
	});

function permissionParams(n: number, tcid: string): Record<string, unknown> {
	const options = flags.has("perm-no-reject")
		? [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
		: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			];
	const base: Record<string, unknown> = { sessionId: SESSION, title: `SECRET-TITLE-${n}`, options };
	if (flags.has("perm-description")) base.description = "SECRET-DESCRIPTION";
	const subject = flagValue("perm");
	if (subject === "tool_call")
		base.subject = { type: "tool_call", toolCall: { toolCallId: tcid, title: "SECRET-TOOL-TITLE" } };
	else if (subject === "command")
		base.subject = {
			type: "command",
			command: process.env.FAKE_V2_COMMAND ?? "rm -rf SECRET-COMMAND",
			cwd: "/tmp",
			toolCallId: tcid,
		};
	else if (subject === "unknown") base.subject = { type: "_vendor_subject", payload: { x: 1 } };
	else if (subject === "future") base.subject = { type: "future_subject", payload: { x: 1 } };
	else if (subject === "malformed-command") base.subject = { type: "command", command: "ls" };
	else if (subject === "malformed-tool") base.subject = { type: "tool_call" };
	else if (subject === "null") base.subject = null;
	if (flags.has("perm-dup-ids"))
		base.options = [
			{ optionId: "x", name: "A", kind: "allow_once" },
			{ optionId: "x", name: "B", kind: "reject_once" },
		];
	if (flags.has("perm-custom-kind-only")) base.options = [{ optionId: "c", name: "C", kind: "_custom" }];
	return base;
}

async function runPrompt(id: unknown, params: Record<string, unknown>): Promise<void> {
	const n = ++promptCount;
	const sessionId = String(params.sessionId);
	const umid = `um-${n}`;
	const amid = `am-${n}`;
	const thid = `th-${n}`;
	const tcid = `tc-${n}`;
	const block = ((params.prompt as unknown[])[0] ?? text("")) as Record<string, unknown>;
	const accept = (): void => reply(id, { messageId: umid });
	if (store === null) store = { sessionId, cwd: "/", messages: [], toolCalls: [] };
	store.messages.push({ id: umid, kind: "user", content: [block] });
	if (flags.has("refuse-prompt")) {
		store.messages.pop();
		fail(id, -32000, "refused");
		return;
	}
	if (flags.has("malformed-accept")) send({ id, result: {} });
	else if (!flags.has("ack-late") && !flags.has("ack-after-echo")) accept();
	if (!flags.has("no-echo")) update(sessionId, { sessionUpdate: "user_message", messageId: umid, content: [block] });
	if (flags.has("ack-after-echo")) accept();
	if (flags.has("idle-only")) {
		update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
		persist();
		return;
	}
	if (flags.has("idle-first")) update(sessionId, { sessionUpdate: "state_update", state: "idle" });
	update(sessionId, { sessionUpdate: "state_update", state: "running" });
	update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: thid, content: text("think ") });
	update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: thid, content: text("hard") });
	store.messages.push({ id: thid, kind: "thought", content: [text("think "), text("hard")] });
	update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: amid, content: text("Hello ") });
	update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: amid, content: text("world") });
	store.messages.push({ id: amid, kind: "agent", content: [text("Hello "), text("world")] });
	update(sessionId, {
		sessionUpdate: "tool_call_update",
		toolCallId: tcid,
		name: "read",
		title: "SECRET-TOOL",
		kind: "read",
		status: "in_progress",
	});
	const finished = { content: [{ type: "content", content: text("SECRET-TOOL-OUTPUT") }], status: "completed" };
	update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tcid, ...finished });
	store.toolCalls.push({
		toolCallId: tcid,
		record: { name: "read", title: "SECRET-TOOL", kind: "read", ...finished },
	});
	if (flags.has("live-only"))
		update(sessionId, {
			sessionUpdate: "agent_message",
			messageId: `lo-${n}`,
			content: [text("local command output")],
		});
	if (flags.has("extras")) {
		update(sessionId, { sessionUpdate: "_vendor/progress", detail: { pct: 50 } });
		update(sessionId, { sessionUpdate: "notice", severity: "info", message: "unstable" });
		update(sessionId, { sessionUpdate: "agent_message", content: [text("no id")] });
		update(sessionId, { sessionUpdate: "state_update", state: "_busy" });
		update(sessionId, { sessionUpdate: "state_update", state: "unknown" });
		update(sessionId, {
			sessionUpdate: "plan_update",
			plan: {
				type: "items",
				planId: "plan-1",
				entries: [{ content: "SECRET-PLAN", priority: "high", status: "pending" }],
			},
		});
		update(sessionId, {
			sessionUpdate: "plan_update",
			plan: {
				type: "items",
				planId: "plan-2",
				entries: [
					{ content: "x", priority: "low", status: "__proto__" },
					{ content: "y", priority: "low", status: "toString" },
					{ content: "z", priority: "low", status: "toString" },
				],
			},
		});
		update(sessionId, { sessionUpdate: "terminal_update", terminalId: "term-1", exitStatus: null, output: null });
		update(sessionId, { sessionUpdate: "usage_update", used: 10, size: 100 });
		update(sessionId, { sessionUpdate: "session_info_update", title: "SECRET-TITLE" });
	}
	if (flags.has("requires-action")) update(sessionId, { sessionUpdate: "state_update", state: "requires_action" });
	if (flagValue("perm") !== undefined) {
		const answer = await request("session/request_permission", permissionParams(n, tcid));
		note({ permissionAnswer: answer.error !== undefined ? { error: answer.error } : answer.result });
		const outcome = (answer.result as { outcome?: { outcome?: string } } | undefined)?.outcome?.outcome;
		if (outcome === "cancelled") {
			update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
			persist();
			return;
		}
	}
	if (flags.has("hold") || flags.has("ignore-cancel")) {
		await new Promise<void>((resolve) => {
			cancelNow = resolve;
		});
		if (flags.has("ignore-cancel")) return; // never goes idle: the agent violates the cancellation MUST
		update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
		persist();
		return;
	}
	if (flags.has("exit-mid-run")) process.exit(3);
	if (flags.has("no-idle")) {
		persist();
		return;
	}
	const stop = flagValue("stop") ?? "end_turn";
	if (flags.has("idle-no-stop")) update(sessionId, { sessionUpdate: "state_update", state: "idle" });
	else update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: stop });
	if (flags.has("ack-late")) accept();
	persist();
}

// ---- replay ---------------------------------------------------------------------------------------------------------
function replay(sessionId: string): void {
	if (store === null) return;
	const strategy = flagValue("retain") ?? "chunks";
	const emit = (message: Message, how: string): void => {
		const kind = message.kind === "user" ? "user" : message.kind === "agent" ? "agent" : "agent_thought";
		const full = kind === "agent_thought" ? "agent_thought" : `${kind}_message`;
		const chunk = kind === "agent_thought" ? "agent_thought_chunk" : `${kind}_message_chunk`;
		if (how === "whole") update(sessionId, { sessionUpdate: full, messageId: message.id, content: message.content });
		else if (how === "empty-first") {
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: [] });
			for (const piece of message.content)
				update(sessionId, { sessionUpdate: chunk, messageId: message.id, content: piece });
		} else if (how === "chunks-after-replace") {
			// A whole message, then chunks that would double it: wrong on purpose (a replacement must not be doubled by earlier chunks).
			update(sessionId, { sessionUpdate: chunk, messageId: message.id, content: text("STALE") });
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: message.content });
		} else if (how === "dup") {
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: message.content });
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: message.content });
		} else if (how === "clear-then-whole") {
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: null });
			update(sessionId, { sessionUpdate: full, messageId: message.id, content: message.content });
		} else
			for (const piece of message.content)
				update(sessionId, { sessionUpdate: chunk, messageId: message.id, content: piece });
	};
	for (const message of store.messages) {
		if (strategy === "mutate" && message.kind === "agent") {
			emit({ ...message, content: [text("DIFFERENT")] }, "whole");
		} else if (strategy === "kind-swap" && message.kind === "agent") {
			update(sessionId, { sessionUpdate: "user_message", messageId: message.id, content: message.content });
		} else emit(message, strategy === "mutate" || strategy === "kind-swap" ? "whole" : strategy);
	}
	if (strategy === "invent")
		update(sessionId, { sessionUpdate: "agent_message", messageId: "never-existed", content: [text("invented")] });
	if (strategy === "contradict")
		update(sessionId, {
			sessionUpdate: "user_message",
			messageId: store.messages.find((m) => m.kind === "agent")?.id ?? "x",
			content: [text("again")],
		});
	for (const call of store.toolCalls) {
		update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, ...call.record });
		if (flags.has("replay-tool-chunk-dup"))
			update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, ...call.record });
	}
	if (flags.has("replay-state"))
		update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
}

// ---- dispatch -------------------------------------------------------------------------------------------------------
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	let message: Record<string, unknown>;
	try {
		message = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}
	if (message.method === undefined && message.id !== undefined) {
		const waiting = pendingResponses.get(message.id);
		if (waiting !== undefined) {
			pendingResponses.delete(message.id);
			waiting(message);
		}
		return;
	}
	const { id, method } = message as { id?: unknown; method?: string };
	const params = (message.params ?? {}) as Record<string, unknown>;
	note({
		received: method,
		...(method === "initialize" ? { protocolVersion: params.protocolVersion } : {}),
		...(method === "session/resume" ? { replayFrom: params.replayFrom ?? null } : {}),
	});
	switch (method) {
		case "initialize":
			reply(id, initializeResult());
			return;
		case "session/new":
			if (flags.has("new-refuse")) return fail(id, -32000, "refused");
			store = { sessionId: SESSION, cwd: String(params.cwd), messages: [], toolCalls: [] };
			persist();
			reply(
				id,
				flags.has("config")
					? {
							sessionId: SESSION,
							configOptions: [
								{
									configId: "model",
									name: "SECRET-MODEL-NAME",
									category: "model",
									type: "select",
									currentValue: "m1",
									options: [{ value: "m1", name: "M1" }],
								},
								{ configId: "verbose", name: "V", type: "boolean", currentValue: false },
							],
						}
					: { sessionId: SESSION },
			);
			return;
		case "session/list":
			if (flags.has("spontaneous") || flags.has("spontaneous-hold")) {
				// Foreground work the client never asked for, reported after the list answer.
				reply(id, { sessions: [] });
				update(SESSION, { sessionUpdate: "state_update", state: "running" });
				if (flags.has("spontaneous-hold")) {
					void new Promise<void>((resolve) => {
						cancelNow = resolve;
					}).then(() =>
						update(SESSION, { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" }),
					);
				} else update(SESSION, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
				return;
			}
			reply(
				id,
				flags.has("list-malformed")
					? { sessions: [{ sessionId: 5 }] }
					: {
							sessions:
								store === null
									? []
									: [
											{
												sessionId: store.sessionId,
												cwd: store.cwd,
												title: typeof params.cursor === "string" ? params.cursor : "t",
												updatedAt: flags.has("list-bad-date")
													? "2023-02-30T00:00:00Z"
													: "2026-01-01T00:00:00Z",
											},
										],
						},
			);
			return;
		case "session/resume": {
			if (store === null || params.sessionId !== store.sessionId) return fail(id, -32602, "unknown session");
			const sessionId = String(params.sessionId);
			const replayFrom = params.replayFrom as { type?: string } | null | undefined;
			if (flags.has("replay-late")) {
				reply(id, {});
				if (replayFrom?.type === "start") replay(sessionId);
				return;
			}
			if (replayFrom?.type === "start" || flags.has("replay-unrequested")) replay(sessionId);
			if (flags.has("resume-malformed")) return send({ id, result: { configOptions: "no" } });
			reply(id, {});
			return;
		}
		case "session/close":
			if (flags.has("close-refuse")) return fail(id, -32000, "no");
			reply(id, {});
			return;
		case "session/prompt":
			void runPrompt(id, params);
			return;
		case "session/cancel":
			note({ cancelled: true });
			cancelNow?.();
			return;
		default:
			if (id !== undefined) fail(id, -32601, "method not found");
	}
});
lines.on("close", () => process.exit(0));
