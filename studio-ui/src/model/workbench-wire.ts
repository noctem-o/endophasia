// Browser wire gate for the workbench routes. The broker (adapters/pi/workbench.ts) is authoritative for state, authority and privacy;
// nothing of it runs here. These checks cover every field the workbench renderers read. A body that does not match is refused whole,
// and a failure becomes fixed text: no response body, grant or transcript text ever reaches a message.
import type { ActivityDescriptor, PrivateActivity } from "../../../protocol/private-activity.ts";
import { type Check, count, eitherNull, list, obj, one, shape } from "./compare-wire.ts";

import { isPrivateActivity, validActivityDescriptor } from "./private-activity-wire.ts";

export type WorkbenchCommandState = "awaiting-approval" | "dispatching" | "accepted" | "refused" | "unknown";
export interface WorkbenchCommand {
	proposalId: string;
	state: WorkbenchCommandState;
	/** Whether it was authorised to be sent (a withdrawn, timed-out or declined prompt never was). */
	approved: boolean;
	/** How, when it was: the operator typed for this request on the terminal, or a session-control grant covered it and nobody typed. */
	authorizedBy: AuthorizedBy | null;
	reason: string | null;
	disposition: string | null;
	bytes: number;
	digestPrefix: string;
	expiresAtMs: number;
	/**
	 * For a prepared work attempt's brief: which attempt and task, whether its one authorisation was written for this request (from then
	 * on it is never sent again), and why it could not be, when it could not. Null for a typed prompt.
	 */
	attempt: CommandAttempt | null;
}
export interface CommandAttempt {
	attemptId: string;
	taskId: string;
	bound: boolean;
	refusal: AttemptRefusal | null;
}
/** Why an attempt could not be requested or bound (runtime/contracts/develop-attempt-dispatch.ts), as a closed list. */
export const ATTEMPT_REFUSALS = [
	"bad-request",
	"not-found",
	"other-project",
	"unreadable",
	"tasks-unreadable",
	"launch-not-registered",
	"task-not-found",
	"task-done",
	"task-words-changed",
	"outcome-recorded",
	"handed-off",
	"already-authorized",
	"brief-too-large",
	"brief-unsafe",
	"storage-failed",
] as const;
export type AttemptRefusal = (typeof ATTEMPT_REFUSALS)[number];
export type InterventionOperation = "steer" | "queue" | "stop";
export type AuthorizedBy = "terminal" | "session-grant";
/** The launch's mode (DEVELOP-UX-002): chosen on the terminal's command line. Nothing this page sends selects or raises it. */
export type WorkbenchMode = "everyday" | "protected" | "strict";
export type ControlOperation = "prompt" | InterventionOperation;
export const CONTROL_END_REASONS = [
	"expired",
	"budget-spent",
	"revoked-on-terminal",
	"revoked-by-page",
	"re-paired",
	"session-changed",
	"workspace-changed",
	"protection-lost",
	"closing",
] as const;
export type ControlEndReason = (typeof CONTROL_END_REASONS)[number];
/**
 * Bounded session authority as the broker reports it. `holder` is true only for the page whose pairing redeemed the code that carried
 * control; only the holder is told the scope. The page displays this: it never decides from it whether a request is authorised.
 */
export interface SessionControl {
	state: "active" | "none";
	holder: boolean;
	/** A code that carries control is waiting on the terminal to be typed into a page. */
	armed: boolean;
	grantId: string | null;
	operations: ControlOperation[];
	expiresAtMs: number | null;
	sendsLeft: number | null;
	workspaceRoot: string | null;
	/** Why the last grant of this launch ended, when there is none now. */
	ended: ControlEndReason | null;
}
/** What bounds the AGENT, as observed by the attached process. A grant is not a boundary; this is. */
export interface ExecutionProtection {
	state: "enforced" | "not-enforced" | "unknown";
	level: "none" | "workspace" | "restricted";
	mechanism: string | null;
	limitations: string[];
}
export type InterventionState = "awaiting-approval" | "dispatching" | "sent" | "accepted" | "refused" | "unknown";
export interface ScanProgress {
	requests: number;
	bytes: number;
}
/**
 * Only `observed` is a finding. `checking` and `incomplete` establish nothing about the message: an incomplete check (a limit reached,
 * a body that could not be read, the session closing) is not "not observed", and never "the model did not receive it".
 */
export type InterventionConsumption =
	| { status: "observed"; exchange: number; captureEvent: string }
	| { status: "not-observed"; reason: string }
	| { status: "not-applicable"; reason: string }
	| { status: "checking"; scanned: ScanProgress; total: number }
	| { status: "incomplete"; reason: string; scanned: ScanProgress; total: number; retryAtMs: number };
