// DEVELOP attempt execution (docs/designs/develop-attempt-execution.md): the one durable link between a prepared work attempt and the Pi
// session its brief was sent to through the live workbench, and what the session's own records say happened next.
//
// One new write-once record, beside the attempt's others in `<root>/develop/attempts/` (storage/develop-attempts.ts):
//
//   <id>.authorized.json   endo.develop-attempt-authorization.v0
//
// It says exactly this: the operator, on the controlling terminal of the attached workbench, approved sending THIS attempt's brief (by its
// sha256) as a new prompt to THIS Pi session, through THIS workbench request (its proposal id and digest, and the authorization event the
// broker recorded in the session log). The broker writes it after the approval and after its own last checks, and BEFORE it records the send
// (`workbench.prompt-dispatched`) and sends. So the record's existence means "authorised; a send may follow", never "sent", "accepted",
// "ran" or "succeeded". Everything after it is read from the session's event log (protocol/workbench.ts, protocol/session-lifecycle.ts),
// which this record names but does not copy.
//
// It is written once, so an attempt can be sent at most once: the second authorisation of the same attempt is refused at the file system
// (`link` refuses an existing name), whichever process tries. Retrying is preparing another attempt, as it already was. A declined, withdrawn
// or expired request writes nothing here: the attempt stays prepared, and the decline is in the session's prompt chain only.
//
// This is a DEVELOP work attempt (`endo.attempt.<32 hex>`). It is unrelated to the research harness's own attempt identifiers.
//
// What is never stored here: the brief's text (it is the prepared record's), the prompt as sent, a transcript, a reply, a path, a key.

import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import { ENDO_LAUNCH_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isEndoIdentifierV0 } from "./identity.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";
import { ENDO_WORKBENCH_REFUSAL_REASONS_V0, type EndoWorkbenchRefusalReasonV0 } from "./workbench.ts";

export const ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0 = "endo.develop-attempt-authorization.v0";

/** A keyed digest of the prompt as the workbench proposal recorded it (protocol/workbench.ts), copied so the two can be compared. */
export interface EndoAttemptMessageRefV0 {
	digest: { algorithm: "hmac-sha256"; keyId: string; value: string };
	bytes: number;
}

/** `<id>.authorized.json`: immutable. Written by the workbench broker, never by a page and never by the workspace host. */
export interface EndoDevelopAttemptAuthorizationV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0;
	attemptId: string;
	/** When the broker wrote this, after the operator's approval and before it recorded the send. */
	recordedAtMs: number;
	/** sha256 of the exact brief text the operator was shown and approved (rendered from the prepared record). */
	briefSha256: string;
	/** The task file's revision when the broker last checked the attempt against it, just before writing this. */
	taskRevision: number;
	harness: "pi";
	/** The canonical session id (`endo.session.pi.<Pi's id>`), from the broker's own attachment, never from a request. */
	session: string;
	attachment: string;
	/** The broker's random id for this launch. */
	launchId: string;
	/** The workbench prompt request this attempt was sent as (protocol/workbench.ts). */
	proposalId: string;
	proposalDigest: string;
	/** The `workbench.prompt-authorized` event (decision allow) the broker recorded for it. */
	authorizationEventId: string;
	message: EndoAttemptMessageRefV0;
	approvedBy: "operator";
	/** Requested and approved on the attached process's controlling terminal. */
	via: "workbench-terminal";
}

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const HEX64 = /^[0-9a-f]{64}$/;
const PROPOSAL_ID = /^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/;

