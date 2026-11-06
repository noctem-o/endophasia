// The eligibility rules: pure functions from collected facts to examples. Each rule adds a closed reason to the objectives it removes the
// example from; an objective is eligible exactly when it has no reason. The rules never upgrade evidence: an operator's declaration stays a
// declaration, a digest stays a digest, a study's exclusion stays an exclusion, and an absent outcome is never a failure.

import type { EndoExperimentRunRecordV0 } from "../../protocol/experiment-artifacts.ts";
import type { Caveat, Example, Objective, Reason, Verdict } from "./contract.ts";
import { OBJECTIVES } from "./contract.ts";
import { type AttemptFacts, decisionOfAttempt } from "./develop-source.ts";
import { decisionOfTrial, type TrialFacts } from "./experiment-source.ts";
import type { RunValidity } from "./validity.ts";

type Reasons = Record<Objective, Set<Reason>>;
const none = (): Reasons => ({
	descriptive: new Set(),
	symptom: new Set(),
	lesson: new Set(),
	"causal-policy": new Set(),
});
const add = (r: Reasons, reason: Reason, ...objectives: Objective[]) => {
	for (const o of objectives) r[o].add(reason);
};
const verdicts = (r: Reasons): Record<Objective, Verdict> =>
	Object.fromEntries(OBJECTIVES.map((o) => [o, { eligible: r[o].size === 0, reasons: [...r[o]].sort() }])) as Record<
		Objective,
		Verdict
	>;

export interface TrialContext {
	sourceId: string;
	study: string | null;
	stage: string | null;
	/** Relative to the source's root, never absolute. */
	location: string;
	record: EndoExperimentRunRecordV0;
	/** The study's validity reading for this run; null when the corpus cites none. */
	validity: RunValidity | null;
	/** A document declares this run invalid. */
	runInvalid: boolean;
	/** Tasks a later analysis examined (declared). */
	examinedTasks: ReadonlySet<string>;
	conditions: number;
}

/** One experiment trial (or interrupted execution) as an example. */
export function experimentExample(ctx: TrialContext, t: TrialFacts): Example {
	const r = none();
	const caveats = new Set<Caveat>();
	const { entry, result } = t;
	const learning: Objective[] = ["symptom", "lesson", "causal-policy"];
	let outcome: Example["outcome"];
	if (t.kind === "interrupted") {
		add(r, "interrupted-execution", ...learning);
		outcome = { kind: "none", why: "missing" };
	} else if (result === null || result.status === "error") {
		add(r, "outcome-missing", ...learning);
		outcome = { kind: "none", why: "missing" };
	} else if (!result.check.ran) {
		add(r, "no-check", ...learning);
		outcome = { kind: "none", why: "no-check" };
	} else {
		outcome = {
			kind: "check",
			passed: result.check.passed,
			timedOut: result.check.timedOut,
			scope: "the task's declared success check (argv), exit code 0, run by the runner in the final workspace",
		};
		if (t.checkOutput === "absent") add(r, "check-output-absent", "symptom", "lesson");
		if (t.checkOutput === "mismatch") add(r, "check-output-mismatch", "symptom", "lesson");
		if (t.checkOutput === "unverifiable") add(r, "check-output-unverifiable", "symptom", "lesson");
	}
	if (!t.capture) add(r, "content-unavailable", "lesson");
	if (ctx.runInvalid) add(r, "run-invalid", ...learning);
	const key = `${entry.task}/${entry.condition}/${entry.trial}`;
	// Without the study's validity reading, a trial's contamination is unknown: it may be described, and its symptom read, but no lesson or
	// causal claim rests on it.
	if (ctx.validity === null) add(r, "validity-undeclared", "lesson", "causal-policy");
	else {
		if (t.kind === "result" && ctx.validity.excluded.includes(key)) add(r, "trial-excluded", ...learning);
		if (ctx.validity.unresolvedTasks.includes(entry.task)) add(r, "exclusions-unresolved", ...learning);
		const arm = ctx.validity.arms[entry.condition] ?? ctx.validity.arms["*"];
		if (arm === undefined) add(r, "validity-undeclared", "causal-policy");
		else if (arm === "invalid") {
			add(r, "arm-invalid", "causal-policy");
			caveats.add("arm-invalid");
		} else if (arm === "checks-incomplete") add(r, "validity-checks-incomplete", "causal-policy");
	}
	if (ctx.conditions < 2) add(r, "single-condition", "causal-policy");
	if (t.harness === null || t.harness.identityDigest === null) add(r, "harness-identity-unavailable", "causal-policy");
	if (ctx.stage === "pilot") caveats.add("pilot-stage");
	if (ctx.examinedTasks.has(entry.task)) caveats.add("task-examined");
	if (t.symptomsWithheld) caveats.add("symptoms-withheld");
	const spec = ctx.record.spec;
	return {
		id: t.kind === "interrupted" ? `exp:${ctx.sourceId}/${t.path}` : `exp:${ctx.sourceId}/${key}`,
		source: {
			kind: "experiment-trial",
			sourceId: ctx.sourceId,
			study: ctx.study,
			run: ctx.sourceId,
			stage: ctx.stage,
			location: `${ctx.location}/${t.path}`,
			schemaVersion: t.schemaVersion,
			recordSha256: t.recordSha256,
		},
		decision: decisionOfTrial(ctx.record, entry),
		identity: {
			configuredModel: `${spec.provider}/${spec.model}`,
			wireModels: t.wireModels,
			harness: t.harness,
		},
		content: {
			store: t.store ? "present" : "absent",
			capture: t.capture ? "present" : "absent",
			checkOutput: t.checkOutput,
		},
		outcome,
		artifact:
			result?.finalWorkspace != null
				? { kind: "workspace-digest", digest: { ...result.finalWorkspace }, binding: "runner-observed" }
				: { kind: "none" },
		symptoms: t.symptoms,
		checksNamed: t.checksNamed,
		caveats: [...caveats].sort(),
		eligibility: verdicts(r),
		links: {},
	};
}

