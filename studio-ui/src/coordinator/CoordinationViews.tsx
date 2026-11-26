import type { ReactElement } from "react";
import type {
	EndoCoordinationAssignmentViewV0,
	EndoCoordinationConflictViewV0,
	EndoCoordinationDependencyViewV0,
	EndoCoordinationProjectViewV0,
	EndoCoordinationRegisteredWorktreeViewV0,
	EndoCoordinationReviewViewV0,
	EndoCoordinationTaskViewV0,
	EndoCoordinatorCoordinationV0,
} from "../../../protocol/coordinator-coordination.ts";
import { Timestamp } from "./Evidence.tsx";
import type { CoordinatorProblem } from "./read.ts";

const ROLE_LABELS = {
	builder: "Builder",
	reviewer: "Reviewer",
	investigator: "Investigator",
} as const;

const EXECUTION_LABELS: Record<EndoCoordinationAssignmentViewV0["attempts"][number]["execution"], string> = {
	"workbench-authorized": "Pi workbench authorized",
	"adapter-authorized": "Adapter authorized",
	"adapter-accepted": "Runtime accepted (consequence unobserved)",
	"adapter-refused": "Runtime refused",
	"adapter-unknown": "Dispatch outcome unknown",
	"aborted-before-transport": "Aborted before transport (route burned)",
	"route-claimed": "Route claimed",
	"none-recorded": "Prepared (not authorized)",
	unknown: "Execution evidence unknown",
};

const SATISFACTION_LABELS = {
	satisfied: "Satisfied",
	unsatisfied: "Unsatisfied",
	unknown: "Unknown",
} as const;

const LIVENESS_LABELS = {
	"liveness-unknown": "Liveness unknown (offline)",
	"stale-observation": "Stale observation (offline)",
	"unsupported-observation": "Observation unavailable (offline)",
} as const;

const CONFLICT_LABELS: Record<EndoCoordinationConflictViewV0["kind"], string> = {
	"shared-writable-worktree-acknowledged": "Shared writable worktree (acknowledged)",
	"unacknowledged-worktree-write-overlap": "Unacknowledged write overlap",
	"shared-mutable-worktree": "Shared mutable worktree",
	"worktree-liveness-unverified": "Worktree liveness unverified",
	"path-hint-overlap": "Path hint overlap",
};

