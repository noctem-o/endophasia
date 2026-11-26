import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EndoCoordinatorCoordinationV0 } from "../../../protocol/coordinator-coordination.ts";
import {
	ENDO_COORDINATOR_AUTHORITY_V0,
	ENDO_COORDINATOR_NOT_ESTABLISHED_V0,
	type EndoCoordinatorPhaseV0,
	type EndoCoordinatorStatusV0,
} from "../../../protocol/coordinator-status.ts";
import { FieldLayer, FieldLegend, useReducedMotion } from "../develop/Field.tsx";
import type { FieldSignal } from "../model/field.ts";
import type { Atmosphere } from "../model/weather.ts";
import type { WorkbenchState } from "../model/workbench.ts";
import {
	CoordinationBanner,
	CoordinationProvenancePanel,
	DependencyGraphView,
	ParticipantLanesView,
} from "./CoordinationViews.tsx";
import { Freshness, SessionCard, TaskCard, Timestamp } from "./Evidence.tsx";
import { ATTENTION_LABELS, type CoordinatorProblem } from "./read.ts";
import { useCoordinator } from "./use-coordinator.ts";

const PHASES = ["open", "in-progress", "blocked", "awaiting-review", "completed"] as const;
const PHASE_LABELS = {
	open: "Open",
	"in-progress": "In progress",
	blocked: "Blocked",
	"awaiting-review": "Awaiting review",
	completed: "Completed",
} satisfies Record<EndoCoordinatorPhaseV0, string>;

const FINDING_SEVERITY_LABELS = {
	contradiction: "Contradiction",
	integrity: "Integrity",
	stale: "Stale",
	incomplete: "Incomplete",
	unavailable: "Unavailable",
	info: "Info",
} satisfies Record<EndoCoordinatorStatusV0["findings"][number]["severity"], string>;

const PROBLEMS = {
	"grant-required": "This page no longer holds the grant. Pair again in Develop.",
	forbidden: "The workspace no longer permits this project scope. Previous records were discarded.",
	"not-found": "This host does not currently offer a Coordinator read.",
	"too-many-requests": "The host is pacing reads. Wait a moment and refresh.",
	unavailable: "The host could not provide the Coordinator read. Previous records were discarded.",
	invalid:
		"The Coordinator response was malformed, unsupported or outside its declared scope. Nothing from it was accepted.",
	unreachable: "The Coordinator read could not reach the host or read its response.",
	timeout: "The Coordinator read timed out. Refresh to try again.",
} satisfies Record<CoordinatorProblem, string>;

interface Filters {
	project: string | null;
	phase: EndoCoordinatorPhaseV0 | null;
}

type ViewMode = "list" | "columns" | "lanes" | "graph";
type Density = "standard" | "compact";

const NO_FILTERS: Filters = { project: null, phase: null };

function SignalList({
	label,
	testId,
	children,
}: {
	label: string;
	testId: string;
	children: ReactElement[];
}): ReactElement {
	return (
		<div className="coordinator-signal-list" data-testid={testId}>
			<ul className="coordinator-signals">{children.slice(0, 2)}</ul>
			{children.length > 2 ? (
				<details>
					<summary>
						{children.length - 2} more {label}
					</summary>
					<ul className="coordinator-signals">{children.slice(2)}</ul>
				</details>
			) : null}
		</div>
	);
}

