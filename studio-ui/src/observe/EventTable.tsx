// The event table over the loaded window, in storage order. `storageSequence` is the one ordering; the producer's clock is shown as
// written under its own name; usage is per event and never added up. The filters act on the loaded window only and say so.
import { type ChangeEvent, type KeyboardEvent, memo, type ReactElement, useEffect, useRef, useState } from "react";
import { NO_FILTERS } from "../model/contract.ts";
import type { Action } from "../model/state.ts";
import { PAGE_SIZES } from "../model/state.ts";
import { filtersWithout, type RowModel, type SelectionStatus, type TimelineModel } from "../model/timeline.ts";
import type { EventKey } from "../model/types.ts";
import { ProvGlyph } from "../ui/marks.tsx";
import { BasisBadge, ConditionTag, Note, TextView } from "../ui/text.tsx";

function Search({ model, dispatch }: { model: TimelineModel; dispatch: (a: Action) => void }): ReactElement {
	// The box keeps its own text while an input method is composing, and the filter is applied when the composition ends (and for plain
	// typing on each key); a box rebuilt from the filter mid-composition would drop the composition.
	const [draft, setDraft] = useState(model.filters.text);
	const composing = useRef(false);
	useEffect(() => {
		if (!composing.current) setDraft(model.filters.text);
	}, [model.filters.text]);
	const apply = (text: string) => dispatch({ type: "set-filters", filters: { ...model.filters, text } });
	return (
		<input
			id="timeline-search"
			type="search"
			className="search"
			aria-label="Filter by kind, producer, id or presented text"
			placeholder="filter kind, producer, id, text"
			data-focus="search"
			value={draft}
			onChange={(event: ChangeEvent<HTMLInputElement>) => {
				setDraft(event.target.value);
				if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) apply(event.target.value);
			}}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onCompositionEnd={(event) => {
				composing.current = false;
				apply((event.currentTarget as HTMLInputElement).value);
			}}
		/>
	);
}

const Row = memo(function Row({
	row,
	hovered,
	onSelect,
	onHover,
}: {
	row: RowModel;
	hovered: boolean;
	onSelect(row: EventKey): void;
	onHover(sequence: number | null): void;
}): ReactElement {
	const select = () => onSelect(row);
	return (
		<tr
			className={`${row.selected ? "selected" : ""}${hovered ? " hovered" : ""}`.trim()}
			aria-selected={row.selected}
			data-seq={row.sequence}
			onClick={select}
			onMouseEnter={() => onHover(row.sequence)}
			onMouseLeave={() => onHover(null)}
		>
			<td className="col-seq">
				<button
					type="button"
					className="seq"
					aria-label={`Inspect event at position ${row.sequence}`}
					aria-pressed={row.selected}
					onClick={(event) => {
						event.stopPropagation();
						select();
					}}
				>
					{row.positionText}
				</button>
			</td>
			<td className="col-time mono" title={row.clock.full}>
				{row.clock.time}
			</td>
			<td className="col-cat">
				<span className={`cat cat-${row.category}`}>{row.categoryLabel}</span>
			</td>
			<td className="col-kind">
				<span className="kind">
					<TextView text={row.kind} />
				</span>
				<span className="producer dim">
					<TextView text={row.producer} />
				</span>
			</td>
			<td className="col-basis">
				{row.bases.length === 0 ? (
					<span className="dim" title="No payload field is approved for presentation for this kind">
						<ProvGlyph kind="envelope" size={10} />
						<span className="sr-only">no presented field</span>
					</span>
				) : (
					row.bases.map((mark) => <BasisBadge key={mark.basis} mark={mark} />)
				)}
			</td>
			<td className="col-marks">
				{row.usage.kind === "none" ? null : row.usage.kind === "not-recorded" ? (
					<span className="tag tag-na" title={row.usage.title}>
						not recorded
					</span>
				) : (
					<span className="usage mono" title="usage reported for this event; see the inspector">
						{row.usage.text}
					</span>
				)}
				{row.flags.map((flag) => (
					<span key={flag.flag} className={`flag flag-${flag.flag}`} title={flag.meaning}>
						{flag.label}
					</span>
				))}
			</td>
		</tr>
	);
});

/** Move focus between row buttons with the arrow keys, so a window can be walked without the mouse. */
function walk(event: KeyboardEvent<HTMLElement>): void {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.seq")];
	const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
	if (at === -1) return;
	const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
	if (next === undefined) return;
	event.preventDefault();
	next.focus();
}

/**
 * One line, always the same height, so that selecting never moves the table under the pointer. It is one button in one place: its label
 * and action change (Show in table / Clear the filters that hide it) but the node does not, so focus survives the change.
 */
