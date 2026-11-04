// The read side of attempt execution (docs/designs/develop-attempt-execution.md): from an attempt's authorisation record and the store's
// event log, what the session's own records say happened to the send and to the run after it. A pure function of what it is given: it reads
// no file, starts nothing, and is shared by every reader (the CLI, the workbench's and the workspace host's attempt views).
//
// Nothing is inferred from text, timestamps or aliases. The record is joined to the log by exact identifiers only, and each join is checked:
//
//   authorization record ── proposalId, proposalDigest, message, session, attachment ──▶ workbench.prompt-proposed   (digest recomputed)
//                        ── authorizationEventId ──▶ workbench.prompt-authorized (allow, for that proposal, derived from it)
//   workbench.prompt-dispatched (derived from that authorization) ─▶ prompt-accepted | prompt-refused
//   the first lifecycle.run-started in the same session and Pi process after the dispatch ─▶ the run's end, as Pi reported it
//
// Storage order (the log's own append order, one writer per store) is the only order used. The broker records the send before it sends, and
// the store syncs every append before returning, so a send that is not in a complete log was not made as of that read.

import { createHash } from "node:crypto";
import {
	type EndoAttemptRunStateV0,
	type EndoAttemptSendStateV0,
	type EndoDevelopAttemptAuthorizationV0,
	type EndoDevelopAttemptExecutionViewV0,
	isEndoAttemptRefusalReasonV0,
} from "../../protocol/develop-attempt-execution.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { EndoWorkbenchRefusalReasonV0 } from "../../protocol/workbench.ts";
import { canonicalEndoJsonV0 } from "./canonical-json.ts";

/** The store's event log as one read saw it. `partial`: the verified prefix of a log whose tail could not be read. */
export type EndoSessionLogReadV0 =
	| { state: "unavailable" }
	| { state: "complete" | "partial"; events: readonly EndoEventV0[] };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const payloadOf = (e: EndoEventV0): Record<string, unknown> =>
	typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload)
		? (e.payload as Record<string, unknown>)
		: {};
const sameJson = (a: unknown, b: unknown): boolean => {
	try {
		return canonicalEndoJsonV0(a as never) === canonicalEndoJsonV0(b as never);
	} catch {
		return false;
	}
};

/** sha256 of a brief's exact text, as the authorisation record holds it. */
export const endoBriefSha256V0 = (brief: string): string => sha256(brief);

/** The workbench proposal's digest, recomputed from its recorded content exactly as the broker computed it (adapters/pi/workbench.ts). */
function proposalDigestOf(p: Record<string, unknown>): string | null {
	try {
		return sha256(
			canonicalEndoJsonV0({
				session: p.session,
				attachment: p.attachment,
				message: p.message,
				origin: p.origin,
				proposedAt: p.proposedAt,
			} as never),
		);
	} catch {
		return null;
	}
}

const RUN_ENDS: Readonly<Record<string, EndoAttemptRunStateV0>> = {
	"lifecycle.run-completed": "completed",
	"lifecycle.run-failed": "failed",
	"lifecycle.run-aborted": "aborted",
	"lifecycle.run-unclassified": "unclassified",
	"lifecycle.interrupted": "interrupted",
};

/** The first run in `session`'s Pi process `instance` after position `from`, and how it ended, as far as the log shows. */
function runAfter(
	events: readonly EndoEventV0[],
	from: number,
	session: string,
	instance: string | null,
): EndoAttemptRunStateV0 {
	let started = false;
	for (let i = from + 1; i < events.length; i++) {
		const e = events[i] as EndoEventV0;
		if (e.coordinates.sessionId !== session || !e.kind.startsWith("lifecycle.")) continue;
		if (!started) {
			if (e.kind === "lifecycle.run-started") {
				// A run of another process (the session resumed elsewhere after this one ended) is not the one the brief was sent to.
				if (instance === null || payloadOf(e).instance !== instance) return "process-ended";
				started = true;
				continue;
			}
			if (
				e.kind === "lifecycle.interrupted" ||
				e.kind === "lifecycle.detached" ||
				e.kind === "lifecycle.session-resumed" ||
				e.kind === "lifecycle.session-started"
			)
				return "process-ended";
			continue;
		}
		const end = RUN_ENDS[e.kind];
		if (end !== undefined) return end;
		// A new process took the session with the run never closed in the log: the lifecycle records that as `interrupted` first, but a
		// resume without it is still not this run's end, so it is reported as interrupted rather than left open.
		if (e.kind === "lifecycle.session-resumed" || e.kind === "lifecycle.session-started") return "interrupted";
	}
	return started ? "open" : "not-observed";
}