/** One DEVELOP attempt as an example. */
export function attemptExample(ctx: { sourceId: string; location: string }, a: AttemptFacts): Example {
	const r = none();
	const { attempt, handoff, outcome: declared, authorized } = a.entry;
	const learning: Objective[] = ["symptom", "lesson", "causal-policy"];
	// The decision was the operator's; nothing records how it was assigned. Nothing binds an artifact to it.
	add(r, "assignment-not-randomized", "causal-policy");
	add(r, "artifact-unbound", ...learning);
	// The session's content is not part of this projection (it lives in the native session, outside canonical evidence).
	add(r, "content-unavailable", "lesson");
	let outcome: Example["outcome"];
	if (a.receipts.length > 0) {
		const commits = [...new Set(a.receipts.map((x) => x.revision.commit))];
		outcome = {
			kind: "receipts",
			outcomes: a.receipts.map((x) => x.outcome),
			commits,
			scope: "the operator's check command, run by endo at the recorded commit (not task acceptance)",
		};
		add(r, "receipt-output-not-retained", "symptom", "lesson");
		add(r, "receipt-link-operator-declared", ...learning);
		if (commits.length > 1) add(r, "receipt-revision-ambiguous", ...learning);
		if (a.receipts.some((x) => x.startedAtMs < attempt.preparedAtMs)) add(r, "receipt-predates-attempt", ...learning);
		if (a.receipts.some((x) => x.projectId !== attempt.projectId)) add(r, "receipt-project-mismatch", ...learning);
	} else if (declared !== null) {
		outcome = { kind: "declared", declared: declared.kind };
		add(r, "outcome-declared-only", ...learning);
	} else if (authorized === null && handoff === null) {
		outcome = { kind: "none", why: "not-executed" };
		add(r, "not-executed", ...learning);
	} else {
		outcome = { kind: "none", why: "missing" };
		add(r, "outcome-missing", ...learning);
	}
	if (!a.receiptsReadable || a.receiptProblems > 0) add(r, "source-problems", ...learning);
	return {
		id: `dev:${ctx.sourceId}/${attempt.id}`,
		source: {
			kind: "develop-attempt",
			sourceId: ctx.sourceId,
			study: null,
			run: null,
			stage: null,
			location: `${ctx.location}/develop/attempts/${attempt.id}`,
			schemaVersion: attempt.schemaVersion,
			recordSha256: a.recordSha256,
		},
		decision: decisionOfAttempt(attempt),
		identity: {
			configuredModel: null,
			wireModels: null,
			harness: authorized === null ? null : { name: authorized.harness, version: null, identityDigest: null },
		},
		content: { store: "present", capture: "absent", checkOutput: "not-applicable" },
		outcome,
		artifact: { kind: "none" },
		symptoms: null,
		checksNamed: null,
		caveats: [],
		eligibility: verdicts(r),
		links: {},
	};
}