function SummaryStrip({ status, filters }: { status: EndoCoordinatorStatusV0; filters: Filters }): ReactElement {
	const tasksReady = status.sources.tasks.state === "ready";
	const selected = status.projects.find((project) => project.id === filters.project);
	const projects = selected === undefined ? status.projects : [selected];
	const tasks = projects.flatMap((project) => project.tasks);
	const taskIds = new Set(tasks.map((task) => task.taskId));
	const sessions =
		selected === undefined
			? status.sessions
			: status.sessions.filter((session) => session.links.some((link) => taskIds.has(link.taskId)));
	const subjects = new Set([selected?.id, ...taskIds, ...sessions.map((session) => session.sessionId)]);
	const inView = (item: { subject: string | null }) =>
		selected === undefined || item.subject === null || subjects.has(item.subject);
	const countsKnown = tasksReady && projects.length > 0;
	const awaitingReview = projects.reduce((total, project) => total + project.counts["awaiting-review"], 0);
	const failingTasks = tasks.filter((task) => task.verification.state === "failing").length;
	const contradictionCount = status.findings.filter(
		(finding) => finding.severity === "contradiction" && inView(finding),
	).length;
	const activeSessions = sessions.filter((session) => session.observation === "active").length;
	const lastObservedSessions = sessions.length - activeSessions;
	const sourceList = [status.sources.tasks, status.sources.attempts, status.sources.events];
	const readySources = sourceList.filter((source) => source.state === "ready").length;
	const alertCount = failingTasks + contradictionCount;
	const eventsUnavailable = status.sources.events.state === "unavailable";
	return (
		<dl className="coordinator-summary" data-testid="coordinator-summary">
			<div className="coordinator-metric">
				<dt>Scope</dt>
				<dd>
					{selected === undefined
						? `${status.projects.length} ${status.projects.length === 1 ? "project" : "projects"}`
						: selected.name || "Unnamed project"}
				</dd>
			</div>
			<div className="coordinator-metric">
				<dt>Recorded tasks</dt>
				<dd>{countsKnown ? tasks.length : "Unavailable"}</dd>
			</div>
			<div className="coordinator-metric" data-tone={countsKnown && awaitingReview > 0 ? "info" : undefined}>
				<dt>Awaiting review</dt>
				<dd>{countsKnown ? awaitingReview : "—"}</dd>
			</div>
			<div className="coordinator-metric" data-tone={countsKnown && alertCount > 0 ? "fault" : undefined}>
				<dt>Failing / contradictions</dt>
				<dd>
					{countsKnown ? (
						<>
							{failingTasks} failing · {contradictionCount}{" "}
							{contradictionCount === 1 ? "contradiction" : "contradictions"}
						</>
					) : (
						"Unavailable"
					)}
				</dd>
			</div>
			<div className="coordinator-metric" data-tone={eventsUnavailable ? "attention" : undefined}>
				<dt>Listed sessions</dt>
				<dd>
					{eventsUnavailable ? (
						"Unavailable"
					) : (
						<>
							{activeSessions} recorded active · {lastObservedSessions} last observed
						</>
					)}
				</dd>
			</div>
			<div className="coordinator-metric" data-tone={readySources < 3 ? "attention" : undefined}>
				<dt>Record sources</dt>
				<dd>{readySources === 3 ? "3 of 3 fresh" : `${readySources} of 3 fresh · degraded`}</dd>
			</div>
		</dl>
	);
}

