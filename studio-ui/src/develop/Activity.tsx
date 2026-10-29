// The selected session's activity: what it recorded, in storage order. Counts and positions are the log's; the lifecycle state is the
// recorded one; tool arguments, results and prompts are withheld by design and the page says so. Filters here cover only the events
// loaded, and the page says that too.
import { type KeyboardEvent, type ReactElement, useState } from "react";
import { basisMark, textModel } from "../model/cells.ts";
import { flagModel } from "../model/detail.ts";
import { STATE_WORDING } from "../model/develop.ts";
import { CATEGORY, known, SOURCE_STATE } from "../model/labels.ts";
import { basesOf, markClassOf, splitClock } from "../model/timeline.ts";
import { grouped } from "../model/views.ts";
import { ProvGlyph } from "../ui/marks.tsx";
import { Panel } from "../ui/Panel.tsx";
import { ConditionTag, Note, TextView } from "../ui/text.tsx";
import { type Develop, StateTag, shortAlias } from "./Navigator.tsx";

const CATEGORIES = [
	"lifecycle",
	"agent",
	"message",
	"tool",
	"session",
	"queue",
	"compaction",
	"retry",
	"harness",
	"control",
	"other",
] as const;

export function Activity({
	develop,
	onObserve,
	onCompare,
	narrow,
}: {
	develop: Develop;
	onObserve(): void;
	onCompare(): void;
	narrow: boolean;
}): ReactElement {
	const { state } = develop;
	const detail = state.detail;
	const [categories, setCategories] = useState<ReadonlySet<string>>(new Set());
	const [flaggedOnly, setFlaggedOnly] = useState(false);
	const reading = state.request !== null;
	const body = (() => {
		if (state.selected === null)
			return (
				<div className="develop-empty" data-testid="activity-empty">
					<h3>
						{state.inventory === null
							? "Nothing read yet"
							: state.inventory.page.total === 0
								? "No session to open"
								: "Select a recorded session"}
					</h3>
					<p>
						{state.inventory === null
							? "Sessions are read from the store when you open DEVELOP or press Read sessions."
							: state.inventory.page.total === 0
								? "This store holds no Pi or DSH recording, so there is no activity to show."
								: "Choose an inspectable session in the list to see what it recorded: its lifecycle, its events in storage order, and what each of them can and cannot establish."}
					</p>
					<p>This page only reads recordings. It cannot start, attach to, prompt or steer an agent.</p>
				</div>
			);
		if (detail === null)
			return reading ? (
				<output className="loading">
					<span className="spinner" aria-hidden="true" /> Reading the session…
				</output>
			) : (
				<Note tone={state.problem === null ? "info" : "error"}>
					{state.problem ?? "The session has not been read. Select it again."}
				</Note>
			);
		const row = detail.session;
		const recorded = row.recorded!;
		const loaded = detail.activity.entries;
		const shown = loaded.filter(
			(entry) =>
				(categories.size === 0 || categories.has(entry.category)) && (!flaggedOnly || entry.flags.length > 0),
		);
		const walk = (event: KeyboardEvent<HTMLElement>) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-event-row]")];
			const at = buttons.indexOf(document.activeElement as HTMLElement);
			if (buttons.length === 0 || at < 0) return;
			event.preventDefault();
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? buttons.length - 1
						: Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
			buttons[next]?.focus();
		};
		const last = splitClock(row.lastRecordedAt);
		return (
			<>
				<div className="develop-head">
					<h3 className="mono" data-testid="activity-title" title={row.session}>
						{shortAlias(row.session)}
					</h3>
					<span className="dim">{row.label}</span>
					<StateTag state={recorded.state} />
					{detail.source.condition.state === "readable" ? null : (
						<ConditionTag
							state={detail.source.condition.state}
							label={known(SOURCE_STATE, detail.source.condition.state)?.label ?? null}
							meaning={known(SOURCE_STATE, detail.source.condition.state)?.meaning ?? null}
						/>
					)}
				</div>
				{detail.source.condition.state === "degraded" ? (
					<p className="note note-warn" data-testid="activity-degraded">
						The event log is degraded: only its readable prefix, to position{" "}
						{grouped(detail.source.watermark?.length ?? 0)}, is shown. This session may continue past it.
					</p>
				) : null}
				<p className="develop-lead">{STATE_WORDING[recorded.state].meaning}</p>
				<p className="develop-counts">
					<span className="sr-only">Counts from the recorded events: </span>
					<span>
						<b>{grouped(row.events)}</b> events
					</span>
					<span>
						<b>{grouped(recorded.runs)}</b> run{recorded.runs === 1 ? "" : "s"}
					</span>
					<span>
						<b>{grouped(recorded.turns)}</b> turn{recorded.turns === 1 ? "" : "s"}
					</span>
					<span>
						positions <b>{grouped(row.firstStorageSequence)}</b>–<b>{grouped(row.lastStorageSequence)}</b>
					</span>
					<span title="The producer's own clock reading on the last recorded event. It is not an ordering and not the time now.">
						last recorded event, producer clock{" "}
						<b>
							{last.date === null ? "" : `${last.date} `}
							{last.time}
						</b>
					</span>
					{detail.activity.tools.calls === null ? null : (
						<span>
							<b>{grouped(detail.activity.tools.calls)}</b> tool call
							{detail.activity.tools.calls === 1 ? "" : "s"}
							{detail.activity.tools.errors === null
								? ""
								: `, ${grouped(detail.activity.tools.errors)} reported as error`}
						</span>
					)}
				</p>
				<div className="develop-actions">
					<button type="button" className="btn" data-testid="open-observe" onClick={onObserve}>
						Open in Observe
					</button>
					<button type="button" className="btn" data-testid="open-compare" onClick={onCompare}>
						Open in Compare as Recording A
					</button>
				</div>
				<p className="dim small">
					Observe shows the window it reads, which may need paging to reach this session. Compare loads its own
					inventory and preselects this recording only if it is selectable there.
				</p>
				<div className="toolbar toolbar-spaced">
					<fieldset className="chips">
						<legend className="sr-only">Category of loaded events</legend>
						{CATEGORIES.filter((name) => detail.activity.byCategory[name] > 0).map((name) => (
							<button
								key={name}
								type="button"
								className="chip"
								aria-pressed={categories.has(name)}
								onClick={() => {
									const next = new Set(categories);
									if (!next.delete(name)) next.add(name);
									setCategories(next);
								}}
							>
								{known(CATEGORY, name) ?? name} {grouped(detail.activity.byCategory[name])}
							</button>
						))}
					</fieldset>
					<label className="check">
						<input
							type="checkbox"
							checked={flaggedOnly}
							onChange={(event) => setFlaggedOnly(event.currentTarget.checked)}
						/>
						Flagged only
					</label>
				</div>
				<p className="window-line dim" data-testid="activity-coverage">
					{shown.length === loaded.length ? "" : `${shown.length} of `}
					{grouped(loaded.length)} of {grouped(detail.activity.total)} events loaded. Chip counts are for the whole
					session; filters apply to the {grouped(loaded.length)} loaded.
				</p>
				{shown.length === 0 ? (
					<Note>No loaded event matches these filters.</Note>
				) : (
					<div className="table-scroll">
						<table className="events develop-event-table">
							<caption className="sr-only">
								Recorded events of the selected session in storage order. The producer clock column is the
								producer's own clock, not an ordering.
							</caption>
							<colgroup>
								<col className="c-seq" />
								<col className="c-time" />
								<col className="c-cat" />
								<col />
								<col className="c-basis" />
								<col className="c-flags" />
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
									<th scope="col">Flags</th>
								</tr>
							</thead>
							<tbody onKeyDown={walk}>
								{shown.map((entry) => {
									const bases = basesOf(entry);
									const mark = markClassOf(bases);
									const clock = splitClock(entry.recordedAt);
									const selected = state.event === entry.storageSequence;
									return (
										<tr key={entry.storageSequence} className={selected ? "selected" : undefined}>
											<td className="col-seq">
												<button
													type="button"
													className="seq"
													data-event-row=""
													data-testid="event-row"
													aria-pressed={selected}
													onClick={() =>
														develop.dispatch({ type: "event", sequence: entry.storageSequence })
													}
												>
													{grouped(entry.storageSequence)}
												</button>
											</td>
											<td className="col-time mono" title={entry.recordedAt}>
												{clock.time}
											</td>
											<td className="col-cat cat">{known(CATEGORY, entry.category) ?? entry.category}</td>
											<td className="col-kind">
												<span className="kind">
													<TextView text={textModel(entry.kind, { mono: true })} />
												</span>
												<span className="producer dim">
													<TextView text={textModel(entry.producer, { mono: true, keep: 28 })} />
												</span>
											</td>
											<td className="col-basis">
												<ProvGlyph kind={mark} />{" "}
												<span
													className="dim small"
													title={
														bases.length === 0
															? "No field is approved for presentation for this kind"
															: bases.map((b) => basisMark(b).label).join(", ")
													}
												>
													{bases.length === 0
														? "envelope only"
														: bases.map((b) => basisMark(b).short).join(" ")}
												</span>
											</td>
											<td className="col-marks">
												{entry.flags.length === 0
													? null
													: entry.flags.map((flag) => (
															<span key={flag} className={`flag flag-${flag}`}>
																{flagModel(flag).label}
															</span>
														))}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				<nav className="pager" aria-label="Activity pages">
					{detail.activity.page.hasMore ? (
						<button
							type="button"
							className="btn"
							id="develop-more-events"
							disabled={reading || develop.paced}
							onClick={develop.moreEvents}
						>
							Load next {Math.min(100, detail.activity.total - loaded.length)} events
						</button>
					) : (
						<span className="dim small">
							All {grouped(detail.activity.total)} events{" "}
							{detail.source.condition.state === "readable" ? "" : "in the readable prefix "}
							are loaded.
						</span>
					)}
					<span className="dim small">
						Tool arguments, tool results, prompts and file paths are withheld by design; only their keyed digests,
						where recorded, can be shown.
					</span>
				</nav>
			</>
		);
	})();
	return (
		<Panel
			id="develop-activity"
			title="Activity"
			subtitle="storage order"
			className="develop-activity"
			resetKey={detail}
			tools={
				<>
					{narrow && detail !== null ? (
						<button
							type="button"
							className="btn"
							onClick={() => develop.dispatch({ type: "stage", stage: "details" })}
						>
							Details
						</button>
					) : null}
					{reading && state.selected !== null ? (
						<button type="button" className="btn" onClick={develop.cancel}>
							Cancel
						</button>
					) : null}
				</>
			}
		>
			{state.problem !== null && detail !== null ? <Note tone="error">{state.problem}</Note> : null}
			{body}
		</Panel>
	);
}
