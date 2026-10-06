// An ACP v1 client attachment: launch one agent command, negotiate ACP v1 over stdio with the official SDK, open one
// session, run prompt turns, cancel, and shut the child down. ACP framing, request correlation and message
// validation belong to @agentclientprotocol/sdk; this module adds only process ownership and evidence.
//
// - The agent runs in a process group this attachment owns (adapters/rpc-jsonl/process-group.ts: the runtime-neutral
//   group primitive, not the JSONL RPC connection). Teardown ends the whole group, so no child outlives close().
// - The agent's environment is exactly `launch.env`: nothing is inherited from this process. stderr is never read.
// - Permissions fail closed. Without an explicit handler every `session/request_permission` is answered with the
//   agent's own `reject_once` option when it offered one, else `cancelled`. A handler's answer is honored only if it
//   selects an option the agent offered; anything else becomes `cancelled`.
// - fs/* and terminal/* are not advertised and not served.
// - Only ACP protocolVersion 1 is accepted. Anything else closes the child and fails the connection.
// - Evidence goes to `onEvent` as endo.event.v0 events (translate.ts). Whatever the agent reports is recorded as
//   reported; a successful `session/prompt` response is the agent's report of a stop reason, nothing more.

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { checkTimeout } from "../rpc-jsonl/limits.ts";
import { type ProcessExitV0, ProcessGroupV0 } from "../rpc-jsonl/process-group.ts";
import { validateAcpDefinitionV0 } from "./schema.ts";
import {
	ACP_LIFECYCLE_UNAVAILABLE_V0,
	ACP_MAPPING_VERSION,
	AcpRecorderV0,
	type AcpStopReasonV0,
	acpSessionRefV0,
	isAcpStopReasonV0,
	isRecord,
	lifecycleEndForStopReasonV0,
	opaqueIdRefV0,
	shortText,
	summarizeConfigOptionsV0,
	summarizeModesV0,
	translateAcpUpdateV0,
} from "./translate.ts";

/** The one ACP protocol version this adapter speaks. Literal, not the SDK's constant, so an SDK change cannot move it. */
export const ACP_SUPPORTED_PROTOCOL_VERSION_V0 = 1;

/** How the agent is started. `env` is the child's complete environment. */
export interface AcpLaunchV0 {
	readonly command: string;
	readonly args: readonly string[];
	/** The child's working directory; absolute. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export type AcpPermissionHandlerV0 = (
	request: acp.RequestPermissionRequest,
) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;

export interface AcpClientOptionsV0 {
	readonly launch: AcpLaunchV0;
	/** Names this attachment in producers, e.g. "omp.default". */
	readonly attachment: string;
	readonly onEvent: (event: EndoEventV0) => void;
	/** Absent: every permission request is rejected or cancelled. Present: it decides, still bounded to offered options. */
	readonly permissionHandler?: AcpPermissionHandlerV0;
	/** initialize and session/new each. Default 30 s. */
	readonly requestTimeoutMs?: number;
	/** A prompt turn. Default 10 min. On expiry the turn is left open; cancel() or close() ends it. */
	readonly promptTimeoutMs?: number;
	/** How long close() waits for the agent to exit after its stdin closed, and again after SIGTERM. Default 2 s each. */
	readonly closeGraceMs?: number;
	readonly now?: () => string;
}

/** What the agent reported at initialize, as reported. `agentInfo` is the agent's claim, not a verified identity. */
export interface AcpInitializeEvidenceV0 {
	readonly protocolVersion: number;
	readonly agentInfo: unknown;
	readonly agentCapabilities: unknown;
	readonly authMethods: unknown;
}

/** The optional session methods an agent advertised at initialize (`agentCapabilities.sessionCapabilities`). */
export interface AcpSessionCapabilitiesV0 {
	readonly list: boolean;
	readonly resume: boolean;
	readonly close: boolean;
}

/** One session as `session/list` reported it, as reported. Ids are agent-local and opaque. */
export interface AcpListedSessionV0 {
	readonly sessionId: string;
	readonly cwd: string;
	readonly title: string | null;
	readonly updatedAt: string | null;
}

export interface AcpSessionListV0 {
	readonly sessions: readonly AcpListedSessionV0[];
	readonly nextCursor: string | null;
}

/** How to open the attachment's session. Default: `session/new`. `resume`: `session/resume` of an agent-local id. */
export interface AcpSessionOpenV0 {
	readonly cwd: string;
	readonly resume?: { readonly sessionId: string };
}

export interface AcpPromptResultV0 {
	/** The agent's reported stop reason. */
	readonly stopReason: AcpStopReasonV0;
	/** Observed session/update counts during this turn, by variant. */
	readonly updates: Readonly<Record<string, number>>;
}

