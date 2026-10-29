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
// The prompt text is NEVER in a record: only its keyed digest and byte length. Authorisation in v0 is the local operator typing the
// exact proposal digest on the controlling terminal of the attached process; the browser can request, never authorise. That
// confirmation is a local operator's decision, not proof of identity. Completion is not recorded here: it is what the session's own
// lifecycle events show afterwards.

import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

export const ENDO_WORKBENCH_SCHEMA_V0 = "endo.workbench.v0";

export const ENDO_WORKBENCH_KINDS_V0 = {
	"workbench.prompt-proposed": "policy-conclusion",
	"workbench.prompt-authorized": "authority-decision",
	"workbench.prompt-dispatched": "runtime-fact",
	"workbench.prompt-accepted": "runtime-fact",
	"workbench.prompt-refused": "runtime-fact",
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
			if (!keys("decision", "confirmation", "proposalDigest", "decidedAt")) return "unexpected members";
			if (p.decision !== "allow" && p.decision !== "deny") return "decision must be allow or deny";
			if (p.confirmation !== "terminal") return "confirmation must be terminal";
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
	}
}
