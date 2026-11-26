// Project-scoped, write-once structured advisory review records (`endo.develop-advisory-review.v0`).
//
// Stored at `<root>/develop/coordination-reviews/<projectId>/<reviewId>.json` via `storage/write-once.ts`.
//
// Epistemic invariants (docs/designs/coordinator-assignment.md §8.2, E2-D):
// - Strictly `standing: "advisory-agent-review"` and `basis: "agent-reported"`.
// - NEVER promoted to a controller-observed host verification receipt (`develop/receipts/`) or operator acceptance,
//   even when an agent claims tests passed (`agentClaimedChecks`).
// - Bound to exact immutable candidate identity (`(candidateTaskId, candidateId)` + commit/tree or protected digests)
//   so reviews of superseded candidates remain attributable to their original candidate forever.
// - Protocol imports only protocol.

import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import {
	ENDO_ASSIGNMENT_ID_PATTERN_V0,
	ENDO_CANDIDATE_ID_PATTERN_V0,
	ENDO_GIT_OID_PATTERN_V0,
	ENDO_HARNESS_FAMILIES_V0,
	ENDO_PARTICIPANT_ID_PATTERN_V0,
	type EndoIntendedHarnessFamilyV0,
	isEndoCanonicalPathV0,
	isEndoPathHintV0,
} from "./develop-coordination.ts";
import { checkEndoDevelopTextV0, ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0 = "endo.develop-advisory-review.v0";
export const ENDO_REVIEW_ID_PATTERN_V0 = /^endo\.review\.[0-9a-f]{32}$/;

export const ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0 = Object.freeze({
	maxRecordBytes: 64 * 1024,
	maxFindings: 64,
	maxReviewsPerProject: 256,
	maxCategory: 64,
	maxToken: 256,
});

export const ENDO_ADVISORY_REVIEW_VERDICTS_V0 = [
	"approve-advisory",
	"changes-requested",
	"comment",
	"blocked",
] as const;
export type EndoAdvisoryReviewVerdictV0 = (typeof ENDO_ADVISORY_REVIEW_VERDICTS_V0)[number];

export const ENDO_ADVISORY_FINDING_SEVERITIES_V0 = ["critical", "high", "medium", "low", "info"] as const;
export type EndoAdvisoryFindingSeverityV0 = (typeof ENDO_ADVISORY_FINDING_SEVERITIES_V0)[number];

export interface EndoAdvisoryReviewFindingV0 {
	severity: EndoAdvisoryFindingSeverityV0;
	category: string;
	summary: string;
	location: string | null;
}

export interface EndoAdvisoryReviewCheckoutV0 {
	standing: "controller-observed" | "unobserved";
	worktreePath: string | null;
	preObservationId: string | null;
	postObservationId: string | null;
	cleanAtCandidate: boolean;
	reason: string | null;
}

export type EndoAdvisoryReviewSubjectV0 =
	| {
			kind: "git-commit";
			commonDir: string;
			commitSha: string;
			treeSha: string;
	  }
	| {
			kind: "protected-candidate";
			attemptId: string;
			runId: string;
			bindingSha256: string;
			candidateSha256: string;
	  };

export interface EndoDevelopAdvisoryReviewV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0;
	reviewId: string;
	projectId: string;
	/** Owning task of the reviewed candidate (same project). */
	candidateTaskId: string;
	candidateId: string;
	subject: EndoAdvisoryReviewSubjectV0;
	assignmentId: string | null;
	attemptId: string | null;
	reviewer: {
		participantId: string;
		harnessFamily: EndoIntendedHarnessFamilyV0 | null;
		sessionKey: string | null;
		runtimeFingerprintId: string | null;
	};
	/** Fixed: never host verification, never protected run, never operator acceptance. */
	standing: "advisory-agent-review";
	basis: "agent-reported";
	verdict: EndoAdvisoryReviewVerdictV0;
	summary: string;
	findings: EndoAdvisoryReviewFindingV0[];
	/** Explicitly isolated unverified agent claim about checks/tests; never promoted to a host receipt. */
	agentClaimedChecks: string | null;
	checkout: EndoAdvisoryReviewCheckoutV0;
	recordedBy: "operator" | "controller";
	recordedAtMs: number;
}

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;
const CATEGORY = /^[a-z][a-z0-9_-]{0,63}$/;
const OBS_ID = /^endo\.obs\.[0-9a-f]{32}$/;

