// The workspace desk: DEVELOP on a workspace host (`endo workspace open`, docs/designs/workspace-host.md), where no agent is attached and
// none is needed. It is the same Task view, overview, attempts and receipts as the live workbench's, in a shell of its own: no
// conversation, run strip, composer, Follow or Pi control, because there is nothing for them to describe, and no "disconnected", because
// nothing was ever connected. What the page can do here is read the project's work and change task metadata the operator asks to change.
//
// Wide: the navigator (a "Your work" row above the recorded sessions), the desk, and the context column. Narrow: one stage at a time, as
// everywhere in DEVELOP.
import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect } from "react";
import { Panel, PanelBoundary } from "../ui/Panel.tsx";
import { useNarrow } from "../ui/use-narrow.ts";
import type { ProjectApi } from "../use-project.ts";
import type { WorkspaceApi } from "../use-workspace.ts";
import { overviewFor } from "./Attention.tsx";
import { ChangesList, DiffView, WorktreeBar } from "./Changes.tsx";
import { Pairing, type Workbench } from "./Live.tsx";
import { ProjectBlock, TaskCluster, TaskPanel } from "./Tasks.tsx";

const BASIS = "the project's registered directory";
const PAIR_HINT =
	"Type the code shown in the terminal that started this workspace (type “pair” there for a new one). Once paired, this page can read the project's tasks and evidence and change tasks you ask it to change. Pairing runs nothing and starts no agent.";

/** A diamond, not a pentagon: the live marks belong to sessions, and this row is not one. */
function DeskGlyph(): ReactElement {
	return (
		<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false" className="desk-glyph">
			<path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
		</svg>
	);
}

/** The navigator's row for the desk: the project and what needs the operator, never a session. */
export function WorkspaceRow({
	workspace,
	selected,
	onSelect,
}: {
	workspace: WorkspaceApi;
	selected: boolean;
	onSelect(): void;
}): ReactElement {
	const view = workspace.state.view;
	const overview = overviewFor(workspace);
	const needs =
		overview === null || overview.evidence === "pending" || !workspace.state.current || !workspace.attention.current
			? null
			: overview.attention.length;
	return (
		<button
			type="button"
			className="caprow session-row live-row desk-row"
			aria-pressed={selected}
			data-testid="workspace-row"
			data-session-row=""
			onClick={onSelect}
		>
			<span className="session-name">
				<DeskGlyph /> {view?.project?.name ?? "Workspace"}
			</span>
			<span className="session-state">
				<span className="state" data-testid="workspace-row-state">
					{!workspace.paired
						? "pair to read"
						: view === null
							? "not read yet"
							: view.state !== "ready"
								? "tasks not shown"
								: `${view.tasks.length} task${view.tasks.length === 1 ? "" : "s"}${needs === null || needs === 0 ? "" : ` · ${needs} need${needs === 1 ? "s" : ""} attention`}`}
				</span>
			</span>
			<span className="session-meta">tasks and evidence · no agent attached</span>
		</button>
	);
}

const TABS = [
	{ id: "task", label: "Tasks" },
	{ id: "changes", label: "Changes" },
] as const;

