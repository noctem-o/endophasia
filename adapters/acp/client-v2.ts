// An EXPERIMENTAL ACP v2 (Draft, baseline) client attachment. ACP v2 has not been released as stable; this is a
// version-pinned conformance study (docs/acp-v2-study.md), not a production path, and it does not replace the v1 client
// (client.ts), whose behaviour it neither shares nor changes (it imports that module's error classes and nothing else). It is the one file allowed to import the SDK's
// experimental v2 entry.
//
// Same ownership model as v1: one agent in a process group this attachment owns, an environment that is exactly
// `launch.env`, stderr never read, fs/* and terminal/* not served, observer failures isolated. What differs is ACP v2's
// semantics, and this module follows them instead of preserving v1 assumptions:
//
// - Negotiation. The client requests protocolVersion 2 and accepts only 2. An agent that answers anything else is a
//   typed AcpVersionNegotiationErrorV0 (the raw answer is read off the wire, because the SDK's own failure for a v1-shaped
//   answer is an uninformative schema error); nothing is reinterpreted. Falling back to v1 is a different, explicit
//   operation (negotiate.ts) that launches the agent again.
// - Session surface. `capabilities.session` absent or null: no session surface, fail closed before session/new.
//   `{}`: the seven baseline methods (new, list, resume, close, prompt, cancel, update) as one contract. Nothing
//   optional or unstable is inferred or called.
// - Prompt lifecycle. The `session/prompt` response means "inserted into the conversation", nothing more. Foreground work
//   is reported by `state_update`: running, requires_action, idle (with an optional stopReason). The run starts on the
//   agent's `running` and ends on its next `idle`; `prompt()` resolves on acceptance and `completed` on idle.
// - Replay. `session/resume` with `replayFrom: {type: "start"}` replays retained history as `session/update`s before the
//   response. Those are reconstructed per messageId into a separate state (conversation-v2.ts), never mixed with live
//   state, never stored as text.
// - Permissions fail closed, as in v1, with v2's shape: a required title, optional description and structured subject.
//   A command subject is evidence for the operator's decision; it is never executed. An unknown or malformed subject is
//   never approved and never shown to the handler.

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp2 from "@agentclientprotocol/sdk/experimental/v2";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { checkTimeout } from "../rpc-jsonl/limits.ts";
import { type ProcessExitV0, ProcessGroupV0 } from "../rpc-jsonl/process-group.ts";
import {
	AcpClosedErrorV0,
	AcpObserverErrorV0,
	AcpProcessExitedErrorV0,
	AcpProtocolErrorV0,
	AcpRefusedErrorV0,
	AcpTimeoutErrorV0,
	AcpUnavailableErrorV0,
} from "./client.ts";
import { AcpV2ConversationV0, type AcpV2StateDigestV0 } from "./conversation-v2.ts";
import { validateAcpV2DefinitionV0 } from "./schema-v2.ts";
import { AcpRecorderV0, acpSessionRefV0, isRecord, opaqueIdRefV0, shortText } from "./translate.ts";
import {
	ACP_V2_LIFECYCLE_UNAVAILABLE_V0,
	ACP_V2_MAPPING_VERSION,
	lifecycleEndForV2StopReasonV0,
	summarizeConfigOptionsV2,
	translateAcpV2UpdateV0,
} from "./translate-v2.ts";

/** The one ACP protocol version this client speaks. Literal, not the SDK's constant, so an SDK change cannot move it. */
export const ACP_V2_PROTOCOL_VERSION_V0 = 2;

export interface AcpV2LaunchV0 {
	readonly command: string;
	readonly args: readonly string[];
	/** The child's working directory; absolute. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export type AcpV2PermissionHandlerV0 = (
	request: acp2.RequestPermissionRequest,
) => acp2.RequestPermissionResponse | Promise<acp2.RequestPermissionResponse>;

export interface AcpV2ClientOptionsV0 {
	readonly launch: AcpV2LaunchV0;
	/** Names this attachment in producers, e.g. "omp.default". */
	readonly attachment: string;
	readonly onEvent: (event: EndoEventV0) => void;
	/** Absent: every permission request is rejected or cancelled. Present: it decides, still bounded to offered options. */
	readonly permissionHandler?: AcpV2PermissionHandlerV0;
	/** initialize, session/new, session/resume, session/list, session/close, and the prompt's acceptance each. Default 30 s. */
	readonly requestTimeoutMs?: number;
	/** How long `completed` waits for the agent's idle. Default 10 min. On expiry the run is left open. */
	readonly promptTimeoutMs?: number;
	readonly closeGraceMs?: number;
	readonly now?: () => string;
}

/** How to open the attachment's session. Default: `session/new`. */
export interface AcpV2SessionOpenV0 {
	readonly cwd: string;
	readonly resume?: { readonly sessionId: string; readonly replay?: "start" };
}

/** What the agent reported at initialize, as reported. `info` is the agent's claim, not a verified identity. */
export interface AcpV2InitializeEvidenceV0 {
	readonly protocolVersion: 2;
	readonly info: unknown;
	readonly capabilities: unknown;
	readonly authMethods: unknown;
}

export interface AcpV2ListedSessionV0 {
	readonly sessionId: string;
	readonly cwd: string;
	readonly title: string | null;
	readonly updatedAt: string | null;
	readonly additionalDirectories: readonly string[];
}

export interface AcpV2SessionListV0 {
	readonly sessions: readonly AcpV2ListedSessionV0[];
	readonly nextCursor: string | null;
}

/** The agent's report that foreground work ended. */
export interface AcpV2RunEndV0 {
	/** The stop reason the idle state_update carried; null when it carried none (a custom reason is passed through as sent). */
	readonly stopReason: string | null;
	/** How Endophasia classified the end. */
	readonly classification: "completed" | "aborted" | "unclassified";
}

export interface AcpV2PromptAcceptedV0 {
	/** The conversation message the agent says it inserted. Acceptance, not completion. */
	readonly messageId: string;
	/** Settles when the agent next reports idle; rejects if the agent exits, the attachment closes, or promptTimeoutMs passes. */
	readonly completed: Promise<AcpV2RunEndV0>;
}

/** The agent answered initialize with a protocol version this client does not speak (or none at all). */
export class AcpVersionNegotiationErrorV0 extends Error {
	readonly offered: number;
	/** The numeric protocolVersion the agent answered; null when the answer carried none. */
	readonly answered: number | null;
	readonly kind: "agent-answered-v1" | "unsupported-version" | "incoherent";
	constructor(kind: AcpVersionNegotiationErrorV0["kind"], answered: number | null) {
		super(
			kind === "incoherent"
				? "the agent's initialize response is not a coherent ACP v2 answer"
				: `the agent answered ACP protocol version ${String(answered)} to an offer of ${ACP_V2_PROTOCOL_VERSION_V0}; only ${ACP_V2_PROTOCOL_VERSION_V0} is spoken by this client`,
		);
		this.name = "AcpVersionNegotiationErrorV0";
		this.kind = kind;
		this.offered = ACP_V2_PROTOCOL_VERSION_V0;
		this.answered = answered;
	}
}