export interface WorkbenchIntervention {
	proposalId: string;
	operation: InterventionOperation;
	state: InterventionState;
	/** Whether it was authorised to be sent. */
	approved: boolean;
	authorizedBy: AuthorizedBy | null;
	reason: string | null;
	disposition: string | null;
	bytes: number | null;
	digestPrefix: string;
	expiresAtMs: number;
	/** The transcript position when it was requested. */
	afterSeq: number;
	/** The run it was made in ended, as the runtime reported it. Not a claim that the request caused it. */
	runEnded: "completed" | "aborted" | "failed" | "unclassified" | null;
	consumption: InterventionConsumption | null;
}
export interface Offer {
	offered: boolean;
	reason: string | null;
}
export interface WorkbenchStatus {
	schemaVersion: "endo.workbench-status.v0";
	launchId: string;
	harness: "pi";
	connection: "connected" | "disconnected";
	run: "active" | "idle" | "unknown";
	session: string | null;
	attachment: string;
	/** `attempt`: whether a prepared work attempt's brief can be requested now (a prompt, on a workbench started with --project). */
	offers: { prompt: Offer; attempt: Offer; steer: Offer; queue: Offer; stop: Offer };
	paired: boolean;
	mode: { requested: WorkbenchMode; effective: WorkbenchMode; reason: string | null };
	protection: ExecutionProtection;
	sessionControl: SessionControl;
	command: WorkbenchCommand | null;
	interventions: WorkbenchIntervention[];
	transcript: { watermark: number; firstSeq: number };
}
/**
 * What a workspace host (`endo workspace open`, protocol/workspace-host.ts) answers on the status route: no harness, so no connection, run,
 * session or offer to report. A normal mode, not a degraded attachment.
 */
export interface WorkspaceHostStatus {
	schemaVersion: "endo.workspace-host-status.v0";
	launchId: string;
	host: "workspace";
	harness: null;
	paired: boolean;
	/** Whether the worktree's changes can be read. */
	changes: boolean;
}
/** One part of a message, in the runtime's order. Reasoning is what the model emitted as reasoning, relayed: not an account of its computation. */
export type MessagePart =
	| { kind: "text"; text: string; truncated: boolean }
	| {
			kind: "reasoning";
			/** `supplied`: text was given. `withheld`: the provider redacted it. `empty`: a block arrived with no text. */
			state: "supplied" | "withheld" | "empty";
			text: string;
			truncated: boolean;
			/** The block's size as the runtime sent it, in UTF-8 bytes (before any cut). */
			bytes: number;
	  };
export type ReasoningPart = Extract<MessagePart, { kind: "reasoning" }>;

export type TranscriptItem =
	| {
			seq: number;
			kind: "message";
			role: "user" | "assistant";
			parts: MessagePart[];
			truncated: boolean;
			partsDropped: number;
			stopReason: string | null;
			/** The in-progress snapshot this completed message replaced, or null. */
			from: number | null;
	  }
	| PrivateActivity
	| { seq: number; kind: "run"; state: "started" | "ended" };
export type TranscriptMessage = Extract<TranscriptItem, { kind: "message" }>;
/** The assistant message being written, as the broker held it when the page read it. Replaced by the completed message. */
export interface OpenMessage {
	id: number;
	afterSeq: number;
	parts: MessagePart[];
}
/** What the source relays of model-provided reasoning: harness-neutral, said by the source, not inferred by the page. */
export interface ReasoningRelay {
	relay: "relayed" | "withheld" | "unsupported";
	reason: string | null;
}
export interface WorkbenchTranscript {
	schemaVersion: "endo.workbench-transcript.v3";
	launchId: string;
	items: TranscriptItem[];
	descriptor: ActivityDescriptor;
	watermark: number;
	firstSeq: number;
	evicted: number;
	more: boolean;
	open: OpenMessage | null;
	reasoning: ReasoningRelay;
}

const bool = (v: unknown): boolean => typeof v === "boolean";
const text =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max;
const short: Check = text(256);
const REASONS = [
	"not-authorized",
	"authorization-denied",
	"approval-timed-out",
	"authorization-expired",
	"session-ended",
	"run-active",
	"capability-unavailable",
	"duplicate",
	"runtime-refused",
	"attempt-changed",
	"attempt-not-recorded",
];

