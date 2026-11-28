// Pure deterministic Attention Engine for Coordinator Studio F1 (`COORDINATOR-STUDIO-F1-002`).
//
// Invariants:
// - Pure deterministic function: zero clock, zero randomness, zero network, zero React, zero language models.
// - Every attention item cites an explicit documented rule ID and strictly separates:
//     * `observed`: direct recorded fact or symptom
//     * `consequence`: deterministic rule-inferred consequence (NOT a verified optimal plan)
//     * `uncertainty`: what the current records do NOT establish
// - Groups related per-task signals without hiding distinct hazards, conflicts, or reviews.

import type { EndoCoordinatorCoordinationV0 } from "../../../protocol/coordinator-coordination.ts";
import type { EndoCoordinatorStatusV0 } from "../../../protocol/coordinator-status.ts";
import type { EndoCoordinatorStudioOperationsV0 } from "../../../protocol/coordinator-studio-operations.ts";
import type { CoordinatorProblem } from "./read.ts";

export type AttentionTier = "hazard" | "blocker" | "verification" | "observation";

export type AttentionTarget =
	| { readonly kind: "task"; readonly taskId: string }
	| { readonly kind: "lanes"; readonly participantId?: string }
	| { readonly kind: "graph" }
	| { readonly kind: "resources" }
	| { readonly kind: "schedules" }
	| { readonly kind: "advisory" };

export interface DeterministicAttentionItem {
	readonly id: string;
	readonly rank: number;
	readonly tier: AttentionTier;
	readonly ruleId: string;
	readonly title: string;
	readonly subjectLabel: string;
	/** What was directly observed in authoritative records (symptom or recorded state). */
	readonly observed: string;
	/** Deterministic rule inference of why this matters — never an optimal plan or command. */
	readonly consequence: string;
	/** Explicit statement of what is NOT established by these records. */
	readonly uncertainty: string;
	readonly evidenceBasis:
		| "controller-observed"
		| "operator-declared"
		| "agent-reported"
		| "recorded-observation"
		| "unavailable";
	readonly freshness: "fresh" | "stale" | "incomplete" | "unavailable" | "offline";
	readonly target: AttentionTarget | null;
}

export interface DeterministicAttentionResult {
	readonly rulesetVersion: "endo.coordinator-attention-rules.v1";
	readonly items: readonly DeterministicAttentionItem[];
	readonly counts: {
		readonly total: number;
		readonly hazard: number;
		readonly blocker: number;
		readonly verification: number;
		readonly observation: number;
	};
}

