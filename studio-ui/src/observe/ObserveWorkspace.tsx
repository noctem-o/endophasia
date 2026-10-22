// The Observe workspace: the loaded window of the event log, its overview, its table, and the inspector, with the runtime, capability
// and source context beside them. It is a reader of the one state in use-observe.ts and draws only what toObserveViewModel returns.
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toObserveViewModel } from "../model/observe.ts";
import type { EventKey } from "../model/types.ts";
import { Panel, PanelBoundary } from "../ui/Panel.tsx";
import { ConditionTag, Note } from "../ui/text.tsx";
import { useNarrow } from "../ui/use-narrow.ts";
import type { Observe } from "../use-observe.ts";
import { Attention } from "./Attention.tsx";
import { EventTable } from "./EventTable.tsx";
import { InspectorBody } from "./Inspector.tsx";
import { Overview } from "./Overview.tsx";
import { CapabilitiesPanel, RuntimePanel, RuntimeTools, SourcesPanel } from "./Side.tsx";

function InspectorDialog({
	open,
	onClose,
	onClosed,
	attention,
	children,
}: {
	open: boolean;
	onClose(): void;
	/** Called after the dialog has closed, so the opener can be given focus back whatever the browser does. */
	onClosed(): void;
	attention: ReactNode;
	children: ReactNode;
}): ReactElement {
	const ref = useRef<HTMLDialogElement>(null);
	const closed = useRef(onClosed);
	closed.current = onClosed;
	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) {
			dialog.close();
			closed.current();
		}
	}, [open]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is a convenience; Escape and the Close button are the keyboard paths
		<dialog
			ref={ref}
			id="inspector"
			className="inspector-dialog"
			aria-labelledby="inspector-title"
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
					<h2 id="inspector-title">Inspector</h2>
					<p className="panel-sub">what was recorded, and where</p>
				</div>
				<button type="button" className="btn" data-focus="inspector-close" onClick={onClose}>
					Close
				</button>
			</header>
			{attention}
			<div className="panel-body">
				<PanelBoundary resetKey={children}>{open ? children : null}</PanelBoundary>
			</div>
		</dialog>
	);
}

export function ObserveWorkspace({ observe }: { observe: Observe }): ReactElement {
	const { state, dispatch, locked, goTo, setPageSize } = observe;
	const [hovered, setHovered] = useState<number | null>(null);
	// Stable, so a hover (which changes only `hovered`) redraws the two rows it touches and not every row of the table.
	const selectRow = useCallback(
		(row: EventKey) =>
			dispatch({ type: "select", selection: { kind: "event", sequence: row.sequence, eventId: row.eventId } }),
		[dispatch],
	);
	const narrow = useNarrow();
	const loaded = state.loaded;
	const model = useMemo(
		() =>
			loaded === null
				? null
				: toObserveViewModel({
						snapshot: loaded.snapshot,
						attachment: state.attachment,
						selection: state.selection,
						filters: state.filters,
						limit: loaded.request.limit,
					}),
		[loaded, state.attachment, state.selection, state.filters],
	);

	// Where the dialog was opened from, so that closing it puts focus back there. A browser restores focus to the element that had it when
	// the dialog opened, but not every browser focuses a button when it is clicked, so this does not depend on that.
	const opener = useRef<NonNullable<typeof state.selection> | null>(null);
	if (state.selection !== null) opener.current = state.selection;

	if (loaded === null || model === null) {
		return (
			<div className="observe observe-empty" data-testid="observe-unread">
				{state.busy ? (
					<output className="loading">
						<span className="spinner" aria-hidden="true" /> Reading the stores…
					</output>
				) : (
					<Note tone={state.problem === null ? "info" : "error"}>
						{state.problem === null
							? "Nothing has been read yet."
							: "No read has succeeded, so nothing is shown. No record is drawn to fill the gap; use Refresh to try again."}
					</Note>
				)}
			</div>
		);
	}

	const selectedSequence = state.selection?.kind === "event" ? state.selection.sequence : null;
	const inspector = <InspectorBody model={model.inspector} clearedNote={state.clearedNote} />;
	const modalOpen = narrow && state.selection !== null;
	const restoreOpener = () => {
		const opened = opener.current;
		const active = document.activeElement;
		if (
			opened === null ||
			(active !== null && active !== document.body && !(active as HTMLElement).matches(":disabled"))
		)
			return;
		const target =
			opened.kind === "event"
				? document.querySelector<HTMLElement>(`tr[data-seq="${opened.sequence}"] button.seq`)
				: document.querySelector<HTMLElement>(`button.caprow[data-key="${CSS.escape(opened.name)}"]`);
		target?.focus({ preventScroll: true });
	};
	const readLine = `Read ${loaded.fetchedAt.toLocaleTimeString("en-GB")} by this browser's clock, in ${
		loaded.durationMs < 1000
			? `${Math.max(1, Math.round(loaded.durationMs))} ms`
			: `${(loaded.durationMs / 1000).toFixed(1)} s`
	}. The projection is a view of recorded observations, not evidence in itself.`;

	return (
		<div className="observe" data-testid="observe">
			<PanelBoundary resetKey={model}>
				<Overview
					model={model.timeline.overview}
					hovered={hovered}
					onHover={setHovered}
					selected={selectedSequence}
					onSelect={(sequence) => {
						const mark = model.timeline.overview.marks.find((m) => m.sequence === sequence);
						if (mark !== undefined) selectRow({ sequence, eventId: mark.eventId });
					}}
				/>
			</PanelBoundary>
			<div className="observe-grid">
				<div className="col col-left">
					<Panel
						resetKey={model}
						id="runtime"
						title="Runtime"
						subtitle="as the registry records it"
						tools={<RuntimeTools model={model.runtime} dispatch={dispatch} />}
					>
						<RuntimePanel model={model.runtime} />
					</Panel>
					<Panel
						resetKey={model}
						id="capabilities"
						title="Capabilities"
						subtitle="recorded status, never inferred"
					>
						<CapabilitiesPanel model={model.capabilities} dispatch={dispatch} />
					</Panel>
				</div>
				<div className="col col-center">
					<Panel
						resetKey={model}
						id="timeline"
						title="Timeline"
						subtitle="storage order"
						className="grow"
						tools={
							<ConditionTag
								state={model.timeline.state.state}
								label={model.timeline.state.label}
								meaning={model.timeline.state.meaning}
							/>
						}
					>
						<EventTable
							model={model.timeline}
							dispatch={dispatch}
							locked={locked}
							pageSize={state.pageSize}
							hovered={hovered}
							onHover={setHovered}
							onSelect={selectRow}
							goTo={goTo}
							setPageSize={setPageSize}
							windowMoves={state.windowMoves}
						/>
					</Panel>
				</div>
				<div className="col col-right">
					{narrow ? (
						<>
							<InspectorDialog
								open={modalOpen}
								onClose={() => dispatch({ type: "close-inspector" })}
								onClosed={restoreOpener}
								attention={<Attention items={model.attention} testid="dialog-attention" />}
							>
								{inspector}
							</InspectorDialog>
							{state.selection === null ? (
								<details className="legend-fold">
									<summary>How to read the marks</summary>
									{inspector}
								</details>
							) : null}
						</>
					) : (
						<Panel
							resetKey={model}
							id="inspector"
							title="Inspector"
							subtitle="what was recorded, and where"
							className="grow"
						>
							{inspector}
						</Panel>
					)}
					<Panel resetKey={model} id="sources" title="Sources & provenance" subtitle="each on its own">
						<SourcesPanel model={model.sources} readLine={readLine} />
					</Panel>
				</div>
			</div>
		</div>
	);
}