const command: Check = (v) =>
	shape(v, {
		proposalId: (x) => typeof x === "string" && /^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/.test(x),
		state: one("awaiting-approval", "dispatching", "accepted", "refused", "unknown"),
		approved: bool,
		authorizedBy: eitherNull(one("terminal", "session-grant")),
		reason: eitherNull(one(...REASONS)),
		disposition: eitherNull(one("started", "queued", "handled")),
		bytes: (n) => count(n) && n <= 16384,
		digestPrefix: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		expiresAtMs: count,
		attempt: eitherNull((x) =>
			shape(x, {
				attemptId: (y) => typeof y === "string" && /^endo\.attempt\.[0-9a-f]{32}$/.test(y),
				taskId: (y) => typeof y === "string" && y.length <= 128,
				bound: bool,
				refusal: eitherNull(one(...ATTEMPT_REFUSALS)),
			}),
		),
	});

const INTERVENTION_REASONS = [...REASONS, "approval-timed-out", "withdrawn", "superseded-by-stop"];
const progress: Check = (v) => shape(v, { requests: count, bytes: count });
const intervention: Check = (v) =>
	shape(v, {
		proposalId: (x) => typeof x === "string" && /^endo\.evidence\.intervention\.proposal\.[0-9a-f]{64}$/.test(x),
		operation: one("steer", "queue", "stop"),
		state: one("awaiting-approval", "dispatching", "sent", "accepted", "refused", "unknown"),
		approved: bool,
		authorizedBy: eitherNull(one("terminal", "session-grant")),
		reason: eitherNull(
			one(
				...INTERVENTION_REASONS,
				"authorization-for-another-proposal",
				"authorization-for-another-session",
				"authorization-for-another-attachment",
				"proposal-tampered",
				"proposal-for-another-session",
				"no-active-run",
				"runtime-failed",
			),
		),
		disposition: eitherNull(one("started", "queued", "handled")),
		bytes: eitherNull((n) => count(n) && n >= 1 && n <= 16384),
		digestPrefix: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		expiresAtMs: count,
		afterSeq: count,
		runEnded: eitherNull(one("completed", "aborted", "failed", "unclassified")),
		consumption: eitherNull(
			(c) =>
				shape(c, { status: one("observed"), exchange: count, captureEvent: short }) ||
				shape(c, { status: one("not-observed"), reason: text(400) }) ||
				shape(c, { status: one("not-applicable"), reason: text(400) }) ||
				shape(c, { status: one("checking"), scanned: progress, total: count }) ||
				shape(c, {
					status: one("incomplete"),
					reason: text(400),
					scanned: progress,
					total: count,
					retryAtMs: count,
				}),
		),
	});

const offer: Check = (o) => shape(o, { offered: bool, reason: eitherNull(text(400)) });
const MODE = one("everyday", "protected", "strict");
const mode: Check = (m) => shape(m, { requested: MODE, effective: MODE, reason: eitherNull(text(300)) });
const protection: Check = (p) =>
	shape(p, {
		state: one("enforced", "not-enforced", "unknown"),
		level: one("none", "workspace", "restricted"),
		mechanism: eitherNull(text(64)),
		limitations: (x) => Array.isArray(x) && x.length <= 8 && list(text(300))(x),
	});
const CONTROL_OPERATIONS = ["prompt", "steer", "queue", "stop"];
const sessionControl: Check = (c) =>
	shape(c, {
		state: one("active", "none"),
		holder: bool,
		armed: bool,
		grantId: eitherNull(
			(x) => typeof x === "string" && /^endo\.evidence\.workbench-session-grant-[0-9a-f]{32}$/.test(x),
		),
		operations: (x) =>
			Array.isArray(x) && x.length <= 4 && new Set(x).size === x.length && list(one(...CONTROL_OPERATIONS))(x),
		expiresAtMs: eitherNull(count),
		sendsLeft: eitherNull(count),
		workspaceRoot: eitherNull(text(4096)),
		ended: eitherNull(one(...CONTROL_END_REASONS)),
	}) && sessionControlConsistent(c as unknown as SessionControl);
/**
 * A body that contradicts itself is refused whole, so the page can never show control it does not hold: a scope is told only to the
 * holder of an active grant, and an active grant has an end.
 */
const sessionControlConsistent = (c: SessionControl): boolean =>
	c.state === "active"
		? c.expiresAtMs !== null &&
			c.ended === null &&
			(c.holder
				? c.grantId !== null && c.sendsLeft !== null && c.workspaceRoot !== null && c.operations.length > 0
				: c.grantId === null && c.sendsLeft === null && c.workspaceRoot === null && c.operations.length === 0)
		: !c.holder &&
			c.grantId === null &&
			c.expiresAtMs === null &&
			c.sendsLeft === null &&
			c.workspaceRoot === null &&
			c.operations.length === 0;