function SelectionBar({
	status,
	onShow,
	onClear,
}: {
	status: SelectionStatus;
	onShow(): void;
	onClear(): void;
}): ReactElement {
	return (
		<div className={`selection-bar selection-${status.kind}`} data-testid="selection-bar">
			<span className="selection-text" id="selection-text" aria-live="polite">
				{status.kind === "none"
					? "No event selected."
					: status.kind === "shown"
						? `Selected: position ${status.sequence.toLocaleString("en-US")}.`
						: `Position ${status.sequence.toLocaleString("en-US")} is open in the inspector and hidden by ${status.clearing}.`}
			</span>
			{status.kind === "none" ? null : (
				<button
					type="button"
					className="btn small-btn"
					data-focus="selection-action"
					aria-describedby="selection-text"
					onClick={status.kind === "shown" ? onShow : onClear}
				>
					{status.kind === "shown" ? "Show in table" : "Clear filters that hide it"}
				</button>
			)}
		</div>
	);
}

/**
 * Bring one row of the table into view, inside the table's own scroller and with no more movement than it takes (a row already in view
 * does not move). The page is moved only if the row is still off the screen after that, and focus goes to the row's own button. It reads
 * nothing: the row is one the window already holds.
 */
function revealRow(scroller: HTMLElement, sequence: number): void {
	const row = scroller.querySelector<HTMLElement>(`tr[data-seq="${sequence}"]`);
	if (row === null) return;
	const head = scroller.querySelector("thead")?.getBoundingClientRect().height ?? 0;
	const box = scroller.getBoundingClientRect();
	const at = row.getBoundingClientRect();
	if (at.top < box.top + head) scroller.scrollTop -= box.top + head - at.top + 4;
	else if (at.bottom > box.bottom) scroller.scrollTop += at.bottom - box.bottom + 4;
	const after = row.getBoundingClientRect();
	if (after.top < 0) window.scrollBy(0, after.top - 8);
	else if (after.bottom > window.innerHeight) window.scrollBy(0, after.bottom - window.innerHeight + 8);
	row.querySelector<HTMLElement>("button.seq")?.focus({ preventScroll: true });
}

