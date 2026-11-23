import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
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

function Board({
	status,
	filters,
	onFilters,
}: {
	status: EndoCoordinatorStatusV0;
	filters: Filters;
	onFilters(filters: Filters): void;
}): ReactElement {
	const tasksReady = status.sources.tasks.state === "ready";
	const selected = status.projects.find((project) => project.id === filters.project);
	const projects = selected === undefined ? status.projects : [selected];
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
					<h3>Projects</h3>
					{status.projects.length > 1 ? (
						<button
							className="coordinator-filter"
							type="button"
							aria-pressed={selected === undefined}
							onClick={() => onFilters({ ...filters, project: null })}
						>
							All reported projects <span className="coordinator-count">{status.projects.length}</span>
						</button>
					) : null}
					{status.projects.map((project) => (
						<div className="coordinator-project" key={project.id}>
							{status.projects.length > 1 ? (
								<button
									className="coordinator-filter"
									type="button"
									aria-pressed={selected?.id === project.id}
									data-testid="coordinator-project"
									onClick={() => onFilters({ ...filters, project: project.id })}
								>
									<span>{project.name || "Unnamed project"}</span>
								</button>
							) : (
								<strong>{project.name || "Unnamed project"}</strong>
							)}
							<div className="coordinator-project-meta">
								{project.head === null ? (
									<span>HEAD unavailable</span>
								) : (
									<span>
										HEAD <code title={project.head.commit}>{project.head.commit.slice(0, 12)}</code> ·{" "}
										{project.head.clean ? "clean" : "changed tree"}
									</span>
								)}
								<Freshness state={project.freshness.state} />
								{project.freshness.reason === null ? null : <p>{project.freshness.reason}</p>}
							</div>
						</div>
					))}
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
							return (
								<div key={key} data-source={key} data-source-state={source.state}>
									<dt>{key === "events" ? "Event log" : key === "tasks" ? "Tasks" : "Attempts"}</dt>
									<dd>
										<Freshness state={source.freshness.state} />
										{source.state === "missing" ? <span>Records missing</span> : null}
									</dd>
								</div>
							);
						})}
					</dl>
				</div>
			</section>
			<section className="coordinator-panel coordinator-mission" aria-labelledby="coordinator-mission-title">
				<header className="coordinator-panel-head">
					<span className="coordinator-index">02 / TASKS</span>
					<h2 id="coordinator-mission-title">Task board</h2>
					<output className="coordinator-muted">
						{countsKnown
							? `${visibleCount} of ${tasks.length} recorded tasks · ${filters.phase === null ? "All phases" : PHASE_LABELS[filters.phase]}`
							: "No reliable task count for this read"}
					</output>
				</header>
				{visibleCount === 0 ? (
					<p className="coordinator-empty">
						{!countsKnown
							? "Tasks could not be established for this scope. This does not mean there are no tasks."
							: tasks.length === 0
								? "No tasks are recorded in the selected project scope."
								: "No recorded tasks match this phase."}
					</p>
				) : (
					projects.map((project) => {
						const visible = project.tasks.filter(
							(task) => filters.phase === null || task.phase === filters.phase,
						);
						if (visible.length === 0) return null;
						return (
							<div key={project.id} className="coordinator-task-group">
								{projects.length > 1 ? (
									<p className="coordinator-index">{project.name || "Unnamed project"}</p>
								) : null}
								{visible.map((task) => (
									<TaskCard
										key={task.taskId}
										task={task}
										phaseLabel={PHASE_LABELS[task.phase]}
										findings={findings.filter((finding) => finding.subject === task.taskId)}
										attemptsReady={status.sources.attempts.state === "ready"}
									/>
								))}
							</div>
						);
					})
				)}
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
							{attention.map((item, i) => (
								<li key={`${item.kind}:${item.subject}:${i}`} data-kind={item.kind}>
									<strong>{ATTENTION_LABELS[item.kind]}</strong>
									{item.subject !== null && taskTitles.has(item.subject) ? (
										<p className="coordinator-signal-name">{taskTitles.get(item.subject)}</p>
									) : null}
									<p>{item.text}</p>
								</li>
							))}
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
						sessions.map((session) => <SessionCard key={session.sessionId} session={session} />)
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
				<div className="coordinator-scope-group">
					<h3>
						Read findings <span className="coordinator-count">{findings.length} items</span>
					</h3>
					{findings.length === 0 ? (
						<p className="coordinator-muted">No findings were reported for this view.</p>
					) : (
						<SignalList label="read findings" testId="coordinator-findings">
							{findings.map((finding, i) => (
								<li
									key={`${finding.code}:${finding.subject}:${i}`}
									data-kind={finding.severity}
									data-finding={finding.code}
								>
									<strong>{finding.severity}</strong>
									<p>{finding.text}</p>
								</li>
							))}
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
	const refreshButton = useRef<HTMLButtonElement>(null);
	const pairingButton = useRef<HTMLButtonElement>(null);
	const focusPairing = useRef(false);
	const [grantRefused, setGrantRefused] = useState(false);
	const [filters, setFilters] = useState(NO_FILTERS);
	const { reply, busy, refresh } = useCoordinator(grant, workbench.launchId, () => {
		focusPairing.current = refreshButton.current === document.activeElement;
		setGrantRefused(true);
		setFilters(NO_FILTERS);
		onGrantRequired();
	});
	useLayoutEffect(() => {
		if (grant !== null || !focusPairing.current) return;
		focusPairing.current = false;
		pairingButton.current?.focus();
	}, [grant]);
	const status = reply?.kind === "status" ? reply.status : null;
	const problem = reply?.kind === "failure" ? reply.problem : null;
	const reduced = useReducedMotion();
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
	return (
		<div className="coordinator" data-testid="coordinator-workspace" data-appearance={appearance} data-state={mode}>
			{field ? <FieldLayer signal={signal} atmosphere={atmosphere} paused={paused} /> : null}
			<div className="coordinator-content">
				<header className="coordinator-hero">
					<div>
						<p className="coordinator-index">COORDINATOR / WORKSPACE RECORDS</p>
						<h1>Mission Board</h1>
						<p className="coordinator-intro">
							Read task status, check evidence and review recorded activity across the paired workspace.
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
				</header>
				<output className="sr-only">{status === null ? emptyNote : "Coordinator snapshot ready."}</output>
				{status === null ? (
					<div className="coordinator-panel coordinator-gate">
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
						<Board status={status} filters={filters} onFilters={setFilters} />
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
