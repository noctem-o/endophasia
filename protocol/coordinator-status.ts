// COORDINATOR-STATUS-001 (docs/designs/coordinator-status.md): the first slice of the future Coordinator, a READ-ONLY, evidence-aware
// status projection over records that already exist (the task file, the attempt records, the verification receipts and the event log).
// It is computed at the read and never stored: there is no second source of truth, no status database and no new authority.
//
// Pure protocol types, closed vocabularies, fixed disclaimers and the shape validator only: zero Node imports, zero I/O, zero authority.
//
// Five distinctions are carried in the structure, not only in prose:
// - active vs last-observed sessions (`observation`), never `active` from a stale, incomplete or ended record;
// - agent-reported vs controller-observed activity (`basis` on every activity item and on a session's last run);
// - task phases (in-progress, awaiting-review, completed, open, blocked), always the OPERATOR's status, never inferred from a run ending;
// - verification results vs unresolved evidence gaps (`verification.results` vs `gaps`);
// - explicit session/task associations vs unknown relationships (`association`), never guessed from names or timestamps;
// and every section carries a freshness state: fresh, stale, unavailable or incomplete.

import type { EndoDevelopAttemptStateV0 } from "./develop-attempts.ts";
import type { EndoReceiptOutcomeV0, EndoReceiptRelationV0 } from "./develop-receipts.ts";
import type { EndoDevelopTaskStatusV0 } from "./develop-tasks.ts";
import type { EndoRunOutcomeV0, EndoSessionOverviewV0 } from "./session-overview.ts";

export const ENDO_COORDINATOR_STATUS_SCHEMA_V0 = "endo.coordinator-status.v0";

/** How long a session's newest recorded event may be old and still be read as current. Default 10 minutes. */
export const ENDO_COORDINATOR_DEFAULT_STALE_AFTER_MS_V0 = 10 * 60 * 1000;

export const ENDO_COORDINATOR_LIMITS_V0 = Object.freeze({
	/** Recent activity items listed per session (newest first); older ones are counted. */
	maxActivityPerSession: 8,
	/** Verification results listed per task (worst first); the rest are counted. */
	maxResultsPerTask: 8,
	maxSessions: 50,
	minStaleAfterMs: 1000,
	maxStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
});

export const ENDO_COORDINATOR_FRESHNESS_V0 = ["fresh", "stale", "unavailable", "incomplete"] as const;
export type EndoCoordinatorFreshnessStateV0 = (typeof ENDO_COORDINATOR_FRESHNESS_V0)[number];

/** Freshness of one section: when what it says was observed, how old that is at the read, and why it is not fresh. */
export interface EndoCoordinatorFreshnessV0 {
	state: EndoCoordinatorFreshnessStateV0;
	observedAtMs: number | null;
	ageMs: number | null;
	reason: string | null;
}

/** Who says so. `agent-reported`: the coding agent's runtime said it (not verified). `controller-observed`: Endophasia's own controller saw it. */
export const ENDO_COORDINATOR_BASES_V0 = [
	"agent-reported",
	"controller-observed",
	"operator-declared",
	"unclassified",
] as const;
export type EndoCoordinatorBasisV0 = (typeof ENDO_COORDINATOR_BASES_V0)[number];

export const ENDO_COORDINATOR_PHASES_V0 = ["in-progress", "awaiting-review", "completed", "open", "blocked"] as const;
export type EndoCoordinatorPhaseV0 = (typeof ENDO_COORDINATOR_PHASES_V0)[number];

/** The phase is the operator's status, renamed for a reader. Nothing else moves a task between phases. */
export const ENDO_COORDINATOR_PHASE_OF_STATUS_V0: Readonly<Record<EndoDevelopTaskStatusV0, EndoCoordinatorPhaseV0>> =
	Object.freeze({
		"in-progress": "in-progress",
		review: "awaiting-review",
		done: "completed",
		open: "open",
		blocked: "blocked",
	});

export const ENDO_COORDINATOR_VERIFICATION_STATES_V0 = [
	"passing-at-head",
	"failing",
	"inconclusive",
	"not-current",
	"no-checks",
	"not-read",
	"unavailable",
] as const;
export type EndoCoordinatorVerificationStateV0 = (typeof ENDO_COORDINATOR_VERIFICATION_STATES_V0)[number];

