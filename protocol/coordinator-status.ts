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
	"incomplete",
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
	"report-recorded-unverified",
	"earlier-failure-not-current",
	"review-without-passing-check",
	"completed-not-reverified",
	"attention-unavailable",
	"attempt-records-missing",
	"receipt-records-missing",
	"receipt-history-unverifiable",
] as const;
export type EndoCoordinatorGapCodeV0 = (typeof ENDO_COORDINATOR_GAP_CODES_V0)[number];

export const ENDO_COORDINATOR_FINDING_CODES_V0 = [
	"tasks-unavailable",
	"attempts-unavailable",
	"attempt-records-unusable",
	"attempt-records-missing",
	"receipt-records-missing",
	"event-log-unavailable",
	"event-log-incomplete",
	"project-not-permitted-or-unknown",
	"project-head-unavailable",
	"status-contradicts-verification",
	"event-time-in-future",
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
	stateBasis: EndoCoordinatorBasisV0;
	freshness: EndoCoordinatorFreshnessV0;
	firstEventAtMs: number;
	lastEventAtMs: number;
	openRun: null | { turns: number; basis: EndoCoordinatorBasisV0 };
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
	/**
	 * Sessions in the log not listed above, counted only. `unknownRelationship` / `unknownActive`: sessions no record links to any task
	 * (a scoped read does not list them). `outOfScope`: sessions linked only to tasks of projects not asked for; their activity is not
	 * reported, so a scoped read says nothing about another project's sessions beyond that count.
	 */
	unlistedSessions: { unknownRelationship: number; unknownActive: number; outOfScope: number };
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

const ACTIVE_STATES = ["idle", "running"];

/** Shape, and the arithmetic every freshness label rests on: observed no later than the read, and age = read - observed. */
function freshness(v: unknown, what: string, readAtMs: number): Obj {
	const f = obj(v, what);
	const state = oneOf(f.state, ENDO_COORDINATOR_FRESHNESS_V0, `${what}.state`);
	numOrNull(f.observedAtMs, `${what}.observedAtMs`);
	numOrNull(f.ageMs, `${what}.ageMs`);
	if (f.reason !== null) str(f.reason, `${what}.reason`);
	if (f.observedAtMs === null) {
		if (f.ageMs !== null) fail(`${what}.ageMs without observedAtMs`);
		if (state === "fresh") fail(`${what} is fresh without an observation time`);
		return f;
	}
	if ((f.observedAtMs as number) > readAtMs) fail(`${what} was observed after the read`);
	if (f.ageMs !== readAtMs - (f.observedAtMs as number)) fail(`${what}.ageMs is not readAtMs - observedAtMs`);
	if (state !== "fresh" && f.reason === null) fail(`${what} is ${state} without a reason`);
	return f;
}

function link(v: unknown, what: string): Obj {
	const l = obj(v, what);
	str(l.taskId, `${what}.taskId`);
	str(l.sessionId, `${what}.sessionId`);
	oneOf(l.via, ["operator-linked", "send-authorized"] as const, `${what}.via`);
	oneOf(l.basis, ["operator-declared", "controller-observed"] as const, `${what}.basis`);
	oneOf(l.inLog, ["yes", "no", "unknown", "not-applicable"] as const, `${what}.inLog`);
	return l;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/**
 * Check that a value is a coordinator status of this version, with every closed vocabulary closed, AND that its labels follow from
 * what it states: freshness ages are recomputed from the read time, `active` and `fresh` are re-derived from the staleness window and
 * the event log's completeness, verification states are checked against the results and HEAD they rest on, the returned scope is
 * reconciled with the request, and an unavailable or partial source must carry its finding. A consumer (the OpenClaw plugin) calls it
 * on what the CLI printed before relaying anything, and refuses another version rather than guessing at its meaning.
 */
export function validateEndoCoordinatorStatusV0(value: unknown): EndoCoordinatorStatusV0 {
	const s = obj(value, "status");
	if (s.schemaVersion !== ENDO_COORDINATOR_STATUS_SCHEMA_V0)
		fail(`schemaVersion is not ${ENDO_COORDINATOR_STATUS_SCHEMA_V0}`);
	const readAtMs = num(s.readAtMs, "readAtMs");
	const staleAfterMs = num(s.staleAfterMs, "staleAfterMs");
	if (
		staleAfterMs < ENDO_COORDINATOR_LIMITS_V0.minStaleAfterMs ||
		staleAfterMs > ENDO_COORDINATOR_LIMITS_V0.maxStaleAfterMs
	)
		fail("staleAfterMs is out of bounds");
	const authority = obj(s.authority, "authority");
	if (authority.kind !== "read-only-projection" || authority.grants !== "none" || authority.writes !== "none")
		fail("authority is not a read-only projection that grants nothing");

	const findings = arr(s.findings, "findings").map((fv, fi) => {
		const f = obj(fv, `findings[${fi}]`);
		const code = oneOf(f.code, ENDO_COORDINATOR_FINDING_CODES_V0, `findings[${fi}].code`);
		oneOf(f.severity, ENDO_COORDINATOR_SEVERITIES_V0, `findings[${fi}].severity`);
		if (f.subject !== null) str(f.subject, `findings[${fi}].subject`);
		return { code, subject: f.subject as string | null };
	});
	const hasFinding = (code: EndoCoordinatorFindingCodeV0, subject?: string) =>
		findings.some((f) => f.code === code && (subject === undefined || f.subject === subject));

	const sources = obj(s.sources, "sources");
	const sourceState: Record<string, string> = {};
	const sourceFinding: Record<string, Partial<Record<string, EndoCoordinatorFindingCodeV0>>> = {
		tasks: { unavailable: "tasks-unavailable" },
		attempts: {
			unavailable: "attempts-unavailable",
			partial: "attempt-records-unusable",
			missing: "attempt-records-missing",
		},
		events: { unavailable: "event-log-unavailable", partial: "event-log-incomplete" },
	};
	for (const key of ["tasks", "attempts", "events"] as const) {
		const src = obj(sources[key], `sources.${key}`);
		const state = oneOf(src.state, ["ready", "partial", "missing", "unavailable"] as const, `sources.${key}.state`);
		const fr = freshness(src.freshness, `sources.${key}.freshness`, readAtMs);
		const expected = state === "ready" ? "fresh" : state === "partial" ? "incomplete" : "unavailable";
		if (fr.state !== expected) fail(`sources.${key} is ${state} but its freshness is ${String(fr.state)}`);
		const needed = sourceFinding[key]?.[state];
		if (needed !== undefined && !hasFinding(needed)) fail(`sources.${key} is ${state} without its ${needed} finding`);
		sourceState[key] = state;
	}

	const scope = obj(s.scope, "scope");
	const requested =
		scope.requested === null
			? null
			: arr(scope.requested, "scope.requested").map((p, i) => str(p, `scope.requested[${i}]`));
	const scopeProjects = arr(scope.projects, "scope.projects").map((p, i) => str(p, `scope.projects[${i}]`));
	const unknown = arr(scope.unknown, "scope.unknown").map((p, i) => str(p, `scope.unknown[${i}]`));
	const projectValues = arr(s.projects, "projects");
	const projectIds = projectValues.map((pv, pi) => str(obj(pv, `projects[${pi}]`).id, `projects[${pi}].id`));
	if (!sameSet(projectIds, scopeProjects)) fail("projects do not match scope.projects");
	if (requested !== null) {
		if (!projectIds.every((id) => requested.includes(id))) fail("a project outside the requested scope is reported");
		if (!unknown.every((id) => requested.includes(id))) fail("scope.unknown names a project that was not requested");
		if (sourceState.tasks === "ready" && !sameSet([...new Set(requested)], [...projectIds, ...unknown]))
			fail("the requested scope is neither reported nor declared unknown");
	} else if (unknown.length > 0) fail("scope.unknown is set for an unscoped read");
	for (const id of unknown)
		if (!hasFinding("project-not-permitted-or-unknown", id)) fail(`unknown project ${id} has no finding`);
	if (sourceState.tasks !== "ready" && projectIds.length > 0) fail("projects are reported without a usable task file");

	const taskIds = new Set<string>();
	projectValues.forEach((pv, pi) => {
		const p = obj(pv, `projects[${pi}]`);
		freshness(p.freshness, `projects[${pi}].freshness`, readAtMs);
		const head = p.head === null ? null : obj(p.head, `projects[${pi}].head`);
		if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(str(head.commit, `projects[${pi}].head.commit`)))
			fail(`projects[${pi}].head.commit is not a full Git object ID`);
		arr(p.tasks, `projects[${pi}].tasks`).forEach((tv, ti) => {
			const w = `projects[${pi}].tasks[${ti}]`;
			const t = obj(tv, w);
			const taskId = str(t.taskId, `${w}.taskId`);
			taskIds.add(taskId);
			if (t.projectId !== p.id) fail(`${w} belongs to another project`);
			const phase = oneOf(t.phase, ENDO_COORDINATOR_PHASES_V0, `${w}.phase`);
			if (t.statusSource !== "operator-declared") fail(`${w}.statusSource is not operator-declared`);
			const status = str(t.status, `${w}.status`);
			if ((ENDO_COORDINATOR_PHASE_OF_STATUS_V0 as Record<string, string>)[status] !== phase)
				fail(`${w}.phase does not follow the operator's status`);
			const gaps = arr(t.gaps, `${w}.gaps`).map((gv, gi) =>
				oneOf(obj(gv, `${w}.gaps[${gi}]`).code, ENDO_COORDINATOR_GAP_CODES_V0, `${w}.gaps[${gi}].code`),
			);
			const v = obj(t.verification, `${w}.verification`);
			const vState = oneOf(v.state, ENDO_COORDINATOR_VERIFICATION_STATES_V0, `${w}.verification.state`);
			const vFresh = freshness(v.freshness, `${w}.verification.freshness`, readAtMs);
			const results = arr(v.results, `${w}.verification.results`).map((rv, ri) => {
				const r = obj(rv, `${w}.verification.results[${ri}]`);
				const fr = oneOf(r.freshness, ENDO_COORDINATOR_FRESHNESS_V0, `${w}.verification.results[${ri}].freshness`);
				if (r.basis !== "controller-observed") fail(`${w}.verification.results[${ri}].basis`);
				if ((fr === "fresh") !== (r.relation === "at-head"))
					fail(`${w}.verification.results[${ri}] freshness does not follow its relation to HEAD`);
				if (r.relation === "at-head" && (head === null || r.commit !== head.commit))
					fail(`${w}.verification.results[${ri}] is at-head but names a commit other than the observed HEAD`);
				return { fresh: fr === "fresh", outcome: r.outcome };
			});
			if (v.incomplete === true && vFresh.state === "fresh") fail(`${w}.verification is incomplete but fresh`);
			if (status === "done") {
				if (vState !== "not-read") fail(`${w} is completed but its verification is not marked not-read`);
				if (!gaps.includes("completed-not-reverified")) fail(`${w} is completed without completed-not-reverified`);
			}
			const current = results.filter((r) => r.fresh);
			if (vState === "failing" && !current.some((r) => r.outcome === "failed" || r.outcome === "mixed"))
				fail(`${w} is failing without a failed check at the current HEAD`);
			if (vState === "inconclusive" && !current.some((r) => r.outcome === "inconclusive"))
				fail(`${w} is inconclusive without an inconclusive check at the current HEAD`);
			if (
				vState === "incomplete" &&
				(v.incomplete !== true || vFresh.state !== "incomplete" || !gaps.includes("receipt-history-unverifiable"))
			)
				fail(`${w} must qualify unverifiable receipt history as incomplete`);
			if ((vState === "failing" || vState === "inconclusive") && head === null)
				fail(`${w} is ${vState} at a HEAD that was not observed`);
			if (vState === "not-current" && vFresh.state === "fresh") fail(`${w} is not-current but fresh`);
			if (vState === "not-current" && !gaps.includes("checks-not-current"))
				fail(`${w} is not-current without its gap`);
			if (vState === "no-checks" && vFresh.state === "fresh") fail(`${w} reads no-checks as fresh evidence`);
			if (
				(gaps.includes("attempt-records-missing") || gaps.includes("receipt-records-missing")) &&
				(vState !== "unavailable" || vFresh.state !== "unavailable")
			)
				fail(`${w} has missing records but its verification is not unavailable`);
			if (sourceState.attempts === "missing" && status !== "done" && !gaps.includes("attempt-records-missing"))
				fail(`${w} is read without its attempt records but has no attempt-records-missing gap`);
			const links = arr(t.sessions, `${w}.sessions`).map((lv, li) => link(lv, `${w}.sessions[${li}]`));
			if (links.some((l) => l.taskId !== taskId)) fail(`${w}.sessions names another task`);
			const association = oneOf(t.association, ENDO_COORDINATOR_ASSOCIATIONS_V0, `${w}.association`);
			if ((association === "explicit") !== links.length > 0) fail(`${w}.association does not match its links`);
		});
	});

	const sessions = arr(s.sessions, "sessions");
	if (sourceState.events === "unavailable" && sessions.length > 0) fail("sessions are reported without an event log");
	sessions.forEach((sv, si) => {
		const w = `sessions[${si}]`;
		const x = obj(sv, w);
		str(x.sessionId, `${w}.sessionId`);
		const observation = oneOf(x.observation, ["active", "last-observed"] as const, `${w}.observation`);
		const recorded = oneOf(
			x.recordedState,
			["not-observed", "idle", "running", "interrupted", "detached"] as const,
			`${w}.recordedState`,
		);
		oneOf(x.stateBasis, ENDO_COORDINATOR_BASES_V0, `${w}.stateBasis`);
		const last = num(x.lastEventAtMs, `${w}.lastEventAtMs`);
		const fr = freshness(x.freshness, `${w}.freshness`, readAtMs);
		if (observation === "active") {
			if (fr.state !== "fresh") fail(`${w} is active without fresh evidence`);
			if (!ACTIVE_STATES.includes(recorded)) fail(`${w} is active but recorded ${recorded}`);
		}
		if (fr.state === "fresh" || fr.state === "stale") {
			if (fr.observedAtMs !== last) fail(`${w}.freshness is not taken from its newest event`);
			const stale = (fr.ageMs as number) > staleAfterMs;
			if (fr.state === "fresh" && stale) fail(`${w} is fresh but older than the staleness window`);
			if (fr.state === "stale" && !stale) fail(`${w} is stale but within the staleness window`);
		}
		if (fr.state === "fresh" && sourceState.events !== "ready")
			fail(`${w} is fresh from an event log not read whole`);
		arr(x.activity, `${w}.activity`).forEach((av, ai) => {
			oneOf(obj(av, `${w}.activity[${ai}]`).basis, ENDO_COORDINATOR_BASES_V0, `${w}.activity[${ai}].basis`);
		});
		const links = arr(x.links, `${w}.links`).map((lv, li) => link(lv, `${w}.links[${li}]`));
		if (links.some((l) => l.sessionId !== x.sessionId)) fail(`${w}.links names another session`);
		if (links.some((l) => !taskIds.has(l.taskId as string)))
			fail(`${w}.links names a task outside the reported scope`);
		const association = oneOf(x.association, ENDO_COORDINATOR_ASSOCIATIONS_V0, `${w}.association`);
		if ((association === "explicit") !== links.length > 0) fail(`${w}.association does not match its links`);
		if (association === "unknown" && requested !== null)
			fail(`${w}: a scoped read lists a session of unknown relationship`);
	});
	const sessionIds = new Set(sessions.map((sv) => obj(sv, "session").sessionId as string));
	const inScope = (subject: unknown) =>
		subject === null ||
		(typeof subject === "string" &&
			(taskIds.has(subject) ||
				sessionIds.has(subject) ||
				projectIds.includes(subject) ||
				unknown.includes(subject)));
	for (const f of findings)
		if (!inScope(f.subject)) fail(`finding ${f.code} is about something outside the reported scope`);
	arr(s.attention, "attention").forEach((av, ai) => {
		if (!inScope(obj(av, `attention[${ai}]`).subject))
			fail(`attention[${ai}] is about something outside the reported scope`);
	});
	const unlisted = obj(s.unlistedSessions, "unlistedSessions");
	const unknownCount = num(unlisted.unknownRelationship, "unlistedSessions.unknownRelationship");
	const unknownActive = num(unlisted.unknownActive, "unlistedSessions.unknownActive");
	num(unlisted.outOfScope, "unlistedSessions.outOfScope");
	if (unknownActive > unknownCount) fail("more unknown sessions are active than exist");
	arr(s.attention, "attention").forEach((av, ai) => {
		str(obj(av, `attention[${ai}]`).text, `attention[${ai}].text`);
	});
	arr(s.notEstablished, "notEstablished").forEach((n, i) => {
		str(n, `notEstablished[${i}]`);
	});
	return value as EndoCoordinatorStatusV0;
}