function plain(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
}
const text = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);
const int = (v: unknown, min: number, max: number, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(`${what} is out of range`);

export function validateEndoAttemptMessageRefV0(value: unknown): EndoAttemptMessageRefV0 {
	const r = plain(value, ["digest", "bytes"], "message");
	const d = plain(r.digest, ["algorithm", "keyId", "value"], "message.digest");
	return {
		digest: {
			algorithm: d.algorithm === "hmac-sha256" ? "hmac-sha256" : bad("message.digest.algorithm"),
			keyId: text(d.keyId, /^[\x21-\x7e]{1,128}$/, "message.digest.keyId"),
			value: text(d.value, HEX64, "message.digest.value"),
		},
		bytes: int(r.bytes, 1, 16 * 1024, "message.bytes"),
	};
}

const KEYS = [
	"schemaVersion",
	"attemptId",
	"recordedAtMs",
	"briefSha256",
	"taskRevision",
	"harness",
	"session",
	"attachment",
	"launchId",
	"proposalId",
	"proposalDigest",
	"authorizationEventId",
	"message",
	"approvedBy",
	"via",
] as const;

/** Closed: an unknown member, version or value is refused, never read past. */
export function validateEndoDevelopAttemptAuthorizationV0(value: unknown): EndoDevelopAttemptAuthorizationV0 {
	const r = plain(value, KEYS, "authorization");
	return {
		schemaVersion:
			r.schemaVersion === ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0
				? ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0
				: bad("schemaVersion"),
		attemptId: text(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "recordedAtMs"),
		briefSha256: text(r.briefSha256, HEX64, "briefSha256"),
		taskRevision: int(r.taskRevision, 0, Number.MAX_SAFE_INTEGER, "taskRevision"),
		harness: r.harness === "pi" ? "pi" : bad("harness"),
		session:
			typeof r.session === "string" &&
			r.session.startsWith("endo.session.pi.") &&
			isEndoIdentifierV0(r.session, "session")
				? r.session
				: bad("session"),
		attachment: text(r.attachment, /^[\x21-\x7e]{1,256}$/, "attachment"),
		launchId: text(r.launchId, ENDO_LAUNCH_ID_PATTERN_V0, "launchId"),
		proposalId: text(r.proposalId, PROPOSAL_ID, "proposalId"),
		proposalDigest: text(r.proposalDigest, HEX64, "proposalDigest"),
		authorizationEventId:
			typeof r.authorizationEventId === "string" && isEndoIdentifierV0(r.authorizationEventId, "event")
				? r.authorizationEventId
				: bad("authorizationEventId"),
		message: validateEndoAttemptMessageRefV0(r.message),
		approvedBy: r.approvedBy === "operator" ? "operator" : bad("approvedBy"),
		via: r.via === "workbench-terminal" ? "workbench-terminal" : bad("via"),
	};
}

// ---- what the session log says happened: the read model ----------------------------------------------------------------------------

/**
 * The send, as the session's own prompt-chain records show it. Never inferred from a function returning or a process exiting.
 * - `evidence-unavailable`: the session's event log could not be read (absent, unopenable, or only part of it was readable and what this
 *   needed was not in that part). Nothing is concluded.
 * - `not-attributable`: the log is readable and does not hold the request this record names, or holds one that differs from it (another
 *   session, attachment, digest or message, or an authorisation that is not an allow for it). The record is shown, and nothing after it is
 *   attributed to the attempt.
 * - `not-sent`: the broker recorded a refusal after the approval and recorded no send. It sends only after recording the send, so the brief
 *   was not sent.
 * - `no-send-recorded`: neither a send nor a refusal is in the log. The broker records the send before sending, so as of this read it was not
 *   sent; the broker may still be about to, or it stopped here.
 * - `sent-no-reply`: the send was recorded and Pi's reply was not (a lost connection, a timeout, a crash, or a reply still on its way). Work
 *   may have started. It is never retried automatically.
 * - `runtime-accepted`: Pi accepted the prompt (its disposition). That is Pi's reply, not completion, and not the operator accepting anything.
 * - `refused-by-runtime`: Pi refused it.
 */
export const ENDO_ATTEMPT_SEND_STATES_V0 = [
	"evidence-unavailable",
	"not-attributable",
	"not-sent",
	"no-send-recorded",
	"sent-no-reply",
	"runtime-accepted",
	"refused-by-runtime",
] as const;
export type EndoAttemptSendStateV0 = (typeof ENDO_ATTEMPT_SEND_STATES_V0)[number];

/**
 * The run the session recorded after the send, in the same Pi process. Pi reports no run identifier, so this is the FIRST run that started in
 * that session and process after the send was recorded; the broker sends a prompt only while the session is idle.
 * - `not-observed`: no run started after the send in what was read (none yet, nothing was sent, or nothing can be attributed).
 * - `open`: a run started and no end is recorded (it may still be running, or the record of its end was lost; this does not say which).
 * - `completed` / `failed` / `aborted` / `unclassified`: how Pi reported the run ended. What Pi reported, never a verdict on the work.
 * - `interrupted`: the observation ended with the run open (the Pi process exited, or the observer was lost); there is no reported outcome.
 * - `process-ended`: the Pi process ended (or a new process took the session) before any run started after the send.
 */
export const ENDO_ATTEMPT_RUN_STATES_V0 = [
	"not-observed",
	"open",
	"completed",
	"failed",
	"aborted",
	"unclassified",
	"interrupted",
	"process-ended",
] as const;
export type EndoAttemptRunStateV0 = (typeof ENDO_ATTEMPT_RUN_STATES_V0)[number];

/** How much of the session log the read saw. `partial`: a torn or damaged tail was left unread (an append in progress, or damage). */
export type EndoAttemptEvidenceV0 = "complete" | "partial" | "unavailable";

/** An attempt's execution as every reader shows it (CLI, workbench and workspace pages). No path, key, prompt text or reply. */
export interface EndoDevelopAttemptExecutionViewV0 {
	authorizedAtMs: number;
	/** The session's presented alias (a label, never a handle: nothing can reach the session through it). */
	session: string;
	attachment: string;
	taskRevision: number;
	send: EndoAttemptSendStateV0;
	/** The workbench's recorded refusal reason, for `not-sent` and `refused-by-runtime`; null otherwise. */
	refusal: EndoWorkbenchRefusalReasonV0 | null;
	/** Pi's disposition, for `runtime-accepted` only. */
	disposition: "started" | "queued" | "handled" | null;
	run: EndoAttemptRunStateV0;
	evidence: EndoAttemptEvidenceV0;
	/** Whether the attempt's brief, rendered now from its prepared record, is still the text that was approved (by sha256). */
	brief: "matches" | "differs";
}

/** The fixed words each state is shown with, everywhere. None of them says the work succeeded. */
export const ENDO_ATTEMPT_SEND_LABELS_V0: Readonly<Record<EndoAttemptSendStateV0, string>> = Object.freeze({
	"evidence-unavailable":
		"Authorised to send to Pi; the session's log could not be read, so what happened next is unknown",
	"not-attributable":
		"Authorised to send to Pi, but the session's log does not hold that request as recorded; nothing after it is attributed",
	"not-sent": "Authorised, then not sent (the workbench refused it before sending)",
	"no-send-recorded":
		"Authorised; no send recorded. It is recorded before it is sent, so it had not been sent as of this read",
	"sent-no-reply": "Sent to Pi; Pi's reply was not recorded. Work may have started; the outcome is unknown",
	"runtime-accepted": "Sent to Pi, and Pi acknowledged it. That is a reply, not completion",
	"refused-by-runtime": "Sent to Pi, and Pi refused it",
});

export const ENDO_ATTEMPT_RUN_LABELS_V0: Readonly<Record<EndoAttemptRunStateV0, string>> = Object.freeze({
	"not-observed": "No run observed after the send",
	open: "A run started; no end is recorded (it may still be running, or its end was not recorded)",
	completed: "Pi reported the run completed. Not verified",
	failed: "Pi reported the run failed",
	aborted: "Pi reported the run aborted",
	unclassified: "The run ended with no stop reason Pi reported",
	interrupted: "Interrupted: the Pi process or its observer ended with the run open; no outcome was reported",
	"process-ended": "The Pi process ended before a run was observed",
});

export const isEndoAttemptRefusalReasonV0 = (v: unknown): v is EndoWorkbenchRefusalReasonV0 =>
	(ENDO_WORKBENCH_REFUSAL_REASONS_V0 as readonly unknown[]).includes(v);
