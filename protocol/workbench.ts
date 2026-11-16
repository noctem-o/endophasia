// The workbench prompt chain (`endo.workbench.v0`): a NEW USER PROMPT sent through the DEVELOP workbench broker, as its own
// authorised, verified sequence. A prompt starts agent work; it is not an intervention (steering.md): STEER, QUEUE and STOP change a
// run that is already open, a prompt opens one. The two chains are therefore kept apart, in their own kinds.
//
//   proposed → authorized → dispatched → accepted            (or refused at any step)
//
// | Record (event kind)          | Source class       | What it is                                                              |
// | :--------------------------- | :----------------- | :---------------------------------------------------------------------- |
// | workbench.prompt-proposed    | policy-conclusion  | a prompt, by keyed digest, for one session and attachment                |
// | workbench.prompt-authorized  | authority-decision | allow or deny, bound to the proposal's id and digest                      |
// | workbench.prompt-dispatched  | runtime-fact       | Endophasia is sending the prompt to the runtime                           |
// | workbench.prompt-accepted    | runtime-fact       | the runtime's reply (Pi: a disposition). Acceptance, never completion     |
// | workbench.prompt-refused     | runtime-fact       | the broker's gate refused it, with a closed reason                        |
//
// The prompt text is NEVER in a record: only its keyed digest and byte length. Authorisation is recorded as what it was
// (`confirmation`): `terminal`, the local operator typing the phrase that carries the proposal's digest on the controlling terminal of the
// attached process; `terminal-code`, the operator typing there the short code the terminal showed for that one question (opt-in,
// `--confirm short`); or `session-grant`, a bounded session-control grant (runtime/contracts/session-control.ts) that the operator
// authorised once on the terminal and that the record names (`sessionGrant`). A send nobody typed for is never recorded as `terminal`.
// The browser can request; it can never authorise. None of these is proof of identity. Completion is not recorded here: it is what the
// session's own lifecycle events show afterwards.
//
// The grant itself has two records, in the same store (DEVELOP-UX-002 §4.4):
//
// | workbench.session-control-granted | authority-decision | a grant: its scope, expiry, budget, and the execution boundary observed  |
// | workbench.session-control-ended   | policy-conclusion  | that grant ended, with a closed reason and the number of sends it covered |
//
// The workspace root is recorded as a keyed digest, never as a path. No token, pairing code or credential is ever in a record.

import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

const SESSION_GRANT_ID = /^endo\.evidence\.workbench-session-grant-[0-9a-f]{32}$/;
/** How a prompt's authorisation was confirmed. */
export const ENDO_WORKBENCH_CONFIRMATIONS_V0 = ["terminal", "terminal-code", "session-grant"] as const;
export type EndoWorkbenchConfirmationV0 = (typeof ENDO_WORKBENCH_CONFIRMATIONS_V0)[number];
/** Why a session-control grant ended (runtime/contracts/session-control.ts holds the same list; a test keeps them equal). */
export const ENDO_WORKBENCH_GRANT_END_REASONS_V0 = [
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

export const ENDO_WORKBENCH_SCHEMA_V0 = "endo.workbench.v0";

/**
 * The workbench terminal's own command, when a message's whole text is one: `pair`, or `attempt` alone or with an attempt id. A message
 * like that typed into the page's composer reaches the agent as chat, not as the command: it sends no attempt's brief and records no
 * authorisation (REVIEW-PILOT-001, run 1). The page refuses to ask for it, and the terminal warns when asked to approve one anyway. Plain
 * English such as "attempt it" is not a command: only an argument that starts like an attempt id is.
 */
export function endoWorkbenchTerminalCommandInV0(
	text: string,
): { command: "attempt" | "pair"; argument: string | null } | null {
	const words = text.trim().split(/\s+/);
	if (words.length === 1 && words[0] === "pair") return { command: "pair", argument: null };
	if (words[0] !== "attempt") return null;
	if (words.length === 1) return { command: "attempt", argument: null };
	return words.length === 2 && /^endo\.attempt\./.test(words[1] as string)
		? { command: "attempt", argument: words[1] as string }
		: null;
}

export const ENDO_WORKBENCH_KINDS_V0 = {
	"workbench.prompt-proposed": "policy-conclusion",
	"workbench.prompt-authorized": "authority-decision",
	"workbench.prompt-dispatched": "runtime-fact",
	"workbench.prompt-accepted": "runtime-fact",
	"workbench.prompt-refused": "runtime-fact",
	"workbench.session-control-granted": "authority-decision",
	"workbench.session-control-ended": "policy-conclusion",
} as const;
export type EndoWorkbenchKindV0 = keyof typeof ENDO_WORKBENCH_KINDS_V0;

export const ENDO_WORKBENCH_REFUSAL_REASONS_V0 = [
	"not-authorized",
	"authorization-denied",
	"approval-timed-out",
	"authorization-expired",
	"session-ended",
	"run-active",
	"capability-unavailable",
	"duplicate",
	"runtime-refused",
	// A prompt that carries a DEVELOP work attempt's brief (docs/designs/develop-attempt-execution.md), refused before it was sent:
	// the attempt, its task or its project no longer allowed it when the approval came back, or its authorisation record could not be
	// written. (`duplicate` is used when the attempt had already been authorised.) Readers never validate these payloads; a build that
	// predates them shows an unknown reason as it would any other.
	"attempt-changed",
	"attempt-not-recorded",
] as const;
export type EndoWorkbenchRefusalReasonV0 = (typeof ENDO_WORKBENCH_REFUSAL_REASONS_V0)[number];

export const ENDO_WORKBENCH_DISPOSITIONS_V0 = ["started", "queued", "handled"] as const;

/** The longest prompt the workbench accepts, in UTF-8 bytes. */
export const ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 = 16 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

export function isEndoWorkbenchProposalIdV0(value: unknown): value is string {
	return (
		typeof value === "string" &&
		isEndoIdentifierV0(value, "evidence") &&
		/^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/.test(value)
	);
}

function digestRef(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return false;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).sort().join() !== "bytes,digest") return false;
	const d = v.digest as Record<string, unknown> | null;
	return (
		typeof v.bytes === "number" &&
		Number.isSafeInteger(v.bytes) &&
		v.bytes >= 1 &&
		v.bytes <= ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 &&
		typeof d === "object" &&
		d !== null &&
		d.algorithm === "hmac-sha256" &&
		typeof d.keyId === "string" &&
		typeof d.value === "string" &&
		HEX64.test(d.value)
	);
}