function Board({
	status,
	coordination,
	filters,
	onFilters,
	viewMode,
	onViewMode,
	density,
	onDensity,
	highlightedTaskId,
	onJumpToTask,
	onClearHighlight,
}: {
	status: EndoCoordinatorStatusV0;
	coordination: EndoCoordinatorCoordinationV0 | null;
	filters: Filters;
	onFilters(filters: Filters): void;
	viewMode: ViewMode;
	onViewMode(mode: ViewMode): void;
	density: Density;
	onDensity(density: Density): void;
	highlightedTaskId: string | null;
	onJumpToTask(taskId: string): void;
	onClearHighlight(): void;
}): ReactElement {
	const tasksReady = status.sources.tasks.state === "ready";
	const selected = status.projects.find((project) => project.id === filters.project);
	const projects = selected === undefined ? status.projects : [selected];
	const coordProjects =
		coordination === null
			? []
			: selected === undefined
				? coordination.projects
				: coordination.projects.filter((p) => p.id === selected.id);
	const tasks = projects.flatMap((project) => project.tasks);
	const taskIds = new Set(tasks.map((task) => task.taskId));
	const taskTitles = new Map(tasks.map((task) => [task.taskId, task.title]));
	const sessions =
		selected === undefined
			? status.sessions
			: status.sessions.filter((session) => session.links.some((link) => taskIds.has(link.taskId)));
	const subjects = new Set([selected?.id, ...taskIds, ...sessions.map((session) => session.sessionId)]);
	const inView = (item: { subject: string | null }) =>
		selected === undefined || item.subject === null || subjects.has(item.subject);
	const attention = status.attention.filter(inView);
	const findings = status.findings.filter(inView);
	const phase = filters.phase;
	const visibleCount =
		phase === null ? tasks.length : projects.reduce((total, project) => total + project.counts[phase], 0);
	const countsKnown = tasksReady && projects.length > 0;
	const { unlistedSessions } = status;
	return (
		<div className="coordinator-grid">
			<section className="coordinator-panel coordinator-scope" aria-labelledby="coordinator-scope-title">
				<header className="coordinator-panel-head">
					<span className="coordinator-index">01 / SCOPE</span>
					<h2 id="coordinator-scope-title">Project scope</h2>
				</header>
				<div className="coordinator-scope-group">
					<h3>
						Projects <span className="coordinator-count">{status.projects.length}</span>
					</h3>
					{status.projects.length > 1 ? (
						<button
							className="coordinator-filter"
							type="button"
							aria-pressed={selected === undefined}
							onClick={() => onFilters({ ...filters, project: null })}
						>
							<span>All reported projects</span>
							<span className="coordinator-count">{status.projects.length}</span>
						</button>
					) : null}
					<div className="coordinator-project-list">
						{status.projects.map((project) => (
							<div
								className="coordinator-project"
								key={project.id}
								data-selected={selected?.id === project.id ? "true" : undefined}
							>
								{status.projects.length > 1 ? (
									<button
										className="coordinator-filter"
										type="button"
										aria-pressed={selected?.id === project.id}
										data-testid="coordinator-project"
										onClick={() => onFilters({ ...filters, project: project.id })}
									>
										<span className="coordinator-project-title">{project.name || "Unnamed project"}</span>
										<span className="coordinator-count">{project.tasks.length}</span>
									</button>
								) : (
									<div className="coordinator-project-single">
										<strong>{project.name || "Unnamed project"}</strong>
										<span className="coordinator-count">{project.tasks.length}</span>
									</div>
								)}
								<div className="coordinator-project-meta">
									{project.head === null ? (
										<span className="coordinator-head-missing">HEAD unavailable</span>
									) : (
										<span className="coordinator-head-ref">
											HEAD <code title={project.head.commit}>{project.head.commit.slice(0, 12)}</code> ·{" "}
											<span data-clean={project.head.clean ? "true" : "false"}>
												{project.head.clean ? "clean" : "changed tree"}
											</span>
										</span>
									)}
									<Freshness state={project.freshness.state} />
									{project.freshness.reason === null ? null : <p>{project.freshness.reason}</p>}
								</div>
							</div>
						))}
					</div>
					{status.scope.unknown.length > 0 ? (
						<p className="coordinator-muted">
							{status.scope.unknown.length} requested{" "}
							{status.scope.unknown.length === 1 ? "project was" : "projects were"} not established. Counts cover
							reported projects only.
						</p>
					) : !tasksReady ? (
						<p className="coordinator-muted">Project and task records could not be established.</p>
					) : null}
				</div>
				<div className="coordinator-scope-group">
					<h3>Task phases</h3>
					{countsKnown ? (
						<div className="coordinator-phases">
							<button
								type="button"
								className="coordinator-filter"
								data-phase="all"
								aria-pressed={filters.phase === null}
								onClick={() => onFilters({ ...filters, phase: null })}
							>
								All phases <span className="coordinator-count">{tasks.length}</span>
							</button>
							{PHASES.map((phase) => (
								<button
									key={phase}
									type="button"
									className="coordinator-filter"
									aria-pressed={filters.phase === phase}
									data-phase={phase}
									onClick={() => onFilters({ ...filters, phase })}
								>
									{PHASE_LABELS[phase]}{" "}
									<span className="coordinator-count">
										{projects.reduce((total, project) => total + project.counts[phase], 0)}
									</span>
								</button>
							))}
						</div>
					) : (
						<p className="coordinator-muted">Phase counts are unavailable, not zero.</p>
					)}
					<p className="coordinator-muted">Phases come from the operator’s task records.</p>
				</div>
				<div className="coordinator-scope-group">
					<h3>Record sources</h3>
					<dl className="coordinator-sources">
						{(["tasks", "attempts", "events"] as const).map((key) => {
							const source = status.sources[key];
							const note = source.freshness.reason;
							return (
								<div key={key} data-source={key} data-source-state={source.state}>
									<dt>{key === "events" ? "Event log" : key === "tasks" ? "Tasks" : "Attempts"}</dt>
									<dd>
										<Freshness state={source.freshness.state} />
										{source.state === "missing" ? <span>Records missing</span> : null}
										{source.state !== "ready" && note !== null ? (
											<span className="coordinator-source-note">{note}</span>
										) : null}
									</dd>
								</div>
							);
						})}
					</dl>
				</div>
			</section>
			<section
				className="coordinator-panel coordinator-mission"
				aria-labelledby="coordinator-mission-title"
				data-view={viewMode}
				data-density={density}
			>
				<header className="coordinator-panel-head coordinator-mission-head">
					<div className="coordinator-mission-title">
						<span className="coordinator-index">02 / TASKS</span>
						<h2 id="coordinator-mission-title">Task board</h2>
						<output className="coordinator-muted">
							{countsKnown
								? `${visibleCount} of ${tasks.length} recorded tasks · ${filters.phase === null ? "All phases" : PHASE_LABELS[filters.phase]}${viewMode === "columns" ? " · Grouped by operator phase (read-only)" : ""}`
								: "No reliable task count for this read"}
						</output>
					</div>
					<div className="coordinator-toolbar">
						<fieldset className="coordinator-segmented">
							<legend className="sr-only">Task view mode</legend>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-view-list"
								aria-pressed={viewMode === "list"}
								onClick={() => onViewMode("list")}
							>
								List
							</button>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-view-columns"
								aria-pressed={viewMode === "columns"}
								onClick={() => onViewMode("columns")}
							>
								Columns
							</button>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-view-lanes"
								aria-pressed={viewMode === "lanes"}
								onClick={() => onViewMode("lanes")}
							>
								Lanes
							</button>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-view-graph"
								aria-pressed={viewMode === "graph"}
								onClick={() => onViewMode("graph")}
							>
								Graph
							</button>
						</fieldset>
						<fieldset className="coordinator-segmented">
							<legend className="sr-only">Task card density</legend>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-density-standard"
								aria-pressed={density === "standard"}
								onClick={() => onDensity("standard")}
							>
								Standard
							</button>
							<button
								type="button"
								className="coordinator-seg-btn"
								data-testid="coordinator-density-compact"
								aria-pressed={density === "compact"}
								onClick={() => onDensity("compact")}
							>
								Compact
							</button>
						</fieldset>
					</div>
				</header>
				{coordination !== null ? <CoordinationBanner coordination={coordination} /> : null}
				{viewMode === "lanes" ? (
					<ParticipantLanesView
						projects={coordProjects}
						taskTitles={taskTitles}
						onJumpToTask={(taskId) => {
							onViewMode("list");
							onJumpToTask(taskId);
						}}
					/>
				) : viewMode === "graph" ? (
					<DependencyGraphView
						projects={coordProjects}
						taskTitles={taskTitles}
						onJumpToTask={(taskId) => {
							onViewMode("list");
							onJumpToTask(taskId);
						}}
					/>
				) : visibleCount === 0 ? (
					<div className="coordinator-empty coordinator-empty-board">
						<p className="coordinator-index">
							{!countsKnown
								? "RECORDS NOT ESTABLISHED"
								: tasks.length === 0
									? "NO RECORDED TASKS"
									: "NO MATCHING PHASE"}
						</p>
						<p className="coordinator-empty-title">
							{!countsKnown
								? "Tasks could not be established for this scope. This does not mean there are no tasks."
								: tasks.length === 0
									? "No tasks are recorded in the selected project scope."
									: "No recorded tasks match this phase."}
						</p>
						{countsKnown && tasks.length === 0 ? (
							<p className="coordinator-muted">
								Project scope and record sources are readable. Tasks recorded by the operator in Develop appear
								here on refresh.
							</p>
						) : null}
					</div>
				) : viewMode === "columns" ? (
					<div className="coordinator-columns" data-testid="coordinator-board-columns">
						{(filters.phase === null ? PHASES : [filters.phase]).map((columnPhase) => {
							const columnTasks = tasks.filter((task) => task.phase === columnPhase);
							const projectNames = new Map(projects.map((p) => [p.id, p.name || "Unnamed project"]));
							return (
								<section
									key={columnPhase}
									className="coordinator-column"
									data-column-phase={columnPhase}
									aria-label={`${PHASE_LABELS[columnPhase]} phase column`}
								>
									<header className="coordinator-column-head">
										<span className="coordinator-phase-tag" data-phase={columnPhase}>
											{PHASE_LABELS[columnPhase]}
										</span>
										<span className="coordinator-count">{columnTasks.length}</span>
									</header>
									{columnTasks.length === 0 ? (
										<p className="coordinator-column-empty">No recorded tasks</p>
									) : (
										<div className="coordinator-column-cards">
											{columnTasks.map((task) => (
												<TaskCard
													key={task.taskId}
													task={task}
													phaseLabel={PHASE_LABELS[task.phase]}
													projectLabel={projects.length > 1 ? projectNames.get(task.projectId) : undefined}
													inColumn={true}
													highlighted={highlightedTaskId === task.taskId}
													findings={findings.filter((finding) => finding.subject === task.taskId)}
													attemptsReady={status.sources.attempts.state === "ready"}
												/>
											))}
										</div>
									)}
								</section>
							);
						})}
					</div>
				) : (
					projects.map((project) => {
						const visible = project.tasks.filter(
							(task) => filters.phase === null || task.phase === filters.phase,
						);
						if (visible.length === 0) return null;
						return (
							<div key={project.id} className="coordinator-task-group">
								{projects.length > 1 ? (
									<div className="coordinator-group-head">
										<p className="coordinator-index">{project.name || "Unnamed project"}</p>
										<span className="coordinator-count">{visible.length} shown</span>
									</div>
								) : null}
								<div className="coordinator-task-list">
									{visible.map((task) => (
										<TaskCard
											key={task.taskId}
											task={task}
											phaseLabel={PHASE_LABELS[task.phase]}
											highlighted={highlightedTaskId === task.taskId}
											findings={findings.filter((finding) => finding.subject === task.taskId)}
											attemptsReady={status.sources.attempts.state === "ready"}
										/>
									))}
								</div>
							</div>
						);
					})
				)}
				{highlightedTaskId !== null && taskIds.has(highlightedTaskId) ? (
					<div className="coordinator-highlight-bar">
						<span className="coordinator-muted">
							Focused task: <strong>{taskTitles.get(highlightedTaskId) || highlightedTaskId}</strong>
						</span>
						<button type="button" className="coordinator-link-btn" onClick={onClearHighlight}>
							Clear focus (Esc)
						</button>
					</div>
				) : null}
			</section>
			<aside className="coordinator-panel coordinator-context" aria-labelledby="coordinator-attention-title">
				<header className="coordinator-panel-head">
					<span className="coordinator-index">03 / SIGNALS</span>
					<h2 id="coordinator-attention-title">Attention &amp; sessions</h2>
				</header>
				<div className="coordinator-scope-group">
					<h3>
						Attention <span className="coordinator-count">{attention.length} items</span>
					</h3>
					<p className="coordinator-muted">Advisory triage, not a verification verdict.</p>
					{attention.length === 0 ? (
						<p className="coordinator-empty">No attention items were reported for this view.</p>
					) : (
						<SignalList label="attention items" testId="coordinator-attention">
							{attention.map((item, i) => {
								const targetId = item.subject !== null && taskTitles.has(item.subject) ? item.subject : null;
								return (
									<li
										key={`${item.kind}:${item.subject}:${i}`}
										data-kind={item.kind}
										data-highlighted={
											targetId !== null && highlightedTaskId === targetId ? "true" : undefined
										}
									>
										<strong>{ATTENTION_LABELS[item.kind]}</strong>
										{targetId !== null ? (
											<button
												type="button"
												className="coordinator-signal-jump"
												data-testid="coordinator-attention-jump"
												data-target-task={targetId}
												onClick={() => onJumpToTask(targetId)}
											>
												<span className="coordinator-signal-name">
													{taskTitles.get(targetId) || "Untitled task"}
												</span>
												<span className="coordinator-jump-cue" aria-hidden="true">
													Inspect →
												</span>
											</button>
										) : null}
										<p>{item.text}</p>
									</li>
								);
							})}
						</SignalList>
					)}
				</div>
				<div className="coordinator-scope-group">
					<h3>
						Session records <span className="coordinator-count">{sessions.length} shown</span>
					</h3>
					<p className="coordinator-muted">Recorded activity does not establish liveness.</p>
					{sessions.length === 0 ? (
						<p className="coordinator-empty">
							{status.sources.events.state !== "ready"
								? "Event evidence is unavailable or incomplete. Session activity cannot be ruled out."
								: "No session records with an explicit link to tasks in this view were listed."}
						</p>
					) : (
						sessions.map((session) => (
							<SessionCard
								key={session.sessionId}
								session={session}
								taskTitles={taskTitles}
								onJumpToTask={onJumpToTask}
							/>
						))
					)}
					{unlistedSessions.unknownRelationship > 0 || unlistedSessions.outOfScope > 0 ? (
						<div className="coordinator-unlisted" data-testid="coordinator-unlisted-sessions">
							<p className="coordinator-index">Not listed · whole host read</p>
							{unlistedSessions.unknownRelationship > 0 ? (
								<p>
									{unlistedSessions.unknownRelationship} with unknown task relationship;{" "}
									{unlistedSessions.unknownActive} recorded active. No association was inferred.
								</p>
							) : null}
							{unlistedSessions.outOfScope > 0 ? (
								<p>{unlistedSessions.outOfScope} linked only outside scope. Their activity is not reported.</p>
							) : null}
						</div>
					) : null}
				</div>
				<CoordinationProvenancePanel projects={coordProjects} taskTitles={taskTitles} />
				<div className="coordinator-scope-group">
					<h3>
						Read findings <span className="coordinator-count">{findings.length} items</span>
					</h3>
					{findings.length === 0 ? (
						<p className="coordinator-muted">No findings were reported for this view.</p>
					) : (
						<SignalList label="read findings" testId="coordinator-findings">
							{findings.map((finding, i) => {
								const targetId =
									finding.subject !== null && taskTitles.has(finding.subject) ? finding.subject : null;
								return (
									<li
										key={`${finding.code}:${finding.subject}:${i}`}
										data-kind={finding.severity}
										data-finding={finding.code}
										data-highlighted={
											targetId !== null && highlightedTaskId === targetId ? "true" : undefined
										}
									>
										<strong>{FINDING_SEVERITY_LABELS[finding.severity]}</strong>
										{targetId !== null ? (
											<button
												type="button"
												className="coordinator-signal-jump"
												data-target-task={targetId}
												onClick={() => onJumpToTask(targetId)}
											>
												<span className="coordinator-signal-name">
													{taskTitles.get(targetId) || "Untitled task"}
												</span>
												<span className="coordinator-jump-cue" aria-hidden="true">
													Inspect →
												</span>
											</button>
										) : null}
										<p>{finding.text}</p>
									</li>
								);
							})}
						</SignalList>
					)}
				</div>
			</aside>
		</div>
	);
}

