/**
 * Milestone D1 — Minimal, bounded stdio JSON-RPC transport for the installed Codex App Server.
 *
 * Spawns the operator-installed `codex` binary directly via `ProcessGroupV0` (with optional `ProcessScopeV0`
 * containment, never via a shell, never an external daemon, never a network listener).
 *
 * Wire format grounded in observed `codex-cli 0.171.0`:
 * - Newline-delimited JSON objects over stdin/stdout (LF framing, optional trailing CR stripped via `JsonlDecoderV0`).
 * - Codex App Server omits `"jsonrpc": "2.0"` on responses and notifications; if `"jsonrpc"` is present it must be `"2.0"`.
 * - Stderr is captured strictly separately as bounded diagnostics, never mixed into protocol frames or canonical evidence.
 * - Supports interleaved notifications and bidirectional `ServerRequest` messages without blocking the read loop while
 *   an operator approval is pending.
 * - Exposes only the governed operational methods (`initialize`, `config/read`, `model/list`, `thread/start`, `thread/read`,
 *   `thread/unsubscribe`, `turn/start`, `turn/steer`, `turn/interrupt`) — never `command/exec`, `thread/shellCommand`, or `fs/*`.
 */

import { randomBytes } from "node:crypto";
import { encodeJsonlRecordV0, JsonlDecoderV0, type JsonlFaultV0 } from "../rpc-jsonl/jsonl.ts";
import {
	type ProcessCleanupV0,
	type ProcessExitV0,
	ProcessGroupV0,
	type ProcessScopeV0,
} from "../rpc-jsonl/process-group.ts";

export type CodexJsonRpcIdV0 = string | number;

export interface CodexJsonRpcErrorV0 {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface CodexServerNotificationV0 {
	readonly instanceId: string;
	readonly method: string;
	readonly params: Record<string, unknown> | undefined;
}

export interface CodexServerRequestV0 {
	readonly instanceId: string;
	readonly id: CodexJsonRpcIdV0;
	readonly method: string;
	readonly params: Record<string, unknown> | undefined;
}

export type CodexTransportFaultKindV0 =
	| JsonlFaultV0
	| "invalid-frame"
	| "unknown-response-id"
	| "duplicate-server-request-id"
	| "server-request-limit-exceeded"
	| "write-failed";

export interface CodexTransportFaultV0 {
	readonly instanceId: string;
	readonly kind: CodexTransportFaultKindV0;
	readonly detail: string;
	readonly byteLength?: number;
}

/** Thrown when the Codex App Server returns a JSON-RPC error response. */
export class CodexRpcErrorV0 extends Error {
	readonly method: string;
	readonly code: number;
	readonly data?: unknown;

	constructor(method: string, error: CodexJsonRpcErrorV0) {
		super(`Codex App Server error for ${method} (${error.code}): ${error.message}`);
		this.name = "CodexRpcErrorV0";
		this.method = method;
		this.code = error.code;
		this.data = error.data;
	}
}

/** Thrown when a request cannot finish because the transport closed, disconnected, timed out, or was aborted. */
export class CodexTransportErrorV0 extends Error {
	readonly code: "disconnected" | "timeout" | "aborted" | "pending-limit" | "write-failed" | "spawn-failed" | "closed";
	readonly dispatched: boolean;