/** Validate a record's payload by its kind. Null when valid, or the problem. */
export function endoWorkbenchPayloadProblemV0(kind: string, payload: JsonValueV0): string | null {
	if (!(kind in ENDO_WORKBENCH_KINDS_V0)) return `unknown workbench kind ${kind}`;
	if (typeof payload !== "object" || payload === null || !isPlainJsonObjectV0(payload)) return "not an object";
	const p = payload as Record<string, unknown>;
	if (p.schemaVersion !== ENDO_WORKBENCH_SCHEMA_V0) return "wrong schemaVersion";
	if (kind === "workbench.session-control-granted" || kind === "workbench.session-control-ended")
		return sessionControlProblem(kind, p);
	if (!isEndoWorkbenchProposalIdV0(p.proposalId)) return "proposalId must be endo.evidence.workbench-prompt-<32 hex>";
	const keys = (...names: string[]) =>
		Object.keys(p).sort().join() === ["proposalId", "schemaVersion", ...names].sort().join();
	switch (kind as EndoWorkbenchKindV0) {
		case "workbench.prompt-proposed":
			if (!keys("session", "attachment", "message", "proposalDigest", "origin", "proposedAt"))
				return "unexpected members";
			if (typeof p.session !== "string" || !isEndoIdentifierV0(p.session, "session"))
				return "session must be an endo session";
			if (typeof p.attachment !== "string" || p.attachment.length < 1 || p.attachment.length > 256)
				return "attachment is required";
			if (!digestRef(p.message)) return "message must be a keyed digest and a byte length";
			if (typeof p.proposalDigest !== "string" || !HEX64.test(p.proposalDigest))
				return "proposalDigest must be sha256 hex";
			if (p.origin !== "operator-workbench") return "origin must be operator-workbench";
			return typeof p.proposedAt === "string" && !Number.isNaN(Date.parse(p.proposedAt))
				? null
				: "proposedAt must be a date";
		case "workbench.prompt-authorized":
			if (!(ENDO_WORKBENCH_CONFIRMATIONS_V0 as readonly unknown[]).includes(p.confirmation))
				return "confirmation must be terminal, terminal-code or session-grant";
			// A grant-authorised send names its grant and is always an allow (a grant never denies: a request it does not cover goes to the
			// terminal); a terminal confirmation names none.
			if (p.confirmation === "session-grant") {
				if (!keys("decision", "confirmation", "proposalDigest", "decidedAt", "sessionGrant"))
					return "unexpected members";
				if (typeof p.sessionGrant !== "string" || !SESSION_GRANT_ID.test(p.sessionGrant))
					return "sessionGrant must name a session-control grant";
				if (p.decision !== "allow") return "a session grant only allows";
			} else if (!keys("decision", "confirmation", "proposalDigest", "decidedAt")) return "unexpected members";
			if (p.decision !== "allow" && p.decision !== "deny") return "decision must be allow or deny";
			if (typeof p.proposalDigest !== "string" || !HEX64.test(p.proposalDigest)) return "proposalDigest is required";
			return typeof p.decidedAt === "string" && !Number.isNaN(Date.parse(p.decidedAt))
				? null
				: "decidedAt must be a date";
		case "workbench.prompt-dispatched":
			return keys() ? null : "unexpected members";
		case "workbench.prompt-accepted":
			if (!keys("disposition")) return "unexpected members";
			return (ENDO_WORKBENCH_DISPOSITIONS_V0 as readonly unknown[]).includes(p.disposition)
				? null
				: "unknown disposition";
		case "workbench.prompt-refused":
			if (!keys("reason")) return "unexpected members";
			return (ENDO_WORKBENCH_REFUSAL_REASONS_V0 as readonly unknown[]).includes(p.reason)
				? null
				: "unknown refusal reason";
		default:
			return `unknown workbench kind ${kind}`;
	}
}