export const ENDO_COORDINATOR_GAP_CODES_V0 = [
	"head-unavailable",
	"no-attempt",
	"no-check-recorded",
	"no-check-at-current-head",
	"checks-not-current",
	"receipts-unreadable",
	"receipts-skipped-at-limit",
	"receipt-files-unusable",
	"attempt-records-unusable",
	"agent-report-unverified",
	"review-without-passing-check",
	"completed-not-reverified",
	"attention-unavailable",
] as const;
export type EndoCoordinatorGapCodeV0 = (typeof ENDO_COORDINATOR_GAP_CODES_V0)[number];

export const ENDO_COORDINATOR_FINDING_CODES_V0 = [
	"tasks-unavailable",
	"attempts-unavailable",
	"attempt-records-unusable",
	"event-log-unavailable",
	"event-log-incomplete",
	"project-not-permitted-or-unknown",
	"project-head-unavailable",
	"status-contradicts-verification",
	"agent-report-contradicts-verification",
	"session-recorded-open-but-stale",
	"session-lifecycle-anomalies",
	"session-link-not-in-log",
	"sessions-truncated",
] as const;
export type EndoCoordinatorFindingCodeV0 = (typeof ENDO_COORDINATOR_FINDING_CODES_V0)[number];

export const ENDO_COORDINATOR_SEVERITIES_V0 = [
	"contradiction",
	"integrity",
	"stale",
	"incomplete",
	"unavailable",
	"info",
] as const;
export type EndoCoordinatorSeverityV0 = (typeof ENDO_COORDINATOR_SEVERITIES_V0)[number];

export interface EndoCoordinatorFindingV0 {
	code: EndoCoordinatorFindingCodeV0;
	severity: EndoCoordinatorSeverityV0;
	/** The task, session or project id the finding is about, or null for the whole read. */
	subject: string | null;
	text: string;
}

export interface EndoCoordinatorGapV0 {
	code: EndoCoordinatorGapCodeV0;
	text: string;
}

/** One check's latest result for a task, as the DEVELOP attention projection reads it. */
export interface EndoCoordinatorResultV0 {
	command: string;
	/** `planned`: read by its attempt's verification plan (behaviour for a behavioural check). `unplanned`: by exit status. */
	reading: "planned" | "unplanned";
	outcome: EndoReceiptOutcomeV0 | "mixed" | "not-run";
	relation: EndoReceiptRelationV0 | null;
	freshness: EndoCoordinatorFreshnessStateV0;
	attemptId: string;
	receiptId: string | null;
	commit: string | null;
	startedAtMs: number | null;
	basis: "controller-observed";
}

export const ENDO_COORDINATOR_ASSOCIATIONS_V0 = ["explicit", "unknown"] as const;
export type EndoCoordinatorAssociationV0 = (typeof ENDO_COORDINATOR_ASSOCIATIONS_V0)[number];

/** An explicit link between a task and a session, exactly as a record states it. Never derived from names, text or timestamps. */
export interface EndoCoordinatorLinkV0 {
	taskId: string;
	sessionId: string;
	/** `operator-linked`: the task file's session reference (the operator's claim). `send-authorized`: an attempt's authorisation record. */
	via: "operator-linked" | "send-authorized";
	basis: "operator-declared" | "controller-observed";
	source: "pi-live" | "omp-saved";
	attemptId: string | null;
	launchId: string | null;
	recordedAtMs: number;
	/** Whether the event log read for this status records that session at all (`unknown` when the log could not be read whole). */
	inLog: "yes" | "no" | "unknown" | "not-applicable";
}

export interface EndoCoordinatorTaskV0 {
	taskId: string;
	projectId: string;
	/** The operator's own words. Private: a consumer that relays status elsewhere should decide whether to disclose it. */
	title: string;
	status: EndoDevelopTaskStatusV0;
	phase: EndoCoordinatorPhaseV0;
	statusSource: "operator-declared";
	updatedAtMs: number;
	revision: number;
	attempts: {
		count: number;
		latest: null | {
			id: string;
			state: EndoDevelopAttemptStateV0;
			/** `reported` is the agent's or operator's statement of a result, never verification. */
			stateBasis: "operator-declared";
			preparedAtMs: number;
			sendAuthorized: boolean;
		};
	};
	verification: {
		state: EndoCoordinatorVerificationStateV0;
		basis: "controller-observed-host-check";
		/** Some receipt or attempt files could not be read or were skipped: a later result may be among them. */
		incomplete: boolean;
		freshness: EndoCoordinatorFreshnessV0;
		results: EndoCoordinatorResultV0[];
		moreResults: number;
	};
	gaps: EndoCoordinatorGapV0[];
	sessions: EndoCoordinatorLinkV0[];
	association: EndoCoordinatorAssociationV0;
}

