// The Pi RPC client: one `pi --mode rpc` child process, driven only through Pi's documented RPC commands
// (packages/coding-agent/docs/rpc-commands.md and src/modes/rpc/rpc-types.ts at the tested version). It imports nothing
// from Pi: every record is JSON on a pipe, and every response field this adapter relies on is validated here before
// use. A response that does not have the documented shape is a protocol fault, never a partial success.
//
// Correlation is by the IDs the connection assigns, never by arrival order (Pi may emit an event such as queue_update
// before the response to the steer that caused it). Session events carry no command ID and are delivered as they arrive.

import {
	RpcConnectionV0,
	type RpcDiagnosticV0,
	type RpcEventV0,
	type RpcTerminationV0,
} from "../rpc-jsonl/rpc-connection.ts";

/** A documented command was refused by Pi (`success: false`). The text is Pi's and may quote input: never persist it. */
export class PiRpcRefusalV0 extends Error {
	readonly command: string;
	readonly refusal: string;
	constructor(command: string, refusal: string) {
		super(`Pi refused ${command}`);
		this.name = "PiRpcRefusalV0";
		this.command = command;
		this.refusal = refusal;
	}
}

/** A response arrived but does not have the documented shape. */
export class PiRpcProtocolErrorV0 extends Error {
	readonly command: string;
	constructor(command: string, detail: string) {
		super(`Pi ${command} response is malformed: ${detail}`);
		this.name = "PiRpcProtocolErrorV0";
		this.command = command;
	}
}

export interface PiModelRefV0 {
	provider: string;
	id: string;
}

/** The fields of Pi's RpcSessionState this adapter uses. */
export interface PiSessionStateV0 {
	model: PiModelRefV0 | null;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionId: string;
	sessionFile: string | null;
	messageCount: number;
	pendingMessageCount: number;
	steeringMode: string;
	followUpMode: string;
}

/** One session entry as get_entries returns it: the common entry fields, the rest kept as Pi sent it. */
export interface PiSessionEntryV0 {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	raw: Readonly<Record<string, unknown>>;
}

export interface PiSessionStatsV0 {
	sessionId: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
}

export interface PiRpcLaunchOptionsV0 {
	/** The resolved executable (from identity.ts). It is spawned directly, never through a shell. */
	readonly executable: string;
	readonly cwd: string;
	/** The child's complete environment. Nothing else is inherited. */
	readonly env: Readonly<Record<string, string>>;
	/** Session persistence: an ephemeral in-memory session, or a session id under a session directory. */
	readonly session:
		| { readonly kind: "ephemeral" }
		| { readonly kind: "persistent"; readonly sessionDir: string; readonly sessionId: string };
	readonly provider?: string;
	readonly model?: string;
	/** Tool selection: Pi's default, none, or an explicit allowlist. */
	readonly tools?: "default" | "none" | readonly string[];
	/** Pass `--offline` (no startup network activity). */
	readonly offline?: boolean;
	readonly requestTimeoutMs?: number;
	readonly closeTimeoutMs?: number;
	readonly onDiagnostic?: (diagnostic: RpcDiagnosticV0) => void;
}