	constructor(
		code: "disconnected" | "timeout" | "aborted" | "pending-limit" | "write-failed" | "spawn-failed" | "closed",
		message: string,
		dispatched: boolean,
	) {
		super(message);
		this.name = "CodexTransportErrorV0";
		this.code = code;
		this.dispatched = dispatched;
	}
}

export interface CodexAppServerClientOptionsV0 {
	/** Resolved path to `codex` (or test fake binary). Never passed to a shell. */
	readonly executable: string;
	/** Explicit argv passed to `executable`. Default: `["app-server", "--listen", "stdio://", ...configOverrides]`. */
	readonly args?: readonly string[];
	/** Key=value TOML overrides passed via `-c <entry>` when `args` is omitted. */
	readonly configOverrides?: readonly string[];
	/** Working directory for spawning the child process. */
	readonly cwd: string;
	/** Complete environment for the child process. Default: `{ ...process.env }` filtered to strings. */
	readonly env?: Readonly<Record<string, string>>;
	/** Optional live containment scope (`ProcessScopeV0`, LIVE-PROCESS-CONTAINMENT-001). */
	readonly scope?: ProcessScopeV0;
	/** Explicit connection instance identifier. Default: random 16-hex string. */
	readonly instanceId?: string;
	/** Max single JSONL frame size in bytes. Default: 16 MiB. */
	readonly maxRecordBytes?: number;
	/** Max concurrent outbound client requests. Default: 64. */
	readonly maxPendingRequests?: number;
	/** Max concurrent inbound server-initiated requests. Default: 32. */
	readonly maxPendingServerRequests?: number;
	/** Max retained stderr diagnostic bytes. Default: 32 KiB. */
	readonly maxStderrBytes?: number;
	/** Default per-request timeout in ms. Default: 30_000. */
	readonly requestTimeoutMs?: number;
	/** Bounded shutdown grace before SIGTERM / release. Default: 1_500 ms. */
	readonly shutdownGraceMs?: number;
	/** Handlers for notifications, server-initiated requests, transport faults, and exit. */
	readonly onNotification?: (notification: CodexServerNotificationV0) => void;
	readonly onServerRequest?: (request: CodexServerRequestV0) => void | Promise<void>;
	readonly onFault?: (fault: CodexTransportFaultV0) => void;
	readonly onDisconnect?: (info: { instanceId: string; reason: string; exit: ProcessExitV0 | null }) => void;
}

export interface CodexInitializeResultV0 {
	readonly userAgent: string;
	readonly codexHome: string;
	readonly platformFamily: string;
	readonly platformOs: string;
}

export interface CodexRequestOptionsV0 {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_PENDING_SERVER_REQUESTS = 32;
const DEFAULT_MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const MAX_METHOD_LENGTH = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isRpcId = (value: unknown): value is CodexJsonRpcIdV0 =>
	(typeof value === "number" && Number.isSafeInteger(value)) ||
	(typeof value === "string" && value.length > 0 && value.length <= 256);

const rpcIdKey = (id: CodexJsonRpcIdV0): string => `${typeof id}:${String(id)}`;

function cleanProcessEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

interface PendingOutbound {
	readonly method: string;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly abortCleanup: (() => void) | null;
	resolve(result: unknown): void;
	reject(error: Error): void;
}

/**
 * Bounded JSON-RPC stdio client for one spawned Codex App Server process.
 */
export class CodexAppServerClientV0 {
	readonly instanceId: string;
	readonly #group: ProcessGroupV0;
	readonly #decoder: JsonlDecoderV0;
	readonly #maxPendingRequests: number;
	readonly #maxPendingServerRequests: number;
	readonly #maxStderrBytes: number;
	readonly #defaultTimeoutMs: number;
	readonly #shutdownGraceMs: number;
	readonly #onNotification: ((n: CodexServerNotificationV0) => void) | undefined;
	readonly #onServerRequest: ((r: CodexServerRequestV0) => void | Promise<void>) | undefined;
	readonly #onFault: ((f: CodexTransportFaultV0) => void) | undefined;
	readonly #onDisconnect:
		| ((info: { instanceId: string; reason: string; exit: ProcessExitV0 | null }) => void)
		| undefined;

	#nextId = 1;
	#connected = true;
	#closed = false;
	#disconnectReported = false;
	#closing: Promise<ProcessCleanupV0> | null = null;
	#lastExit: ProcessExitV0 | null = null;
	#stderrTail = "";
	#stderrTruncated = false;
	readonly #pending = new Map<number, PendingOutbound>();
	readonly #pendingServerRequests = new Map<string, CodexJsonRpcIdV0>();

