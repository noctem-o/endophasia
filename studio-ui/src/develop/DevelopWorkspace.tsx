// The DEVELOP workspace: a recorded-session desk. Read-only: it starts, attaches to, prompts and steers nothing, and it never claims
// a process exists. Wide: navigator, activity, inspector. Compact: navigator beside activity over inspector. Narrow: one stage at a
// time (sessions, activity, details) so no column is squeezed; an event opens in a dialog as in Observe.
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import type { EndoCockpitDevelopSessionRowV0 } from "../../../protocol/cockpit-develop.ts";
import { eventDetail } from "../model/detail.ts";
import type { DevelopStage } from "../model/develop.ts";
import { EventView } from "../observe/Inspector.tsx";
import { Panel } from "../ui/Panel.tsx";
import { Note } from "../ui/text.tsx";
import { useNarrow } from "../ui/use-narrow.ts";
import type { ProjectApi } from "../use-project.ts";
import { Activity } from "./Activity.tsx";
import { LiveContext, LiveConversation, LiveRow, shortSession, type Workbench } from "./Live.tsx";
import { type Develop, Navigator, shortAlias } from "./Navigator.tsx";
import { SessionInspector } from "./SessionInspector.tsx";

function EventDialog({
	open,
	onClose,
	children,
}: {
	open: boolean;
	onClose(): void;
	children: ReactNode;
}): ReactElement {
	const ref = useRef<HTMLDialogElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) {
			opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			dialog.showModal();
		}
		if (!open && dialog.open) {
			dialog.close();
			const back = opener.current;
			opener.current = null;
			if (back?.isConnected) back.focus({ preventScroll: true });
		}
	}, [open]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is a convenience; Escape and the Close button are the keyboard paths
		<dialog
			ref={ref}
			id="develop-event-dialog"
			className="inspector-dialog"
			aria-labelledby="develop-event-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<header className="panel-head">
				<div className="panel-titles">
					<h2 id="develop-event-title">Event</h2>
					<p className="panel-sub">what was recorded, and where</p>
				</div>
				<div className="panel-tools">
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
				</div>
			</header>
			<div className="panel-body">{children}</div>
		</dialog>
	);
}