export function EventTable({
	model,
	dispatch,
	locked,
	pageSize,
	hovered,
	onHover,
	onSelect,
	goTo,
	setPageSize,
	windowMoves,
}: {
	model: TimelineModel;
	dispatch: (a: Action) => void;
	locked: boolean;
	pageSize: number;
	hovered: number | null;
	onHover(sequence: number | null): void;
	onSelect(row: EventKey): void;
	goTo(after: number): void;
	setPageSize(size: number): void;
	windowMoves: number;
}): ReactElement {
	const scroller = useRef<HTMLDivElement>(null);
	// A read that brought a different window starts that window at the top; a refresh of the same window keeps its place.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the window moves
	useEffect(() => {
		if (scroller.current !== null) scroller.current.scrollTop = 0;
	}, [windowMoves]);

	if (model.empty !== null) return <Note tone={model.empty.tone}>{model.empty.text}</Note>;
	const set = (patch: Partial<typeof model.filters>) =>
		dispatch({ type: "set-filters", filters: { ...model.filters, ...patch } });
	const reasonFor: Record<string, string | null> = {
		First: model.pager.reasons.first,
		Previous: model.pager.reasons.previous,
		Next: model.pager.reasons.next,
		Latest: model.pager.reasons.latest,
	};
	const unavailable = (["First", "Previous", "Next", "Latest"] as const).filter((label) => reasonFor[label] !== null);
	const pager = (label: string, after: number | null) => (
		<button
			type="button"
			className="btn"
			data-focus={`pager:${label}`}
			aria-describedby={after === null || locked ? "pager-reasons" : undefined}
			title={reasonFor[label] ?? undefined}
			disabled={after === null || locked}
			onClick={() => after !== null && goTo(after)}
		>
			{label}
		</button>
	);
	return (
		<div className="timeline-wrap">
			{model.degradedText === null ? null : <Note tone="warn">{model.degradedText}</Note>}
			<fieldset className="toolbar">
				<legend className="sr-only">Filters for the events in this window</legend>
				<Search model={model} dispatch={dispatch} />
				<fieldset className="chips">
					<legend className="sr-only">Categories in this window</legend>
					{model.categories.map((c) => (
						<button
							key={c.category}
							type="button"
							className={`chip cat-${c.category}`}
							aria-pressed={c.on}
							data-focus={`category:${c.category}`}
							onClick={() => {
								const next = new Set(model.filters.categories);
								if (c.on) next.delete(c.category);
								else next.add(c.category);
								set({ categories: next });
							}}
						>
							{c.label} {c.count}
						</button>
					))}
				</fieldset>
				<label className="check">
					<input
						type="checkbox"
						value="flagged"
						data-focus="flagged"
						checked={model.filters.flaggedOnly}
						onChange={(event) => set({ flaggedOnly: event.target.checked })}
					/>
					flagged only
				</label>
				{model.sessions.length === 0 ? null : (
					<select
						aria-label="Session (seen in this window)"
						data-focus="session"
						value={model.filters.session ?? ""}
						onChange={(event) => set({ session: event.target.value === "" ? null : event.target.value })}
					>
						<option value="">all sessions in this window</option>
						{model.sessions.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label} · {s.first}–{s.last} · {s.entries} here
							</option>
						))}
					</select>
				)}
				{model.filtersActive ? (
					<button
						type="button"
						className="btn quiet"
						data-focus="clear"
						onClick={() => dispatch({ type: "set-filters", filters: NO_FILTERS })}
					>
						clear filters
					</button>
				) : null}
			</fieldset>
			<p className="window-line" aria-live="polite">
				<span className="mono">{model.pager.range}</span>{" "}
				<span className="dim">{`${model.pager.of}${model.pager.more}`}</span>
				{" · "}
				<span className="dim">{model.window.text}</span>
			</p>
			<SelectionBar
				status={model.selection}
				onShow={() =>
					scroller.current !== null &&
					model.selection.kind === "shown" &&
					revealRow(scroller.current, model.selection.sequence)
				}
				onClear={() =>
					model.selection.kind === "hidden" &&
					dispatch({ type: "set-filters", filters: filtersWithout(model.filters, model.selection.reasons) })
				}
			/>
			{model.rows.length === 0 ? (
				<Note>{model.noRowsText}</Note>
			) : (
				<div className="table-scroll" ref={scroller}>
					<table className="events">
						<caption className="sr-only">
							Recorded events in storage order. The producer clock column is the producer's own clock, not an
							ordering.
						</caption>
						<colgroup>
							<col className="c-seq" />
							<col className="c-time" />
							<col className="c-cat" />
							<col />
							<col className="c-basis" />
							<col className="c-marks" />
						</colgroup>
						<thead>
							<tr>
								<th scope="col" title="Position in the event log: the only ordering">
									Position
								</th>
								<th scope="col" title="The producer's own clock, as written. Not an ordering.">
									Producer clock
								</th>
								<th scope="col">Category</th>
								<th scope="col">Kind · producer</th>
								<th scope="col" title="How the presented fields of the event are known">
									Basis
								</th>
								<th scope="col" title="Reported by the runtime for this event, never summed">
									Usage · flags
								</th>
							</tr>
						</thead>
						<tbody onKeyDown={walk}>
							{model.rows.flatMap((row) => [
								row.dateDivider === null ? null : (
									<tr className="date-row" key={`d${row.sequence}`}>
										<th colSpan={6} scope="colgroup" title="the producer's clock, not an ordering">
											{row.dateDivider} · producer clock
										</th>
									</tr>
								),
								<Row
									key={row.sequence}
									row={row}
									hovered={hovered === row.sequence}
									onSelect={onSelect}
									onHover={onHover}
								/>,
							])}
						</tbody>
					</table>
				</div>
			)}
			<nav className="pager" aria-label="Timeline pages">
				{pager("First", model.pager.firstAfter)}
				{pager("Previous", model.pager.previousAfter)}
				{pager("Next", model.pager.nextAfter)}
				{pager("Latest", model.pager.latestAfter)}
				<label className="select-label">
					<span className="dim">Rows</span>
					<select
						aria-label="Rows per page"
						data-focus="pagesize"
						disabled={locked}
						value={pageSize}
						onChange={(event) => setPageSize(Number(event.target.value))}
					>
						{PAGE_SIZES.map((size) => (
							<option key={size} value={size}>
								{size}
							</option>
						))}
					</select>
				</label>
				<span className="dim small">Each page is a new read of the whole log.</span>
			</nav>
			<p className="pager-reasons dim small" id="pager-reasons">
				{locked ? "Reads are paused: one is running, or the server asked for a pause. " : ""}
				{unavailable.map((label) => `${label}: ${reasonFor[label]} `).join("")}
			</p>
		</div>
	);
}

export function TimelineTools({ model }: { model: TimelineModel }): ReactElement {
	return <ConditionTag state={model.state.state} label={model.state.label} meaning={model.state.meaning} />;
}