interface OpenRun {
	/** The client sent session/prompt for this run. False: foreground work the agent started on its own. */
	prompted: boolean;
	/** The agent reported `running` since this run was opened. */
	started: boolean;
	stopRequested: boolean;
	/** session/prompt has crossed the transmission boundary. False: a cancel now would be for work not yet submitted. */
	sent: boolean;
	/** A re-entrant cancel() arrived before the prompt was sent: the prompt is not sent at all. */
	cancelledBeforeSend?: boolean;
	updates: Record<string, number>;
	/** The message id the agent accepted this run's prompt with. */
	messageId?: string;
	settle?: { resolve(end: AcpV2RunEndV0): void; reject(error: unknown): void };
	timer?: ReturnType<typeof setTimeout>;
}

const cancelledResponse = (): acp2.RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
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

/** The fault named for a response the SDK itself refused, by the request it answered. */
const MALFORMED_FAULT: Readonly<Record<string, string>> = {
	"session/new": "session-new-response-malformed",
	"session/resume": "session-resume-response-malformed",
	"session/list": "session-list-response-malformed",
	"session/close": "session-close-response-malformed",
	"session/prompt": "prompt-response-malformed",
};

const idKey = (id: unknown): string => `${typeof id}:${String(id)}`;

interface TapHooksV2 {
	/** A well-formed session/update notification, raw. */
	update(params: unknown): void;
	/** The response to a request this client sent, raw, with the method it answers. */
	response(method: string, message: Record<string, unknown>): void;
	/** An incoming session/request_permission request, raw. */
	permissionRequest(id: unknown, params: unknown): void;
	/** A response this client sent to a permission request (a result or an error). */
	permissionAnswered(id: unknown): void;
}

/**
 * The SDK's own session-update router parses every update with a closed union and drops what it does not know, and its
 * handlers see only parsed values. This client needs the raw bytes' meaning, in wire order: updates, the raw answer to
 * initialize (so a version answer is classified from what was sent, not from the SDK's failure), the moment `session/resume`
 * answers (replay is everything before it), and permission requests whose malformed shape the SDK rejects before any
 * handler. Both directions are observed; everything except session/update notifications continues to the SDK untouched.
 */
function tapStream(stream: acp2.Stream, hooks: TapHooksV2): acp2.Stream {
	const sent = new Map<string, string>();
	const guard = (run: () => void): void => {
		try {
			run();
		} catch {
			// Evidence that could not be recorded must not take the connection down.
		}
	};
	const isUpdate = (message: Record<string, unknown>): boolean =>
		message.jsonrpc === "2.0" && message.method === "session/update" && !("id" in message);
	const incoming = (message: unknown): "pass" | "take" => {
		if (!isRecord(message)) return "pass";
		if (isUpdate(message)) {
			guard(() => hooks.update(message.params));
			return "take";
		}
		if (typeof message.method === "string") {
			if (message.method === "session/request_permission" && "id" in message)
				guard(() => hooks.permissionRequest(message.id, message.params));
			return "pass";
		}
		if ("id" in message && ("result" in message || "error" in message)) {
			const method = sent.get(idKey(message.id));
			if (method !== undefined) {
				sent.delete(idKey(message.id));
				guard(() => hooks.response(method, message));
			}
		}
		return "pass";
	};
	const outgoing = (message: unknown): void => {
		if (!isRecord(message) || !("id" in message)) return;
		if (typeof message.method === "string") sent.set(idKey(message.id), message.method);
		else if ("result" in message || "error" in message) guard(() => hooks.permissionAnswered(message.id));
	};
	const writer = stream.writable.getWriter();
	return {
		writable: new WritableStream<acp2.AnyWireMessage>({
			async write(message) {
				for (const entry of Array.isArray(message) ? message : [message]) outgoing(entry);
				await writer.write(message);
			},
			async close() {
				await writer.close();
			},
			async abort(reason) {
				await writer.abort(reason);
			},
		}),
		readable: stream.readable.pipeThrough(
			new TransformStream<acp2.AnyWireMessage, acp2.AnyWireMessage>({
				transform(message, controller) {
					if (Array.isArray(message)) {
						const rest = (message as unknown[]).filter((entry) => incoming(entry) === "pass");
						if (rest.length > 0) controller.enqueue(rest as unknown as acp2.AnyWireMessage);
					} else if (incoming(message) === "pass") controller.enqueue(message);
				},
			}),
		),
	};
}

type SubjectKind = "none" | "tool_call" | "command" | "unrecognized" | "malformed";

interface PermissionEntry {
	readonly request: acp2.RequestPermissionRequest | null;
	readonly subject: SubjectKind;
	/** Nothing may be decided: the attachment was already gone when the request arrived. */
	readonly late: boolean;
	readonly requested: EndoEventV0 | null;
	decided: boolean;
	/** Whether the operator's handler was asked, for the record of an answer that was an error. */
	handlerConsulted: boolean;
}

/** Classify a raw permission request against the baseline. The subject is judged apart from the rest of the request. */
function classifyPermission(params: unknown): { request: acp2.RequestPermissionRequest | null; subject: SubjectKind } {
	if (validateAcpV2DefinitionV0("RequestPermissionRequest", params)) {
		const subject = (params as { subject?: unknown }).subject;
		const type = isRecord(subject) ? subject.type : undefined;
		const kind: SubjectKind =
			subject === undefined || subject === null
				? "none"
				: type === "tool_call" || type === "command"
					? type
					: "unrecognized";
		return { request: params as acp2.RequestPermissionRequest, subject: kind };
	}
	return { request: null, subject: "malformed" };
}

