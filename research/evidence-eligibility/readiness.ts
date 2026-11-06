// MEM-001 readiness, as three separate judgements and an overall one. Each is READY, NOT READY or INDETERMINATE with the conditions that
// decided it; there is no confidence number. The rules are stated here once and printed with the result (README.md, "Readiness rules").

import type { Example, SourceEntry, SourceProblem } from "./contract.ts";
import type { Card, CardAssessment, Target } from "./lessons.ts";

export type Readiness = "READY" | "NOT READY" | "INDETERMINATE";

export interface Judgement {
	status: Readiness;
	conditions: string[];
}

export interface ReadinessReport {
	evidence: Judgement;
	lessons: Judgement;
	evaluator: Judgement;
	overall: Judgement;
	/** Which of the brief's final options the rules point to, and why (a rule's output, not a decision: RESULTS.md decides). */
	suggests: { option: "A" | "B" | "C"; because: string };
}

/**
 * Two usable cards can make retrieval differ from a fixed checklist only if choosing between them matters: some case selects one and not
 * the other (one excludes a feature the other requires, or neither's requirements imply the other's), AND the usable cards cannot all be
 * given together (they exceed the shared allowance) or one is shown to mislead outside its conditions (it has a resolved contradiction).
 * Otherwise a checklist holding every usable card carries the same guidance, and an R − S contrast has no mechanism to measure.
 */
export function selectionMatters(cards: readonly Card[], usable: readonly CardAssessment[], budget: number): boolean {
	const byId = new Map(cards.map((c) => [c.id, c]));
	const u = usable.map((a) => byId.get(a.id)).filter((c): c is Card => c !== undefined);
	let separable = false;
	for (const a of u)
		for (const b of u) {
			if (a.id >= b.id) continue;
			const aExcludesB = a.excludes.some((f) => b.applies.includes(f));
			const bExcludesA = b.excludes.some((f) => a.applies.includes(f));
			const aImpliesB = b.applies.every((f) => a.applies.includes(f));
			const bImpliesA = a.applies.every((f) => b.applies.includes(f));
			if (aExcludesB || bExcludesA || (!aImpliesB && !bImpliesA)) separable = true;
		}
	const tokens = usable.reduce((n, a) => n + a.tokens, 0);
	const misleads = usable.some((a) => a.contradicting.length > 0 && a.contradicting.every((c) => c.eligible > 0));
	return separable && (tokens > budget || misleads);
}