export class AcpProtocolErrorV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpProtocolErrorV0";
	}
}
export class AcpProcessExitedErrorV0 extends Error {
	readonly exit: ProcessExitV0;
	constructor(message: string, exit: ProcessExitV0) {
		super(message);
		this.name = "AcpProcessExitedErrorV0";
		this.exit = exit;
	}
}
export class AcpTimeoutErrorV0 extends Error {
	constructor(what: string, ms: number) {
		super(`${what} did not complete within ${ms} ms`);
		this.name = "AcpTimeoutErrorV0";
	}
}
/** The attachment was closed while a request was in flight. The agent is not blamed for it. */
export class AcpClosedErrorV0 extends Error {
	constructor(what: string) {
		super(`the ACP attachment was closed during ${what}`);
		this.name = "AcpClosedErrorV0";
	}
}
/** An optional ACP method the agent did not advertise at initialize: nothing was sent. Absence is UNAVAILABLE, not "probably". */
export class AcpUnavailableErrorV0 extends Error {
	readonly capability: string;
	constructor(capability: string) {
		super(`the agent did not advertise sessionCapabilities.${capability}; the method was not called`);
		this.name = "AcpUnavailableErrorV0";
		this.capability = capability;
	}
}
/** The agent answered a request with a JSON-RPC error. */
export class AcpRefusedErrorV0 extends Error {
	readonly code: number;
	constructor(what: string, code: number) {
		super(`${what} was refused by the agent (JSON-RPC error ${code})`);
		this.name = "AcpRefusedErrorV0";
		this.code = code;
	}
}

interface OpenRun {
	readonly started: EndoEventV0;
	stopRequested: boolean;
	updates: Record<string, number>;
}

/** Always a fresh object: a response handed to the SDK must not be shared or mutable from elsewhere. */
const cancelledResponse = (): acp.RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
/** What the cancellation race resolves with when the adapter, not the handler, ended the wait. */
const ADAPTER_CANCEL = Symbol("adapter-cancel");

function delay(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), ms);
		timer.unref();
	});
}