export function DevelopWorkspace({
	develop,
	onObserve,
	onCompare,
	observeBlocked,
	workbench,
	project,
	onObserveLive,
}: {
	develop: Develop;
	/** The worktree context of the live launch (read-only Git, read when asked). */
	project: ProjectApi;
	/** The workbench (the broker's live view), or a state saying the server has none. */
	workbench: Workbench;
	/** Open Observe on a live session by its alias. */
	onObserveLive(alias: string | null, attachment: string | null): void;
	onObserve(row: EndoCockpitDevelopSessionRowV0, attachment: string | null): void;
	onCompare(row: EndoCockpitDevelopSessionRowV0): void;
	/** Why Observe cannot take a hand-off now (it is reading or paused), or null. */
	observeBlocked: string | null;
}): ReactElement {
	const narrow = useNarrow();
	const { state, dispatch } = develop;
	const detail = state.detail;
	const entry =
		detail === null || state.event === null
			? null
			: (detail.activity.entries.find((item) => item.storageSequence === state.event) ?? null);
	const eventModel = (() => {
		if (entry === null) return null;
		try {
			return eventDetail(entry);
		} catch {
			return null;
		}
	})();
	const crumb = useRef<HTMLDivElement>(null);
	const previousStage = useRef<DevelopStage>(state.stage);
	useEffect(() => {
		if (narrow && previousStage.current !== state.stage) crumb.current?.focus({ preventScroll: true });
		previousStage.current = state.stage;
	}, [narrow, state.stage]);
	// Between the wide and the narrow layouts the inspector sits under the activity, out of sight: opening an event brings it into view
	// (instantly, so reduced motion is respected) without moving focus.
	useEffect(() => {
		if (narrow || state.event === null || !window.matchMedia("(max-width: 1359.98px)").matches) return;
		document.getElementById("develop-inspector")?.scrollIntoView({ block: "nearest" });
	}, [narrow, state.event]);
	// Escape steps back one stage on a narrow screen, unless the event dialog is open (which closes itself).
	useEffect(() => {
		if (!narrow) return;
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || document.querySelector("dialog[open]") !== null || event.defaultPrevented)
				return;
			// While changes are being read, Escape belongs to that view (it returns to the conversation), not to a stage change.
			if (
				workbench.state.availability === "available" &&
				workbench.state.view === "live" &&
				project.state.view === "changes"
			)
				return;
			// Escape inside a text field belongs to the field: a draft is not abandoned by a stage change.
			const target = event.target as HTMLElement | null;
			if (target !== null && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable))
				return;
			if (state.stage === "details") dispatch({ type: "stage", stage: "activity" });
			else if (state.stage === "activity") dispatch({ type: "stage", stage: "sessions" });
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [narrow, state.stage, dispatch, workbench.state.availability, workbench.state.view, project.state.view]);

	// The sessions list is a drawer at the widths where three columns do not fit; it closes when something is chosen, and on Escape.
	const [drawer, setDrawer] = useState(false);
	const liveShown = workbench.state.availability === "available" && workbench.state.view === "live";
	// biome-ignore lint/correctness/useExhaustiveDependencies: choosing a session (or the live one) closes the drawer
	useEffect(() => setDrawer(false), [state.selected, liveShown]);
	// An open drawer takes focus, and a click outside it closes it (it is a convenience, never a trap).
	useEffect(() => {
		if (!drawer) return;
		document
			.querySelector<HTMLElement>("#develop-nav-wrap button, #develop-nav-wrap input")
			?.focus({ preventScroll: true });
		const outside = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("#develop-nav-wrap, [data-testid=sessions-toggle]") != null) return;
			setDrawer(false);
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
	}, [drawer]);
	// Reading changes from the keyboard, while the live session is shown and nobody is typing: j and k (also ] and [) read the next and the
	// previous file, Escape returns to the conversation. These only read; none of them sends, approves or changes anything.
	useEffect(() => {
		if (!liveShown) return;
		const key = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
			if (document.querySelector("dialog[open]") !== null) return;
			const target = event.target as HTMLElement | null;
			// Escape closes the drawer from anywhere in it, even from its filter field.
			if (event.key === "Escape" && drawer) {
				setDrawer(false);
				document.querySelector<HTMLElement>('[data-testid="sessions-toggle"]')?.focus({ preventScroll: true });
				return;
			}
			if (target !== null && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable))
				return;
			const reading = project.state.view === "changes";
			if (event.key === "Escape" && reading) {
				project.setView("conversation");
				document.getElementById("develop-tab-conversation")?.focus({ preventScroll: true });
				return;
			}
			const inList = target?.closest?.(".changes-list") != null;
			if (!reading && !inList) return;
			// PageUp and PageDown scroll the diff from wherever focus is: a button in the list would otherwise swallow them.
			if (reading && (event.key === "PageDown" || event.key === "PageUp")) {
				const region = document.querySelector<HTMLElement>(".diff-scroll");
				region?.scrollBy({ top: (event.key === "PageDown" ? 1 : -1) * region.clientHeight * 0.9 });
				event.preventDefault();
				return;
			}
			if (event.key === "j" || event.key === "]") project.step(1);
			else if (event.key === "k" || event.key === "[") project.step(-1);
			else return;
			event.preventDefault();
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [liveShown, drawer, project]);

	const inspector = (
		<Panel
			id="develop-inspector"
			title="Inspector"
			subtitle={eventModel === null ? "the session, and where it stops" : "one recorded event"}
			className="develop-inspector"
			resetKey={`${state.selected}:${state.event}:${detail === null}`}
		>
			{eventModel !== null && detail !== null ? (
				<>
					<p className="develop-crumb">
						<button
							type="button"
							className="btn small-btn"
							onClick={() => dispatch({ type: "event", sequence: null })}
						>
							‹ Back to session {shortAlias(detail.session.session)}
						</button>
					</p>
					<EventView detail={eventModel} hidden={false} clearing="" />
				</>
			) : detail !== null ? (
				<SessionInspector detail={detail} />
			) : (
				<div className="develop-empty">
					<h3>No session open</h3>
					<p>
						When a session is open, this panel shows where it came from, what qualifies it, which source condition
						it was read under and what the runtime did not report. Fields that cannot be established say so.
					</p>
				</div>
			)}
		</Panel>
	);

	const open = (
		<Activity
			develop={develop}
			narrow={narrow}
			observeBlocked={observeBlocked}
			onObserve={() => detail !== null && onObserve(detail.session, detail.attachment)}
			onCompare={() => detail !== null && onCompare(detail.session)}
		/>
	);

	// The live conversation is shown only when this server has a workbench and the operator has not chosen a recorded session.
	const liveMode = workbench.state.availability === "available" && workbench.state.view === "live";
	const liveRow =
		workbench.state.availability === "available" ? (
			<LiveRow
				wb={workbench}
				selected={liveMode}
				onSelect={() => {
					workbench.setView("live");
					if (narrow) dispatch({ type: "stage", stage: "activity" });
				}}
			/>
		) : undefined;
	const navigator = <Navigator develop={develop} live={liveRow} onRecorded={() => workbench.setView("recorded")} />;
	// Choosing a file in the context column reads it in the centre: on a narrow screen that is the other stage.
	const chosen: ProjectApi = {
		...project,
		select: (key) => {
			project.select(key);
			if (narrow) dispatch({ type: "stage", stage: "activity" });
		},
	};
	const liveContext = (
		<LiveContext
			wb={workbench}
			project={chosen}
			onObserve={() =>
				onObserveLive(workbench.state.status?.session ?? null, workbench.state.status?.attachment ?? null)
			}
		/>
	);
	const inList = state.stage === "sessions" || (!liveMode && state.selected === null);
	const crumbName = liveMode
		? workbench.state.status?.session === null || workbench.state.status === null
			? "live session"
			: shortSession(workbench.state.status.session)
		: detail === null
			? "…"
			: shortAlias(detail.session.session);

	return (
		<div
			className="develop"
			id="develop-workspace"
			data-testid="develop"
			data-fill={liveMode && !narrow ? "true" : "false"}
		>
			{narrow ? (
				<>
					{inList ? null : (
						<div className="develop-crumb" ref={crumb} tabIndex={-1} data-testid="develop-crumb">
							<button
								type="button"
								className="btn small-btn"
								onClick={() => dispatch({ type: "stage", stage: "sessions" })}
							>
								‹ Sessions
							</button>
							<span aria-hidden="true">›</span>
							<span className="mono">{crumbName}</span>
							{state.stage === "details" ? (
								<button
									type="button"
									className="btn small-btn"
									onClick={() => dispatch({ type: "stage", stage: "activity" })}
								>
									‹ {liveMode ? "Conversation" : "Activity"}
								</button>
							) : liveMode ? (
								<button
									type="button"
									className="btn small-btn"
									onClick={() => dispatch({ type: "stage", stage: "details" })}
								>
									Context
								</button>
							) : null}
						</div>
					)}
					{inList ? (
						navigator
					) : state.stage === "activity" ? (
						liveMode ? (
							<LiveConversation wb={workbench} project={project} />
						) : (
							open
						)
					) : liveMode ? (
						liveContext
					) : (
						inspector
					)}
					<EventDialog
						open={state.event !== null && eventModel !== null && !liveMode}
						onClose={() => dispatch({ type: "event", sequence: null })}
					>
						{eventModel === null ? (
							<Note>This event is not in the loaded activity.</Note>
						) : (
							<EventView detail={eventModel} hidden={false} clearing="" />
						)}
					</EventDialog>
				</>
			) : (
				<div className="develop-grid" data-drawer={drawer ? "open" : "closed"}>
					<div className="develop-nav-wrap" id="develop-nav-wrap">
						{navigator}
					</div>
					{liveMode ? (
						<LiveConversation
							wb={workbench}
							project={project}
							leading={
								<button
									type="button"
									className="btn small-btn sessions-toggle"
									data-testid="sessions-toggle"
									aria-expanded={drawer}
									aria-controls="develop-nav-wrap"
									onClick={() => setDrawer((open) => !open)}
								>
									Sessions
								</button>
							}
						/>
					) : (
						open
					)}
					{liveMode ? liveContext : inspector}
				</div>
			)}
		</div>
	);
}