export function WorkspaceDesk({
	wb,
	project,
	workspace,
	leading,
}: {
	wb: Workbench;
	project: ProjectApi;
	workspace: WorkspaceApi;
	/** Shown at the start of the header: the sessions toggle at the widths where the list is a drawer. */
	leading?: ReactNode;
}): ReactElement {
	const paired = wb.state.grant !== null;
	const host = wb.state.host;
	const changesOffered = host?.changes === true && project.state.availability !== "absent";
	// The desk shows Tasks unless the operator chose Changes: the live views' "conversation" has no place here.
	const view = project.state.view === "changes" && changesOffered ? "changes" : "task";
	const narrow = useNarrow();
	const offered = TABS.filter((t) => t.id !== "changes" || changesOffered);
	// The desk opens on Tasks (the project's view starts on the conversation, which a desk does not have).
	useEffect(() => {
		if (project.state.view === "conversation") project.setView("task");
	}, [project.state.view, project.setView]);
	const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const at = offered.findIndex((t) => t.id === view);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? offered.length - 1
					: Math.max(0, Math.min(offered.length - 1, at + (event.key === "ArrowRight" ? 1 : -1)));
		const to = offered[next]?.id ?? "task";
		project.setView(to);
		document.getElementById(`desk-tab-${to}`)?.focus();
	};
	return (
		<PanelBoundary resetKey={wb.state.launchId ?? "none"}>
			<section
				className="panel develop-activity develop-live develop-desk"
				id="develop-desk"
				aria-label="Workspace"
				data-testid="workspace-desk"
				data-view={view}
			>
				<header className="panel-head live-head">
					{leading}
					<div className="view-tabs" role="tablist" aria-label="Tasks or changes" onKeyDown={tabKeys}>
						{offered.map((t) => (
							<button
								key={t.id}
								type="button"
								role="tab"
								id={`desk-tab-${t.id}`}
								className="view-tab"
								data-testid={`desk-tab-${t.id}`}
								aria-selected={view === t.id}
								aria-controls={`desk-view-${t.id}`}
								tabIndex={view === t.id ? 0 : -1}
								onClick={() => project.setView(t.id)}
							>
								{t.label}
							</button>
						))}
					</div>
					<div className="panel-tools">
						<button
							type="button"
							className="btn"
							data-testid="desk-refresh"
							disabled={!paired || workspace.state.busy}
							title="Read the project's tasks and checks again (and the worktree, when Changes is shown). Nothing polls."
							onClick={() => {
								// The host's status too: it says whether this page is still paired (a revoked grant shows the pairing form again).
								wb.refresh();
								workspace.refresh();
								if (view === "changes") project.refresh();
							}}
						>
							{workspace.state.busy ? "Reading…" : "Read again"}
						</button>
					</div>
				</header>
				<WorktreeBar
					api={project}
					paired={paired}
					connected
					basis={BASIS}
					leading={
						<TaskCluster
							workspace={workspace}
							git={project.state.project}
							onDetails={() => project.setView("task")}
						/>
					}
				/>
				<div
					className="run-strip host-strip"
					data-testid="host-strip"
					title="This workspace host runs no agent. Tasks, attempts and checks are read from the store when you ask; a status changes only when you set it."
				>
					<DeskGlyph />
					<span className="strip-session">Workspace</span>
					<span className="dim" data-testid="host-strip-words">
						No agent attached · read from the store when you ask · statuses change only when you set them
					</span>
				</div>
				<div
					className="live-view"
					id="desk-view-task"
					role="tabpanel"
					aria-labelledby="desk-tab-task"
					hidden={view !== "task"}
				>
					<TaskPanel workspace={workspace} git={project.state.project} session="none" />
				</div>
				{changesOffered ? (
					<div
						className="live-view"
						id="desk-view-changes"
						role="tabpanel"
						aria-labelledby="desk-tab-changes"
						hidden={view !== "changes"}
					>
						<DiffView
							api={project}
							paired={paired}
							connected
							narrow={narrow}
							onBack={() => {
								project.setView("task");
								document.getElementById("desk-tab-task")?.focus();
							}}
						/>
					</div>
				) : null}
				{/* What the last request to the host said (a refused code, an unreachable host), in words, where the pairing form is. */}
				<output className="small desk-problem" aria-live="polite" data-testid="desk-problem">
					{wb.state.problem ?? ""}
				</output>
				{paired ? null : <Pairing wb={wb} hint={PAIR_HINT} />}
			</section>
		</PanelBoundary>
	);
}

/** The context column on a workspace host: the changed files, the project, and what this host is and is not. */
export function WorkspaceContext({
	wb,
	project,
	workspace,
}: {
	wb: Workbench;
	project: ProjectApi;
	workspace: WorkspaceApi;
}): ReactElement {
	const paired = wb.state.grant !== null;
	const changes = wb.state.host?.changes === true;
	return (
		<Panel
			id="develop-context"
			title="Context"
			subtitle="where the work is, and what this page can do"
			className="develop-inspector"
			resetKey={wb.state.launchId ?? "none"}
		>
			{changes ? <ChangesList api={project} paired={paired} connected /> : null}
			<ProjectBlock workspace={workspace} git={project.state.project} />
			<section className="block" data-testid="context-host">
				<h3>This workspace</h3>
				<dl className="facts">
					<div className="fact">
						<dt>host</dt>
						<dd>endo workspace open</dd>
					</div>
					<div className="fact">
						<dt>agent</dt>
						<dd>none attached, none needed</dd>
					</div>
					<div className="fact">
						<dt>pairing</dt>
						<dd>{paired ? "this page is paired" : "not paired"}</dd>
					</div>
				</dl>
				<p className="dim small">
					It reads your tasks, attempts and verification receipts from the store, and changes a task only when you
					ask. It cannot send a prompt, steer or stop an agent, link a session, or run a command or a check. The
					terminal that started it issues pairing codes (<span className="mono">pair</span>), ends the grant (
					<span className="mono">revoke</span>) and stops it (Ctrl-C).
				</p>
			</section>
		</Panel>
	);
}
