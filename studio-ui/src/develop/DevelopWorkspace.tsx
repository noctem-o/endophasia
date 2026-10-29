// The DEVELOP workspace: a recorded-session desk. Read-only: it starts, attaches to, prompts and steers nothing, and it never claims
// a process exists. Wide: navigator, activity, inspector. Compact: navigator beside activity over inspector. Narrow: one stage at a
// time (sessions, activity, details) so no column is squeezed; an event opens in a dialog as in Observe.
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import type { EndoCockpitDevelopSessionRowV0 } from "../../../protocol/cockpit-develop.ts";
import { eventDetail } from "../model/detail.ts";
import type { DevelopStage } from "../model/develop.ts";
import { EventView } from "../observe/Inspector.tsx";
import { Panel } from "../ui/Panel.tsx";
import { Note } from "../ui/text.tsx";
import { useNarrow } from "../ui/use-narrow.ts";
import { Activity } from "./Activity.tsx";
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
}: {
	develop: Develop;
	onObserve(row: EndoCockpitDevelopSessionRowV0, attachment: string | null): void;
	onCompare(row: EndoCockpitDevelopSessionRowV0): void;
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
			if (state.stage === "details") dispatch({ type: "stage", stage: "activity" });
			else if (state.stage === "activity") dispatch({ type: "stage", stage: "sessions" });
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [narrow, state.stage, dispatch]);

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
			onObserve={() => detail !== null && onObserve(detail.session, detail.attachment)}
			onCompare={() => detail !== null && onCompare(detail.session)}
		/>
	);

	return (
		<div className="develop" id="develop-workspace" data-testid="develop">
			{narrow ? (
				<>
					{state.stage === "sessions" || state.selected === null ? null : (
						<div className="develop-crumb" ref={crumb} tabIndex={-1} data-testid="develop-crumb">
							<button
								type="button"
								className="btn small-btn"
								onClick={() => dispatch({ type: "stage", stage: "sessions" })}
							>
								‹ Sessions
							</button>
							<span aria-hidden="true">›</span>
							<span className="mono">{detail === null ? "…" : shortAlias(detail.session.session)}</span>
							{state.stage === "details" ? (
								<button
									type="button"
									className="btn small-btn"
									onClick={() => dispatch({ type: "stage", stage: "activity" })}
								>
									‹ Activity
								</button>
							) : null}
						</div>
					)}
					{state.stage === "sessions" || state.selected === null ? (
						<Navigator develop={develop} />
					) : state.stage === "activity" ? (
						open
					) : (
						inspector
					)}
					<EventDialog
						open={state.event !== null && eventModel !== null}
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
				<div className="develop-grid">
					<Navigator develop={develop} />
					{open}
					{inspector}
				</div>
			)}
		</div>
	);
}