/** The Pi process instance the session was attached through at position `at`: the last start or resume of that session before it. */
function instanceAt(events: readonly EndoEventV0[], at: number, session: string): string | null {
	for (let i = at - 1; i >= 0; i--) {
		const e = events[i] as EndoEventV0;
		if (e.coordinates.sessionId !== session) continue;
		if (e.kind === "lifecycle.session-started" || e.kind === "lifecycle.session-resumed") {
			const instance = payloadOf(e).instance;
			return typeof instance === "string" ? instance : null;
		}
	}
	return null;
}

export interface EndoAttemptExecutionFindingV0 {
	send: EndoAttemptSendStateV0;
	refusal: EndoWorkbenchRefusalReasonV0 | null;
	disposition: "started" | "queued" | "handled" | null;
	run: EndoAttemptRunStateV0;
}

/** What the log says about the request an authorisation record names. Exact joins only; see the header. */
export function endoAttemptExecutionFindingV0(
	record: EndoDevelopAttemptAuthorizationV0,
	log: EndoSessionLogReadV0,
): EndoAttemptExecutionFindingV0 {
	const none = (send: EndoAttemptSendStateV0): EndoAttemptExecutionFindingV0 => ({
		send,
		refusal: null,
		disposition: null,
		run: "not-observed",
	});
	if (log.state === "unavailable") return none("evidence-unavailable");
	const events = log.events;
	// What is absent from a partial log may be in the part that could not be read: absence decides nothing then.
	const absent = (): EndoAttemptExecutionFindingV0 =>
		none(log.state === "partial" ? "evidence-unavailable" : "not-attributable");
	const forProposal = (e: EndoEventV0): boolean =>
		e.coordinates.sessionId === record.session && payloadOf(e).proposalId === record.proposalId;

	const proposals = events.filter((e) => e.kind === "workbench.prompt-proposed" && forProposal(e));
	if (proposals.length === 0) return absent();
	if (proposals.length > 1) return none("not-attributable");
	const proposal = proposals[0] as EndoEventV0;
	const p = payloadOf(proposal);
	if (
		p.session !== record.session ||
		p.attachment !== record.attachment ||
		p.origin !== "operator-workbench" ||
		p.proposalDigest !== record.proposalDigest ||
		proposalDigestOf(p) !== record.proposalDigest ||
		!sameJson(p.message, record.message)
	)
		return none("not-attributable");

	const authorization = events.find((e) => e.id === record.authorizationEventId);
	if (authorization === undefined) return absent();
	const a = payloadOf(authorization);
	if (
		authorization.kind !== "workbench.prompt-authorized" ||
		!forProposal(authorization) ||
		a.decision !== "allow" ||
		a.proposalDigest !== record.proposalDigest ||
		!authorization.derivedFrom.includes(proposal.id)
	)
		return none("not-attributable");

	const dispatchAt = events.findIndex(
		(e) => e.kind === "workbench.prompt-dispatched" && forProposal(e) && e.derivedFrom.includes(authorization.id),
	);
	const refused = events.find((e) => e.kind === "workbench.prompt-refused" && forProposal(e));
	const reason = refused === undefined ? null : payloadOf(refused).reason;
	const refusal = isEndoAttemptRefusalReasonV0(reason) ? reason : null;
	if (dispatchAt < 0) {
		if (refused !== undefined) return { ...none("not-sent"), refusal };
		return log.state === "partial" ? none("evidence-unavailable") : none("no-send-recorded");
	}
	const dispatch = events[dispatchAt] as EndoEventV0;
	const run = runAfter(events, dispatchAt, record.session, instanceAt(events, dispatchAt, record.session));
	const accepted = events.find(
		(e) => e.kind === "workbench.prompt-accepted" && forProposal(e) && e.derivedFrom.includes(dispatch.id),
	);
	if (accepted !== undefined) {
		const d = payloadOf(accepted).disposition;
		const disposition = d === "started" || d === "queued" || d === "handled" ? d : null;
		return { send: "runtime-accepted", refusal: null, disposition, run };
	}
	// After the send, the only refusal the broker records is Pi's own.
	if (refused !== undefined && refusal === "runtime-refused")
		return { send: "refused-by-runtime", refusal, disposition: null, run };
	return { send: "sent-no-reply", refusal: null, disposition: null, run };
}

/** The view every reader shows. `aliasOf` presents the session id (a label for the page; the CLI shows the id itself). */
export function endoAttemptExecutionViewV0(
	record: EndoDevelopAttemptAuthorizationV0,
	log: EndoSessionLogReadV0,
	briefNow: string,
	aliasOf: (sessionId: string) => string = (id) => id,
): EndoDevelopAttemptExecutionViewV0 {
	const finding = endoAttemptExecutionFindingV0(record, log);
	return {
		authorizedAtMs: record.recordedAtMs,
		session: aliasOf(record.session),
		attachment: record.attachment,
		taskRevision: record.taskRevision,
		...finding,
		evidence: log.state === "unavailable" ? "unavailable" : log.state,
		brief: sha256(briefNow) === record.briefSha256 ? "matches" : "differs",
	};
}