const LOCATION_RANK: Record<string, number> = { "research-data": 0, store: 1, repository: 2 };

/**
 * Cross-source pass. The same trial read from two locations (a committed copy and the raw run) is one record: same run (spec digest, seed,
 * creation time) and coordinates with the same bytes is a duplicate, counted once at the location holding the most content; the same
 * coordinates with other bytes is a conflict, and neither copy is used. A counted rerun is linked to the interrupted executions it replaced.
 */
export function linkExamples(examples: Example[], runCreated: ReadonlyMap<string, string>): Example[] {
	const out = examples.map((e) => ({ ...e, eligibility: { ...e.eligibility }, links: { ...e.links } }));
	const coordinate = (e: Example) =>
		e.decision.kind === "condition-assignment"
			? `${e.decision.specSha256}|${e.decision.seed}|${runCreated.get(e.source.sourceId) ?? ""}|${e.decision.task}|${e.decision.condition}|${e.decision.trial}|${e.source.schemaVersion === "interrupted" ? e.source.location.split("/").pop() : "counted"}`
			: `attempt|${e.id.split("/").pop()}`;
	const groups = new Map<string, Example[]>();
	for (const e of out) groups.set(coordinate(e), [...(groups.get(coordinate(e)) ?? []), e]);
	const mark = (e: Example, reason: Reason, objectives: readonly Objective[]) => {
		for (const o of objectives) {
			const v = e.eligibility[o];
			e.eligibility[o] = { eligible: false, reasons: [...new Set([...v.reasons, reason])].sort() };
		}
	};
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const ranked = [...group].sort(
			(a, b) =>
				(LOCATION_RANK[a.source.location.split("/")[0] ?? ""] ?? 9) -
					(LOCATION_RANK[b.source.location.split("/")[0] ?? ""] ?? 9) ||
				(a.content.capture === b.content.capture ? 0 : a.content.capture === "present" ? -1 : 1) ||
				(a.id < b.id ? -1 : 1),
		);
		if (new Set(group.map((e) => e.source.recordSha256)).size > 1) {
			for (const e of group) mark(e, "conflicting-duplicate", OBJECTIVES);
			continue;
		}
		const [canonical, ...rest] = ranked as [Example, ...Example[]];
		for (const e of rest) {
			mark(e, "duplicate-record", OBJECTIVES);
			e.links.duplicateOf = canonical.id;
		}
	}
	// Interrupted executions and the counted trial at the same coordinates in the same run.
	const counted = new Map<string, Example>();
	for (const e of out)
		if (e.decision.kind === "condition-assignment" && e.source.schemaVersion !== "interrupted")
			counted.set(`${e.source.sourceId}|${e.decision.task}|${e.decision.condition}|${e.decision.trial}`, e);
	for (const e of out) {
		if (e.decision.kind !== "condition-assignment" || e.source.schemaVersion !== "interrupted") continue;
		const rerun = counted.get(`${e.source.sourceId}|${e.decision.task}|${e.decision.condition}|${e.decision.trial}`);
		if (rerun === undefined) continue;
		rerun.links.interruptedCopies = [...(rerun.links.interruptedCopies ?? []), e.id].sort();
		if (!rerun.caveats.includes("rerun-after-interruption"))
			rerun.caveats = [...rerun.caveats, "rerun-after-interruption" as Caveat].sort();
	}
	return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