export class AcpClientV2 {
	readonly #options: AcpV2ClientOptionsV0;
	readonly #group: ProcessGroupV0;
	readonly #recorder: AcpRecorderV0;
	readonly #connection: acp2.ClientConnection;
	readonly #requestTimeoutMs: number;
	readonly #promptTimeoutMs: number;
	readonly #closeGraceMs: number;
	readonly #pendingPermissions = new Set<() => void>();
	readonly #permissions = new Map<string, PermissionEntry>();
	readonly #updates: Record<string, number> = Object.create(null);
	readonly #replayUpdates: Record<string, number> = Object.create(null);
	readonly #live = new AcpV2ConversationV0();
	readonly #replay = new AcpV2ConversationV0();
	#initialize: AcpV2InitializeEvidenceV0 | null = null;
	#rawInitialize: Record<string, unknown> | undefined;
	/**
	 * The raw `result` of the latest response per method, taken off the wire before the SDK parsed it. The SDK repairs
	 * what the baseline calls invalid (a bad optional field is dropped, a bad list item skipped); everything this client
	 * validates and reads is the raw value, so nothing repaired is ever taken for what the agent sent.
	 */
	readonly #rawResults = new Map<string, unknown>();
	#sessionId: string | null = null;
	#run: OpenRun | null = null;
	#exit: ProcessExitV0 | null = null;
	#closing: Promise<ProcessExitV0> | undefined;
	#closed = false;
	#unusable = false;
	#sessionClosed = false;
	#sessionClosing = false;
	/** `session/resume` was sent with replayFrom and has not answered: updates before its response are replay. */
	#replaying = false;
	/** `session/resume` was sent without replayFrom and has not answered: replayed history here is a protocol violation. */
	#resumeWithoutReplay = false;
	#replayRequested = false;
	#replayCompleted = false;
	/** harness.attached was recorded: only then is there a session to detach from. */
	#attached = false;
	#listing: Promise<void> = Promise.resolve();