export function CoordinatorWorkspace({
	workbench,
	onGrantRequired,
	onHostRefresh,
	onDevelop,
	appearance,
	atmosphere,
	paused,
	onPause,
	onAtmosphere,
}: {
	workbench: WorkbenchState;
	onGrantRequired(): void;
	onHostRefresh(): void;
	onDevelop(): void;
	appearance: "instrument" | "field";
	atmosphere: Atmosphere;
	paused: boolean;
	onPause(value: boolean): void;
	onAtmosphere(value: Atmosphere): void;
}): ReactElement {
	const isHost = workbench.availability === "workspace";
	const grant = isHost ? workbench.grant : null;
	const workspaceRef = useRef<HTMLDivElement>(null);
	const refreshButton = useRef<HTMLButtonElement>(null);
	const pairingButton = useRef<HTMLButtonElement>(null);
	const focusPairing = useRef(false);
	const [grantRefused, setGrantRefused] = useState(false);
	const [filters, setFilters] = useState(NO_FILTERS);
	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [density, setDensity] = useState<Density>("standard");
	const [highlightedTask, setHighlightedTask] = useState<{ id: string; seq: number } | null>(null);
	const { reply, coordinationReply, busy, refresh } = useCoordinator(grant, workbench.launchId, () => {
		focusPairing.current = refreshButton.current === document.activeElement;
		setGrantRefused(true);
		setFilters(NO_FILTERS);
		setHighlightedTask(null);
		onGrantRequired();
	});
	useLayoutEffect(() => {
		if (grant !== null) {
			setGrantRefused(false);
			return;
		}
		setFilters(NO_FILTERS);
		setHighlightedTask(null);
		if (!focusPairing.current) return;
		focusPairing.current = false;
		pairingButton.current?.focus();
	}, [grant]);
	const status = reply?.kind === "status" ? reply.status : null;
	const coordination = coordinationReply?.kind === "coordination" ? coordinationReply.coordination : null;
	const problem = reply?.kind === "failure" ? reply.problem : null;
	useLayoutEffect(() => {
		if (problem === "forbidden") {
			setFilters(NO_FILTERS);
			setHighlightedTask(null);
		}
	}, [problem]);
	const reduced = useReducedMotion();
	useLayoutEffect(() => {
		if (highlightedTask === null || workspaceRef.current === null) return;
		const cards = workspaceRef.current.querySelectorAll<HTMLElement>("[data-testid='coordinator-task']");
		for (const card of cards) {
			if (card.dataset.taskId === highlightedTask.id) {
				card.scrollIntoView({ block: "nearest", behavior: reduced ? "instant" : "smooth" });
				const summary = card.querySelector<HTMLElement>("[data-testid='coordinator-task-evidence'] > summary");
				summary?.focus();
				break;
			}
		}
	}, [highlightedTask, reduced]);
	useEffect(() => {
		if (highlightedTask === null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setHighlightedTask(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [highlightedTask]);
	const jumpToTask = (taskId: string) => {
		if (status !== null) {
			const target = status.projects.flatMap((project) => project.tasks).find((task) => task.taskId === taskId);
			if (target !== undefined && filters.phase !== null && filters.phase !== target.phase) {
				setFilters({ ...filters, phase: null });
			}
		}
		setHighlightedTask((current) => ({ id: taskId, seq: (current?.seq ?? 0) + 1 }));
	};
	const field = appearance === "field";
	const still = reduced || paused;
	const signal: FieldSignal = {
		motion: still ? "still" : "drift",
		tempo: still ? 0 : 0.22,
		texture: "solid",
		attention: false,
		presence: 0.72,
		pulse: 0,
		responsive: false,
		words: still
			? "Still contours. The atmosphere is scenery, not a signal."
			: "Slow contours. The atmosphere is scenery, not a signal.",
		state: "The board shows records as of the last successful read.",
	};
	const hostUnknown = workbench.availability === "unknown";
	const mode = busy
		? "loading"
		: status !== null
			? "ready"
			: problem !== null
				? problem
				: isHost
					? "unpaired"
					: hostUnknown
						? "discovering"
						: "unsupported";
	const emptyNote = busy
		? "Reading the paired workspace. Previous records are not shown while a read is pending."
		: problem !== null
			? PROBLEMS[problem]
			: isHost
				? grantRefused
					? PROBLEMS["grant-required"]
					: "Pair this page from Develop using the code from the workspace host’s terminal. The board reads only the scope the host grants."
				: hostUnknown
					? workbench.problem === null
						? "Checking whether this Studio is connected to a workspace host."
						: "Studio could not confirm the host type. Check the host again to continue."
					: "Coordinator is available only from a paired workspace host opened with endo workspace open. This Studio host does not support it.";
	const gateTone =
		problem === "invalid" || problem === "forbidden" || problem === "unavailable"
			? "fault"
			: isHost && grant === null
				? "attention"
				: problem !== null
					? "attention"
					: "info";
	const gateEyebrow = busy
		? "STATUS / READING WORKSPACE"
		: problem === "invalid"
			? "STATUS / RESPONSE REJECTED"
			: problem === "forbidden"
				? "STATUS / SCOPE FORBIDDEN"
				: problem !== null
					? "STATUS / READ UNAVAILABLE"
					: isHost
						? grantRefused
							? "STATUS / GRANT REVOKED"
							: "STATUS / PAIRING REQUIRED"
						: hostUnknown
							? "STATUS / CHECKING HOST"
							: "STATUS / WORKSPACE HOST REQUIRED";
	return (
		<div
			ref={workspaceRef}
			className="coordinator"
			data-testid="coordinator-workspace"
			data-appearance={appearance}
			data-atmosphere={field ? atmosphere : undefined}
			data-state={mode}
		>
			{field ? <FieldLayer signal={signal} atmosphere={atmosphere} paused={paused} /> : null}
			<div className="coordinator-content">
				<header className="coordinator-hero">
					<div className="coordinator-hero-top">
						<div className="coordinator-hero-title">
							<p className="coordinator-index">COORDINATOR / WORKSPACE RECORDS</p>
							<h1>Mission Board</h1>
							<p className="coordinator-intro">
								Read-only projection of task status, check evidence, and recorded sessions.
							</p>
						</div>
						<div className="coordinator-read">
							<div className="coordinator-tags">
								<span className="coordinator-readonly">Read-only</span>
								{grant !== null ? (
									<button
										type="button"
										className="btn"
										ref={refreshButton}
										data-testid="coordinator-refresh"
										aria-disabled={busy}
										onClick={refresh}
									>
										{busy ? "Reading…" : "Refresh"}
									</button>
								) : null}
							</div>
							<p className="coordinator-muted">
								{status === null ? (
									"No snapshot shown"
								) : (
									<>
										Snapshot · <Timestamp ms={status.readAtMs} />
									</>
								)}
							</p>
						</div>
					</div>
					{status !== null ? <SummaryStrip status={status} filters={filters} /> : null}
				</header>
				<output className="sr-only">{status === null ? emptyNote : "Coordinator snapshot ready."}</output>
				{status === null ? (
					<div className="coordinator-panel coordinator-gate" data-gate-tone={gateTone}>
						<p className="coordinator-index">{gateEyebrow}</p>
						<h2>
							{busy
								? "Reading workspace"
								: problem !== null
									? "Read not available"
									: isHost
										? "Pairing required"
										: hostUnknown
											? "Workspace host"
											: "Workspace host required"}
						</h2>
						<p>{emptyNote}</p>
						{isHost && grant === null ? (
							<button type="button" ref={pairingButton} className="btn" onClick={onDevelop}>
								Open Develop to pair
							</button>
						) : null}
						{hostUnknown && workbench.problem !== null ? (
							<button type="button" className="btn" disabled={workbench.busy} onClick={onHostRefresh}>
								Check host
							</button>
						) : null}
					</div>
				) : (
					<>
						<Board
							status={status}
							coordination={coordination}
							filters={filters}
							onFilters={setFilters}
							viewMode={viewMode}
							onViewMode={setViewMode}
							density={density}
							onDensity={setDensity}
							highlightedTaskId={highlightedTask?.id ?? null}
							onJumpToTask={jumpToTask}
							onClearHighlight={() => setHighlightedTask(null)}
						/>
						<details className="coordinator-limits coordinator-panel" data-testid="coordinator-limits">
							<summary>
								Reading limits <span>· Decisions stay with the operator</span>
							</summary>
							<div className="coordinator-evidence-body">
								<p>
									Recorded session freshness uses a {status.staleAfterMs / 1000}-second window at the time of
									the read.
								</p>
								<ul>
									{[...ENDO_COORDINATOR_AUTHORITY_V0.notes, ...ENDO_COORDINATOR_NOT_ESTABLISHED_V0].map(
										(note) => (
											<li key={note}>{note}</li>
										),
									)}
								</ul>
							</div>
						</details>
					</>
				)}
				{field ? (
					<FieldLegend
						signal={signal}
						atmosphere={atmosphere}
						paused={paused}
						reduced={reduced}
						onPause={onPause}
						onAtmosphere={onAtmosphere}
					/>
				) : null}
			</div>
		</div>
	);
}