export const readWorkspaceHostStatus = (v: unknown): WorkspaceHostStatus | null =>
	shape(v, {
		schemaVersion: one("endo.workspace-host-status.v0"),
		launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		host: one("workspace"),
		harness: (x) => x === null,
		paired: bool,
		changes: bool,
	})
		? (v as unknown as WorkspaceHostStatus)
		: null;

export const readWorkbenchStatus = (v: unknown): WorkbenchStatus | null =>
	shape(v, {
		schemaVersion: one("endo.workbench-status.v0"),
		launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		harness: one("pi"),
		connection: one("connected", "disconnected"),
		run: one("active", "idle", "unknown"),
		session: eitherNull((x) => typeof x === "string" && x.length <= 269 && /^endo\.session\./.test(x)),
		attachment: short,
		offers: (o) => shape(o, { prompt: offer, attempt: offer, steer: offer, queue: offer, stop: offer }),
		paired: bool,
		mode,
		protection,
		sessionControl,
		command: eitherNull(command),
		interventions: (x) => Array.isArray(x) && x.length <= 40 && list(intervention)(x),
		transcript: (t) => shape(t, { watermark: count, firstSeq: count }),
	})
		? (v as unknown as WorkbenchStatus)
		: null;

// The broker's bounds (adapters/pi/live-transcript.ts) in UTF-16 units: a UTF-8 byte is at most one unit, so these never refuse a body
// the broker may send, and they stop one it may not.
const MAX_PARTS = 32;
const part: Check = (v) =>
	shape(v, { kind: one("text"), text: text(32 * 1024), truncated: bool }) ||
	(shape(v, {
		kind: one("reasoning"),
		state: one("supplied", "withheld", "empty"),
		text: text(64 * 1024),
		truncated: bool,
		bytes: count,
	}) &&
		reasoningConsistent(v as unknown as ReasoningPart));
/** Withheld and empty blocks carry no text and no cut. A supplied block has text, unless the message's reasoning budget ran out first. */
const reasoningConsistent = (r: ReasoningPart): boolean =>
	r.state === "supplied" ? r.text.length > 0 || r.truncated : r.text === "" && !r.truncated && r.bytes === 0;
const parts: Check = (x) => Array.isArray(x) && x.length <= MAX_PARTS && list(part)(x);
const item: Check = (v) =>
	shape(v, {
		seq: (n) => count(n) && n >= 1,
		kind: one("message"),
		role: one("user", "assistant"),
		parts,
		truncated: bool,
		partsDropped: count,
		stopReason: eitherNull(text(32)),
		from: eitherNull((n) => count(n) && n >= 1),
	}) ||
	isPrivateActivity(v) ||
	shape(v, { seq: (n) => count(n) && n >= 1, kind: one("run"), state: one("started", "ended") });

export function readWorkbenchTranscript(v: unknown): WorkbenchTranscript | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.workbench-transcript.v3"),
			launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
			items: (x) => Array.isArray(x) && x.length <= 200 && list(item)(x),
			descriptor: validActivityDescriptor,
			watermark: count,
			firstSeq: count,
			evicted: count,
			more: bool,
			open: eitherNull((o) => shape(o, { id: (n) => count(n) && n >= 1, afterSeq: count, parts })),
			reasoning: (r) =>
				shape(r, { relay: one("relayed", "withheld", "unsupported"), reason: eitherNull(text(400)) }),
		})
	)
		return null;
	const t = v as unknown as WorkbenchTranscript;
	// The message being written belongs after an item the broker has issued.
	if (t.open !== null && t.open.afterSeq > t.watermark) return null;
	let previous = 0;
	for (const i of t.items) {
		if (i.seq <= previous || i.seq > t.watermark) return null;
		previous = i.seq;
	}
	return t;
}

export const readWorkbenchGrant = (v: unknown): { grant: string; expiresAtMs: number } | null =>
	shape(v, {
		schemaVersion: one("endo.workbench-grant.v0"),
		grant: (x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x),
		expiresAtMs: count,
	})
		? (v as unknown as { grant: string; expiresAtMs: number })
		: null;

export const readWorkbenchCommand = (v: unknown): WorkbenchCommand | null =>
	command(v) && obj(v) ? (v as unknown as WorkbenchCommand) : null;

export const readWorkbenchIntervention = (v: unknown): WorkbenchIntervention | null =>
	intervention(v) && obj(v) ? (v as unknown as WorkbenchIntervention) : null;