const shortId = (id: string): string => (id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-6)}` : id);

/**
 * Derive an ordered, deterministic attention triage list from authoritative Coordinator projections.
 * Operates with zero language models and zero inference tokens.
 */
export function buildDeterministicAttention(args: {
	readonly status: EndoCoordinatorStatusV0;
	readonly coordination: EndoCoordinatorCoordinationV0 | null;
	readonly operations: EndoCoordinatorStudioOperationsV0 | null;
	readonly coordinationProblem: CoordinatorProblem | null;
	readonly operationsProblem: CoordinatorProblem | null;
}): DeterministicAttentionResult {
	const { status, coordination, operations, coordinationProblem, operationsProblem } = args;
	const items: Omit<DeterministicAttentionItem, "rank">[] = [];
	const seenIds = new Set<string>();

	const push = (item: Omit<DeterministicAttentionItem, "rank">) => {
		if (seenIds.has(item.id)) return;
		seenIds.add(item.id);
		items.push(item);
	};

	const taskTitles = new Map<string, string>();
	const allTasks = status.projects.flatMap((p) =>
		p.tasks.map((t) => {
			taskTitles.set(t.taskId, t.title || shortId(t.taskId));
			return { project: p, task: t };
		}),
	);

	// ---- Tier 1: Hazards & Contradictions ----------------------------------------------------------------------------------------

	// Rule H1: Worktree conflicts & unacknowledged write overlaps
	if (coordination !== null) {
		for (const proj of coordination.projects) {
			for (const [idx, conflict] of proj.conflicts.entries()) {
				const severe =
					conflict.kind === "unacknowledged-worktree-write-overlap" ||
					conflict.kind === "worktree-liveness-unverified";
				push({
					id: `conflict:${conflict.kind}:${conflict.worktreePath}:${idx}`,
					tier: severe ? "hazard" : "blocker",
					ruleId: severe ? "R1-WORKTREE-HAZARD" : "R2-WORKTREE-OVERLAP",
					title:
						conflict.kind === "unacknowledged-worktree-write-overlap"
							? "Unacknowledged worktree write overlap"
							: conflict.kind === "worktree-liveness-unverified"
								? "Worktree liveness unverified"
								: conflict.kind === "shared-mutable-worktree"
									? "Shared mutable worktree"
									: conflict.kind === "shared-writable-worktree-acknowledged"
										? "Shared writable worktree (acknowledged)"
										: "Worktree path-hint overlap",
					subjectLabel: conflict.worktreePath,
					observed: `Observed conflict "${conflict.kind}" across ${conflict.assignmentIds.length} assignment(s) (${conflict.assignmentIds.map(shortId).join(", ")}).`,
					consequence:
						"Concurrent or unverified edits in the same working tree risk conflicting changes or invalidated receipts.",
					uncertainty:
						"Offline projection does not observe live OS processes or file locks; actual concurrent writes are not established.",
					evidenceBasis: "controller-observed",
					freshness: "offline",
					target: { kind: "lanes" },
				});
			}

			// Rule H2: Unverified process termination / assignment liveness hazard
			for (const assign of proj.assignments) {
				if (assign.hazard !== "liveness-unverified") continue;
				const title = taskTitles.get(assign.taskId) ?? shortId(assign.taskId);
				push({
					id: `hazard:liveness:${assign.assignmentId}`,
					tier: "hazard",
					ruleId: "R1-LIVENESS-UNVERIFIED",
					title: "Unverified session termination hazard",
					subjectLabel: `${assign.participantId} · ${title}`,
					observed: `Assignment ${shortId(assign.assignmentId)} (${assign.state}) carries hazard "liveness-unverified" on worktree ${assign.workspace.worktreePath}.`,
					consequence:
						"A previously linked session may still be running or modifying the checkout; reusing the worktree before verifying process exit risks corruption.",
					uncertainty: "Offline projection does not probe host processes; termination is explicitly unconfirmed.",
					evidenceBasis: "controller-observed",
					freshness: "offline",
					target: { kind: "lanes", participantId: assign.participantId },
				});
			}
		}
	}

	// Rule H3: Contradictions in status findings (e.g., review/complete vs failing HEAD check)
	for (const [idx, finding] of status.findings.entries()) {
		if (finding.severity !== "contradiction") continue;
		const subjectTaskId = finding.subject !== null && taskTitles.has(finding.subject) ? finding.subject : null;
		const subjectTitle =
			subjectTaskId !== null ? (taskTitles.get(subjectTaskId) ?? shortId(subjectTaskId)) : "Project scope";
		push({
			id: `contradiction:${finding.code}:${finding.subject ?? idx}`,
			tier: "hazard",
			ruleId: "R1-STATUS-CONTRADICTION",
			title: "Status vs verification contradiction",
			subjectLabel: subjectTitle,
			observed: finding.text,
			consequence:
				"Operator-declared task phase disagrees with controller-observed verification receipts at current HEAD.",
			uncertainty: "Records do not establish whether the task status or the latest check run should be updated.",
			evidenceBasis: "controller-observed",
			freshness: "fresh",
			target: subjectTaskId !== null ? { kind: "task", taskId: subjectTaskId } : null,
		});
	}

	// Rule H4: Current-HEAD failing verification checks
	for (const { task } of allTasks) {
		if (task.verification.state !== "failing") continue;
		push({
			id: `task:failing:${task.taskId}`,
			tier: "hazard",
			ruleId: "R1-CURRENT-CHECK-FAILING",
			title: "Current-HEAD verification failing",
			subjectLabel: task.title || shortId(task.taskId),
			observed: `Task "${task.title || shortId(task.taskId)}" (${task.phase}) has a failing controller-observed host check at current HEAD.`,
			consequence:
				"Candidate or checkout changes currently fail verification and should be inspected before handoff.",
			uncertainty: "A failing host check establishes that the recorded command failed, not the root cause.",
			evidenceBasis: "controller-observed",
			freshness: task.verification.freshness.state,
			target: { kind: "task", taskId: task.taskId },
		});
	}

	// ---- Tier 2: Blockers, Changes-Requested Reviews, Unsatisfied Dependencies ---------------------------------------------------

	if (coordination !== null) {
		for (const proj of coordination.projects) {
			// Rule B1: Advisory reviews requesting changes or reporting blocked
			for (const review of proj.reviews ?? []) {
				if (review.verdict !== "changes-requested" && review.verdict !== "blocked") continue;
				const subjectTitle = taskTitles.get(review.candidateTaskId) ?? shortId(review.candidateTaskId);
				const severeFindings = review.findingCounts.critical + review.findingCounts.high;
				push({
					id: `review:${review.reviewId}`,
					tier: "blocker",
					ruleId: "R2-ADVISORY-REVIEW-CHANGES",
					title:
						review.verdict === "changes-requested"
							? "Advisory review requested changes"
							: "Advisory review reported blocked",
					subjectLabel: `${subjectTitle} · ${review.reviewerParticipantId}`,
					observed: `Agent-reported review by ${review.reviewerParticipantId} returned "${review.verdict}" (${review.candidateRelation}; findings C${review.findingCounts.critical}/H${review.findingCounts.high}/M${review.findingCounts.medium}/L${review.findingCounts.low}).`,
					consequence:
						severeFindings > 0
							? "High or critical advisory findings were raised against this candidate and warrant operator inspection."
							: "Reviewer flagged issues on this candidate that may need follow-up before acceptance.",
					uncertainty:
						"Advisory reviews are agent-reported only — never controller-observed host check receipts and never operator acceptance.",
					evidenceBasis: "agent-reported",
					freshness: review.candidateRelation === "current-candidate" ? "fresh" : "stale",
					target: { kind: "task", taskId: review.candidateTaskId },
				});
			}

			// Rule B2: Unsatisfied or unknown declared dependencies
			for (const dep of proj.dependencies) {
				if (dep.satisfaction === "satisfied") continue;
				const prereq = taskTitles.get(dep.prerequisiteTaskId) ?? shortId(dep.prerequisiteTaskId);
				const dependent = taskTitles.get(dep.dependentTaskId) ?? shortId(dep.dependentTaskId);
				const isUnsatisfied = dep.satisfaction === "unsatisfied";
				push({
					id: `dep:${dep.dependencyId}`,
					tier: isUnsatisfied ? "blocker" : "verification",
					ruleId: isUnsatisfied ? "R2-UNSATISFIED-DEPENDENCY" : "R3-DEPENDENCY-UNKNOWN",
					title: isUnsatisfied ? "Unsatisfied declared dependency" : "Declared dependency satisfaction unknown",
					subjectLabel: `${prereq} → ${dependent}`,
					observed: `Declared dependency (${dep.condition}) from "${prereq}" to "${dependent}" is ${dep.satisfaction}${dep.reasons.length > 0 ? ` (${dep.reasons.join(", ")})` : ""}.`,
					consequence: isUnsatisfied
						? `Downstream task "${dependent}" does not currently satisfy its operator-declared prerequisite condition.`
						: `Prerequisite standing for "${dependent}" could not be established from current records.`,
					uncertainty:
						"Dependency satisfaction reflects recorded state only; readiness never confers execution permission.",
					evidenceBasis: "controller-observed",
					freshness: "offline",
					target: { kind: "graph" },
				});
			}
		}
	}

	// Rule B3: Blocked tasks
	for (const { task } of allTasks) {
		if (task.phase !== "blocked") continue;
		push({
			id: `task:blocked:${task.taskId}`,
			tier: "blocker",
			ruleId: "R2-TASK-BLOCKED",
			title: "Task marked blocked",
			subjectLabel: task.title || shortId(task.taskId),
			observed: `Operator-declared status for "${task.title || shortId(task.taskId)}" is "blocked" (rev ${task.revision}).`,
			consequence: "Work on this task is paused pending operator intervention or prerequisite resolution.",
			uncertainty: "Task status is operator-declared; the store may not record all external blockers.",
			evidenceBasis: "operator-declared",
			freshness: "fresh",
			target: { kind: "task", taskId: task.taskId },
		});
	}

	// ---- Tier 3: Verification, Review Queue, and Candidate Limitations -----------------------------------------------------------

	// Rule V1: Tasks awaiting operator review
	for (const { task } of allTasks) {
		if (task.phase !== "awaiting-review") continue;
		push({
			id: `task:review:${task.taskId}`,
			tier: "verification",
			ruleId: "R3-AWAITING-REVIEW",
			title: "Task awaits operator review",
			subjectLabel: task.title || shortId(task.taskId),
			observed: `Task "${task.title || shortId(task.taskId)}" is in "awaiting-review" with verification state "${task.verification.state}".`,
			consequence: "Operator review is needed to inspect receipts and decide whether to accept or continue work.",
			uncertainty: "Verification state reflects recorded host receipts only; review status is operator-declared.",
			evidenceBasis: "operator-declared",
			freshness: task.verification.freshness.state,
			target: { kind: "task", taskId: task.taskId },
		});
	}

	// Rule V2: Inconclusive, incomplete, historical, or missing verification on active/review tasks
	for (const { task } of allTasks) {
		if (task.phase === "completed" || task.phase === "open") continue;
		const v = task.verification.state;
		if (
			v === "inconclusive" ||
			v === "incomplete" ||
			v === "not-current" ||
			v === "no-checks" ||
			v === "unavailable"
		) {
			push({
				id: `task:verify-gap:${task.taskId}`,
				tier: "verification",
				ruleId: `R3-VERIFICATION-${v.toUpperCase()}`,
				title:
					v === "inconclusive"
						? "Current check inconclusive"
						: v === "incomplete"
							? "Verification coverage incomplete"
							: v === "not-current"
								? "Only historical verification recorded"
								: v === "no-checks"
									? "No host checks recorded"
									: "Verification evidence unavailable",
				subjectLabel: task.title || shortId(task.taskId),
				observed: `Active/review task "${task.title || shortId(task.taskId)}" has verification state "${v}"${task.verification.freshness.reason ? ` (${task.verification.freshness.reason})` : ""}.`,
				consequence: "Current checkout correctness is not established by a current-HEAD passing host receipt.",
				uncertainty:
					v === "no-checks"
						? "Absence of recorded checks means no receipt was found in the read — not that the work failed or succeeded."
						: "Incomplete or historical receipts cannot confirm the current working tree.",
				evidenceBasis: v === "unavailable" ? "unavailable" : "controller-observed",
				freshness: task.verification.freshness.state,
				target: { kind: "task", taskId: task.taskId },
			});
		}
	}

	// Rule V3: Candidate readiness or receipt limitations
	if (coordination !== null) {
		for (const proj of coordination.projects) {
			for (const ct of proj.tasks) {
				const limited = ct.candidates.filter(
					(c) => c.relation !== "current" || c.receipts !== "passing" || c.workspace !== "matches-candidate",
				);
				if (limited.length === 0) continue;
				const summary = limited
					.map(
						(c) =>
							`${shortId(c.candidateId)} (${c.relation}, workspace: ${c.workspace}, receipts: ${c.receipts})`,
					)
					.join("; ");
				push({
					id: `candidate:limits:${ct.taskId}`,
					tier: "verification",
					ruleId: "R3-CANDIDATE-LIMITATIONS",
					title: "Candidate evidence limitations",
					subjectLabel: taskTitles.get(ct.taskId) ?? shortId(ct.taskId),
					observed: `${limited.length} declared candidate(s) have non-current or unverified standing: ${summary}.`,
					consequence:
						"Candidate readiness is constrained until checkout cleanliness and current-HEAD host receipts are established.",
					uncertainty:
						"Candidate standing is read from recorded declarations and receipts; readiness never implies permission.",
					evidenceBasis: "controller-observed",
					freshness: "offline",
					target: { kind: "task", taskId: ct.taskId },
				});
			}
		}
	}

	// ---- Tier 4: Operational, Resource, Schedule, and Observation Gaps -----------------------------------------------------------

	// Rule O1: Unavailable companion projections or status sources
	if (coordinationProblem !== null) {
		push({
			id: `source:coordination-unavailable:${coordinationProblem}`,
			tier: "observation",
			ruleId: "R4-COORDINATION-UNAVAILABLE",
			title: "Coordination projection unavailable",
			subjectLabel: "Coordination store",
			observed: `Read-only coordination projection failed (${coordinationProblem}).`,
			consequence: "Assignments, worktree hazards, dependencies, and advisory reviews could not be inspected.",
			uncertainty: "Absence of warnings while this source is unavailable does NOT mean absence of hazards.",
			evidenceBasis: "unavailable",
			freshness: "unavailable",
			target: { kind: "lanes" },
		});
	}
	if (operationsProblem !== null) {
		push({
			id: `source:operations-unavailable:${operationsProblem}`,
			tier: "observation",
			ruleId: "R4-OPERATIONS-UNAVAILABLE",
			title: "Operations projection unavailable",
			subjectLabel: "S1/S2 operational store",
			observed: `Read-only operations projection failed (${operationsProblem}).`,
			consequence: "Recorded resource health, schedule ledger, and advisory history are not currently visible.",
			uncertainty: "Unavailable operational data is unknown — never treated as healthy, empty, or zero.",
			evidenceBasis: "unavailable",
			freshness: "unavailable",
			target: { kind: "resources" },
		});
	}

	for (const sourceKey of ["tasks", "attempts", "events"] as const) {
		const src = status.sources[sourceKey];
		if (src.state === "ready") continue;
		push({
			id: `source:status:${sourceKey}`,
			tier: "observation",
			ruleId: "R4-STATUS-SOURCE-DEGRADED",
			title: `Status ${sourceKey} source ${src.state}`,
			subjectLabel: `Store source: ${sourceKey}`,
			observed: `The ${sourceKey} source reported state "${src.state}"${src.detail ? ` (${src.detail})` : ""}.`,
			consequence: "Task, receipt, or session visibility may be incomplete in this read.",
			uncertainty: "Unreadable or incomplete records cannot establish absence of checks, sessions, or faults.",
			evidenceBasis: src.state === "unavailable" ? "unavailable" : "controller-observed",
			freshness: src.freshness.state,
			target: null,
		});
	}

	// Rule O2: Unresolved / incomplete schedule fires or degraded schedule storage
	if (operations !== null) {
		if (operations.schedules.observation.incompleteCount > 0 || operations.schedules.advisory.incompleteCount > 0) {
			const obsInc = operations.schedules.observation.incompleteCount;
			const advInc = operations.schedules.advisory.incompleteCount;
			push({
				id: "schedules:claimed-incomplete",
				tier: "observation",
				ruleId: "R4-SCHEDULE-FIRE-INCOMPLETE",
				title: "Unresolved claimed schedule fire(s)",
				subjectLabel: "Schedule ledger",
				observed: `Recorded ${obsInc} incomplete observation fire(s) and ${advInc} incomplete project advisory fire(s).`,
				consequence:
					"A prior tick claimed a window without recording a terminal outcome; future ticks recover it without retrying dispatched inference.",
				uncertainty: "Incomplete claims do not establish whether external side effects completed before exit.",
				evidenceBasis: "recorded-observation",
				freshness: "incomplete",
				target: { kind: "schedules" },
			});
		}

		if (
			operations.schedules.observation.state === "unreadable" ||
			operations.schedules.observation.degraded ||
			operations.schedules.advisory.state === "unreadable" ||
			operations.schedules.advisory.degraded
		) {
			push({
				id: "schedules:degraded",
				tier: "observation",
				ruleId: "R4-SCHEDULES-DEGRADED",
				title: "Schedule ledger degraded or unreadable",
				subjectLabel: "S1/S2 schedules",
				observed: `Observation ledger is ${operations.schedules.observation.state}${operations.schedules.observation.degraded ? " (degraded)" : ""}; project advisory ledger is ${operations.schedules.advisory.state}${operations.schedules.advisory.degraded ? " (degraded)" : ""}.`,
				consequence:
					"Scheduled run history or budget accounting may be incomplete; missing entries do not mean no runs occurred.",
				uncertainty: "Damaged or bounded-out schedule records cannot establish absence of prior runs or charges.",
				evidenceBasis: "unavailable",
				freshness: "incomplete",
				target: { kind: "schedules" },
			});
		}
		if (operations.resources.state === "unreadable") {
			push({
				id: "resources:unreadable",
				tier: "observation",
				ruleId: "R4-RESOURCES-UNREADABLE",
				title: "Recorded resource snapshot unreadable",
				subjectLabel: "S1 resources",
				observed: `S1 resources.json is unreadable (${operations.resources.detail ?? "error"}).`,
				consequence: "Local endpoint and provider allowance standing cannot be established from recorded state.",
				uncertainty: "Studio never live-probes endpoints or wakes models to replace an unreadable snapshot.",
				evidenceBasis: "unavailable",
				freshness: "unavailable",
				target: { kind: "resources" },
			});
		} else if (operations.resources.state === "ready") {
			if (operations.resources.freshness === "stale") {
				push({
					id: "resources:stale",
					tier: "observation",
					ruleId: "R4-RESOURCES-STALE",
					title: "Recorded resource observation is stale",
					subjectLabel: "S1 resources",
					observed: `Recorded resource observation exceeded its freshness window (${Math.round((operations.resources.staleAfterMs ?? 0) / 1000)}s).`,
					consequence:
						"Endpoint readiness and provider standing shown in Resources may no longer reflect current state.",
					uncertainty: "Studio reads recorded S1 observations only and never triggers live probes or model loads.",
					evidenceBasis: "recorded-observation",
					freshness: "stale",
					target: { kind: "resources" },
				});
			}
			const degradedEndpoints = operations.resources.localEndpoints.filter((ep) =>
				["unhealthy", "unreachable", "saturated", "model-unavailable", "probe-refused"].includes(ep.readiness),
			);
			if (degradedEndpoints.length > 0) {
				push({
					id: "resources:endpoints-degraded",
					tier: "observation",
					ruleId: "R4-LOCAL-ENDPOINTS-DEGRADED",
					title: "Recorded local model endpoint(s) degraded",
					subjectLabel: degradedEndpoints.map((e) => e.memberId).join(", "),
					observed: `${degradedEndpoints.length} recorded local endpoint(s) reported degraded readiness: ${degradedEndpoints.map((e) => `${e.memberId} (${e.readiness})`).join(", ")}.`,
					consequence:
						"Advisory inference cannot rely on degraded local endpoints until a fresh healthy observation is recorded.",
					uncertainty:
						"Recorded S1 observations do not prove current reachability and never wake sleeping models.",
					evidenceBasis: "recorded-observation",
					freshness: operations.resources.freshness === "fresh" ? "fresh" : "stale",
					target: { kind: "resources" },
				});
			}
		}

		// Rule O4: Advisory history unreadability or degradation (never hides deterministic board!)
		if (operations.advisoryHistory.state === "unreadable" || operations.advisoryHistory.degraded) {
			push({
				id: "advisory:unreadable",
				tier: "observation",
				ruleId:
					operations.advisoryHistory.state === "unreadable"
						? "R4-ADVISORY-HISTORY-UNREADABLE"
						: "R4-ADVISORY-HISTORY-DEGRADED",
				title:
					operations.advisoryHistory.state === "unreadable"
						? "Advisory history storage unreadable"
						: "Advisory history storage degraded",
				subjectLabel: "S2 advisory records",
				observed:
					operations.advisoryHistory.state === "unreadable"
						? `Project advisory records could not be read (${operations.advisoryHistory.detail ?? "error"}).`
						: "One or more advisory turn or proposal files could not be read; counts and history may be incomplete.",
				consequence:
					"Historical untrusted briefings, proposals, or token totals may be incomplete; deterministic task and coordination views remain unaffected.",
				uncertainty:
					"Unreadable or degraded advisory history does not establish zero briefings, proposals, or tokens.",
				evidenceBasis: "unavailable",
				freshness: operations.advisoryHistory.state === "unreadable" ? "unavailable" : "incomplete",
				target: { kind: "advisory" },
			});
		}
	}

	const tierOrder: Record<AttentionTier, number> = {
		hazard: 0,
		blocker: 1,
		verification: 2,
		observation: 3,
	};

	items.sort(
		(a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id),
	);

	const ranked: DeterministicAttentionItem[] = items.map((item, idx) => ({ ...item, rank: idx + 1 }));
	return {
		rulesetVersion: "endo.coordinator-attention-rules.v1",
		items: ranked,
		counts: {
			total: ranked.length,
			hazard: ranked.filter((i) => i.tier === "hazard").length,
			blocker: ranked.filter((i) => i.tier === "blocker").length,
			verification: ranked.filter((i) => i.tier === "verification").length,
			observation: ranked.filter((i) => i.tier === "observation").length,
		},
	};
}