	constructor(options: CodexAppServerClientOptionsV0) {
		this.instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
		this.#maxPendingServerRequests = options.maxPendingServerRequests ?? DEFAULT_MAX_PENDING_SERVER_REQUESTS;
		this.#maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.#defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		this.#onNotification = options.onNotification;
		this.#onServerRequest = options.onServerRequest;
		this.#onFault = options.onFault;
		this.#onDisconnect = options.onDisconnect;
		this.#decoder = new JsonlDecoderV0({ maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES });

		const argv =
			options.args !== undefined
				? [...options.args]
				: [
						"app-server",
						"--listen",
						"stdio://",
						...(options.configOverrides ?? []).flatMap((override) => ["-c", override]),
					];

		this.#group = new ProcessGroupV0(options.executable, argv, {
			cwd: options.cwd,
			env: options.env ?? cleanProcessEnv(),
			stderr: "pipe",
			...(options.scope === undefined ? {} : { scope: options.scope }),
		});

		this.#group.stdin?.on("error", () => {
			// Handled on write and exit paths; never crash Node with unhandled EPIPE.
		});

		this.#group.stdout?.on("data", (chunk: Buffer) => {
			const records = this.#decoder.push(chunk);
			for (const record of records) {
				if (record.kind === "fault") {
					this.#emitFault(record.fault, `malformed stdio frame (${record.fault})`, record.byteLength);
				} else {
					this.#handleFrame(record.value);
				}
			}
		});

		this.#group.stdout?.on("end", () => {
			const tail = this.#decoder.end();
			for (const record of tail) {
				if (record.kind === "fault") {
					this.#emitFault(record.fault, `malformed trailing stdio frame (${record.fault})`, record.byteLength);
				} else {
					this.#handleFrame(record.value);
				}
			}
			// Immediately mark transport disconnected so no further writes happen, then wait briefly (50 ms) for
			// `#group.exited` so the disconnect callback preserves the actual process exit code/signal when available.
			this.#connected = false;
			this.#failAllPending(this.#closed ? "closed" : "disconnected", "Codex App Server stdout closed.");
			void Promise.race([
				this.#group.exited,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
			]).then((exit) => {
				const observedExit = exit ?? this.#lastExit;
				const reason =
					observedExit !== null
						? observedExit.spawnFailed
							? "Codex App Server executable failed to spawn."
							: `Codex App Server exited (code=${String(observedExit.code)}, signal=${String(observedExit.signal)}).`
						: "Codex App Server stdout closed.";
				this.#markDisconnected(reason, observedExit);
			});
		});

		this.#group.stderr?.on("data", (chunk: Buffer) => {
			this.#appendStderr(chunk.toString("utf8"));
		});

		void this.#group.exited.then((exit) => {
			this.#lastExit = exit;
			const reason = exit.spawnFailed
				? "Codex App Server executable failed to spawn."
				: `Codex App Server exited (code=${String(exit.code)}, signal=${String(exit.signal)}).`;
			this.#markDisconnected(reason, exit);
		});
	}

	get connected(): boolean {
		return this.#connected && !this.#closed;
	}

	get pid(): number | undefined {
		return this.#group.pid;
	}

	get scopeUnit(): string | undefined {
		return this.#group.scopeUnit;
	}

	get lastExit(): ProcessExitV0 | null {
		return this.#lastExit;
	}

	get pendingRequestCount(): number {
		return this.#pending.size;
	}

	get pendingServerRequestCount(): number {
		return this.#pendingServerRequests.size;
	}

	/** Bounded stderr diagnostic tail (kept strictly separate from protocol messages and canonical evidence). */
	stderrDiagnostics(): { text: string; truncated: boolean } {
		return { text: this.#stderrTail, truncated: this.#stderrTruncated };
	}

	/** Explicit `initialize` handshake (strictly validates returned `InitializeResponse` shape). */
	async initialize(
		params: {
			clientInfo: { name: string; version: string; title?: string | null };
			capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: string[] | null } | null;
		},
		options?: CodexRequestOptionsV0,
	): Promise<CodexInitializeResultV0> {
		const raw = await this.#request(
			"initialize",
			{
				clientInfo: params.clientInfo,
				capabilities: params.capabilities ?? { experimentalApi: false },
			},
			options,
		);
		if (
			!isRecord(raw) ||
			typeof raw.userAgent !== "string" ||
			raw.userAgent.length === 0 ||
			typeof raw.codexHome !== "string" ||
			typeof raw.platformFamily !== "string" ||
			typeof raw.platformOs !== "string"
		) {
			throw new CodexTransportErrorV0(
				"disconnected",
				"Codex App Server returned a malformed InitializeResponse.",
				true,
			);
		}
		return {
			userAgent: raw.userAgent,
			codexHome: raw.codexHome,
			platformFamily: raw.platformFamily,
			platformOs: raw.platformOs,
		};
	}

	/** Send `initialized` client notification after `initialize` succeeds. */
	notifyInitialized(): void {
		this.#notify("initialized");
	}

	/** Read effective Codex configuration (read-only). */
	async configRead(
		params: { includeLayers?: boolean; cwd?: string | null } = {},
		options?: CodexRequestOptionsV0,
	): Promise<Record<string, unknown>> {
		const raw = await this.#request("config/read", params, options);
		if (!isRecord(raw)) {
			throw new CodexTransportErrorV0("disconnected", "Malformed config/read response.", true);
		}
		return raw;
	}

	/** List exposed models (read-only). */
	async modelList(
		params: {
			modelProvider?: string | null;
			cursor?: string | null;
			limit?: number | null;
			includeHidden?: boolean | null;
		} = {},
		options?: CodexRequestOptionsV0,
	): Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }> {
		const raw = await this.#request("model/list", params, options);
		if (!isRecord(raw) || !Array.isArray(raw.data)) {
			throw new CodexTransportErrorV0("disconnected", "Malformed model/list response.", true);
		}
		return {
			data: raw.data.filter(isRecord),
			nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null,
		};
	}

	/** Start a fresh owned thread (`thread/start`). */
	async threadStart(
		params: Record<string, unknown>,
		options?: CodexRequestOptionsV0,
	): Promise<Record<string, unknown>> {
		const raw = await this.#request("thread/start", params, options);
		if (!isRecord(raw) || !isRecord(raw.thread) || typeof raw.thread.id !== "string" || raw.thread.id.length === 0) {
			throw new CodexTransportErrorV0("disconnected", "Malformed thread/start response.", true);
		}
		return raw;
	}

	/** Read metadata for an owned thread (`thread/read`). */
	async threadRead(
		params: { threadId: string; includeTurns?: boolean },
		options?: CodexRequestOptionsV0,
	): Promise<Record<string, unknown>> {
		const raw = await this.#request("thread/read", params, options);
		if (!isRecord(raw) || !isRecord(raw.thread)) {
			throw new CodexTransportErrorV0("disconnected", "Malformed thread/read response.", true);
		}
		return raw;
	}

	/** Unsubscribe from an owned thread (`thread/unsubscribe`). */
	async threadUnsubscribe(params: { threadId: string }, options?: CodexRequestOptionsV0): Promise<{ status: string }> {
		const raw = await this.#request("thread/unsubscribe", params, options);
		if (!isRecord(raw) || typeof raw.status !== "string") {
			throw new CodexTransportErrorV0("disconnected", "Malformed thread/unsubscribe response.", true);
		}
		return { status: raw.status };
	}

	/** Start a turn on an owned thread (`turn/start`). */
	async turnStart(params: Record<string, unknown>, options?: CodexRequestOptionsV0): Promise<Record<string, unknown>> {
		const raw = await this.#request("turn/start", params, options);
		if (!isRecord(raw) || !isRecord(raw.turn) || typeof raw.turn.id !== "string" || raw.turn.id.length === 0) {
			throw new CodexTransportErrorV0("disconnected", "Malformed turn/start response.", true);
		}
		return raw;
	}

	/** Steer an active turn with mandatory `expectedTurnId` precondition (`turn/steer`). */
	async turnSteer(
		params: { threadId: string; expectedTurnId: string; input: readonly Record<string, unknown>[] },
		options?: CodexRequestOptionsV0,
	): Promise<{ turnId: string }> {
		const raw = await this.#request("turn/steer", params, options);
		if (!isRecord(raw) || typeof raw.turnId !== "string" || raw.turnId.length === 0) {
			throw new CodexTransportErrorV0("disconnected", "Malformed turn/steer response.", true);
		}
		return { turnId: raw.turnId };
	}

	/** Request targeted interruption of one active turn (`turn/interrupt`). */
	async turnInterrupt(
		params: { threadId: string; turnId: string },
		options?: CodexRequestOptionsV0,
	): Promise<Record<string, unknown>> {
		const raw = await this.#request("turn/interrupt", params, options);
		if (!isRecord(raw)) {
			throw new CodexTransportErrorV0("disconnected", "Malformed turn/interrupt response.", true);
		}
		return raw;
	}

	/**
	 * Send a JSON-RPC result response for a pending server-initiated request (`ServerRequest`).
	 * Single-use: returns false if `id` is no longer pending (e.g., already resolved or cancelled).
	 */
	respondServerRequest(id: CodexJsonRpcIdV0, result: Record<string, unknown>): boolean {
		const key = rpcIdKey(id);
		if (!this.#pendingServerRequests.has(key)) return false;
		this.#pendingServerRequests.delete(key);
		if (!this.connected) return false;
		return this.#writeFrame({ id, result });
	}

	/**
	 * Send a JSON-RPC error response for a pending server-initiated request (`ServerRequest`).
	 * Single-use: returns false if `id` is no longer pending.
	 */
	rejectServerRequest(id: CodexJsonRpcIdV0, code: number, message: string): boolean {
		const key = rpcIdKey(id);
		if (!this.#pendingServerRequests.has(key)) return false;
		this.#pendingServerRequests.delete(key);
		if (!this.connected) return false;
		return this.#writeFrame({ id, error: { code, message } });
	}

	/** Remove a pending server request entry when Codex notifies `serverRequest/resolved`. */
	clearPendingServerRequest(id: CodexJsonRpcIdV0): boolean {
		return this.#pendingServerRequests.delete(rpcIdKey(id));
	}

	/** Bounded orderly teardown returning explicit `ProcessCleanupV0` (never hangs indefinitely). */
	close(): Promise<ProcessCleanupV0> {
		if (this.#closing !== null) return this.#closing;
		this.#closed = true;
		this.#connected = false;
		this.#failAllPending("closed", "Codex App Server transport closed.");
		this.#pendingServerRequests.clear();

		this.#closing = (async () => {
			try {
				this.#group.stdin?.end();
			} catch {
				// Ignore broken stdin on shutdown.
			}
			const exitedNormally = await this.#waitExit(this.#shutdownGraceMs);
			if (!exitedNormally) {
				this.#group.signalGroup("SIGTERM");
				await this.#waitExit(500);
			}
			const cleanup = await this.#group.release();
			this.#markDisconnected("Codex App Server transport closed.", this.#lastExit);
			return cleanup;
		})();
		return this.#closing;
	}

	#waitExit(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(false);
			}, timeoutMs);
			void this.#group.exited.then(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	#request(method: string, params: Record<string, unknown>, options?: CodexRequestOptionsV0): Promise<unknown> {
		if (this.#closed) {
			return Promise.reject(new CodexTransportErrorV0("closed", "Codex transport is closed.", false));
		}
		if (!this.#connected) {
			return Promise.reject(new CodexTransportErrorV0("disconnected", "Codex transport is disconnected.", false));
		}
		if (this.#pending.size >= this.#maxPendingRequests) {
			return Promise.reject(
				new CodexTransportErrorV0(
					"pending-limit",
					`Exceeded max pending Codex requests (${this.#maxPendingRequests}).`,
					false,
				),
			);
		}
		if (options?.signal?.aborted) {
			return Promise.reject(
				new CodexTransportErrorV0("aborted", `Request ${method} aborted before dispatch.`, false),
			);
		}

		const id = this.#nextId;
		this.#nextId += 1;
		const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const entry = this.#pending.get(id);
				if (entry === undefined) return;
				this.#pending.delete(id);
				entry.abortCleanup?.();
				reject(
					new CodexTransportErrorV0("timeout", `Codex request ${method} timed out after ${timeoutMs} ms.`, true),
				);
			}, timeoutMs);

			let abortCleanup: (() => void) | null = null;
			if (options?.signal !== undefined) {
				const signal = options.signal;
				const onAbort = () => {
					const entry = this.#pending.get(id);
					if (entry === undefined) return;
					this.#pending.delete(id);
					clearTimeout(entry.timer);
					reject(
						new CodexTransportErrorV0("aborted", `Codex request ${method} aborted while awaiting reply.`, true),
					);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => signal.removeEventListener("abort", onAbort);
			}

			this.#pending.set(id, { method, timer, abortCleanup, resolve, reject });
			const ok = this.#writeFrame({ id, method, params });
			if (!ok) {
				const entry = this.#pending.get(id);
				if (entry !== undefined) {
					this.#pending.delete(id);
					clearTimeout(entry.timer);
					entry.abortCleanup?.();
				}
				reject(
					new CodexTransportErrorV0("write-failed", `Failed to write Codex request ${method} to stdin.`, false),
				);
			}
		});
	}

	#notify(method: string, params?: Record<string, unknown>): void {
		if (!this.connected) {
			throw new CodexTransportErrorV0(
				"disconnected",
				`Cannot send notification ${method}: transport disconnected.`,
				false,
			);
		}
		const payload: Record<string, unknown> = params === undefined ? { method } : { method, params };
		if (!this.#writeFrame(payload)) {
			throw new CodexTransportErrorV0("write-failed", `Failed to write Codex notification ${method}.`, false);
		}
	}

	#writeFrame(frame: Record<string, unknown>): boolean {
		const stdin = this.#group.stdin;
		if (stdin === null || stdin.destroyed || stdin.writableEnded) {
			this.#emitFault("write-failed", "stdin is closed or destroyed");
			return false;
		}
		try {
			stdin.write(encodeJsonlRecordV0(frame));
			return true;
		} catch {
			this.#emitFault("write-failed", "stdin write threw synchronously");
			return false;
		}
	}

	#handleFrame(frame: Record<string, unknown>): void {
		if (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") {
			this.#emitFault("invalid-frame", "unexpected jsonrpc version field");
			return;
		}
		const hasId = Object.hasOwn(frame, "id") && frame.id !== undefined && frame.id !== null;
		const hasMethod = Object.hasOwn(frame, "method") && frame.method !== undefined;

		if (hasMethod) {
			if (typeof frame.method !== "string" || frame.method.length === 0 || frame.method.length > MAX_METHOD_LENGTH) {
				this.#emitFault("invalid-frame", "frame method must be a bounded non-empty string");
				return;
			}
			if (frame.params !== undefined && frame.params !== null && !isRecord(frame.params)) {
				this.#emitFault("invalid-frame", `params for ${frame.method} must be a JSON object when supplied`);
				return;
			}
			const params = isRecord(frame.params) ? frame.params : undefined;

			if (hasId) {
				if (!isRpcId(frame.id)) {
					this.#emitFault("invalid-frame", `server request ${frame.method} carries an invalid id`);
					return;
				}
				const key = rpcIdKey(frame.id);
				if (this.#pendingServerRequests.has(key)) {
					this.#emitFault("duplicate-server-request-id", `duplicate in-flight server request id ${key}`);
					return;
				}
				if (this.#pendingServerRequests.size >= this.#maxPendingServerRequests) {
					this.#emitFault(
						"server-request-limit-exceeded",
						`server request limit (${this.#maxPendingServerRequests}) exceeded for ${frame.method}`,
					);
					this.#writeFrame({
						id: frame.id,
						error: { code: -32000, message: "Server request capacity exceeded (fail-closed)." },
					});
					return;
				}
				this.#pendingServerRequests.set(key, frame.id);
				const req: CodexServerRequestV0 = {
					instanceId: this.instanceId,
					id: frame.id,
					method: frame.method,
					params,
				};
				if (this.#onServerRequest === undefined) {
					this.rejectServerRequest(frame.id, -32601, "No server request handler registered (fail-closed).");
					return;
				}
				try {
					const maybePromise = this.#onServerRequest(req);
					if (maybePromise !== undefined && typeof (maybePromise as Promise<void>).catch === "function") {
						void (maybePromise as Promise<void>).catch(() => {
							this.rejectServerRequest(
								frame.id as CodexJsonRpcIdV0,
								-32000,
								"Server request handler failed (fail-closed).",
							);
						});
					}
				} catch {
					this.rejectServerRequest(frame.id, -32000, "Server request handler threw (fail-closed).");
				}
				return;
			}

			// Notification
			this.#onNotification?.({ instanceId: this.instanceId, method: frame.method, params });
			return;
		}

		// Response
		if (!hasId || typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) {
			this.#emitFault("invalid-frame", "response frame missing valid numeric id");
			return;
		}
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) {
			this.#emitFault("unknown-response-id", `response id ${frame.id} does not match any pending request`);
			return;
		}
		this.#pending.delete(frame.id);
		clearTimeout(pending.timer);
		pending.abortCleanup?.();

		if (Object.hasOwn(frame, "error") && frame.error !== undefined && frame.error !== null) {
			if (
				!isRecord(frame.error) ||
				typeof frame.error.code !== "number" ||
				typeof frame.error.message !== "string"
			) {
				pending.reject(
					new CodexTransportErrorV0(
						"disconnected",
						`Malformed JSON-RPC error response for ${pending.method}.`,
						true,
					),
				);
				return;
			}
			pending.reject(
				new CodexRpcErrorV0(pending.method, {
					code: frame.error.code,
					message: frame.error.message,
					data: frame.error.data,
				}),
			);
			return;
		}

		if (!Object.hasOwn(frame, "result")) {
			pending.reject(
				new CodexTransportErrorV0(
					"disconnected",
					`Response for ${pending.method} had neither result nor error.`,
					true,
				),
			);
			return;
		}
		pending.resolve(frame.result);
	}

	#appendStderr(text: string): void {
		if (text.length === 0) return;
		const combined = this.#stderrTail + text;
		if (Buffer.byteLength(combined, "utf8") <= this.#maxStderrBytes) {
			this.#stderrTail = combined;
			return;
		}
		this.#stderrTruncated = true;
		// Retain bounded trailing bytes.
		const buf = Buffer.from(combined, "utf8");
		this.#stderrTail = buf.subarray(buf.length - this.#maxStderrBytes).toString("utf8");
	}

	#emitFault(kind: CodexTransportFaultKindV0, detail: string, byteLength?: number): void {
		this.#onFault?.({
			instanceId: this.instanceId,
			kind,
			detail,
			...(byteLength === undefined ? {} : { byteLength }),
		});
	}

	#failAllPending(code: "disconnected" | "closed", reason: string): void {
		for (const [id, entry] of this.#pending.entries()) {
			this.#pending.delete(id);
			clearTimeout(entry.timer);
			entry.abortCleanup?.();
			entry.reject(new CodexTransportErrorV0(code, `${entry.method}: ${reason}`, true));
		}
	}

	#markDisconnected(reason: string, exit: ProcessExitV0 | null): void {
		this.#connected = false;
		this.#failAllPending(this.#closed ? "closed" : "disconnected", reason);
		this.#pendingServerRequests.clear();
		if (this.#disconnectReported) return;
		this.#disconnectReported = true;
		this.#onDisconnect?.({ instanceId: this.instanceId, reason, exit });
	}
}