async function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new AcpTimeoutErrorV0(what, ms)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The SDK's client app installs its own session-update router, which parses every `session/update` with a closed
 * union and throws on a variant it does not know: the update is logged to the console and dropped before any
 * registered handler runs. A client that must not lose an unknown update therefore takes `session/update`
 * notifications off the stream first, as raw values, and hands the SDK everything else (framing, correlation and
 * validation of every other message stay the SDK's).
 */
function withRawSessionUpdates(stream: acp.Stream, onUpdate: (params: unknown) => void): acp.Stream {
	// Only a well-formed JSON-RPC 2.0 notification is taken as an update. Anything else naming the method is left to the
	// SDK, which rejects a malformed envelope; it is never counted as activity.
	const isUpdate = (message: unknown): boolean =>
		isRecord(message) &&
		message.jsonrpc === "2.0" &&
		message.method === acp.methods.client.session.update &&
		!("id" in message);
	const take = (message: unknown): void => {
		try {
			onUpdate((message as { params?: unknown }).params);
		} catch {
			// An update that could not be recorded must not take the connection down.
		}
	};
	return {
		writable: stream.writable,
		readable: stream.readable.pipeThrough(
			new TransformStream<acp.AnyMessage, acp.AnyMessage>({
				transform(message, controller) {
					if (Array.isArray(message)) {
						const rest: unknown[] = [];
						for (const entry of message as unknown[]) {
							if (isUpdate(entry)) take(entry);
							else rest.push(entry);
						}
						if (rest.length > 0) controller.enqueue(rest as unknown as acp.AnyMessage);
					} else if (isUpdate(message)) take(message);
					else controller.enqueue(message);
				},
			}),
		),
	};
}

/** Advertised means a non-null object at `sessionCapabilities.<name>` (`{}` is support). Absent or null is not. */
function advertisedSessionCapabilities(agentCapabilities: unknown): AcpSessionCapabilitiesV0 {
	const session =
		isRecord(agentCapabilities) && isRecord(agentCapabilities.sessionCapabilities)
			? agentCapabilities.sessionCapabilities
			: {};
	return { list: isRecord(session.list), resume: isRecord(session.resume), close: isRecord(session.close) };
}

export class AcpClientV0 {
	readonly #options: AcpClientOptionsV0;
	readonly #group: ProcessGroupV0;
	readonly #recorder: AcpRecorderV0;
	readonly #connection: acp.ClientConnection;
	readonly #requestTimeoutMs: number;
	readonly #promptTimeoutMs: number;
	readonly #closeGraceMs: number;
	readonly #pendingPermissions = new Set<() => void>();
	// Null-prototype: a variant named `constructor` or `__proto__` must count as itself, not as an inherited property.
	readonly #updates: Record<string, number> = Object.create(null);
	#initialize: AcpInitializeEvidenceV0 | null = null;
	#sessionId: string | null = null;
	#run: OpenRun | null = null;
	#exit: ProcessExitV0 | null = null;
	#closing: Promise<ProcessExitV0> | undefined;
	#closed = false;
	/** The ACP stream ended under a living agent: nothing more can be asked or approved. */
	#unusable = false;
	#sessionCapabilities: AcpSessionCapabilitiesV0 = { list: false, resume: false, close: false };
	/** The agent accepted session/close: the session is over, and later traffic for it is not activity. */
	#sessionClosed = false;

	private constructor(options: AcpClientOptionsV0) {
		this.#options = options;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.#promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
		this.#closeGraceMs = options.closeGraceMs ?? 2_000;
		this.#recorder = new AcpRecorderV0({
			attachment: options.attachment,
			instance: randomBytes(6).toString("hex"),
			now: options.now ?? (() => new Date().toISOString().replace(/\.\d+Z$/, "Z")),
			onEvent: options.onEvent,
		});
		const { launch } = options;
		this.#group = new ProcessGroupV0(launch.command, launch.args, {
			cwd: launch.cwd,
			env: launch.env,
			stderr: "ignore",
		});
		// A dead child makes writes fail with EPIPE; the exit is what gets recorded, not these.
		this.#group.stdin?.on("error", () => {});
		this.#group.stdout?.on("error", () => {});
		void this.#group.exited.then((exit) => this.#onExit(exit));

		const stream = withRawSessionUpdates(
			acp.ndJsonStream(
				Writable.toWeb(this.#group.stdin as Writable) as WritableStream<Uint8Array>,
				Readable.toWeb(this.#group.stdout as Readable) as ReadableStream<Uint8Array>,
			),
			(params) => this.#onUpdate(params),
		);
		this.#connection = acp
			.client({ name: "endophasia-acp" })
			.onRequest(acp.methods.client.session.requestPermission, (ctx) => this.#onPermission(ctx.params))
			.connect(stream);
		void this.#connection.closed.catch(() => {}).then(() => this.#onConnectionClosed());
	}

	/**
	 * Launch the agent, negotiate ACP v1, and open one session in `cwd` (absolute). Any failure tears the child down
	 * before it propagates.
	 */
	static async connect(options: AcpClientOptionsV0, request: AcpSessionOpenV0): Promise<AcpClientV0> {
		// A private snapshot: what is validated here is what is sent later, whatever the caller does with its object.
		const resumeId = request.resume === undefined ? undefined : request.resume.sessionId;
		const session: AcpSessionOpenV0 = Object.freeze({
			cwd: request.cwd,
			...(resumeId === undefined ? {} : { resume: Object.freeze({ sessionId: resumeId }) }),
		});
		if (!isAbsolute(options.launch.cwd)) throw new TypeError("launch.cwd must be an absolute path");
		if (typeof session.cwd !== "string" || !isAbsolute(session.cwd))
			throw new TypeError("session.cwd must be an absolute path");
		if (
			session.resume !== undefined &&
			(typeof session.resume.sessionId !== "string" || session.resume.sessionId === "")
		)
			throw new TypeError("resume.sessionId must be a non-empty string");
		for (const [name, value] of [
			["requestTimeoutMs", options.requestTimeoutMs ?? 0],
			["promptTimeoutMs", options.promptTimeoutMs ?? 0],
			["closeGraceMs", options.closeGraceMs ?? 0],
		] as const)
			checkTimeout(name, value);
		const client = new AcpClientV0(options);
		try {
			await client.#negotiate();
			await client.#openSession(session);
			// The keeper's exit channel is independent of stdout: an agent that answered and died may have been seen dead
			// first. Not an attachment.
			if (client.#exit !== null)
				throw new AcpProcessExitedErrorV0("the agent process ended during attach", client.#exit);
			if (client.#unusable || client.#closed)
				throw new AcpProtocolErrorV0("the ACP connection closed during attach");
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	/** The optional session methods the agent advertised. Fixed at initialize. */
	get sessionCapabilities(): AcpSessionCapabilitiesV0 {
		return { ...this.#sessionCapabilities };
	}

	/** What the agent reported at initialize. */
	get initialize(): AcpInitializeEvidenceV0 {
		if (this.#initialize === null) throw new TypeError("not initialized");
		return this.#initialize;
	}

	get sessionId(): string {
		if (this.#sessionId === null) throw new TypeError("no session is open");
		return this.#sessionId;
	}

	/** session/update counts observed since the session opened, by variant. */
	get updateCounts(): Readonly<Record<string, number>> {
		return { ...this.#updates };
	}

	/** Whether a member of the owned process group other than its keeper still runs (/proc; undefined when unknowable). */
	liveProcessMembers(): boolean | undefined {
		return this.#group.liveMembers();
	}

	async #negotiate(): Promise<void> {
		const response: unknown = await this.#request(
			"initialize",
			this.#connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: ACP_SUPPORTED_PROTOCOL_VERSION_V0,
				// Nothing is served: no file system, no terminal.
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "endophasia", version: "0" },
			}),
		);
		if (!isRecord(response) || typeof response.protocolVersion !== "number") {
			this.#recorder.record("harness.protocol-fault", { fault: "initialize-response-malformed" });
			throw new AcpProtocolErrorV0("the agent's initialize response carries no numeric protocolVersion");
		}
		const info = isRecord(response.agentInfo) ? response.agentInfo : {};
		const capabilities = JSON.parse(JSON.stringify(response.agentCapabilities ?? null)) as JsonValueV0;
		const canonical = canonicalEndoJsonV0(capabilities);
		// What the agent reported, as reported: its own claim, not a verified identity of the executable.
		const reportedByAgent: Record<string, JsonValueV0> = {
			protocolVersion: response.protocolVersion,
			agentInfo: { name: shortText(info.name) ?? null, version: shortText(info.version) ?? null },
			capabilitiesDigest: sha256HexV0(canonical),
			capabilities: canonical.length <= 8192 ? capabilities : null,
			authMethodIds: Array.isArray(response.authMethods)
				? response.authMethods.map((method) => (isRecord(method) ? (shortText(method.id) ?? null) : null))
				: null,
		};
		if (response.protocolVersion !== ACP_SUPPORTED_PROTOCOL_VERSION_V0) {
			this.#recorder.record("harness.protocol-fault", {
				fault: "unsupported-protocol-version",
				supported: ACP_SUPPORTED_PROTOCOL_VERSION_V0,
				...reportedByAgent,
			});
			throw new AcpProtocolErrorV0(
				`the agent negotiated ACP protocol version ${String(response.protocolVersion)}; only ${ACP_SUPPORTED_PROTOCOL_VERSION_V0} is supported`,
			);
		}
		// Version 1 is negotiated: the response must now be a valid v1 InitializeResponse, which the SDK does not check.
		if (!validateAcpDefinitionV0("InitializeResponse", response)) {
			this.#recorder.record("harness.protocol-fault", { fault: "initialize-response-schema-invalid" });
			throw new AcpProtocolErrorV0("the agent's initialize response is not a valid ACP v1 InitializeResponse");
		}
		this.#sessionCapabilities = Object.freeze(advertisedSessionCapabilities(response.agentCapabilities));
		this.#initialize = {
			protocolVersion: response.protocolVersion,
			agentInfo: response.agentInfo,
			agentCapabilities: response.agentCapabilities,
			authMethods: response.authMethods,
		};
		this.#recorder.record("harness.acp-initialized", {
			mapping: ACP_MAPPING_VERSION,
			...reportedByAgent,
			// Which optional session methods this adapter will call: exactly the ones advertised.
			sessionMethodsAdvertised: { ...this.#sessionCapabilities },
		});
	}

	async #openSession(open: AcpSessionOpenV0): Promise<void> {
		const resumeId = open.resume?.sessionId;
		if (resumeId !== undefined && !this.#sessionCapabilities.resume)
			throw this.#unavailable("resume", "session.resume");
		const method = resumeId !== undefined ? "session/resume" : "session/new";
		const response: unknown = await this.#request(
			method,
			resumeId !== undefined
				? this.#connection.agent.request(acp.methods.agent.session.resume, {
						sessionId: resumeId,
						cwd: open.cwd,
						mcpServers: [],
					})
				: this.#connection.agent.request(acp.methods.agent.session.new, { cwd: open.cwd, mcpServers: [] }),
		);
		// session/resume answers without a session id: the session is the one that was asked for, nothing more.
		const sessionId = resumeId ?? (isRecord(response) ? response.sessionId : undefined);
		if (
			!isRecord(response) ||
			typeof sessionId !== "string" ||
			sessionId.length === 0 ||
			!validateAcpDefinitionV0(resumeId !== undefined ? "ResumeSessionResponse" : "NewSessionResponse", response)
		) {
			this.#recorder.record("harness.protocol-fault", {
				fault: resumeId !== undefined ? "session-resume-response-malformed" : "session-new-response-malformed",
			});
			throw new AcpProtocolErrorV0(`the agent's ${method} response is not a valid ACP v1 response`);
		}
		if (this.#exit !== null) {
			throw new AcpProcessExitedErrorV0(`the agent process ended during ${method}`, this.#exit);
		}
		this.#sessionId = sessionId;
		this.#recorder.setSession(sessionId);
		const attached = this.#recorder.record("harness.attached", {
			mapping: ACP_MAPPING_VERSION,
			instance: this.#recorder.instance,
			acpSessionId: acpSessionRefV0(sessionId),
			openedBy: method,
			// session/resume reattaches without replaying history to the client (that is session/load): none is claimed.
			...(resumeId !== undefined ? { historyReplay: "not-requested" } : {}),
		});
		this.#recorder.derive(
			"lifecycle.session-started",
			{
				runtime: "acp",
				runtimeSessionId: acpSessionRefV0(sessionId),
				instance: this.#recorder.instance,
				openedBy: method,
				unavailable: ACP_LIFECYCLE_UNAVAILABLE_V0.map((field) => ({ ...field })),
			},
			attached,
		);
		// What the agent advertised at open, as it reported it: configuration is the agent's claim, not verified identity.
		const configOptions = Array.isArray(response.configOptions) ? response.configOptions : undefined;
		const modes = summarizeModesV0(response.modes);
		if (configOptions !== undefined || modes !== undefined) {
			this.#recorder.record("session.config-observed", {
				origin: method,
				...(configOptions !== undefined ? summarizeConfigOptionsV0(configOptions) : {}),
				...(modes !== undefined ? { modes } : {}),
			});
		}
	}

	/** An optional method the agent did not advertise: said so in the record, nothing sent. */
	#unavailable(capability: keyof AcpSessionCapabilitiesV0, name: string): AcpUnavailableErrorV0 {
		this.#recorder.record("control.unavailable", { capability: name, reason: "not-advertised" });
		return new AcpUnavailableErrorV0(capability);
	}

	#assertUsable(what: string): void {
		if (this.#closed || this.#unusable || this.#exit !== null || this.#sessionClosed)
			throw new TypeError(`the ACP attachment is closed (${what})`);
	}

	/**
	 * `session/list`, only if the agent advertised it. Ids, working directories and titles are returned to the caller as
	 * reported; the record keeps only how many sessions and whether more pages exist.
	 */
	async listSessions(params: { readonly cwd?: string; readonly cursor?: string } = {}): Promise<AcpSessionListV0> {
		this.#assertUsable("session/list");
		if (!this.#sessionCapabilities.list) throw this.#unavailable("list", "session.list");
		// Read once: what is validated is what is sent.
		const { cwd, cursor } = params;
		if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd)))
			throw new TypeError("cwd must be an absolute path");
		const response: unknown = await this.#request(
			"session/list",
			this.#connection.agent.request(acp.methods.agent.session.list, {
				...(cwd !== undefined ? { cwd } : {}),
				...(cursor !== undefined ? { cursor } : {}),
			}),
		);
		if (!isRecord(response) || !validateAcpDefinitionV0("ListSessionsResponse", response)) {
			this.#recorder.record("harness.protocol-fault", { fault: "session-list-response-malformed" });
			throw new AcpProtocolErrorV0("the agent's session/list response is not a valid ACP v1 response");
		}
		const sessions = (Array.isArray(response.sessions) ? response.sessions : []) as Array<Record<string, unknown>>;
		const nextCursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
		this.#recorder.record("session.listed", { count: sessions.length, hasNextCursor: nextCursor !== null });
		return {
			sessions: sessions.map((entry) => ({
				sessionId: String(entry.sessionId),
				cwd: String(entry.cwd),
				title: typeof entry.title === "string" ? entry.title : null,
				updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
			})),
			nextCursor,
		};
	}

	/**
	 * `session/close`, only if the agent advertised it: the agent must cancel the session's work and free its resources.
	 * A response is the agent's acceptance, not proof that anything was freed. The process is not ended; close() does that.
	 */
	async closeSession(): Promise<void> {
		this.#assertUsable("session/close");
		if (!this.#sessionCapabilities.close) throw this.#unavailable("close", "session.close");
		const requested = this.#recorder.record("control.requested", { capability: "session.close", action: "close" });
		const run = this.#run;
		if (run !== null) {
			// Closing a session cancels its work.
			this.#recorder.derive("lifecycle.stop-requested", { runOpen: true }, requested);
			run.stopRequested = true;
		}
		// Pending permission requests are answered `cancelled` whether or not a turn is still open.
		for (const cancel of [...this.#pendingPermissions]) cancel();
		// From the moment it is asked the session is not usable: an answer that arrives after a timeout still means the
		// agent closed it, so an indeterminate outcome must not leave the session live.
		this.#sessionClosed = true;
		let response: unknown;
		try {
			response = await this.#request(
				"session/close",
				this.#connection.agent.request(acp.methods.agent.session.close, { sessionId: this.sessionId }),
			);
		} catch (error) {
			// Only an explicit refusal shows the session was not closed.
			if (error instanceof AcpRefusedErrorV0) this.#sessionClosed = false;
			throw error;
		}
		if (!isRecord(response) || !validateAcpDefinitionV0("CloseSessionResponse", response)) {
			this.#recorder.record("harness.protocol-fault", { fault: "session-close-response-malformed" });
			throw new AcpProtocolErrorV0("the agent's session/close response is not a valid ACP v1 response");
		}
		this.#recorder.record("session.close-accepted", { basis: "jsonrpc-response" });
	}

	/** One bounded request, with refusals and a vanished agent classified. */
	async #request<T>(what: string, work: Promise<T>): Promise<T> {
		work.catch(() => {});
		try {
			return await bounded(Promise.race([work, this.#exitedEarly(what)]), this.#requestTimeoutMs, what);
		} catch (error) {
			// close() ended the connection under the request. The agent did nothing wrong: no fault is recorded.
			if (this.#closed && !(error instanceof acp.RequestError)) throw new AcpClosedErrorV0(what);
			throw await this.#classify(what, error);
		}
	}

	/**
	 * Rejects when the agent process exits. A request is raced against it: a descendant can keep the agent's stdout open
	 * after the agent itself ended, and the ACP stream then never reports the end.
	 */
	#exitedEarly(what: string): Promise<never> {
		const early = this.#group.exited.then((exit): never => {
			throw new AcpProcessExitedErrorV0(`the agent process ended during ${what}`, exit);
		});
		early.catch(() => {});
		return early;
	}

	async #classify(what: string, error: unknown): Promise<unknown> {
		if (
			error instanceof AcpTimeoutErrorV0 ||
			error instanceof AcpProtocolErrorV0 ||
			error instanceof AcpProcessExitedErrorV0
		)
			return error;
		if (error instanceof acp.RequestError) return new AcpRefusedErrorV0(what, error.code);
		// The connection ended under the request. Give the keeper's exit report a moment to arrive first.
		await Promise.race([this.#group.exited, delay(500)]);
		if (this.#exit !== null) {
			return new AcpProcessExitedErrorV0(`the agent process ended during ${what}`, this.#exit);
		}
		this.#recorder.record("harness.protocol-fault", { fault: "transport-closed" });
		return new AcpProtocolErrorV0(`the ACP connection failed during ${what}`);
	}

	/**
	 * Send one text prompt and wait for the agent's answer. Resolves only with a stop reason the agent reported from
	 * ACP's closed set; an exit, a JSON-RPC error, a malformed answer or a timeout rejects.
	 */
	async prompt(text: string): Promise<AcpPromptResultV0> {
		const sessionId = this.sessionId;
		if (this.#closed || this.#unusable || this.#exit !== null || this.#sessionClosed)
			throw new TypeError("the ACP attachment is closed");
		if (this.#run !== null) throw new TypeError("a prompt turn is already open");
		const requested = this.#recorder.record("control.requested", { capability: "session.prompt", action: "prompt" });
		// The run start is the client's own request, said so: ACP v1 sends no run-start notification.
		const started = this.#recorder.derive(
			"lifecycle.run-started",
			{ instance: this.#recorder.instance, basis: "client-sent-session-prompt" },
			requested,
		);
		const run: OpenRun = { started, stopRequested: false, updates: Object.create(null) };
		this.#run = run;
		// The turn settles on its own path, whenever the agent answers. A timeout only stops this caller waiting: the
		// answer, if it comes later (after a cancel(), say), is still recorded as the agent's report.
		const settled = this.#settle(
			run,
			this.#connection.agent.request(acp.methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "text", text }],
			}),
		);
		settled.catch(() => {});
		try {
			return await bounded(settled, this.#promptTimeoutMs, "session/prompt");
		} catch (error) {
			// Not an observed end: the turn stays open until the agent answers, cancel() or close().
			if (error instanceof AcpTimeoutErrorV0) {
				this.#recorder.record("harness.prompt-timeout", { timeoutMs: this.#promptTimeoutMs });
			}
			throw error;
		}
	}

	async #settle(run: OpenRun, request: Promise<unknown>): Promise<AcpPromptResultV0> {
		let response: unknown;
		try {
			request.catch(() => {});
			response = await Promise.race([request, this.#exitedEarly("session/prompt")]);
		} catch (error) {
			throw await this.#promptFailed(run, error);
		}
		if (this.#run !== run) {
			// The exit handler already closed this run as interrupted; a late answer is not a completion.
			throw new AcpProcessExitedErrorV0("the agent process ended during session/prompt", this.#exitReport());
		}
		const stopReason = isRecord(response) ? response.stopReason : undefined;
		if (!isAcpStopReasonV0(stopReason) || !validateAcpDefinitionV0("PromptResponse", response)) {
			const fault = this.#recorder.record("harness.protocol-fault", { fault: "stop-reason-malformed" });
			this.#recorder.derive("lifecycle.run-unclassified", { reason: "stop-reason-malformed" }, fault);
			this.#run = null;
			throw new AcpProtocolErrorV0("the agent's session/prompt response carries no ACP v1 stopReason");
		}
		const responded = this.#recorder.record("agent.prompt-responded", { stopReason, updates: { ...run.updates } });
		const end = lifecycleEndForStopReasonV0(stopReason, run.stopRequested);
		this.#recorder.derive(end.kind, end.payload, responded);
		this.#run = null;
		return { stopReason, updates: { ...run.updates } };
	}

	/** The exit report; only read after the exit handler ran. */
	#exitReport(): ProcessExitV0 {
		return (this.#exit as ProcessExitV0 | null) ?? { code: null, signal: null, spawnFailed: false };
	}

	async #promptFailed(run: OpenRun, error: unknown): Promise<unknown> {
		// close() ended the connection under the request. The agent did nothing wrong: no fault is recorded, and the
		// open run is left to the exit handler, which records the interruption when the process actually ends.
		if (this.#closed && !(error instanceof acp.RequestError)) return new AcpClosedErrorV0("session/prompt");
		const classified = await this.#classify("session/prompt", error);
		if (this.#run !== run) return classified; // The exit handler already closed the run as interrupted.
		if (classified instanceof AcpRefusedErrorV0) {
			const failed = this.#recorder.record("agent.prompt-failed", { code: classified.code });
			// Deviation from EndoReportedCauseV0: ACP's cause is a JSON-RPC error code, not an assistant message or a
			// retry loop. The message text is not kept.
			this.#recorder.derive(
				"lifecycle.run-failed",
				{ cause: { source: "jsonrpc-error", code: classified.code } },
				failed,
			);
		} else {
			const fault = this.#recorder.record("harness.protocol-fault", { fault: "prompt-transport-failed" });
			this.#recorder.derive("lifecycle.run-unclassified", { reason: "prompt-transport-failed" }, fault);
		}
		this.#run = null;
		return classified;
	}

	/**
	 * Ask the agent to cancel the open prompt turn (`session/cancel`, a notification: ACP gives no acknowledgement).
	 * Returns false when no turn is open. The turn's end is whatever `prompt()` then resolves with.
	 */
	async cancel(): Promise<boolean> {
		const run = this.#run;
		if (run === null || this.#closed || this.#unusable) return false;
		const requested = this.#recorder.record("control.requested", { capability: "session.cancel", action: "cancel" });
		this.#recorder.derive("lifecycle.stop-requested", { runOpen: true }, requested);
		run.stopRequested = true;
		// A client must answer pending permission requests with `cancelled` once it cancels the turn.
		for (const cancel of [...this.#pendingPermissions]) cancel();
		await this.#connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
		return true;
	}

	#onUpdate(params: unknown): void {
		// After the agent was declared gone (or the stream closed, or close() began) a straggler, typically from a
		// descendant that kept stdout open, is not the agent's activity: recorded as ignored, never counted.
		if (this.#exit !== null || this.#unusable || this.#closed || this.#sessionClosed) {
			const after =
				this.#exit !== null ? "exit" : this.#unusable ? "stream-closed" : this.#closed ? "close" : "session-close";
			this.#recorder.record("harness.late-message", { method: "session/update", after });
			return;
		}
		const update = isRecord(params) ? params.update : undefined;
		if (!isRecord(params) || params.sessionId !== this.#sessionId || this.#sessionId === null) {
			this.#recorder.record("runtime.malformed-event", {
				runtimeEvent: "session/update",
				problem: "session-id-mismatch",
			});
			return;
		}
		const translated = translateAcpUpdateV0(update);
		if (translated.kind === "malformed") {
			// Recorded, never counted: malformed traffic is not update activity.
			this.#recorder.record("runtime.malformed-event", translated.payload);
			return;
		}
		this.#updates[translated.variant] = (this.#updates[translated.variant] ?? 0) + 1;
		if (this.#run !== null) this.#run.updates[translated.variant] = (this.#run.updates[translated.variant] ?? 0) + 1;
		if (translated.kind === "delta") return;
		const event = this.#recorder.record(translated.eventKind, translated.payload);
		if (translated.eventKind === "runtime.unrecognized-event") {
			this.#recorder.derive("lifecycle.unrecognized-runtime-event", { runtimeEvent: translated.variant }, event);
		}
	}

	async #onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		// After the agent was declared gone (or the stream closed, or close() began) a request, typically from a descendant
		// that kept stdout open, is not the agent's: no authority event is recorded for it, the handler is not consulted,
		// and nothing is approved. Same rule as a late session/update.
		if (this.#exit !== null || this.#unusable || this.#closed || this.#sessionClosed) {
			const after =
				this.#exit !== null ? "exit" : this.#unusable ? "stream-closed" : this.#closed ? "close" : "session-close";
			this.#recorder.record("harness.late-message", { method: acp.methods.client.session.requestPermission, after });
			return cancelledResponse();
		}
		// What was offered, snapshotted before any user code sees the request: a handler that mutates what it was given
		// cannot widen what it may select.
		const offered: ReadonlyArray<{ readonly optionId: string; readonly kind: string }> = (
			Array.isArray(request.options) ? request.options : []
		).map((option) => ({ optionId: String(option?.optionId), kind: String(option?.kind) }));
		// Two options sharing an id cannot be told apart by the agent from the answer: nothing is selected.
		const duplicateIds = new Set(offered.map((option) => option.optionId)).size !== offered.length;
		const requested = this.#recorder.record("permission.requested", {
			toolCallId: opaqueIdRefV0(request.toolCall?.toolCallId) ?? null,
			optionKinds: offered.map((option) => shortText(option.kind, 32) ?? null),
			runOpen: this.#run !== null,
			sessionMatches: request.sessionId === this.#sessionId,
			...(duplicateIds ? { duplicateOptionIds: true } : {}),
		});
		const run = this.#run;
		let response: acp.RequestPermissionResponse = cancelledResponse();
		// "handler" only when the handler's own valid answer is what is returned; a consulted handler whose answer was
		// refused, threw, or lost a race to cancel/close did not decide.
		let decidedBy: "adapter-default" | "handler" = "adapter-default";
		let handlerConsulted = false;
		if (
			run === null ||
			run.stopRequested ||
			this.#closed ||
			this.#unusable ||
			duplicateIds ||
			request.sessionId !== this.#sessionId
		) {
			// No open turn, a turn being cancelled, a closing attachment, ambiguous options, or another session's id:
			// nothing here can be approved, and the handler is not consulted.
		} else if (this.#options.permissionHandler === undefined) {
			const reject = offered.find((option) => option.kind === "reject_once");
			if (reject !== undefined) response = { outcome: { outcome: "selected", optionId: reject.optionId } };
		} else {
			handlerConsulted = true;
			let cancel!: () => void;
			const cancelled = new Promise<typeof ADAPTER_CANCEL>((resolve) => {
				cancel = () => resolve(ADAPTER_CANCEL);
			});
			this.#pendingPermissions.add(cancel);
			try {
				const answer = await Promise.race([
					Promise.resolve().then(() =>
						(this.#options.permissionHandler as AcpPermissionHandlerV0)(structuredClone(request)),
					),
					cancelled,
				]);
				const outcome = answer === ADAPTER_CANCEL ? undefined : answer?.outcome;
				// Fail closed: only an option the agent actually offered can be selected, and only while the turn the request
				// belongs to is still the open one, not being cancelled, and the attachment is still open (the agent may have
				// finished the turn without waiting for its own request).
				const stillOpen =
					this.#run === run && !run.stopRequested && !this.#closed && !this.#unusable && this.#exit === null;
				if (stillOpen && outcome?.outcome === "cancelled") {
					// The handler's own explicit cancellation is its decision, and is attributed to it.
					decidedBy = "handler";
				} else if (
					this.#run === run &&
					!run.stopRequested &&
					!this.#closed &&
					!this.#unusable &&
					this.#exit === null &&
					outcome?.outcome === "selected" &&
					offered.some((option) => option.optionId === outcome.optionId)
				) {
					// Rebuilt from the validated id: the handler's own object (which it may still hold) is never returned.
					response = { outcome: { outcome: "selected", optionId: outcome.optionId } };
					decidedBy = "handler";
				}
			} catch {
				// A handler that throws decided nothing: cancelled.
			} finally {
				this.#pendingPermissions.delete(cancel);
			}
		}
		const chosen = response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
		const selected = chosen === undefined ? undefined : offered.find((option) => option.optionId === chosen);
		this.#recorder.record(
			"permission.decided",
			{
				decidedBy,
				handlerConsulted,
				decision: selected === undefined ? "cancelled" : "selected",
				optionKind: selected === undefined ? null : (shortText(selected.kind, 32) ?? null),
			},
			"authority-decision",
			[requested.id],
		);
		return response;
	}

	/**
	 * The ACP stream ended. If the agent process is ending too, its exit is what gets recorded. If it is not (stdout
	 * closed, the child lives on), the attachment is unusable: record the fault and end the owned group.
	 */
	async #onConnectionClosed(): Promise<void> {
		if (this.#closed) return;
		// Unusable at once, before the diagnostic wait: no prompt, cancel or approval gets through in the meantime.
		this.#unusable = true;
		for (const cancel of [...this.#pendingPermissions]) cancel();
		await Promise.race([this.#group.exited, delay(500)]);
		if (this.#closed || this.#exit !== null) return;
		this.#recorder.record("harness.protocol-fault", { fault: "connection-closed" });
		await this.close();
	}

	#onExit(exit: ProcessExitV0): void {
		this.#exit = exit;
		const recorded = this.#recorder.record("harness.process-exited", {
			code: exit.code,
			signal: exit.signal,
			spawnFailed: exit.spawnFailed,
			expected: this.#closed,
		});
		const run = this.#run;
		if (run === null) {
			// A process that ended before any session opened has nothing to detach from: the exit is recorded above, and no
			// lifecycle event names a session that never started.
			if (this.#sessionId === null) return;
			this.#recorder.derive(
				"lifecycle.detached",
				{
					instance: this.#recorder.instance,
					expected: this.#closed,
					exit: { code: exit.code, signal: exit.signal },
				},
				recorded,
			);
		} else {
			// The agent ended with a turn open: an interruption, with no agent-reported outcome.
			this.#recorder.derive(
				"lifecycle.interrupted",
				{
					cause: "runtime-exited",
					instance: this.#recorder.instance,
					runOpen: true,
					stopRequested: run.stopRequested,
					exit: { code: exit.code, signal: exit.signal },
				},
				recorded,
			);
			this.#run = null;
		}
	}

	/**
	 * End the attachment and the whole owned process group. Idempotent and bounded: stdin closes, the agent gets a
	 * grace period, then SIGTERM and a second grace, then the group is SIGKILLed whatever is left (release()).
	 */
	close(): Promise<ProcessExitV0> {
		this.#closing ??= (async () => {
			this.#closed = true;
			for (const cancel of [...this.#pendingPermissions]) cancel();
			try {
				this.#connection.close();
			} catch {
				// Already closed.
			}
			this.#group.stdin?.end();
			if ((await Promise.race([this.#group.exited, delay(this.#closeGraceMs)])) === "timeout") {
				this.#group.signalGroup("SIGTERM");
				await Promise.race([this.#group.exited, delay(this.#closeGraceMs)]);
			}
			// Always: a command that exited by itself can leave descendants in its group.
			await this.#group.release();
			return this.#group.exited;
		})();
		return this.#closing;
	}
}