const isDate = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value));
const OPERATIONS = ["prompt", "steer", "queue", "stop"];

/** The two records of a session-control grant. Closed: no member can carry a path, a token or free text. */
function sessionControlProblem(kind: string, p: Record<string, unknown>): string | null {
	const keys = (...names: string[]) =>
		Object.keys(p).sort().join() === ["grantId", "schemaVersion", ...names].sort().join();
	if (typeof p.grantId !== "string" || !SESSION_GRANT_ID.test(p.grantId))
		return "grantId must be endo.evidence.workbench-session-grant-<32 hex>";
	if (kind === "workbench.session-control-ended") {
		if (!keys("reason", "endedAt", "sends")) return "unexpected members";
		if (!(ENDO_WORKBENCH_GRANT_END_REASONS_V0 as readonly unknown[]).includes(p.reason)) return "unknown end reason";
		if (typeof p.sends !== "number" || !Number.isSafeInteger(p.sends) || p.sends < 0) return "sends must be a count";
		return isDate(p.endedAt) ? null : "endedAt must be a date";
	}
	if (
		!keys(
			"session",
			"attachment",
			"launchId",
			"mode",
			"operations",
			"workspace",
			"protection",
			"confirmation",
			"issuedAt",
			"expiresAt",
			"maxSends",
		)
	)
		return "unexpected members";
	if (typeof p.session !== "string" || !isEndoIdentifierV0(p.session, "session"))
		return "session must be an endo session";
	if (typeof p.attachment !== "string" || p.attachment.length < 1 || p.attachment.length > 256)
		return "attachment is required";
	if (typeof p.launchId !== "string" || !/^[0-9a-f]{16}$/.test(p.launchId)) return "launchId must be 16 hex";
	if (p.mode !== "everyday" && p.mode !== "protected") return "mode must be everyday or protected";
	if (
		!Array.isArray(p.operations) ||
		p.operations.length < 1 ||
		p.operations.length > OPERATIONS.length ||
		new Set(p.operations).size !== p.operations.length ||
		!p.operations.every((op) => OPERATIONS.includes(op as string))
	)
		return "operations must be distinct members of prompt, steer, queue, stop";
	const w = p.workspace as Record<string, unknown> | null;
	if (
		typeof w !== "object" ||
		w === null ||
		!isPlainJsonObjectV0(w as JsonValueV0) ||
		Object.keys(w).sort().join() !== "algorithm,keyId,value" ||
		w.algorithm !== "hmac-sha256" ||
		typeof w.keyId !== "string" ||
		typeof w.value !== "string" ||
		!HEX64.test(w.value)
	)
		return "workspace must be a keyed digest";
	const g = p.protection as Record<string, unknown> | null;
	if (
		typeof g !== "object" ||
		g === null ||
		!isPlainJsonObjectV0(g as JsonValueV0) ||
		Object.keys(g).sort().join() !== "level,mechanism" ||
		(g.level !== "workspace" && g.level !== "restricted") ||
		typeof g.mechanism !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(g.mechanism)
	)
		return "protection must name an enforced level and its mechanism";
	if (p.confirmation !== "terminal-pairing-code") return "confirmation must be terminal-pairing-code";
	if (typeof p.maxSends !== "number" || !Number.isSafeInteger(p.maxSends) || p.maxSends < 1)
		return "maxSends must be a positive count";
	if (!isDate(p.issuedAt) || !isDate(p.expiresAt)) return "issuedAt and expiresAt must be dates";
	return Date.parse(p.expiresAt as string) > Date.parse(p.issuedAt as string) &&
		Date.parse(p.expiresAt as string) - Date.parse(p.issuedAt as string) <= 60 * 60_000
		? null
		: "a grant lives at most one hour";
}
