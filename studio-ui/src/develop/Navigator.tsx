// The session navigator: recorded sessions grouped by the source that recorded them. Filters are client-side and cover only the
// loaded list, and say so. A row states its RECORDED lifecycle state in words ("as recorded"); it never claims a live process.
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import type { EndoCockpitDevelopSessionRowV0 } from "../../../protocol/cockpit-develop.ts";
import {
	type DevelopFilters,
	developFiltersActive,
	filterRows,
	groupBySource,
	type LifecycleState,
	listCoverage,
	NO_DEVELOP_FILTERS,
	STATE_WORDING,
} from "../model/develop.ts";
import { presentRecorded } from "../model/develop-session.ts";
import { known, SOURCE_STATE } from "../model/labels.ts";
import { grouped } from "../model/views.ts";
import { LifecycleGlyph } from "../ui/marks.tsx";
import { Panel } from "../ui/Panel.tsx";
import { ConditionTag, Note } from "../ui/text.tsx";
import type { useDevelop } from "../use-develop.ts";
import { SurfaceTag } from "./Surface.tsx";

export type Develop = ReturnType<typeof useDevelop>;
const STATES: LifecycleState[] = ["idle", "running", "interrupted", "detached"];

export const shortAlias = (alias: string): string => alias.replace(/^endo\.session\./, "");

export function StateTag({ state }: { state: LifecycleState }): ReactElement {
	return (
		<span className="state state-life" data-life={state} title={STATE_WORDING[state].meaning}>
			<LifecycleGlyph state={state} />
			<span>{STATE_WORDING[state].word}</span>
		</span>
	);
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	if (!next.delete(value)) next.add(value);
	return next;
}

function Row({
	row,
	selected,
	onChoose,
}: {
	row: EndoCockpitDevelopSessionRowV0;
	selected: boolean;
	onChoose(): void;
}) {
	const meta = (
		<>
			{grouped(row.events)} event{row.events === 1 ? "" : "s"}
			{row.recorded === null
				? null
				: ` · ${grouped(row.recorded.runs)} run${row.recorded.runs === 1 ? "" : "s"}${
						row.recorded.lastRunOutcome === null ? "" : ` · last run ${row.recorded.lastRunOutcome}`
					}`}
		</>
	);
	if (row.recorded === null || row.selector === null)
		return (
			<li>
				<div
					className="caprow session-row is-static"
					data-testid="session-row"
					data-qualification={row.qualification}
				>
					<span className="session-name mono" title={row.session}>
						{shortAlias(row.session)}
					</span>
					<span className="session-state state state-degraded">{row.qualification}</span>
					<span className="session-meta">{meta}</span>
					<SurfaceTag session={presentRecorded(row, null)} />
					<span className="session-reason">
						{row.reason === "several-attachments"
							? "Several Pi attachments recorded this session; it is not reduced."
							: row.reason === "import-incomplete"
								? "The DSH import is incomplete or not recorded as clean."
								: "Could not be qualified for inspection."}
					</span>
				</div>
			</li>
		);
	return (
		<li>
			<button
				type="button"
				className="caprow session-row"
				aria-pressed={selected}
				data-session-row=""
				data-testid="session-row"
				data-qualification="inspectable"
				onClick={onChoose}
			>
				<span className="session-name mono" title={row.session}>
					{shortAlias(row.session)}
				</span>
				<span className="session-state">
					<StateTag state={row.recorded.state} />
				</span>
				<span className="session-meta">{meta}</span>
				<SurfaceTag session={presentRecorded(row, null)} />
			</button>
		</li>
	);
}