export interface EndoCoordinatorProjectV0 {
	id: string;
	name: string;
	source: "operator-declared";
	head: { commit: string; clean: boolean } | null;
	freshness: EndoCoordinatorFreshnessV0;
	counts: Record<EndoCoordinatorPhaseV0, number>;
	tasks: EndoCoordinatorTaskV0[];
}

export interface EndoCoordinatorActivityV0 {
	kind: string;
	atMs: number;
	basis: EndoCoordinatorBasisV0;
	eventId: string;
}

export interface EndoCoordinatorSessionV0 {
	sessionId: string;
	runtime: string | null;
	runtimeSessionId: string | null;
	/**
	 * `active`: recorded as attached (idle or running), its newest event is fresh, and the log was read whole. Otherwise `last-observed`:
	 * what the records last said, never promoted to activity. Endophasia has no read-only liveness probe for a session: an attached session
	 * that has said nothing for longer than `staleAfterMs` reads as last-observed.
	 */
	observation: "active" | "last-observed";
	recordedState: EndoSessionOverviewV0["state"];
	stateBasis: "controller-observed";
	freshness: EndoCoordinatorFreshnessV0;
	firstEventAtMs: number;
	lastEventAtMs: number;
	openRun: null | { turns: number; basis: "agent-reported" };
	lastRun: null | { outcome: EndoRunOutcomeV0; turns: number; basis: EndoCoordinatorBasisV0 };
	activity: EndoCoordinatorActivityV0[];
	moreActivity: number;
	counts: {
		events: number;
		agentReported: number;
		controllerObserved: number;
		unclassified: number;
		anomalies: number;
	};
	association: EndoCoordinatorAssociationV0;
	links: EndoCoordinatorLinkV0[];
}

export interface EndoCoordinatorSourceV0 {
	state: "ready" | "partial" | "missing" | "unavailable";
	freshness: EndoCoordinatorFreshnessV0;
	detail: string | null;
}

export interface EndoCoordinatorAttentionV0 {
	kind:
		| "awaiting-your-review"
		| "verification-failing"
		| "verification-inconclusive"
		| "contradiction"
		| "blocked"
		| "evidence-stale"
		| "source-unavailable";
	subject: string | null;
	text: string;
}

/** Fixed statement of what this projection is and is not allowed to do, included in every reading. */
export const ENDO_COORDINATOR_AUTHORITY_V0 = Object.freeze({
	kind: "read-only-projection" as const,
	grants: "none" as const,
	writes: "none" as const,
	decisionAuthority: "operator-only" as const,
	notes: Object.freeze([
		"Reading this status writes nothing, moves no task, sends no prompt, launches no agent and changes no approval.",
		"Task status is the operator's own record; an agent finishing or a run ending never moves a task.",
		"DEVELOP records and the event log are unsigned local files writable by any same-uid process.",
		"Attention items are advisory triage, not acceptance and not an authoritative verification PASS.",
	]),
});

/** What no reading of this status can establish from existing records alone. */
export const ENDO_COORDINATOR_NOT_ESTABLISHED_V0 = Object.freeze([
	"That a session is alive now: there is no read-only liveness probe, so an attached session that has said nothing for longer than the staleness window reads as last-observed.",
	"Which task an unlinked session worked on: relationships are taken only from explicit records, never from names, prompt text or timestamps.",
	"That an agent's reported result is true, or that a passing check satisfies a task's acceptance criteria.",
	"Who or what wrote any changed byte in a working tree.",
	"Verification of completed tasks: their receipts are not re-read by this status.",
	"Protection against a same-uid process editing the records this status reads.",
]);