const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Build Pi's argument vector after `--mode rpc`. Every value is a separate argv element; nothing is interpolated. */
export function piRpcArgumentsV0(options: PiRpcLaunchOptionsV0): string[] {
	const args: string[] = [];
	if (options.session.kind === "ephemeral") args.push("--no-session");
	else {
		if (!SESSION_ID.test(options.session.sessionId)) throw new TypeError("invalid Pi session id");
		if (options.session.sessionDir.length === 0) throw new TypeError("empty Pi session directory");
		args.push("--session-dir", options.session.sessionDir, "--session-id", options.session.sessionId);
	}
	if (options.provider !== undefined) {
		if (options.model === undefined) throw new TypeError("Pi requires --model with --provider");
		args.push("--provider", options.provider);
	}
	if (options.model !== undefined) args.push("--model", options.model);
	const tools = options.tools ?? "default";
	if (tools === "none") args.push("--no-tools");
	else if (tools !== "default") {
		if (tools.length === 0 || !tools.every((name) => TOOL_NAME.test(name))) throw new TypeError("invalid tool list");
		args.push("--tools", tools.join(","));
	}
	if (options.offline === true) args.push("--offline");
	if (args.some((value) => value.includes("\0"))) throw new TypeError("a Pi argument contains a NUL byte");
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseState(data: unknown): PiSessionStateV0 {
	if (!isRecord(data)) throw new PiRpcProtocolErrorV0("get_state", "data is not an object");
	const { model, thinkingLevel, isStreaming, isCompacting, sessionId, sessionFile, messageCount } = data;
	if (typeof thinkingLevel !== "string") throw new PiRpcProtocolErrorV0("get_state", "thinkingLevel");
	if (typeof isStreaming !== "boolean" || typeof isCompacting !== "boolean")
		throw new PiRpcProtocolErrorV0("get_state", "isStreaming/isCompacting");
	if (typeof sessionId !== "string" || sessionId.length === 0)
		throw new PiRpcProtocolErrorV0("get_state", "sessionId");
	if (sessionFile !== undefined && typeof sessionFile !== "string")
		throw new PiRpcProtocolErrorV0("get_state", "sessionFile");
	if (!isCount(messageCount) || !isCount(data.pendingMessageCount))
		throw new PiRpcProtocolErrorV0("get_state", "message counts");
	if (typeof data.steeringMode !== "string" || typeof data.followUpMode !== "string")
		throw new PiRpcProtocolErrorV0("get_state", "queue modes");
	let ref: PiModelRefV0 | null = null;
	if (model !== undefined) {
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string")
			throw new PiRpcProtocolErrorV0("get_state", "model");
		ref = { provider: model.provider, id: model.id };
	}
	return {
		model: ref,
		thinkingLevel,
		isStreaming,
		isCompacting,
		sessionId,
		sessionFile: sessionFile ?? null,
		messageCount,
		pendingMessageCount: data.pendingMessageCount as number,
		steeringMode: data.steeringMode,
		followUpMode: data.followUpMode,
	};
}

function parseEntries(data: unknown): { entries: PiSessionEntryV0[]; leafId: string | null } {
	if (!isRecord(data) || !Array.isArray(data.entries)) throw new PiRpcProtocolErrorV0("get_entries", "entries");
	if (data.leafId !== null && (typeof data.leafId !== "string" || data.leafId.length === 0))
		throw new PiRpcProtocolErrorV0("get_entries", "leafId");
	const seen = new Set<string>();
	const entries = data.entries.map((entry, index) => {
		if (!isRecord(entry)) throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} is not an object`);
		const { type, id, parentId, timestamp } = entry;
		if (typeof type !== "string" || type.length === 0)
			throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} type`);
		if (typeof id !== "string" || id.length === 0 || id.length > 256)
			throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} id`);
		if (seen.has(id)) throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} repeats id`);
		seen.add(id);
		if (parentId !== null && (typeof parentId !== "string" || parentId.length === 0))
			throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} parentId`);
		if (typeof timestamp !== "string") throw new PiRpcProtocolErrorV0("get_entries", `entry ${index} timestamp`);
		return { type, id, parentId: parentId as string | null, timestamp, raw: entry };
	});
	return { entries, leafId: data.leafId as string | null };
}

function parseStats(data: unknown): PiSessionStatsV0 {
	if (!isRecord(data)) throw new PiRpcProtocolErrorV0("get_session_stats", "data is not an object");
	const { tokens, cost, sessionId } = data;
	if (typeof sessionId !== "string") throw new PiRpcProtocolErrorV0("get_session_stats", "sessionId");
	if (!isRecord(tokens)) throw new PiRpcProtocolErrorV0("get_session_stats", "tokens");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
		if (!isCount(tokens[key])) throw new PiRpcProtocolErrorV0("get_session_stats", `tokens.${key}`);
	}
	if (!isCount(cost)) throw new PiRpcProtocolErrorV0("get_session_stats", "cost");
	for (const key of ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages"]) {
		if (!isCount(data[key])) throw new PiRpcProtocolErrorV0("get_session_stats", key);
	}
	return {
		sessionId,
		tokens: {
			input: tokens.input as number,
			output: tokens.output as number,
			cacheRead: tokens.cacheRead as number,
			cacheWrite: tokens.cacheWrite as number,
			total: tokens.total as number,
		},
		cost,
		userMessages: data.userMessages as number,
		assistantMessages: data.assistantMessages as number,
		toolCalls: data.toolCalls as number,
		toolResults: data.toolResults as number,
		totalMessages: data.totalMessages as number,
	};
}

function parseDisposition(command: string, data: unknown, allowed: readonly string[]): string {
	if (!isRecord(data) || typeof data.disposition !== "string" || !allowed.includes(data.disposition)) {
		throw new PiRpcProtocolErrorV0(command, "disposition");
	}
	return data.disposition;
}

/** One running Pi RPC process. */
export class PiRpcClientV0 {
	readonly connection: RpcConnectionV0;
	readonly args: readonly string[];

	constructor(options: PiRpcLaunchOptionsV0) {
		this.args = Object.freeze(piRpcArgumentsV0(options));
		this.connection = new RpcConnectionV0({
			launch: { command: options.executable, leadingArgs: [] },
			label: "Pi",
			args: this.args,
			env: options.env,
			cwd: options.cwd,
			stderr: "capture",
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
			...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
			...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
		});
	}

	/** Receive every session event as it arrives. */
	subscribe(listener: (event: RpcEventV0) => void): () => void {
		return this.connection.subscribe(listener);
	}

	/** Send a documented command; resolve with its data on success, reject with PiRpcRefusalV0 on a refusal. */
	async command(type: string, fields: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
		const response = await this.connection.request({ type, ...fields }, timeoutMs === undefined ? {} : { timeoutMs });
		if (!response.success) throw new PiRpcRefusalV0(type, response.error ?? "");
		return response.data;
	}

	/** Send a command and return the raw response, refusal included (for checks that expect a refusal). */
	raw(type: string, fields: Record<string, unknown> = {}) {
		return this.connection.request({ type, ...fields });
	}

	async getState(): Promise<PiSessionStateV0> {
		return parseState(await this.command("get_state"));
	}

	/** Entries strictly after `since` (an opaque entry id), or all entries. An unknown cursor is a refusal. */
	async getEntries(since?: string): Promise<{ entries: PiSessionEntryV0[]; leafId: string | null }> {
		return parseEntries(await this.command("get_entries", since === undefined ? {} : { since }));
	}

	async getSessionStats(): Promise<PiSessionStatsV0> {
		return parseStats(await this.command("get_session_stats"));
	}

	async getTree(): Promise<{ tree: unknown[]; leafId: string | null }> {
		const data = await this.command("get_tree");
		if (!isRecord(data) || !Array.isArray(data.tree)) throw new PiRpcProtocolErrorV0("get_tree", "tree");
		if (data.leafId !== null && typeof data.leafId !== "string") throw new PiRpcProtocolErrorV0("get_tree", "leafId");
		return { tree: data.tree, leafId: data.leafId as string | null };
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		const data = await this.command("get_available_thinking_levels");
		if (!isRecord(data) || !Array.isArray(data.levels) || !data.levels.every((level) => typeof level === "string"))
			throw new PiRpcProtocolErrorV0("get_available_thinking_levels", "levels");
		return data.levels as string[];
	}

	/** Accepted, queued or handled; never "completed". */
	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<string> {
		const data = await this.command("prompt", {
			message,
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
		return parseDisposition("prompt", data, ["started", "queued", "handled"]);
	}

	/** Pi's acceptance only: "queued" or "handled". It carries no identity for the queued message. */
	async steer(message: string): Promise<string> {
		return parseDisposition("steer", await this.command("steer", { message }), ["queued", "handled"]);
	}

	async followUp(message: string): Promise<string> {
		return parseDisposition("follow_up", await this.command("follow_up", { message }), ["queued", "handled"]);
	}

	/** Abort whatever operation is current. Pi's abort takes no target: it cannot be confined to one run. */
	async abort(): Promise<void> {
		await this.command("abort");
	}

	async clearQueue(): Promise<{ steering: number; followUp: number }> {
		const data = await this.command("clear_queue");
		if (!isRecord(data) || !Array.isArray(data.steering) || !Array.isArray(data.followUp))
			throw new PiRpcProtocolErrorV0("clear_queue", "queues");
		// The queued texts are user content: only their counts leave this function.
		return { steering: data.steering.length, followUp: data.followUp.length };
	}

	async setModel(provider: string, modelId: string): Promise<PiModelRefV0> {
		const data = await this.command("set_model", { provider, modelId });
		if (!isRecord(data) || typeof data.provider !== "string" || typeof data.id !== "string")
			throw new PiRpcProtocolErrorV0("set_model", "model");
		return { provider: data.provider, id: data.id };
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.command("set_thinking_level", { level });
	}

	async compact(): Promise<{ firstKeptEntryId: string; tokensBefore: number }> {
		const data = await this.command("compact", {}, 300_000);
		if (!isRecord(data) || typeof data.firstKeptEntryId !== "string" || !isCount(data.tokensBefore))
			throw new PiRpcProtocolErrorV0("compact", "result");
		return { firstKeptEntryId: data.firstKeptEntryId, tokensBefore: data.tokensBefore };
	}

	/** End Pi's input (its documented orderly shutdown) and wait, bounded, for exit. */
	close(): Promise<RpcTerminationV0> {
		return this.connection.close();
	}
}