export function Navigator({
	develop,
	live,
	onRecorded,
}: {
	develop: Develop;
	/** The live session's row, offered by a workbench: a "Connected" group above the recorded sessions. */
	live?: ReactNode;
	/** Called when a recorded session is chosen, so the workspace can leave the live view. */
	onRecorded?: () => void;
}): ReactElement {
	const { state } = develop;
	const inventory = state.inventory;
	const rows = inventory === null ? [] : filterRows(inventory.sessions, state.filters);
	const groups = groupBySource(rows);
	const reading = state.request !== null;
	const set = (filters: Partial<DevelopFilters>) =>
		develop.dispatch({ type: "filters", filters: { ...state.filters, ...filters } });
	const walk = (event: KeyboardEvent<HTMLElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-session-row]")];
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
	const condition = inventory === null ? null : known(SOURCE_STATE, inventory.source.condition.state);
	return (
		<Panel
			id="develop-sessions"
			title="Sessions"
			subtitle="recorded, grouped by source"
			className="develop-nav"
			resetKey={inventory}
			tools={
				<>
					{state.problem !== null && inventory !== null ? (
						<span
							className="stale-chip"
							title="The latest attempt to read failed: this is the last read that succeeded."
						>
							not current
						</span>
					) : null}
					{reading ? (
						<button type="button" className="btn" id="develop-cancel" onClick={develop.cancel}>
							Cancel
						</button>
					) : null}
					<button
						type="button"
						className="btn"
						id="develop-refresh"
						disabled={reading || develop.paced}
						onClick={develop.refresh}
					>
						{reading ? "Reading…" : inventory === null ? "Read sessions" : "Reload list"}
					</button>
				</>
			}
		>
			{live === undefined ? null : (
				<section className="nav-group" aria-labelledby="develop-group-connected">
					<h3 id="develop-group-connected">Attached (1)</h3>
					<ul className="caplist">
						<li>{live}</li>
					</ul>
				</section>
			)}
			{state.problem === null ? null : <Note tone="error">{state.problem}</Note>}
			{state.notice === null ? null : <Note tone="warn">{state.notice}</Note>}
			{reading && inventory === null ? (
				<output className="loading">
					<span className="spinner" aria-hidden="true" /> Reading recorded sessions…
				</output>
			) : null}
			{inventory === null ? null : (
				<>
					{inventory.source.condition.state === "readable" ? null : (
						<p className="note note-warn" data-testid="develop-source-note">
							<ConditionTag
								state={inventory.source.condition.state}
								label={condition?.label ?? null}
								meaning={condition?.meaning ?? null}
							/>{" "}
							{inventory.source.condition.state === "degraded"
								? "Sessions are listed from the last verified position only; what follows it is not readable here."
								: (condition?.meaning ?? "")}
						</p>
					)}
					{inventory.page.total === 0 ? (
						<div className="develop-empty" data-testid="develop-empty">
							<h3>
								{inventory.source.condition.state === "absent" ? "No event store here" : "No recorded sessions"}
							</h3>
							<p>
								Sessions appear here once a Pi attachment or a DSH import has recorded them in the store this
								page reads. An empty list is not evidence that nothing ran: it says only that this store holds
								no such recording.
							</p>
							<p>This page only reads. It cannot start, attach to or steer an agent.</p>
						</div>
					) : (
						<>
							<div className="toolbar">
								<input
									className="search"
									type="search"
									aria-label="Filter loaded sessions by alias"
									placeholder="Filter by alias"
									value={state.filters.text}
									onChange={(event) => set({ text: event.currentTarget.value })}
								/>
								<fieldset className="chips">
									<legend className="sr-only">Source</legend>
									{(["pi", "dsh"] as const).map((source) => (
										<button
											key={source}
											type="button"
											className="chip"
											aria-pressed={state.filters.sources.has(source)}
											onClick={() => set({ sources: toggled(state.filters.sources, source) })}
										>
											{source === "pi" ? "Pi" : "DSH"}
										</button>
									))}
								</fieldset>
								<fieldset className="chips">
									<legend className="sr-only">Recorded state</legend>
									{STATES.map((s) => (
										<button
											key={s}
											type="button"
											className="chip"
											aria-pressed={state.filters.states.has(s)}
											onClick={() => set({ states: toggled(state.filters.states, s) })}
										>
											{s}
										</button>
									))}
								</fieldset>
							</div>
							<p className="dim small" data-testid="develop-coverage">
								{listCoverage(state, rows.length)}
							</p>
							<p className="dim small">
								Project: unavailable for every session. The recorded evidence does not establish one.
							</p>
							{state.readAt === null ? null : (
								<p className="dim small" title="By this browser's clock. Not the time of any recorded event.">
									Read at {state.readAt.toLocaleTimeString([], { hour12: false })} (browser clock).
								</p>
							)}
							{inventory.otherSessions === 0 ? null : (
								<p className="dim small">
									{inventory.otherSessions} other session{inventory.otherSessions === 1 ? "" : "s"} in the log{" "}
									{inventory.otherSessions === 1 ? "is" : "are"} not Pi or DSH recording
									{inventory.otherSessions === 1 ? "" : "s"} and not listed.
								</p>
							)}
							{rows.length === 0 ? (
								<Note>
									No loaded session matches these filters.{" "}
									{developFiltersActive(state.filters) ? (
										<button
											type="button"
											className="btn small-btn"
											onClick={() => develop.dispatch({ type: "filters", filters: NO_DEVELOP_FILTERS })}
										>
											Clear filters
										</button>
									) : null}
								</Note>
							) : (
								<nav aria-label="Recorded sessions" className="sessions-scroll" onKeyDown={walk}>
									{groups.map((group) => (
										<section
											key={group.source}
											className="nav-group"
											aria-labelledby={`develop-group-${group.source}`}
										>
											<h3 id={`develop-group-${group.source}`}>
												{group.label} ({group.rows.length})
											</h3>
											<ul className="caplist">
												{group.rows.map((row) => (
													<Row
														key={`${row.source}:${row.session}`}
														row={row}
														selected={row.selector !== null && row.selector === state.selected}
														onChoose={() => {
															if (row.selector === null) return;
															onRecorded?.();
															develop.choose(row.selector);
														}}
													/>
												))}
											</ul>
										</section>
									))}
								</nav>
							)}
							{inventory.page.hasMore ? (
								<p>
									<button
										type="button"
										className="btn"
										id="develop-more"
										disabled={reading || develop.paced}
										onClick={develop.more}
									>
										Load next sessions
									</button>
								</p>
							) : null}
						</>
					)}
				</>
			)}
		</Panel>
	);
}