export interface EndoCoordinatorStatusV0 {
	schemaVersion: typeof ENDO_COORDINATOR_STATUS_SCHEMA_V0;
	readAtMs: number;
	staleAfterMs: number;
	authority: typeof ENDO_COORDINATOR_AUTHORITY_V0;
	scope: {
		/** The project ids the reader was asked for, or null for every project in the task file. */
		requested: string[] | null;
		projects: string[];
		unknown: string[];
	};
	sources: { tasks: EndoCoordinatorSourceV0; attempts: EndoCoordinatorSourceV0; events: EndoCoordinatorSourceV0 };
	projects: EndoCoordinatorProjectV0[];
	/** Sessions explicitly linked to a task in scope, plus (unscoped reads only) sessions with an unknown relationship. */
	sessions: EndoCoordinatorSessionV0[];
	/** Sessions in the log not listed above, counted only: unknown relationship in a scoped read, or linked only to tasks out of scope. */
	unlistedSessions: { unknownRelationship: number; outOfScope: number; active: number };
	attention: EndoCoordinatorAttentionV0[];
	findings: EndoCoordinatorFindingV0[];
	notEstablished: readonly string[];
}

// ---- validation ---------------------------------------------------------------------------------------------------------------------

export class EndoInvalidCoordinatorStatusV0 extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (what: string): never => {
	throw new EndoInvalidCoordinatorStatusV0(`invalid coordinator status: ${what}`);
};
const obj = (v: unknown, what: string): Obj => (isObj(v) ? v : fail(`${what} is not an object`));
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(`${what} is not an array`));
const str = (v: unknown, what: string): string => (typeof v === "string" ? v : fail(`${what} is not a string`));
const num = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isFinite(v) ? v : fail(`${what} is not a number`);
const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v)
		? (v as T)
		: fail(`${what} is not one of ${values.join("|")}`);
const numOrNull = (v: unknown, what: string): void => {
	if (v !== null) num(v, what);
};

function freshness(v: unknown, what: string): void {
	const f = obj(v, what);
	oneOf(f.state, ENDO_COORDINATOR_FRESHNESS_V0, `${what}.state`);
	numOrNull(f.observedAtMs, `${what}.observedAtMs`);
	numOrNull(f.ageMs, `${what}.ageMs`);
	if (f.reason !== null) str(f.reason, `${what}.reason`);
}

function link(v: unknown, what: string): void {
	const l = obj(v, what);
	str(l.taskId, `${what}.taskId`);
	str(l.sessionId, `${what}.sessionId`);
	oneOf(l.via, ["operator-linked", "send-authorized"] as const, `${what}.via`);
	oneOf(l.basis, ["operator-declared", "controller-observed"] as const, `${what}.basis`);
	oneOf(l.inLog, ["yes", "no", "unknown", "not-applicable"] as const, `${what}.inLog`);
}

/**
 * Check that a value is a coordinator status of this version, with every closed vocabulary closed. A consumer (the OpenClaw plugin)
 * calls it on what the CLI printed before relaying anything, and refuses another version rather than guessing at its meaning.
 */