export type WorkbenchRequest =
	| { kind: "status" }
	| { kind: "transcript"; after: number }
	| { kind: "pair"; code: string }
	/** `nonce` names this one act of the operator, so a repeated request is the same request and never a second send. No authority. */
	| { kind: "propose"; message: string; nonce: string }
	/** Ask to send a prepared work attempt's brief: by its id only; the broker reads the brief from the attempt's own record. */
	| { kind: "attempt"; attemptId: string }
	| { kind: "command"; proposalId: string }
	| { kind: "discard"; proposalId: string }
	| { kind: "intervene"; operation: InterventionOperation; message: string | null; nonce: string }
	/** Give up this page's session control. It can only reduce what the page may do; nothing here asks for more. */
	| { kind: "relinquish" }
	| { kind: "withdraw"; proposalId: string }
	| { kind: "check"; proposalId: string };

export type WorkbenchReply =
	| { kind: "status"; record: WorkbenchStatus }
	/** The server is a workspace host: tasks and evidence, no harness (`endo workspace open`). */
	| { kind: "host"; record: WorkspaceHostStatus }
	| { kind: "transcript"; record: WorkbenchTranscript }
	| { kind: "grant"; record: { grant: string; expiresAtMs: number } }
	| { kind: "command"; record: WorkbenchCommand }
	| { kind: "intervention"; record: WorkbenchIntervention }
	/** 404 on the status route: this server has no workbench (it is the read-only Studio). */
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: string; message: string; retrySeconds: number | null };

/** One clause per refusal, in the page's words (the terminal has its own). Nothing was recorded or sent when one is shown. */
export const ATTEMPT_REFUSAL_WORDS: Readonly<Record<AttemptRefusal, string>> = {
	"bad-request": "that is not an attempt id",
	"not-found": "it is not in this store",
	"other-project": "it belongs to another project than this workbench's",
	unreadable: "its records cannot be read safely",
	"tasks-unreadable": "the task file cannot be read now",
	"launch-not-registered":
		"Pi was not started in the project's registered directory, so the brief would run somewhere else",
	"task-not-found": "its task is no longer in this project",
	"task-done": "its task is done",
	"task-words-changed": "the task's words changed since the brief was prepared; prepare a new attempt",
	"outcome-recorded": "an outcome is already recorded for it",
	"handed-off": "you recorded handing it to another agent; prepare a new attempt to send one to Pi",
	"already-authorized": "it was already authorised to be sent once; prepare a new attempt to try again",
	"brief-too-large": "its brief is longer than a workbench prompt",
	"brief-unsafe": "its brief holds characters the terminal cannot show faithfully",
	"storage-failed": "its authorisation could not be recorded",
};

const FIXED: Record<string, string> = {
	"pairing-refused":
		"That pairing code was not accepted. Type `pair` in the terminal that started this server for a new one.",
	"grant-required": "This page is not paired. Enter the pairing code shown in the terminal that started this server.",
	"not-offered": "That cannot be requested right now. The reason is shown beside it.",
	"not-checkable": "Only an accepted steer or queue can be checked.",
	"bad-request": "The request was not in a form the workbench accepts.",
	"not-found": "That prompt is no longer known to the workbench.",
	"check-busy": "Other evidence checks are running. Try again in a moment; nothing was asked of the capture.",
	closing: "The session is closing. Closing it checks the capture once more and records what it shows.",
	"not-withdrawable": "That prompt is no longer waiting for approval.",
	"not-recording": "The session is not recording, so nothing was requested.",
	"no-session-control": "This page holds no session control to give up.",
	forbidden: "The workbench refused this request.",
	...Object.fromEntries(
		ATTEMPT_REFUSALS.map((code) => [
			`attempt-${code}`,
			`That attempt cannot be requested: ${ATTEMPT_REFUSAL_WORDS[code]}.`,
		]),
	),
};

/** A failure as fixed text. The body's `error` code selects a sentence; nothing else of it is shown. */
export function workbenchFailure(
	status: number,
	body: unknown,
	retry: string | null,
): Extract<WorkbenchReply, { kind: "failure" }> {
	const code = obj(body) && typeof body.error === "string" && /^[a-z-]{1,40}$/.test(body.error) ? body.error : "";
	return {
		kind: "failure",
		status,
		code,
		retrySeconds:
			status === 429 && retry !== null && /^(0|[1-9][0-9]{0,3})$/.test(retry) ? Math.min(3600, Number(retry)) : null,
		message:
			status === 429
				? "The server is pacing requests. Wait, then try again."
				: (FIXED[code] ??
					(status >= 500
						? "The workbench could not complete the request."
						: "The workbench did not accept the request.")),
	};
}