function closed(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(value, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const k of keys) if (!Object.hasOwn(value, k)) return bad(`${what} lacks ${k}`);
	return value as Record<string, unknown>;
}

const match = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);

const nullableMatch = (v: unknown, pattern: RegExp, what: string): string | null =>
	v === null ? null : match(v, pattern, what);

const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not allowed`);

const stamp = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is not a time`);

const nonEmptyNote = (v: unknown, what: string): string => {
	const checked = checkEndoDevelopTextV0("note", v);
	if (!checked.ok || checked.text !== v || checked.text === "") return bad(`${what} is not acceptable text`);
	return checked.text;
};

const nullableText = (v: unknown, rule: "note" | "text", what: string): string | null => {
	if (v === null) return null;
	const checked = checkEndoDevelopTextV0(rule, v);
	if (!checked.ok || checked.text !== v || checked.text === "") return bad(`${what} is not acceptable text`);
	return checked.text;
};

export function validateEndoDevelopAdvisoryReviewV0(value: unknown): EndoDevelopAdvisoryReviewV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"reviewId",
			"projectId",
			"candidateTaskId",
			"candidateId",
			"subject",
			"assignmentId",
			"attemptId",
			"reviewer",
			"standing",
			"basis",
			"verdict",
			"summary",
			"findings",
			"agentClaimedChecks",
			"checkout",
			"recordedBy",
			"recordedAtMs",
		],
		"advisory review",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0) bad("schemaVersion");
	if (r.standing !== "advisory-agent-review") bad("standing must be advisory-agent-review");
	if (r.basis !== "agent-reported") bad("basis must be agent-reported");
	const recordedBy = oneOf(r.recordedBy, ["operator", "controller"] as const, "recordedBy");

	const subjectRaw = r.subject;
	if (typeof subjectRaw !== "object" || subjectRaw === null) bad("subject is not an object");
	const kind = (subjectRaw as { kind?: unknown }).kind;
	let subject: EndoAdvisoryReviewSubjectV0;
	if (kind === "git-commit") {
		const s = closed(subjectRaw, ["kind", "commonDir", "commitSha", "treeSha"], "git-commit subject");
		if (!isEndoCanonicalPathV0(s.commonDir)) return bad("subject.commonDir");
		const commitSha = match(s.commitSha, ENDO_GIT_OID_PATTERN_V0, "subject.commitSha");
		const treeSha = match(s.treeSha, ENDO_GIT_OID_PATTERN_V0, "subject.treeSha");
		if (commitSha.length !== treeSha.length) return bad("subject mixes git oid lengths");
		subject = { kind: "git-commit", commonDir: s.commonDir, commitSha, treeSha };
	} else if (kind === "protected-candidate") {
		const s = closed(
			subjectRaw,
			["kind", "attemptId", "runId", "bindingSha256", "candidateSha256"],
			"protected-candidate subject",
		);
		subject = {
			kind: "protected-candidate",
			attemptId: match(s.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "subject.attemptId"),
			runId: match(s.runId, /^[\x21-\x7e]{1,128}$/, "subject.runId"),
			bindingSha256: match(s.bindingSha256, HEX64, "subject.bindingSha256"),
			candidateSha256: match(s.candidateSha256, HEX64, "subject.candidateSha256"),
		};
	} else {
		return bad("subject.kind is unknown");
	}

	const rev = closed(r.reviewer, ["participantId", "harnessFamily", "sessionKey", "runtimeFingerprintId"], "reviewer");
	const reviewer = {
		participantId: match(rev.participantId, ENDO_PARTICIPANT_ID_PATTERN_V0, "reviewer.participantId"),
		harnessFamily:
			rev.harnessFamily === null
				? null
				: oneOf(rev.harnessFamily, ENDO_HARNESS_FAMILIES_V0, "reviewer.harnessFamily"),
		sessionKey: nullableMatch(rev.sessionKey, SAFE_TOKEN, "reviewer.sessionKey"),
		runtimeFingerprintId: nullableMatch(
			rev.runtimeFingerprintId,
			/^[\x21-\x7e]{1,128}$/,
			"reviewer.runtimeFingerprintId",
		),
	};

	const summaryChecked = checkEndoDevelopTextV0("text", r.summary);
	if (!summaryChecked.ok || summaryChecked.text !== r.summary || summaryChecked.text === "")
		return bad("summary is not acceptable text");

	if (!Array.isArray(r.findings) || r.findings.length > ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0.maxFindings)
		return bad("findings must be a bounded list");
	const findings: EndoAdvisoryReviewFindingV0[] = r.findings.map((item: unknown) => {
		const f = closed(item, ["severity", "category", "summary", "location"], "finding");
		if (f.location !== null && !isEndoPathHintV0(f.location)) return bad("finding.location");
		return {
			severity: oneOf(f.severity, ENDO_ADVISORY_FINDING_SEVERITIES_V0, "finding.severity"),
			category: match(f.category, CATEGORY, "finding.category"),
			summary: nonEmptyNote(f.summary, "finding.summary"),
			location: f.location as string | null,
		};
	});

	const ck = closed(
		r.checkout,
		["standing", "worktreePath", "preObservationId", "postObservationId", "cleanAtCandidate", "reason"],
		"checkout",
	);
	const checkoutStanding = oneOf(ck.standing, ["controller-observed", "unobserved"] as const, "checkout.standing");
	if (ck.worktreePath !== null && !isEndoCanonicalPathV0(ck.worktreePath)) return bad("checkout.worktreePath");
	if (typeof ck.cleanAtCandidate !== "boolean") return bad("checkout.cleanAtCandidate");
	// An unobserved checkout can never claim cleanAtCandidate: true.
	if (checkoutStanding === "unobserved" && ck.cleanAtCandidate)
		return bad("unobserved checkout cannot claim cleanAtCandidate");
	const checkout: EndoAdvisoryReviewCheckoutV0 = {
		standing: checkoutStanding,
		worktreePath: ck.worktreePath as string | null,
		preObservationId: nullableMatch(ck.preObservationId, OBS_ID, "checkout.preObservationId"),
		postObservationId: nullableMatch(ck.postObservationId, OBS_ID, "checkout.postObservationId"),
		cleanAtCandidate: ck.cleanAtCandidate,
		reason: nullableText(ck.reason, "note", "checkout.reason"),
	};

	return {
		schemaVersion: ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0,
		reviewId: match(r.reviewId, ENDO_REVIEW_ID_PATTERN_V0, "reviewId"),
		projectId: match(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		candidateTaskId: match(r.candidateTaskId, ENDO_TASK_ID_PATTERN_V0, "candidateTaskId"),
		candidateId: match(r.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "candidateId"),
		subject,
		assignmentId: nullableMatch(r.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "assignmentId"),
		attemptId: nullableMatch(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		reviewer,
		standing: "advisory-agent-review",
		basis: "agent-reported",
		verdict: oneOf(r.verdict, ENDO_ADVISORY_REVIEW_VERDICTS_V0, "verdict"),
		summary: summaryChecked.text,
		findings,
		agentClaimedChecks: nullableText(r.agentClaimedChecks, "note", "agentClaimedChecks"),
		checkout,
		recordedBy,
		recordedAtMs: stamp(r.recordedAtMs, "recordedAtMs"),
	};
}