export function validateEndoCoordinatorStatusV0(value: unknown): EndoCoordinatorStatusV0 {
	const s = obj(value, "status");
	if (s.schemaVersion !== ENDO_COORDINATOR_STATUS_SCHEMA_V0)
		fail(`schemaVersion is not ${ENDO_COORDINATOR_STATUS_SCHEMA_V0}`);
	num(s.readAtMs, "readAtMs");
	num(s.staleAfterMs, "staleAfterMs");
	const authority = obj(s.authority, "authority");
	if (authority.kind !== "read-only-projection" || authority.grants !== "none" || authority.writes !== "none")
		fail("authority is not a read-only projection that grants nothing");
	const scope = obj(s.scope, "scope");
	if (scope.requested !== null)
		arr(scope.requested, "scope.requested").forEach((p, i) => {
			str(p, `scope.requested[${i}]`);
		});
	arr(scope.projects, "scope.projects").forEach((p, i) => {
		str(p, `scope.projects[${i}]`);
	});
	arr(scope.unknown, "scope.unknown").forEach((p, i) => {
		str(p, `scope.unknown[${i}]`);
	});
	const sources = obj(s.sources, "sources");
	for (const key of ["tasks", "attempts", "events"] as const) {
		const src = obj(sources[key], `sources.${key}`);
		oneOf(src.state, ["ready", "partial", "missing", "unavailable"] as const, `sources.${key}.state`);
		freshness(src.freshness, `sources.${key}.freshness`);
	}
	arr(s.projects, "projects").forEach((pv, pi) => {
		const p = obj(pv, `projects[${pi}]`);
		str(p.id, `projects[${pi}].id`);
		freshness(p.freshness, `projects[${pi}].freshness`);
		arr(p.tasks, `projects[${pi}].tasks`).forEach((tv, ti) => {
			const w = `projects[${pi}].tasks[${ti}]`;
			const t = obj(tv, w);
			str(t.taskId, `${w}.taskId`);
			const phase = oneOf(t.phase, ENDO_COORDINATOR_PHASES_V0, `${w}.phase`);
			if (t.statusSource !== "operator-declared") fail(`${w}.statusSource is not operator-declared`);
			const status = str(t.status, `${w}.status`);
			if ((ENDO_COORDINATOR_PHASE_OF_STATUS_V0 as Record<string, string>)[status] !== phase)
				fail(`${w}.phase does not follow the operator's status`);
			const v = obj(t.verification, `${w}.verification`);
			oneOf(v.state, ENDO_COORDINATOR_VERIFICATION_STATES_V0, `${w}.verification.state`);
			freshness(v.freshness, `${w}.verification.freshness`);
			arr(v.results, `${w}.verification.results`).forEach((rv, ri) => {
				const r = obj(rv, `${w}.verification.results[${ri}]`);
				oneOf(r.freshness, ENDO_COORDINATOR_FRESHNESS_V0, `${w}.verification.results[${ri}].freshness`);
				if (r.basis !== "controller-observed") fail(`${w}.verification.results[${ri}].basis`);
			});
			arr(t.gaps, `${w}.gaps`).forEach((gv, gi) => {
				oneOf(obj(gv, `${w}.gaps[${gi}]`).code, ENDO_COORDINATOR_GAP_CODES_V0, `${w}.gaps[${gi}].code`);
			});
			const links = arr(t.sessions, `${w}.sessions`);
			links.forEach((lv, li) => {
				link(lv, `${w}.sessions[${li}]`);
			});
			const association = oneOf(t.association, ENDO_COORDINATOR_ASSOCIATIONS_V0, `${w}.association`);
			if ((association === "explicit") !== links.length > 0) fail(`${w}.association does not match its links`);
		});
	});
	arr(s.sessions, "sessions").forEach((sv, si) => {
		const w = `sessions[${si}]`;
		const x = obj(sv, w);
		str(x.sessionId, `${w}.sessionId`);
		const observation = oneOf(x.observation, ["active", "last-observed"] as const, `${w}.observation`);
		oneOf(
			x.recordedState,
			["not-observed", "idle", "running", "interrupted", "detached"] as const,
			`${w}.recordedState`,
		);
		freshness(x.freshness, `${w}.freshness`);
		if (observation === "active" && obj(x.freshness, `${w}.freshness`).state !== "fresh")
			fail(`${w} is active without fresh evidence`);
		arr(x.activity, `${w}.activity`).forEach((av, ai) => {
			oneOf(obj(av, `${w}.activity[${ai}]`).basis, ENDO_COORDINATOR_BASES_V0, `${w}.activity[${ai}].basis`);
		});
		const links = arr(x.links, `${w}.links`);
		links.forEach((lv, li) => {
			link(lv, `${w}.links[${li}]`);
		});
		const association = oneOf(x.association, ENDO_COORDINATOR_ASSOCIATIONS_V0, `${w}.association`);
		if ((association === "explicit") !== links.length > 0) fail(`${w}.association does not match its links`);
	});
	const unlisted = obj(s.unlistedSessions, "unlistedSessions");
	num(unlisted.unknownRelationship, "unlistedSessions.unknownRelationship");
	num(unlisted.outOfScope, "unlistedSessions.outOfScope");
	num(unlisted.active, "unlistedSessions.active");
	arr(s.attention, "attention").forEach((av, ai) => {
		str(obj(av, `attention[${ai}]`).text, `attention[${ai}].text`);
	});
	arr(s.findings, "findings").forEach((fv, fi) => {
		const f = obj(fv, `findings[${fi}]`);
		oneOf(f.code, ENDO_COORDINATOR_FINDING_CODES_V0, `findings[${fi}].code`);
		oneOf(f.severity, ENDO_COORDINATOR_SEVERITIES_V0, `findings[${fi}].severity`);
	});
	arr(s.notEstablished, "notEstablished").forEach((n, i) => {
		str(n, `notEstablished[${i}]`);
	});
	return value as EndoCoordinatorStatusV0;
}