const shortId = (id: string): string => (id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-6)}` : id);

function computeTopologicalLayers(
	taskIds: readonly string[],
	dependencies: readonly EndoCoordinationDependencyViewV0[],
): string[][] {
	const idSet = new Set(taskIds);
	for (const d of dependencies) {
		idSet.add(d.prerequisiteTaskId);
		idSet.add(d.dependentTaskId);
	}
	const nodes = [...idSet].sort();
	const prereqs = new Map<string, string[]>();
	for (const id of nodes) prereqs.set(id, []);
	for (const d of dependencies) {
		prereqs.get(d.dependentTaskId)?.push(d.prerequisiteTaskId);
	}
	const depth = new Map<string, number>();
	const visiting = new Set<string>();
	const getDepth = (id: string): number => {
		const cached = depth.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const parents = prereqs.get(id) ?? [];
		let d = 0;
		for (const p of parents) d = Math.max(d, getDepth(p) + 1);
		visiting.delete(id);
		depth.set(id, d);
		return d;
	};
	const layers = new Map<number, string[]>();
	for (const id of nodes) {
		const layer = getDepth(id);
		layers.set(layer, [...(layers.get(layer) ?? []), id]);
	}
	return [...layers.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids.sort());
}

export function CoordinationBanner({ coordination }: { coordination: EndoCoordinatorCoordinationV0 }): ReactElement {
	const conflicts = coordination.projects.flatMap((p) => p.conflicts);
	const hazards = coordination.projects.flatMap((p) =>
		p.assignments.filter((a) => a.hazard === "liveness-unverified"),
	);
	return (
		<div className="coordinator-coord-banner" data-testid="coordinator-coordination-banner">
			<span className="coordinator-pill" data-tone="neutral">
				Coordination: {coordination.source.state}
				{coordination.source.revision !== null ? ` (rev ${coordination.source.revision})` : ""}
			</span>
			<span className="coordinator-muted">
				Read-only offline projection · assignment is intent only · readiness is not execution permission · liveness
				not observed.
			</span>
			{conflicts.length > 0 || hazards.length > 0 ? (
				<span className="coordinator-pill" data-tone="attention">
					{hazards.length} unverified {hazards.length === 1 ? "hazard" : "hazards"} · {conflicts.length}{" "}
					{conflicts.length === 1 ? "conflict" : "conflicts"}
				</span>
			) : null}
			{coordination.gaps.length > 0 ? (
				<span className="coordinator-pill" data-tone="muted">
					Gaps: {coordination.gaps.join(", ")}
				</span>
			) : null}
		</div>
	);
}

const COORDINATION_PROBLEM_LABELS: Record<CoordinatorProblem, string> = {
	"grant-required": "Pairing grant required",
	forbidden: "Project scope unavailable",
	"not-found": "Coordination endpoint not found",
	"too-many-requests": "Host busy (rate limited)",
	unavailable: "Coordination projection unavailable (503)",
	invalid: "Coordination response failed schema validation",
	unreachable: "Workspace host unreachable",
	timeout: "Coordination read timed out",
};

export function CoordinationUnavailableBanner({ problem }: { problem: CoordinatorProblem }): ReactElement {
	return (
		<div className="coordinator-coord-banner" data-testid="coordinator-coordination-unavailable">
			<span className="coordinator-pill" data-tone="attention">
				Coordination: unavailable
			</span>
			<span className="coordinator-muted">
				{COORDINATION_PROBLEM_LABELS[problem]}. Assignments, dependencies, worktree hazards, and advisory reviews
				could not be established — absence of warnings does not mean absence of hazards.
			</span>
		</div>
	);
}

export function CoordinationUnavailableBoard({
	view,
	problem,
}: {
	view: "lanes" | "graph";
	problem: CoordinatorProblem;
}): ReactElement {
	const subject = view === "lanes" ? "Participant assignments" : "Task dependencies";
	return (
		<div
			className="coordinator-empty coordinator-empty-board"
			data-testid={view === "lanes" ? "coordinator-lanes-unavailable" : "coordinator-graph-unavailable"}
		>
			<p className="coordinator-index">COORDINATION READ UNAVAILABLE</p>
			<p className="coordinator-empty-title">
				{subject} could not be established ({COORDINATION_PROBLEM_LABELS[problem]}).
			</p>
			<p className="coordinator-muted">
				This does not mean no {view === "lanes" ? "assignments" : "dependencies"} or worktree hazards exist. Refresh
				to retry the read-only coordination projection.
			</p>
		</div>
	);
}

export function ParticipantLanesView({
	projects,
	taskTitles,
	onJumpToTask,
}: {
	projects: readonly EndoCoordinationProjectViewV0[];
	taskTitles: ReadonlyMap<string, string>;
	onJumpToTask(taskId: string): void;
}): ReactElement {
	const assignments = projects.flatMap((p) => p.assignments);
	const conflicts = projects.flatMap((p) => p.conflicts);
	if (assignments.length === 0) {
		return (
			<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-lanes-empty">
				<p className="coordinator-index">NO RECORDED ASSIGNMENTS</p>
				<p className="coordinator-empty-title">No participant assignments are recorded in this scope.</p>
				<p className="coordinator-muted">
					Assignments express operator intent via CLI (`endo assign create`) and confer no execution authority.
				</p>
			</div>
		);
	}
	const byParticipant = new Map<string, EndoCoordinationAssignmentViewV0[]>();
	for (const a of assignments) {
		byParticipant.set(a.participantId, [...(byParticipant.get(a.participantId) ?? []), a]);
	}
	const participantIds = [...byParticipant.keys()].sort();
	return (
		<div className="coordinator-lanes" data-testid="coordinator-participant-lanes">
			{participantIds.map((participantId) => {
				const items = byParticipant.get(participantId) ?? [];
				const primaryRole = items.find((a) => a.state === "active")?.role ?? items[0]!.role;
				const harness = items.find((a) => a.intendedHarnessFamily !== null)?.intendedHarnessFamily ?? null;
				return (
					<section
						key={participantId}
						className="coordinator-lane"
						data-testid="coordinator-participant-lane"
						data-participant={participantId}
					>
						<header className="coordinator-lane-head">
							<div className="coordinator-lane-id">
								<strong>{participantId}</strong>
								<span className="coordinator-pill" data-role={primaryRole}>
									{ROLE_LABELS[primaryRole]}
								</span>
								{harness !== null ? (
									<span className="coordinator-pill" data-tone="muted">
										{harness}
									</span>
								) : null}
							</div>
							<span className="coordinator-count">{items.length}</span>
						</header>
						<div className="coordinator-lane-cards">
							{items.map((a) => {
								const myConflicts = conflicts.filter((c) => c.assignmentIds.includes(a.assignmentId));
								return (
									<article
										key={a.assignmentId}
										className="coordinator-assign-card"
										data-testid="coordinator-assignment-card"
										data-assignment-state={a.state}
										data-hazard={a.hazard}
									>
										<div className="coordinator-assign-top">
											<button
												type="button"
												className="coordinator-signal-jump"
												onClick={() => onJumpToTask(a.taskId)}
											>
												<span className="coordinator-signal-name">
													{taskTitles.get(a.taskId) ?? shortId(a.taskId)}
												</span>
											</button>
											<span className="coordinator-pill" data-tone={a.state === "active" ? "info" : "muted"}>
												{a.state} · rev {a.revision}
											</span>
											<span
												className="coordinator-pill"
												data-tone={a.taskBinding === "current" ? "neutral" : "attention"}
											>
												binding: {a.taskBinding}
											</span>
										</div>
										<dl className="coordinator-assign-meta">
											<div>
												<dt>Worktree</dt>
												<dd>
													<code>{a.workspace.worktreePath}</code> · {a.workspace.registration} ·{" "}
													{a.workspace.accessIntent === "read-write-intended"
														? "rw-intended"
														: "ro-intended"}
												</dd>
											</div>
											<div>
												<dt>Session</dt>
												<dd>
													{a.session === null ? (
														<span className="coordinator-muted">None declared</span>
													) : (
														<span>
															<code>{a.session.sessionKey}</code> ·{" "}
															{LIVENESS_LABELS[a.session.livenessState ?? "liveness-unknown"]} ·
															termination unconfirmed
															{a.session.lastRecordedAtMs !== null &&
															a.session.lastRecordedAtMs !== undefined ? (
																<>
																	{" "}
																	· last recorded <Timestamp ms={a.session.lastRecordedAtMs} />
																</>
															) : null}
															{a.session.instanceStatus === "recorded-instance-superseded" ? (
																<span className="coordinator-pill" data-tone="attention">
																	instance superseded
																</span>
															) : null}
														</span>
													)}
												</dd>
											</div>
											{a.targetCandidate !== null ? (
												<div>
													<dt>Target candidate</dt>
													<dd>
														<code>{shortId(a.targetCandidate.candidateId)}</code> ·{" "}
														<span
															className="coordinator-pill"
															data-tone={
																a.targetCandidate.relation === "current-candidate"
																	? "neutral"
																	: "attention"
															}
														>
															{a.targetCandidate.relation}
														</span>
													</dd>
												</div>
											) : null}
											{a.attempts.length > 0 ? (
												<div>
													<dt>Attempts</dt>
													<dd>
														<ul className="coordinator-inline-list">
															{a.attempts.map((at) => (
																<li key={at.attemptId}>
																	<code>{shortId(at.attemptId)}</code> ·{" "}
																	{EXECUTION_LABELS[at.execution]}
																</li>
															))}
														</ul>
													</dd>
												</div>
											) : null}
											{a.hazard !== "none" || myConflicts.length > 0 ? (
												<div>
													<dt>Hazards / conflicts</dt>
													<dd>
														{a.hazard !== "none" ? (
															<span
																className="coordinator-pill"
																data-tone={a.hazard === "liveness-unverified" ? "fault" : "muted"}
															>
																hazard: {a.hazard}
															</span>
														) : null}{" "}
														{myConflicts.map((c, idx) => (
															<span
																key={`${c.kind}:${idx}`}
																className="coordinator-pill"
																data-tone={
																	c.kind === "unacknowledged-worktree-write-overlap" ||
																	c.kind === "worktree-liveness-unverified"
																		? "fault"
																		: "attention"
																}
															>
																{CONFLICT_LABELS[c.kind]}
															</span>
														))}
													</dd>
												</div>
											) : null}
											{a.findings.length > 0 ? (
												<div>
													<dt>Findings</dt>
													<dd className="coordinator-muted">{a.findings.join(" · ")}</dd>
												</div>
											) : null}
										</dl>
									</article>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);
}

export function DependencyGraphView({
	projects,
	taskTitles,
	onJumpToTask,
}: {
	projects: readonly EndoCoordinationProjectViewV0[];
	taskTitles: ReadonlyMap<string, string>;
	onJumpToTask(taskId: string): void;
}): ReactElement {
	const dependencies = projects.flatMap((p) => p.dependencies);
	const coordTasks = projects.flatMap((p) => p.tasks);
	const readinessByTask = new Map<string, EndoCoordinationTaskViewV0["readiness"]>(
		coordTasks.map((t) => [t.taskId, t.readiness]),
	);
	if (dependencies.length === 0) {
		return (
			<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-graph-empty">
				<p className="coordinator-index">NO DECLARED DEPENDENCIES</p>
				<p className="coordinator-empty-title">No task dependency edges are recorded in this scope.</p>
				<p className="coordinator-muted">
					Only explicit operator-declared edges (`endo dep add`) are shown here; no relationships are inferred.
				</p>
			</div>
		);
	}
	const involvedTaskIds = [...new Set(dependencies.flatMap((d) => [d.prerequisiteTaskId, d.dependentTaskId]))].sort();
	const layers = computeTopologicalLayers(involvedTaskIds, dependencies);

	// Pure deterministic SVG coordinates for actual declared dependency edges (zero `style={}` props).
	const colWidth = 220;
	const rowHeight = 72;
	const padX = 24;
	const padY = 24;
	const boxW = 164;
	const boxH = 44;
	const coords = new Map<string, { x: number; y: number }>();
	let maxRows = 1;
	layers.forEach((layer, col) => {
		maxRows = Math.max(maxRows, layer.length);
		layer.forEach((taskId, row) => {
			coords.set(taskId, { x: padX + col * colWidth, y: padY + row * rowHeight });
		});
	});
	const svgW = Math.max(420, padX * 2 + Math.max(1, layers.length) * colWidth - (colWidth - boxW));
	const svgH = Math.max(120, padY * 2 + maxRows * rowHeight - (rowHeight - boxH));

	return (
		<div className="coordinator-dep-graph" data-testid="coordinator-dependency-graph">
			<p className="coordinator-muted">
				Actual declared task dependencies only (prerequisite → dependent). Readiness confers zero execution
				authority.
			</p>
			<div className="coordinator-dep-svg-wrap">
				<svg
					className="coordinator-dep-svg"
					viewBox={`0 0 ${svgW} ${svgH}`}
					role="img"
					aria-label="Declared task dependency graph"
				>
					{dependencies.map((d) => {
						const from = coords.get(d.prerequisiteTaskId);
						const to = coords.get(d.dependentTaskId);
						if (from === undefined || to === undefined) return null;
						const x1 = from.x + boxW;
						const y1 = from.y + boxH / 2;
						const x2 = to.x;
						const y2 = to.y + boxH / 2;
						return (
							<line
								key={d.dependencyId}
								x1={x1}
								y1={y1}
								x2={x2}
								y2={y2}
								className="coordinator-dep-edge-line"
								data-satisfaction={d.satisfaction}
							/>
						);
					})}
					{involvedTaskIds.map((taskId) => {
						const pos = coords.get(taskId);
						if (pos === undefined) return null;
						const label = (taskTitles.get(taskId) ?? shortId(taskId)).slice(0, 22);
						const readiness = readinessByTask.get(taskId) ?? "no-dependencies";
						return (
							<g key={taskId} className="coordinator-dep-node" data-readiness={readiness}>
								<rect x={pos.x} y={pos.y} width={boxW} height={boxH} rx={3} />
								<text x={pos.x + 8} y={pos.y + 18} className="coordinator-dep-node-title">
									{label}
								</text>
								<text x={pos.x + 8} y={pos.y + 34} className="coordinator-dep-node-sub">
									{readiness}
								</text>
							</g>
						);
					})}
				</svg>
			</div>
			<ul className="coordinator-dep-edge-list" data-testid="coordinator-dependency-edges">
				{dependencies.map((d) => (
					<li key={d.dependencyId} className="coordinator-dep-edge-row" data-satisfaction={d.satisfaction}>
						<div className="coordinator-dep-edge-main">
							<button
								type="button"
								className="coordinator-signal-jump"
								onClick={() => onJumpToTask(d.prerequisiteTaskId)}
							>
								{taskTitles.get(d.prerequisiteTaskId) ?? shortId(d.prerequisiteTaskId)}
							</button>
							<span aria-hidden="true">→</span>
							<button
								type="button"
								className="coordinator-signal-jump"
								onClick={() => onJumpToTask(d.dependentTaskId)}
							>
								{taskTitles.get(d.dependentTaskId) ?? shortId(d.dependentTaskId)}
							</button>
							<span className="coordinator-pill" data-tone="muted">
								{d.condition}
							</span>
							<span
								className="coordinator-pill"
								data-tone={
									d.satisfaction === "satisfied"
										? "info"
										: d.satisfaction === "unsatisfied"
											? "attention"
											: "muted"
								}
							>
								{SATISFACTION_LABELS[d.satisfaction]}
							</span>
						</div>
						{d.reasons.length > 0 ? <p className="coordinator-muted">Reasons: {d.reasons.join(", ")}</p> : null}
						{d.warnings.length > 0 ? (
							<p className="coordinator-muted">Warnings: {d.warnings.join(", ")}</p>
						) : null}
						<p className="coordinator-muted">Disclosures: {d.disclosures.join(", ")}</p>
					</li>
				))}
			</ul>
		</div>
	);
}

export function CoordinationProvenancePanel({
	projects,
	taskTitles,
}: {
	projects: readonly EndoCoordinationProjectViewV0[];
	taskTitles: ReadonlyMap<string, string>;
}): ReactElement | null {
	const conflicts = projects.flatMap((p) => p.conflicts);
	const worktrees: EndoCoordinationRegisteredWorktreeViewV0[] = projects.flatMap((p) => p.registeredWorktrees ?? []);
	const reviews: EndoCoordinationReviewViewV0[] = projects.flatMap((p) => p.reviews ?? []);
	const tasksWithCandidates = projects.flatMap((p) => p.tasks.filter((t) => t.candidates.length > 0));
	if (conflicts.length === 0 && worktrees.length === 0 && reviews.length === 0 && tasksWithCandidates.length === 0) {
		return null;
	}
	return (
		<div className="coordinator-provenance-groups" data-testid="coordinator-coordination-provenance">
			{conflicts.length > 0 ? (
				<div className="coordinator-scope-group">
					<h3>
						Worktree conflicts &amp; hazards <span className="coordinator-count">{conflicts.length}</span>
					</h3>
					<ul className="coordinator-conflict-list" data-testid="coordinator-conflicts">
						{conflicts.map((c, i) => (
							<li key={`${c.kind}:${c.worktreePath}:${i}`} data-conflict={c.kind}>
								<strong>{CONFLICT_LABELS[c.kind]}</strong>
								<code>{c.worktreePath}</code>
								<span className="coordinator-muted">{c.assignmentIds.map(shortId).join(", ")}</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{worktrees.length > 0 ? (
				<div className="coordinator-scope-group">
					<h3>
						Registered sibling worktrees <span className="coordinator-count">{worktrees.length}</span>
					</h3>
					<ul className="coordinator-conflict-list" data-testid="coordinator-registered-worktrees">
						{worktrees.map((w) => (
							<li key={w.worktreeId}>
								<strong>{w.label ?? shortId(w.worktreeId)}</strong>
								<code>{w.worktreePath}</code>
								<span className="coordinator-muted">
									{w.observation}
									{w.headCommit !== null ? ` · HEAD ${w.headCommit.slice(0, 12)}` : ""}
									{w.clean !== null ? ` · ${w.clean ? "clean" : "dirty"}` : ""}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{tasksWithCandidates.length > 0 ? (
				<div className="coordinator-scope-group">
					<h3>
						Candidates &amp; host receipts <span className="coordinator-count">{tasksWithCandidates.length}</span>
					</h3>
					<ul className="coordinator-review-list" data-testid="coordinator-candidates">
						{tasksWithCandidates.map((t) => (
							<li key={t.taskId}>
								<strong>{taskTitles.get(t.taskId) ?? shortId(t.taskId)}</strong>
								<span className="coordinator-muted">readiness: {t.readiness}</span>
								<ul className="coordinator-inline-list">
									{t.candidates.map((c) => (
										<li key={c.candidateId}>
											<code>{shortId(c.candidateId)}</code> ({c.kind}) · {c.relation} · identity:{" "}
											{c.identity} · workspace: {c.workspace} · host receipts: {c.receipts}
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{reviews.length > 0 ? (
				<div className="coordinator-scope-group">
					<h3>
						Advisory reviews <span className="coordinator-count">{reviews.length}</span>
					</h3>
					<p className="coordinator-muted">Agent-reported advisory reviews only — never host check receipts.</p>
					<ul className="coordinator-review-list" data-testid="coordinator-reviews">
						{reviews.map((r) => (
							<li key={r.reviewId} data-candidate-relation={r.candidateRelation}>
								<div className="coordinator-review-head">
									<strong>{r.reviewerParticipantId}</strong>
									<span className="coordinator-pill" data-tone="muted">
										{r.verdict}
									</span>
									<span
										className="coordinator-pill"
										data-tone={r.candidateRelation === "current-candidate" ? "neutral" : "attention"}
									>
										{r.candidateRelation}
									</span>
								</div>
								<p className="coordinator-muted">
									Candidate <code>{shortId(r.candidateId)}</code> ({r.candidateKind}) · standing: {r.standing}{" "}
									· checkout: {r.checkoutStanding} (
									{r.checkoutCleanAtCandidate ? "clean at candidate" : "unverified"}) · findings: C
									{r.findingCounts.critical}/H{r.findingCounts.high}/M{r.findingCounts.medium}/L
									{r.findingCounts.low}/I{r.findingCounts.info}
								</p>
								{r.agentClaimedChecksPresent ? (
									<p className="coordinator-muted">
										Agent claimed checks ran (unverified statement; not a host receipt).
									</p>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