export function judgeReadiness(input: {
	sources: readonly SourceEntry[];
	problems: readonly SourceProblem[];
	examples: readonly Example[];
	cards: readonly Card[];
	assessments: readonly CardAssessment[];
	target: Target;
	researchDataRead: boolean;
}): ReadinessReport {
	const { sources, problems, examples, cards, assessments, target } = input;
	// ---- evidence ----
	const ev: string[] = [];
	let evidence: Readiness = "READY";
	const missing = sources.filter((s) => s.status === "missing");
	const refused = sources.filter((s) => s.status === "refused");
	const conflicts = examples.filter((e) => e.eligibility.descriptive.reasons.includes("conflicting-duplicate")).length;
	if (!input.researchDataRead) {
		evidence = "INDETERMINATE";
		ev.push(
			"The raw research archives were not read: only committed records were projected, which is not a qualification of the archives.",
		);
	}
	if (missing.length > 0) {
		evidence = evidence === "READY" ? "INDETERMINATE" : evidence;
		ev.push(
			`${missing.length} declared source(s) were not present, so they are unqualified, not empty: ${missing.map((s) => s.id).join(", ")}.`,
		);
	}
	if (refused.length > 0 || conflicts > 0) {
		evidence = "NOT READY";
		if (refused.length > 0) ev.push(`${refused.length} source(s) were refused by their readers.`);
		if (conflicts > 0)
			ev.push(`${conflicts} example(s) have conflicting copies (same coordinates, different bytes).`);
	}
	// The study stages the cards' observations cite (a selector without a stage cites every stage of its study).
	const cited = cards.filter((c) => !c.revoked).flatMap((c) => c.evidence.observations);
	const undeclared = [
		...new Set(
			cited
				.filter((o) =>
					examples.some(
						(e) =>
							e.source.study === o.study &&
							(o.stage === null || e.source.stage === o.stage) &&
							e.eligibility["causal-policy"].reasons.includes("validity-undeclared"),
					),
				)
				.map((o) => `${o.study}${o.stage === null ? "" : ` (${o.stage})`}`),
		),
	];
	if (undeclared.length > 0) {
		evidence = "NOT READY";
		ev.push(`Cited studies without a machine-readable validity reading: ${undeclared.sort().join(", ")}.`);
	}
	const unreadRecords = problems.filter((p) => p.kind !== "missing").length;
	if (unreadRecords > 0)
		ev.push(`${unreadRecords} record(s) were reported as problems and left out (manifest, problems).`);
	if (ev.length === 0)
		ev.push(
			"Every declared source was read; provenance, validity and exclusions are recorded for every cited study.",
		);

	// ---- lessons ----
	const ls: string[] = [];
	const usable = assessments.filter((a) => a.usableInTarget);
	const supported = assessments.filter((a) => a.supported);
	ls.push(
		`${assessments.length} candidate(s): ${supported.length} supported by the evidence as stated, ${usable.length} usable as retrieved guidance in ${target.name}.`,
	);
	for (const a of assessments.filter((x) => x.supported && !x.usableInTarget))
		ls.push(`${a.id}: supported but not usable in the target (${a.targetProblems.join(", ")}).`);
	for (const a of assessments.filter((x) => !x.supported))
		ls.push(`${a.id}: not supported (${a.problems.join(", ")}).`);
	let lessons: Readiness;
	if (usable.length < 2) {
		lessons = "NOT READY";
		ls.push(
			"Fewer than two usable cards: there is nothing to select between, so retrieval cannot differ from a checklist.",
		);
	} else if (!selectionMatters(cards, usable, target.contextBudgetTokens)) {
		lessons = "NOT READY";
		ls.push(
			"The usable cards fit together in the shared allowance and none is shown to mislead outside its conditions: a checklist can carry them all.",
		);
	} else {
		lessons = "READY";
		ls.push("Usable cards exist whose selection matters (see the rule above).");
	}

	// ---- evaluator ----
	// No experiment run record has a field for an isolation boundary: none can say one was in force. The rest is cited (README.md).
	const runs = sources.filter((s) => s.kind === "experiment-run" && s.status === "read").length;
	const evaluator: Judgement = {
		status: "NOT READY",
		conditions: [
			`0 of ${runs} read experiment runs record an execution isolation boundary (endo.experiment-run.v0 has no field for one).`,
			"Missing boundary 1: the agent process can read the host (the repository, the research archive, hidden checks, other trials); the completion-cap study recorded a hidden-check read and broad deletions in a shared /tmp.",
			"Missing boundary 2: the success check runs in the agent's own workspace and environment, after the agent, without a separate verifier environment or artifact export.",
			"Missing boundary 3: no network restriction is applied or recorded for the agent.",
			"Missing boundary 4: an interrupted trial is rerun and replaced in the counted set (kept aside, not in the denominator).",
		],
	};

	// ---- overall ----
	const all = [evidence, lessons, evaluator.status];
	const overall: Readiness = all.includes("NOT READY")
		? "NOT READY"
		: all.includes("INDETERMINATE")
			? "INDETERMINATE"
			: "READY";
	const suggests: ReadinessReport["suggests"] =
		overall === "READY"
			? { option: "A", because: "evidence, lessons and evaluator are all ready" }
			: lessons === "NOT READY" && supported.some((a) => a.lever !== target.variedLever)
				? {
						option: "C",
						because:
							"the supported lessons act on levers the target holds fixed (configuration, evaluation, design), not on the agent's context",
					}
				: { option: "B", because: "specific evidence or attribution gaps remain (see the evidence conditions)" };
	return {
		evidence: { status: evidence, conditions: ev },
		lessons: { status: lessons, conditions: ls },
		evaluator,
		overall: {
			status: overall,
			conditions: [`evidence ${evidence}, lessons ${lessons}, evaluator ${evaluator.status}`],
		},
		suggests,
	};
}