	private constructor(options: AcpV2ClientOptionsV0) {
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
		this.#group.stdin?.on("error", () => {});
		this.#group.stdout?.on("error", () => {});
		void this.#group.exited.then((exit) => this.#onExit(exit));

		const stream = tapStream(
			acp2.ndJsonStream(
				Writable.toWeb(this.#group.stdin as Writable) as WritableStream<Uint8Array>,
				Readable.toWeb(this.#group.stdout as Readable) as ReadableStream<Uint8Array>,
			),
			{
				update: (params) => this.#onUpdate(params),
				response: (method, message) => this.#onResponse(method, message),
				permissionRequest: (id, params) => this.#onPermissionRequest(id, params),
				permissionAnswered: (id) => this.#onPermissionAnswered(id),
			},
		);
		this.#connection = acp2
			.client({ name: "endophasia-acp-v2" })
			.onRequest(acp2.methods.client.session.requestPermission, (ctx) =>
				this.#onPermission(ctx.requestId, ctx.params),
			)
			.connect(stream);
		void this.#connection.closed.catch(() => {}).then(() => this.#onConnectionClosed());
	}

	/**
	 * Launch the agent, negotiate ACP v2, and open one session in `cwd` (absolute). Any failure tears the child down
	 * before it propagates.
	 */
	static async connect(options: AcpV2ClientOptionsV0, request: AcpV2SessionOpenV0): Promise<AcpClientV2> {
		const resume =
			request.resume === undefined
				? undefined
				: { sessionId: request.resume.sessionId, replay: request.resume.replay };
		const session: AcpV2SessionOpenV0 = Object.freeze({
			cwd: request.cwd,
			...(resume === undefined ? {} : { resume: Object.freeze(resume) }),
		});
		if (!isAbsolute(options.launch.cwd)) throw new TypeError("launch.cwd must be an absolute path");
		if (typeof session.cwd !== "string" || !isAbsolute(session.cwd))
			throw new TypeError("session.cwd must be an absolute path");
		if (session.resume !== undefined) {
			if (typeof session.resume.sessionId !== "string") throw new TypeError("resume.sessionId must be a string");
			if (session.resume.replay !== undefined && session.resume.replay !== "start")
				throw new TypeError('resume.replay must be "start" or omitted');
		}
		for (const [name, value] of [
			["requestTimeoutMs", options.requestTimeoutMs ?? 0],
			["promptTimeoutMs", options.promptTimeoutMs ?? 0],
			["closeGraceMs", options.closeGraceMs ?? 0],
		] as const)
			checkTimeout(name, value);
		const client = new AcpClientV2(options);
		try {
			await client.#negotiate();
			await client.#openSession(session);
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

	get initialize(): AcpV2InitializeEvidenceV0 {
		if (this.#initialize === null) throw new TypeError("not initialized");
		return this.#initialize;
	}

	get sessionId(): string {
		if (this.#sessionId === null) throw new TypeError("no session is open");
		return this.#sessionId;
	}

	/** Live `session/update` counts observed since the session opened, by variant (replay is counted apart). */
	get updateCounts(): Readonly<Record<string, number>> {
		return { ...this.#updates };
	}

	/** `session/update` counts received while a requested replay was in flight, by variant. */
	get replayUpdateCounts(): Readonly<Record<string, number>> {
		return { ...this.#replayUpdates };
	}

	/** Digests of the conversation reconstructed from live updates. Never content. */
	liveState(): AcpV2StateDigestV0 {
		return this.#live.digest();
	}

	/**
	 * Digests of the conversation reconstructed from the replay `session/resume` was asked for; null when no replay was
	 * requested, or while it has not completed. Compare with compareAcpV2ReplayV0 (conversation-v2.ts).
	 */
	replayState(): AcpV2StateDigestV0 | null {
		return this.#replayCompleted ? this.#replay.digest() : null;
	}

	liveProcessMembers(): boolean | undefined {
		return this.#group.liveMembers();
	}

	get observerErrors(): readonly unknown[] {
		return [...this.#recorder.observerErrors];
	}

	/** Whether foreground work is open (the agent reported running and has not reported idle, or a prompt awaits its idle). */
	get runOpen(): boolean {
		return this.#run !== null;
	}

	#fault(fault: string): EndoEventV0 {
		return this.#recorder.record("harness.protocol-fault", { fault });
	}

	async #negotiate(): Promise<void> {
		let response: unknown;
		try {
			response = await this.#request(
				"initialize",
				this.#connection.agent.request(acp2.methods.agent.initialize, {
					protocolVersion: ACP_V2_PROTOCOL_VERSION_V0,
					info: { name: "endophasia", version: "0" },
					// Nothing is offered: no elicitation, no authentication extensions, nothing unstable.
					capabilities: {},
				}),
			);
		} catch (error) {
			// The SDK refuses an answer that is not a v2 InitializeResponse before anything else; the raw answer says why.
			const raw = this.#rawInitialize;
			if (raw !== undefined && error instanceof Error && !(error instanceof AcpProcessExitedErrorV0)) {
				// Version 2 answered in a shape the baseline rejects is an incoherent answer, not an unsupported version.
				if (raw.protocolVersion === ACP_V2_PROTOCOL_VERSION_V0) {
					this.#fault("initialize-response-schema-invalid");
					throw new AcpVersionNegotiationErrorV0("incoherent", ACP_V2_PROTOCOL_VERSION_V0);
				}
				throw this.#negotiationFailure(raw);
			}
			throw error;
		}
		const raw = this.#rawInitialize;
		if (raw === undefined || !isRecord(response)) {
			this.#fault("initialize-response-malformed");
			throw new AcpVersionNegotiationErrorV0("incoherent", null);
		}
		if (raw.protocolVersion !== ACP_V2_PROTOCOL_VERSION_V0) throw this.#negotiationFailure(raw);
		if (!validateAcpV2DefinitionV0("InitializeResponse", raw)) {
			this.#fault("initialize-response-schema-invalid");
			throw new AcpVersionNegotiationErrorV0("incoherent", ACP_V2_PROTOCOL_VERSION_V0);
		}
		const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
		const info = isRecord(raw.info) ? raw.info : {};
		const canonical = canonicalEndoJsonV0(JSON.parse(JSON.stringify(capabilities)) as JsonValueV0);
		const sessionAdvertised = isRecord(capabilities.session);
		const unstableCapabilities = ["providers", "nes", "positionEncoding"].filter(
			(name) => capabilities[name] != null,
		);
		const sessionExtras = isRecord(capabilities.session)
			? ["delete", "additionalDirectories", "fork"].filter(
					(name) => (capabilities.session as Record<string, unknown>)[name] != null,
				)
			: [];
		this.#initialize = {
			protocolVersion: 2,
			info: raw.info,
			capabilities: raw.capabilities,
			authMethods: raw.authMethods,
		};
		this.#recorder.record("harness.acp-initialized", {
			mapping: ACP_V2_MAPPING_VERSION,
			protocolVersion: 2,
			info: { name: opaqueIdRefV0(info.name) ?? null, version: opaqueIdRefV0(info.version) ?? null },
			capabilitiesDigest: sha256HexV0(canonical),
			capabilities: canonical.length <= 8192 ? (JSON.parse(canonical) as JsonValueV0) : null,
			authMethodIds: Array.isArray(raw.authMethods)
				? raw.authMethods.map((method) => (isRecord(method) ? (opaqueIdRefV0(method.methodId) ?? null) : null))
				: null,
			// The baseline session methods are one contract: `{}` advertises all seven, absent or null advertises none.
			sessionSurface: sessionAdvertised ? "baseline" : "none",
			// Advertised but not used by this client: named so a reader sees they were ignored, not unnoticed.
			ignoredOptionalSessionCapabilities: sessionExtras,
			ignoredUnstableCapabilities: unstableCapabilities,
		});
		if (!sessionAdvertised) {
			this.#recorder.record("control.unavailable", { capability: "session", reason: "not-advertised" });
			throw new AcpUnavailableErrorV0("session");
		}
	}

	#negotiationFailure(raw: Record<string, unknown>): AcpVersionNegotiationErrorV0 {
		const answered =
			typeof raw.protocolVersion === "number" && Number.isInteger(raw.protocolVersion) ? raw.protocolVersion : null;
		if (answered === null) {
			this.#fault("initialize-response-malformed");
			return new AcpVersionNegotiationErrorV0("incoherent", null);
		}
		this.#recorder.record("harness.protocol-fault", {
			fault: "unsupported-protocol-version",
			offered: ACP_V2_PROTOCOL_VERSION_V0,
			answered,
		});
		return new AcpVersionNegotiationErrorV0(answered === 1 ? "agent-answered-v1" : "unsupported-version", answered);
	}

	async #openSession(open: AcpV2SessionOpenV0): Promise<void> {
		const resume = open.resume;
		const method = resume !== undefined ? "session/resume" : "session/new";
		if (resume !== undefined) {
			// Updates before the answer are replay if it was asked for, and a violation if it was not. The id is known now.
			this.#sessionId = resume.sessionId;
			this.#recorder.setSession(resume.sessionId);
			this.#replayRequested = resume.replay === "start";
			this.#replaying = this.#replayRequested;
			this.#resumeWithoutReplay = !this.#replayRequested;
		}
		const sending =
			resume !== undefined
				? this.#connection.agent.request(acp2.methods.agent.session.resume, {
						sessionId: resume.sessionId,
						cwd: open.cwd,
						mcpServers: [],
						...(resume.replay === "start" ? { replayFrom: { type: "start" as const } } : {}),
					})
				: this.#connection.agent.request(acp2.methods.agent.session.new, { cwd: open.cwd, mcpServers: [] });
		let response: unknown;
		try {
			await this.#requestOptional(method, sending);
			response = this.#takeRaw(method);
		} finally {
			// Whatever happened, nothing after this is replay.
			this.#replaying = false;
			this.#resumeWithoutReplay = false;
		}
		const sessionId = resume?.sessionId ?? (isRecord(response) ? response.sessionId : undefined);
		if (
			!isRecord(response) ||
			typeof sessionId !== "string" ||
			!validateAcpV2DefinitionV0(resume !== undefined ? "ResumeSessionResponse" : "NewSessionResponse", response)
		) {
			this.#fault(resume !== undefined ? "session-resume-response-malformed" : "session-new-response-malformed");
			throw new AcpProtocolErrorV0(`the agent's ${method} response is not a valid ACP v2 baseline response`);
		}
		if (this.#exit !== null)
			throw new AcpProcessExitedErrorV0(`the agent process ended during ${method}`, this.#exit);
		this.#sessionId = sessionId;
		this.#recorder.setSession(sessionId);
		if (this.#replayRequested) this.#replayCompleted = true;
		this.#attached = true;
		const attached = this.#recorder.record("harness.attached", {
			mapping: ACP_V2_MAPPING_VERSION,
			instance: this.#recorder.instance,
			acpSessionId: acpSessionRefV0(sessionId),
			openedBy: method,
			...(resume !== undefined
				? {
						historyReplay: this.#replayRequested ? "requested" : "not-requested",
						...(this.#replayRequested ? { replayedUpdates: sumCounts(this.#replayUpdates) } : {}),
					}
				: {}),
		});
		this.#recorder.derive(
			"lifecycle.session-started",
			{
				runtime: "acp",
				runtimeSessionId: acpSessionRefV0(sessionId),
				instance: this.#recorder.instance,
				openedBy: method,
				protocol: "acp-v2-draft",
				unavailable: ACP_V2_LIFECYCLE_UNAVAILABLE_V0.map((field) => ({ ...field })),
			},
			attached,
		);
		const configOptions = Array.isArray(response.configOptions) ? response.configOptions : undefined;
		if (configOptions !== undefined)
			this.#recorder.record("session.config-observed", {
				origin: method,
				...summarizeConfigOptionsV2(configOptions),
			});
		// The opening response may carry the agent's commands and need not repeat them in an update: the same count the
		// update path records, tagged with where it came from.
		if (Array.isArray(response.availableCommands))
			this.#recorder.record("session.update-observed", {
				update: "available_commands_update",
				origin: method,
				commands: response.availableCommands.length,
			});
	}

	/** A request whose JSON-RPC refusal is recorded (by code) before it propagates. */
	async #requestOptional<T>(what: string, work: Promise<T>): Promise<T> {
		try {
			return await this.#request(what, work);
		} catch (error) {
			if (error instanceof AcpRefusedErrorV0)
				this.#recorder.record("control.refused", { capability: what.replace("/", "."), code: error.code });
			throw error;
		}
	}

	#own(own: { failed: boolean; error?: unknown }, event: EndoEventV0): EndoEventV0 {
		if (!own.failed && this.#recorder.deliveryFailed(event)) {
			own.failed = true;
			own.error = this.#recorder.lastObserverError;
		}
		return event;
	}

	#reportObserverFailure(own: { failed: boolean; error?: unknown }): void {
		if (own.failed) throw new AcpObserverErrorV0(own.error);
	}

	#assertUsable(what: string): void {
		if (this.#closed || this.#unusable || this.#exit !== null || this.#sessionClosed || this.#sessionClosing)
			throw new TypeError(`the ACP attachment is closed (${what})`);
	}

	/** `session/list`: part of the baseline session surface this client negotiated. */
	listSessions(params: { readonly cwd?: string; readonly cursor?: string } = {}): Promise<AcpV2SessionListV0> {
		// One session/list in flight at a time: the raw result is captured per method, so concurrent lists could not be told
		// apart (nor, if answered in one batch, kept apart). Callers still get their own answers, in call order.
		const turn = this.#listing.then(() => this.#listSessions(params));
		this.#listing = turn.then(
			() => {},
			() => {},
		);
		return turn;
	}

	async #listSessions(params: { readonly cwd?: string; readonly cursor?: string }): Promise<AcpV2SessionListV0> {
		this.#assertUsable("session/list");
		const { cwd, cursor } = params;
		if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd)))
			throw new TypeError("cwd must be an absolute path");
		await this.#requestOptional(
			"session/list",
			this.#connection.agent.request(acp2.methods.agent.session.list, {
				...(cwd !== undefined ? { cwd } : {}),
				...(cursor !== undefined ? { cursor } : {}),
			}),
		);
		const response = this.#takeRaw("session/list");
		if (!isRecord(response) || !validateAcpV2DefinitionV0("ListSessionsResponse", response)) {
			this.#fault("session-list-response-malformed");
			throw new AcpProtocolErrorV0("the agent's session/list response is not a valid ACP v2 baseline response");
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
				additionalDirectories: Array.isArray(entry.additionalDirectories)
					? entry.additionalDirectories.map((directory) => String(directory))
					: [],
			})),
			nextCursor,
		};
	}

	/**
	 * `session/close`: the agent must cancel the session's work and free its resources. A response is the agent's
	 * acceptance, not proof that anything was freed. The process is not ended; close() does that.
	 */
	async closeSession(): Promise<void> {
		this.#assertUsable("session/close");
		const own = { failed: false } as { failed: boolean; error?: unknown };
		this.#sessionClosing = true;
		const run = this.#run;
		const hadStopRequested = run?.stopRequested ?? false;
		if (run !== null) run.stopRequested = true;
		let restored = false;
		const restoreLive = (): void => {
			if (restored) return;
			restored = true;
			this.#sessionClosing = false;
			if (run !== null && this.#run === run) run.stopRequested = hadStopRequested;
		};
		try {
			const requested = this.#own(
				own,
				this.#recorder.record("control.requested", { capability: "session.close", action: "close" }),
			);
			if (run !== null)
				this.#own(own, this.#recorder.derive("lifecycle.stop-requested", { runOpen: true }, requested));
		} catch (error) {
			restoreLive();
			throw error;
		}
		let response: unknown;
		// Pending permissions are answered only once the close is definitive: a `cancelled` outcome is irreversible, and a
		// refused close leaves the work running.
		const settlePermissions = (): void => {
			for (const cancel of [...this.#pendingPermissions]) cancel();
		};
		try {
			await this.#requestOptional(
				"session/close",
				this.#connection.agent.request(acp2.methods.agent.session.close, { sessionId: this.sessionId }),
			);
			response = this.#takeRaw("session/close");
		} catch (error) {
			if (error instanceof AcpRefusedErrorV0) restoreLive();
			else {
				// Timed out, transport failure: the session cannot be used or reported on again, so a waiter is released.
				this.#sessionClosed = true;
				settlePermissions();
				const open = this.#run;
				if (open !== null) this.#closeRun(open, new AcpClosedErrorV0("session/close"));
			}
			throw error;
		}
		this.#sessionClosed = true;
		settlePermissions();
		if (!isRecord(response) || !validateAcpV2DefinitionV0("CloseSessionResponse", response)) {
			const open = this.#run;
			if (open !== null) this.#closeRun(open, new AcpClosedErrorV0("session/close"));
			this.#fault("session-close-response-malformed");
			throw new AcpProtocolErrorV0("the agent's session/close response is not a valid ACP v2 baseline response");
		}
		this.#own(own, this.#recorder.record("session.close-accepted", { basis: "jsonrpc-response" }));
		// The session is over: nothing more can be reported for it, so a waiter is released with the closure. No lifecycle end
		// is derived from the response.
		const open = this.#run;
		if (open !== null) this.#closeRun(open, new AcpClosedErrorV0("session/close"));
		this.#reportObserverFailure(own);
	}

	async #request<T>(what: string, work: Promise<T>): Promise<T> {
		work.catch(() => {});
		try {
			return await bounded(Promise.race([work, this.#exitedEarly(what)]), this.#requestTimeoutMs, what);
		} catch (error) {
			if (this.#closed && !(error instanceof acp2.RequestError)) throw new AcpClosedErrorV0(what);
			throw await this.#classify(what, error);
		}
	}

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
		if (error instanceof acp2.RequestError) return new AcpRefusedErrorV0(what, error.code);
		// The SDK refused a response it received as not matching the schema: the agent's answer is malformed, which is
		// not a transport fault and not a refusal.
		if (error instanceof Error && error.name === "ZodError" && !this.#closed && this.#exit === null) {
			if (what === "initialize" && this.#rawInitialize !== undefined) return error;
			this.#fault(MALFORMED_FAULT[what] ?? "response-malformed");
			return new AcpProtocolErrorV0(`the agent's ${what} response is not a valid ACP v2 baseline response`);
		}
		await Promise.race([this.#group.exited, delay(500)]);
		if (this.#exit !== null) return new AcpProcessExitedErrorV0(`the agent process ended during ${what}`, this.#exit);
		this.#fault("transport-closed");
		return new AcpProtocolErrorV0(`the ACP connection failed during ${what}`);
	}

	/**
	 * Send one text prompt. Resolves when the agent ACCEPTS it (`session/prompt` answers with the id of the message it
	 * inserted): that is not the start of foreground work and not its end. `completed` settles on the agent's next idle.
	 */
	async prompt(text: string): Promise<AcpV2PromptAcceptedV0> {
		const sessionId = this.sessionId;
		this.#assertUsable("session/prompt");
		if (this.#run !== null) throw new TypeError("foreground work is already open");
		const run: OpenRun = {
			prompted: true,
			started: false,
			stopRequested: false,
			sent: false,
			updates: Object.create(null),
		};
		const completed = new Promise<AcpV2RunEndV0>((resolve, reject) => {
			run.settle = { resolve, reject };
		});
		completed.catch(() => {});
		this.#run = run;
		let requested: EndoEventV0;
		try {
			requested = this.#recorder.record("control.requested", { capability: "session.prompt", action: "prompt" });
		} catch (error) {
			if (this.#run === run) this.#run = null;
			throw error;
		}
		if (this.#run !== run || this.#closed || this.#unusable || this.#sessionClosing || this.#sessionClosed) {
			if (this.#run === run) this.#run = null;
			throw new TypeError("the ACP attachment was closed while the prompt was being recorded");
		}
		if (run.cancelledBeforeSend) {
			// An observer cancelled from inside the control.requested event: nothing was submitted, so nothing is sent.
			this.#closeRun(run);
			throw new TypeError("the prompt was cancelled before it was sent");
		}
		this.#armTimeout(run);
		let response: unknown;
		try {
			run.sent = true;
			const sending = this.#connection.agent.request(acp2.methods.agent.session.prompt, {
				sessionId,
				prompt: [{ type: "text", text }],
			});
			await this.#request("session/prompt", sending);
			response = this.#takeRaw("session/prompt");
		} catch (error) {
			throw this.#promptRefused(run, error, requested);
		}
		if (!isRecord(response) || !validateAcpV2DefinitionV0("PromptResponse", response)) {
			this.#fault("prompt-response-malformed");
			// Whether the agent inserted the message is unknown: the run, if any, is unattributed from here.
			if (this.#run === run) {
				if (run.started) {
					// The agent has already reported `running`: that work is observed and stays open (cancellable, ended by its
					// idle, an exit or a close), but nothing ties it to this prompt any more.
					run.prompted = false;
				} else
					this.#closeRun(
						run,
						new AcpProtocolErrorV0("the agent's session/prompt response is not a valid ACP v2 baseline response"),
					);
			}
			throw new AcpProtocolErrorV0("the agent's session/prompt response is not a valid ACP v2 baseline response");
		}
		const messageId = response.messageId as string;
		const stillOpen = this.#run === run;
		if (stillOpen) run.messageId = messageId;
		this.#recorder.record("agent.prompt-accepted", {
			messageId: opaqueIdRefV0(messageId) ?? null,
			// The user-message update carrying this id may precede or follow the response; both are tolerated.
			runOpen: stillOpen,
		});
		// The run already ended before the acceptance arrived: the echo is judged now.
		if (!stillOpen) this.#checkEcho(messageId);
		return { messageId, completed };
	}

	#armTimeout(run: OpenRun): void {
		run.timer = setTimeout(() => {
			if (this.#run !== run) return;
			// Not an observed end: the run stays open until the agent reports idle, cancel() or close().
			this.#recorder.record("harness.prompt-timeout", { timeoutMs: this.#promptTimeoutMs });
			run.settle?.reject(new AcpTimeoutErrorV0("the agent's idle state_update", this.#promptTimeoutMs));
		}, this.#promptTimeoutMs);
		run.timer.unref();
	}

	#promptRefused(run: OpenRun, error: unknown, _requested: EndoEventV0): unknown {
		if (this.#run === run && !run.started) {
			// The agent did not insert the message (refused, vanished, or too slow to say): no foreground work was reported,
			// so no run is claimed. A run that already reported `running` is the agent's, and stays open.
			if (error instanceof AcpRefusedErrorV0) this.#recorder.record("agent.prompt-refused", { code: error.code });
			else if (
				!(
					error instanceof AcpClosedErrorV0 ||
					error instanceof AcpProcessExitedErrorV0 ||
					error instanceof AcpProtocolErrorV0
				)
			)
				this.#fault("prompt-transport-failed");
			this.#closeRun(run, error);
		}
		return error;
	}

	#closeRun(run: OpenRun, error?: unknown): void {
		if (this.#run === run) this.#run = null;
		clearTimeout(run.timer);
		if (error !== undefined) run.settle?.reject(error);
	}

	/**
	 * Ask the agent to cancel foreground work (`session/cancel`, a notification). Returns false when none is open. The
	 * agent's answer is its idle state_update, which the run's `completed` settles on; there is no response to wait for.
	 */
	async cancel(): Promise<boolean> {
		const run = this.#run;
		if (run === null || run.stopRequested) return false;
		if (this.#closed || this.#unusable || this.#sessionClosed || this.#sessionClosing) return false;
		const own = { failed: false } as { failed: boolean; error?: unknown };
		run.stopRequested = true;
		if (!run.sent) {
			// Re-entered from inside prompt()'s own control.requested event: the request is withdrawn before it is sent. No
			// session/cancel goes out (nothing was submitted) and no lifecycle stop is claimed.
			run.cancelledBeforeSend = true;
			this.#own(
				own,
				this.#recorder.record("control.requested", {
					capability: "session.cancel",
					action: "cancel",
					beforeSend: true,
				}),
			);
			this.#reportObserverFailure(own);
			return true;
		}
		const requested = this.#own(
			own,
			this.#recorder.record("control.requested", { capability: "session.cancel", action: "cancel" }),
		);
		this.#own(own, this.#recorder.derive("lifecycle.stop-requested", { runOpen: true }, requested));
		// The client MUST answer every pending permission request with `cancelled` when it cancels active work.
		for (const cancel of [...this.#pendingPermissions]) cancel();
		await this.#connection.agent.notify(acp2.methods.agent.session.cancel, { sessionId: this.sessionId });
		this.#reportObserverFailure(own);
		return true;
	}

	/** The raw result of the response just awaited (undefined if none arrived, which is as malformed as a bad one). */
	#takeRaw(method: string): unknown {
		const raw = this.#rawResults.get(method);
		this.#rawResults.delete(method);
		return raw;
	}

	#onResponse(method: string, message: Record<string, unknown>): void {
		if ("result" in message) this.#rawResults.set(method, structuredClone(message.result));
		else this.#rawResults.delete(method);
		if (method === "initialize") {
			if ("result" in message && isRecord(message.result)) this.#rawInitialize = structuredClone(message.result);
			return;
		}
		if (method === "session/resume" && "result" in message && this.#replaying) {
			// Everything the agent replayed was sent before this answer: from here on, updates are live.
			this.#replaying = false;
			this.#resumeWithoutReplay = false;
		}
	}

	#onUpdate(params: unknown): void {
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
		const translated = translateAcpV2UpdateV0(update);
		// Evidence recorded while a requested replay is in flight says so: a replayed tool-call completion must not read as
		// a second live one. (Live events carry no phase.)
		const replay = this.#replaying;
		const phase: Record<string, JsonValueV0> = replay ? { phase: "replay" } : {};
		if (translated.kind === "malformed") {
			this.#recorder.record("runtime.malformed-event", { ...translated.payload, ...phase });
			return;
		}
		const isMessageHistory =
			typeof translated.variant === "string" && AcpV2ConversationV0.consumes(translated.variant);
		if (this.#resumeWithoutReplay && isMessageHistory) {
			// session/resume without replayFrom MUST NOT replay conversation history.
			this.#recorder.record("harness.protocol-fault", {
				fault: "history-replayed-without-request",
				variant: translated.variant,
			});
			return;
		}
		const counts = replay ? this.#replayUpdates : this.#updates;
		counts[translated.variant] = (counts[translated.variant] ?? 0) + 1;
		if (!replay && this.#run !== null)
			this.#run.updates[translated.variant] = (this.#run.updates[translated.variant] ?? 0) + 1;
		if (isMessageHistory) {
			const applied = (replay ? this.#replay : this.#live).apply(update as Record<string, unknown>);
			if (!applied.applied && applied.problem !== "not-reconstructed")
				this.#recorder.record("session.state-conflict", {
					origin: replay ? "replay" : "live",
					variant: translated.variant,
					problem: shortText(applied.problem.split(" ")[0], 32) ?? "conflict",
				});
		}
		if (translated.kind === "delta") return;
		if (translated.kind === "state") {
			// Replayed history does not drive foreground work: a retained state is history, not the current state.
			if (replay) return;
			this.#onState(translated.state, translated.stopReason);
			return;
		}
		const event = this.#recorder.record(translated.eventKind, { ...translated.payload, ...phase });
		if (translated.eventKind === "runtime.unrecognized-event")
			this.#recorder.derive(
				"lifecycle.unrecognized-runtime-event",
				{ runtimeEvent: translated.variant, ...phase },
				event,
			);
	}

	/** One baseline state_update: foreground work as the agent reports it. */
	#onState(state: "running" | "idle" | "requires_action", stopReason: string | null | undefined): void {
		// State first, then evidence: `onEvent` is caller code and can re-enter this client (a prompt, a cancel) from inside
		// record(). The run this update is about is fixed before the observer can see the event.
		const runOpen = this.#run !== null;
		let run = this.#run;
		if (state === "running" && run === null) {
			// Foreground work the client did not ask for (or asked for earlier and saw end): the agent's own, unattributed.
			run = { prompted: false, started: false, stopRequested: false, sent: true, updates: Object.create(null) };
			this.#run = run;
		}
		const reported = this.#recorder.record("agent.state-reported", {
			state,
			...(state === "idle"
				? {
						stopReason:
							stopReason === undefined || stopReason === null
								? null
								: (shortText(stopReason, 64) ?? "unprintable"),
					}
				: {}),
			runOpen,
		});
		if (state === "requires_action") return;
		if (run === null) {
			// An idle that states why foreground work stopped, with nothing known to have been running: a missed or malformed
			// run. A reasonless idle with no run is an initial or stale state and says nothing.
			if (state === "idle" && stopReason !== undefined && stopReason !== null)
				this.#recorder.derive(
					"lifecycle.run-unclassified",
					{ reason: "idle-without-running", stopRequested: false },
					reported,
				);
			return;
		}
		if (this.#run !== run) return; // The observer already ended it.
		if (state === "running") {
			if (run.started) return;
			run.started = true;
			this.#recorder.derive(
				"lifecycle.run-started",
				{
					instance: this.#recorder.instance,
					basis: "agent-state-update",
					// By order only: ACP v2 does not say which message a run is for.
					attribution: run.prompted ? "client-prompt-by-order" : "none",
				},
				reported,
			);
			return;
		}
		// idle
		const hasReason = stopReason !== undefined && stopReason !== null;
		if (!run.started && !hasReason) return; // Not an end of anything this run did: a stale or initial idle.
		if (!run.started) {
			// An end with no start: the agent never said `running`, which the protocol requires. Not a completion.
			this.#recorder.derive(
				"lifecycle.run-unclassified",
				{ reason: "idle-without-running", stopRequested: run.stopRequested },
				reported,
			);
			this.#endRun(run, hasReason ? stopReason : null, "unclassified");
			return;
		}
		if (!hasReason) {
			this.#recorder.derive(
				"lifecycle.run-unclassified",
				{ reason: "idle-without-stop-reason", stopRequested: run.stopRequested },
				reported,
			);
			this.#endRun(run, null, "unclassified");
			return;
		}
		const end = lifecycleEndForV2StopReasonV0(stopReason, run.stopRequested);
		this.#recorder.derive(end.kind, end.payload, reported);
		this.#endRun(
			run,
			stopReason,
			end.kind === "lifecycle.run-completed"
				? "completed"
				: end.kind === "lifecycle.run-aborted"
					? "aborted"
					: "unclassified",
		);
	}

	#endRun(run: OpenRun, stopReason: string | null, classification: AcpV2RunEndV0["classification"]): void {
		if (this.#run === run) this.#run = null;
		clearTimeout(run.timer);
		run.settle?.resolve({ stopReason, classification });
		if (run.messageId !== undefined) this.#checkEcho(run.messageId);
	}

	/**
	 * The agent MUST echo the message it accepted as a user message in the live session, before or after the response.
	 * Checked once both the acceptance and the end of foreground work are known; its absence is a protocol fault and
	 * changes no lifecycle outcome.
	 */
	#checkEcho(messageId: string): void {
		if (!this.#live.hasMessage(messageId, "user")) this.#fault("prompt-echo-missing");
	}

	/** Approval needs foreground work the client still stands behind. A request is still recorded when this is false. */
	#canApprove(run: OpenRun | null): boolean {
		return (
			run !== null &&
			this.#run === run &&
			!run.stopRequested &&
			!this.#closed &&
			!this.#unusable &&
			this.#exit === null &&
			!this.#sessionClosing &&
			!this.#sessionClosed
		);
	}

	#onPermissionRequest(id: unknown, params: unknown): void {
		const late = this.#exit !== null || this.#unusable || this.#closed || this.#sessionClosed;
		if (late) {
			const after =
				this.#exit !== null ? "exit" : this.#unusable ? "stream-closed" : this.#closed ? "close" : "session-close";
			this.#recorder.record("harness.late-message", { method: "session/request_permission", after });
			this.#permissions.set(idKey(id), {
				request: null,
				subject: "malformed",
				late: true,
				requested: null,
				decided: true,
				handlerConsulted: false,
			});
			return;
		}
		const { request, subject } = classifyPermission(params);
		const options = request === null ? [] : request.options;
		const optionIds = options.map((option) => String(option.optionId));
		const duplicateIds = new Set(optionIds).size !== optionIds.length;
		const toolCallId =
			request === null || request.subject == null
				? undefined
				: subject === "tool_call"
					? (request.subject as { toolCall?: { toolCallId?: unknown } }).toolCall?.toolCallId
					: subject === "command"
						? (request.subject as { toolCallId?: unknown }).toolCallId
						: undefined;
		// Recorded: the shape of the request. Never the title, the description, the command, its directory or the options' labels.
		const requested = this.#recorder.record("permission.requested", {
			subjectKind: subject,
			toolCallId: opaqueIdRefV0(toolCallId) ?? null,
			optionKinds: options.map((option) => shortText(option.kind, 32) ?? null),
			hasDescription: request !== null && typeof request.description === "string",
			runOpen: this.#run !== null,
			sessionMatches: isRecord(params) && params.sessionId === this.#sessionId,
			...(duplicateIds ? { duplicateOptionIds: true } : {}),
		});
		this.#permissions.set(idKey(id), {
			request,
			subject,
			late: false,
			requested,
			decided: false,
			handlerConsulted: false,
		});
	}

	/** A response left for a permission request. If no decision was recorded for it, nothing was selected: say so. */
	#onPermissionAnswered(id: unknown): void {
		const entry = this.#permissions.get(idKey(id));
		if (entry === undefined) return;
		this.#permissions.delete(idKey(id));
		if (entry.decided || entry.requested === null) return;
		entry.decided = true;
		// The SDK (or this adapter) refused the request with a JSON-RPC error: the agent received no approval.
		this.#recorder.record(
			"permission.decided",
			{
				decidedBy: "adapter-default",
				handlerConsulted: entry.handlerConsulted,
				decision: "error",
				optionKind: null,
				subjectKind: entry.subject,
			},
			"authority-decision",
			[entry.requested.id],
		);
	}

	async #onPermission(requestId: unknown, _params: unknown): Promise<acp2.RequestPermissionResponse> {
		const entry = this.#permissions.get(idKey(requestId));
		if (entry === undefined || entry.late || entry.request === null) {
			// Late, or not a baseline-valid request that reached the handler: nothing is approved, nothing decided here.
			if (entry !== undefined && entry.request === null && !entry.late)
				throw acp2.RequestError.invalidParams(undefined, "malformed permission request");
			return cancelledResponse();
		}
		const request = entry.request;
		const offered = request.options.map((option) => ({
			optionId: String(option.optionId),
			kind: String(option.kind),
		}));
		const duplicateIds = new Set(offered.map((option) => option.optionId)).size !== offered.length;
		const run = this.#run;
		let response = cancelledResponse();
		let decidedBy: "adapter-default" | "handler" = "adapter-default";
		let handlerConsulted = false;
		const interpretable = entry.subject === "none" || entry.subject === "tool_call" || entry.subject === "command";
		if (!this.#canApprove(run) || duplicateIds || request.sessionId !== this.#sessionId) {
			// No foreground work to stand behind, a run being cancelled, a closing attachment, ambiguous options or another
			// session's id: nothing can be approved, and the handler is not consulted.
		} else if (!interpretable) {
			// A subject this client does not understand is never shown to the handler and never approved. The agent's own
			// `reject_once` is the answer it offered for "no"; without one, `cancelled` is the only non-approval left.
			const reject = offered.find((option) => option.kind === "reject_once");
			if (reject !== undefined) response = { outcome: { outcome: "selected", optionId: reject.optionId } };
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
						(this.#options.permissionHandler as AcpV2PermissionHandlerV0)(structuredClone(request)),
					),
					cancelled,
				]);
				const outcome = answer === ADAPTER_CANCEL ? undefined : answer?.outcome;
				const stillOpen = this.#canApprove(run);
				if (stillOpen && outcome?.outcome === "cancelled") {
					decidedBy = "handler";
				} else if (
					stillOpen &&
					outcome?.outcome === "selected" &&
					typeof outcome.optionId === "string" &&
					offered.some((option) => option.optionId === outcome.optionId)
				) {
					// Rebuilt from the validated id: the handler's own object is never returned.
					response = { outcome: { outcome: "selected", optionId: outcome.optionId } };
					decidedBy = "handler";
				}
			} catch {
				// A handler that throws decided nothing: cancelled.
			} finally {
				this.#pendingPermissions.delete(cancel);
			}
		}
		// `cancelled` means "active session work was cancelled before the response". It is only true to say when it was: the
		// run is being cancelled or the session is closing or gone. Anything else with nothing selectable (no reject option, a
		// handler that did not decide, ambiguous options, no foreground work) is refused with a JSON-RPC error instead: the
		// agent still receives no approval, and no false cancellation. A handler's own explicit `cancelled` is its decision.
		const cancelling =
			(run?.stopRequested ?? false) ||
			this.#sessionClosing ||
			this.#sessionClosed ||
			this.#closed ||
			this.#unusable ||
			this.#exit !== null;
		if (response.outcome.outcome !== "selected" && decidedBy !== "handler" && !cancelling) {
			entry.handlerConsulted = handlerConsulted;
			throw acp2.RequestError.invalidRequest(undefined, "no offered permission option could be selected");
		}
		const chosen = response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
		const selected = chosen === undefined ? undefined : offered.find((option) => option.optionId === chosen);
		entry.decided = true;
		this.#recorder.record(
			"permission.decided",
			{
				decidedBy,
				handlerConsulted,
				decision: selected === undefined ? "cancelled" : "selected",
				optionKind: selected === undefined ? null : (shortText(selected.kind, 32) ?? null),
				subjectKind: entry.subject,
			},
			"authority-decision",
			entry.requested === null ? [] : [entry.requested.id],
		);
		return response;
	}

	async #onConnectionClosed(): Promise<void> {
		if (this.#closed) return;
		this.#unusable = true;
		for (const cancel of [...this.#pendingPermissions]) cancel();
		await Promise.race([this.#group.exited, delay(500)]);
		if (this.#closed || this.#exit !== null) return;
		this.#fault("connection-closed");
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
			if (!this.#attached) return;
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
			this.#closeRun(
				run,
				new AcpProcessExitedErrorV0("the agent process ended while foreground work was open", exit),
			);
		}
	}

	/** End the attachment and the whole owned process group. Idempotent and bounded, as in v1. */
	close(): Promise<ProcessExitV0> {
		this.#closing ??= (async () => {
			this.#closed = true;
			for (const cancel of [...this.#pendingPermissions]) cancel();
			const run = this.#run;
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
			await this.#group.release();
			const exit = await this.#group.exited;
			// A run still open once the process is gone was never completed: the waiter is released with the closure.
			if (run !== null && this.#run === run) this.#closeRun(run, new AcpClosedErrorV0("foreground work"));
			return exit;
		})();
		return this.#closing;
	}
}

function sumCounts(counts: Readonly<Record<string, number>>): number {
	return Object.values(counts).reduce((n, count) => n + count, 0);
}
