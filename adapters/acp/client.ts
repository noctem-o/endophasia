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
import {
	ACP_LIFECYCLE_UNAVAILABLE_V0,
	ACP_MAPPING_VERSION,
	AcpRecorderV0,
	type AcpStopReasonV0,
	acpSessionRefV0,
	isAcpStopReasonV0,
	isRecord,
	lifecycleEndForStopReasonV0,
	shortText,
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

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

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
	static async connect(options: AcpClientOptionsV0, session: { readonly cwd: string }): Promise<AcpClientV0> {
		if (!isAbsolute(options.launch.cwd)) throw new TypeError("launch.cwd must be an absolute path");
		if (!isAbsolute(session.cwd)) throw new TypeError("session.cwd must be an absolute path");
		for (const [name, value] of [
			["requestTimeoutMs", options.requestTimeoutMs ?? 0],
			["promptTimeoutMs", options.promptTimeoutMs ?? 0],
			["closeGraceMs", options.closeGraceMs ?? 0],
		] as const)
			checkTimeout(name, value);
		const client = new AcpClientV0(options);
		try {
			await client.#negotiate();
			await client.#openSession(session.cwd);
			// The keeper's exit channel is independent of stdout: an agent that answered and died may have been seen dead
			// first. Not an attachment.
			if (client.#exit !== null)
				throw new AcpProcessExitedErrorV0("the agent process ended during attach", client.#exit);
			return client;
		} catch (error) {
			await client.close();
			throw error;
		}
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
		this.#initialize = {
			protocolVersion: response.protocolVersion,
			agentInfo: response.agentInfo,
			agentCapabilities: response.agentCapabilities,
			authMethods: response.authMethods,
		};
		this.#recorder.record("harness.acp-initialized", { mapping: ACP_MAPPING_VERSION, ...reportedByAgent });
	}

	async #openSession(cwd: string): Promise<void> {
		const response: unknown = await this.#request(
			"session/new",
			this.#connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
		);
		if (!isRecord(response) || typeof response.sessionId !== "string" || response.sessionId.length === 0) {
			this.#recorder.record("harness.protocol-fault", { fault: "session-new-response-malformed" });
			throw new AcpProtocolErrorV0("the agent's session/new response carries no sessionId");
		}
		if (this.#exit !== null) {
			throw new AcpProcessExitedErrorV0("the agent process ended during session/new", this.#exit);
		}
		this.#sessionId = response.sessionId;
		this.#recorder.setSession(response.sessionId);
		const attached = this.#recorder.record("harness.attached", {
			mapping: ACP_MAPPING_VERSION,
			instance: this.#recorder.instance,
			acpSessionId: acpSessionRefV0(response.sessionId),
		});
		this.#recorder.derive(
			"lifecycle.session-started",
			{
				runtime: "acp",
				runtimeSessionId: acpSessionRefV0(response.sessionId),
				instance: this.#recorder.instance,
				unavailable: ACP_LIFECYCLE_UNAVAILABLE_V0.map((field) => ({ ...field })),
			},
			attached,
		);
	}

	/** One bounded request, with refusals and a vanished agent classified. */
	async #request<T>(what: string, work: Promise<T>): Promise<T> {
		try {
			return await bounded(work, this.#requestTimeoutMs, what);
		} catch (error) {
			throw await this.#classify(what, error);
		}
	}

	async #classify(what: string, error: unknown): Promise<unknown> {
		if (error instanceof AcpTimeoutErrorV0 || error instanceof AcpProtocolErrorV0) return error;
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
		if (this.#closed || this.#exit !== null) throw new TypeError("the ACP attachment is closed");
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
			response = await request;
		} catch (error) {
			throw await this.#promptFailed(run, error);
		}
		if (this.#run !== run) {
			// The exit handler already closed this run as interrupted; a late answer is not a completion.
			throw new AcpProcessExitedErrorV0("the agent process ended during session/prompt", this.#exitReport());
		}
		const stopReason = isRecord(response) ? response.stopReason : undefined;
		if (!isAcpStopReasonV0(stopReason)) {
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
		if (run === null || this.#closed) return false;
		const requested = this.#recorder.record("control.requested", { capability: "session.cancel", action: "cancel" });
		this.#recorder.derive("lifecycle.stop-requested", { runOpen: true }, requested);
		run.stopRequested = true;
		// A client must answer pending permission requests with `cancelled` once it cancels the turn.
		for (const cancel of [...this.#pendingPermissions]) cancel();
		await this.#connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
		return true;
	}

	#onUpdate(params: unknown): void {
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
		// What was offered, snapshotted before any user code sees the request: a handler that mutates what it was given
		// cannot widen what it may select.
		const offered: ReadonlyArray<{ readonly optionId: string; readonly kind: string }> = (
			Array.isArray(request.options) ? request.options : []
		).map((option) => ({ optionId: String(option?.optionId), kind: String(option?.kind) }));
		// Two options sharing an id cannot be told apart by the agent from the answer: nothing is selected.
		const duplicateIds = new Set(offered.map((option) => option.optionId)).size !== offered.length;
		const requested = this.#recorder.record("permission.requested", {
			toolCallId: shortText(request.toolCall?.toolCallId) ?? null,
			optionKinds: offered.map((option) => shortText(option.kind, 32) ?? null),
			runOpen: this.#run !== null,
			sessionMatches: request.sessionId === this.#sessionId,
			...(duplicateIds ? { duplicateOptionIds: true } : {}),
		});
		const run = this.#run;
		let response: acp.RequestPermissionResponse = CANCELLED;
		// "handler" only when the handler's own valid answer is what is returned; a consulted handler whose answer was
		// refused, threw, or lost a race to cancel/close did not decide.
		let decidedBy: "adapter-default" | "handler" = "adapter-default";
		let handlerConsulted = false;
		if (run === null || run.stopRequested || this.#closed || duplicateIds || request.sessionId !== this.#sessionId) {
			// No open turn, a turn being cancelled, a closing attachment, ambiguous options, or another session's id:
			// nothing here can be approved, and the handler is not consulted.
		} else if (this.#options.permissionHandler === undefined) {
			const reject = offered.find((option) => option.kind === "reject_once");
			if (reject !== undefined) response = { outcome: { outcome: "selected", optionId: reject.optionId } };
		} else {
			handlerConsulted = true;
			let cancel!: () => void;
			const cancelled = new Promise<acp.RequestPermissionResponse>((resolve) => {
				cancel = () => resolve(CANCELLED);
			});
			this.#pendingPermissions.add(cancel);
			try {
				const answer = await Promise.race([
					Promise.resolve().then(() =>
						(this.#options.permissionHandler as AcpPermissionHandlerV0)(structuredClone(request)),
					),
					cancelled,
				]);
				const outcome = answer?.outcome;
				// Fail closed: only an option the agent actually offered can be selected, and only while the turn the request
				// belongs to is still the open one, not being cancelled, and the attachment is still open (the agent may have
				// finished the turn without waiting for its own request).
				if (
					this.#run === run &&
					!run.stopRequested &&
					!this.#closed &&
					outcome?.outcome === "selected" &&
					offered.some((option) => option.optionId === outcome.optionId)
				) {
					response = answer;
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
