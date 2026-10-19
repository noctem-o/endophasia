// The timeline panel: the event log's window in storage order. `storageSequence` is the one ordering; `recordedAt` is the
// producer's own clock, shown as written under its own heading; `producerSequence` is meaningful within one producer only and
// is shown in the inspector, not here. Filters act on the loaded window only and say so.
import type { EndoCockpitTimelineEntryV0 } from "../../protocol/cockpit.ts";
import { h, show } from "./dom.ts";
import { CATEGORY, FLAG, known, SOURCE_STATE } from "./labels.ts";
import { categoryCounts, filterEntries, filtersActive, grouped, NO_FILTERS, pagerView, usageView } from "./model.ts";
import { type Actions, type AppState, controlsLocked, PAGE_SIZES } from "./state.ts";
import { note, stateBadge, textValue } from "./widgets.ts";

/** The producer-clock string as written, split at the `T`: the date shows once above the rows it covers, the time in each row. */
function splitClock(recordedAt: string): { date: string | null; time: string } {
	const at = recordedAt.indexOf("T");
	return at === -1
		? { date: null, time: recordedAt }
		: { date: recordedAt.slice(0, at), time: recordedAt.slice(at + 1) };
}
const timePart = (recordedAt: string) => splitClock(recordedAt).time;

function usageCell(entry: EndoCockpitTimelineEntryV0): HTMLElement | null {
	const usage = usageView(entry.usage);
	if (usage.kind === "never") return null;
	if (usage.kind === "not-recorded")
		return h(
			"span",
			{ class: "tag tag-na", title: `usage not recorded for this event: ${usage.reason}` },
			"not recorded",
		);
	const part = (label: string) => usage.parts.find((p) => p.label === label)?.value ?? "";
	return h(
		"span",
		{ class: "usage mono", title: "usage reported for this event; see the inspector" },
		`in ${part("input tokens")} · out ${part("output tokens")}`,
	);
}

function row(entry: EndoCockpitTimelineEntryV0, selected: boolean, actions: Actions): HTMLElement {
	const select = () => actions.select({ kind: "event", sequence: entry.storageSequence });
	return h(
		"tr",
		{
			class: selected ? "selected" : "",
			attrs: { "aria-selected": String(selected), "data-seq": String(entry.storageSequence) },
			on: { click: select },
		},
		h(
			"td",
			{ class: "col-seq" },
			h(
				"button",
				{
					type: "button",
					class: "seq",
					attrs: {
						"aria-label": `Inspect event at position ${entry.storageSequence}`,
						"aria-pressed": String(selected),
					},
					on: {
						click: (event) => {
							event.stopPropagation();
							select();
						},
					},
				},
				grouped(entry.storageSequence),
			),
		),
		h("td", { class: "col-time mono", title: entry.recordedAt }, timePart(entry.recordedAt)),
		h(
			"td",
			{ class: "col-cat" },
			h(
				"span",
				{ class: `cat cat-${known(CATEGORY, entry.category) === null ? "other" : entry.category}` },
				known(CATEGORY, entry.category) ?? entry.category,
			),
		),
		h("td", { class: "col-kind" }, textValue(entry.kind, { mono: true })),
		h("td", { class: "col-producer" }, textValue(entry.producer, { mono: true })),
		h(
			"td",
			{ class: "col-marks" },
			usageCell(entry),
			...entry.flags.map((flag) =>
				h(
					"span",
					{ class: `flag flag-${flag}`, title: known(FLAG, flag)?.meaning ?? "" },
					known(FLAG, flag)?.label ?? flag,
				),
			),
		),
	);
}

/** Move focus between row buttons with the arrow keys, so a window can be walked without the mouse. */
function walk(event: KeyboardEvent): void {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button.seq")];
	const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
	if (at === -1) return;
	const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
	if (next === undefined) return;
	event.preventDefault();
	next.focus();
}

function pagerButton(label: string, after: number | null, actions: Actions, busy: boolean): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: "btn",
			attrs: { "data-focus": `pager:${label}`, ...(after === null || busy ? { disabled: "disabled" } : {}) },
			on: { click: () => after !== null && actions.goTo(after) },
		},
		label,
	);
}

export function renderTimeline(
	panel: { body: HTMLElement; tools: HTMLElement },
	state: AppState,
	actions: Actions,
): void {
	const snapshot = state.loaded?.snapshot ?? null;
	if (snapshot === null) {
		show(panel.tools);
		show(panel.body, note("No snapshot has been read yet."));
		return;
	}
	const timeline = snapshot.timeline;
	const condition = timeline.source.condition;
	const pager = pagerView(timeline, state.loaded?.request.limit ?? state.pageSize);
	const filtered = filterEntries(timeline.entries, state.filters);
	const counts = categoryCounts(timeline.entries);
	const active = filtersActive(state.filters);
	const sessionIds = timeline.sessions.map((s) => s.sessionId);

	show(
		panel.tools,
		stateBadge(condition.state),
		h(
			"label",
			{ class: "select-label" },
			h("span", { class: "dim" }, "Rows"),
			h(
				"select",
				{
					attrs: {
						"aria-label": "Rows per page",
						"data-focus": "pagesize",
						...(controlsLocked(state) ? { disabled: "disabled" } : {}),
					},
					on: { change: (event) => actions.setPageSize(Number((event.currentTarget as HTMLSelectElement).value)) },
				},
				...PAGE_SIZES.map((size) =>
					h(
						"option",
						{ attrs: { value: String(size), ...(size === state.pageSize ? { selected: "selected" } : {}) } },
						String(size),
					),
				),
			),
		),
	);

	const unreadable = condition.state === "unopenable" || timeline.source.watermark === null;
	const emptyMessage =
		condition.state === "absent"
			? "No event log exists under this store root."
			: condition.state === "empty"
				? "The event log exists and holds no events."
				: condition.state === "unopenable"
					? `The event log could not be opened${condition.error === null ? "" : `: ${condition.error.message}`}. Nothing is shown from it. This is not an empty log.`
					: null;

	const toolbar = h(
		"div",
		{ class: "toolbar", attrs: { role: "group", "aria-label": "Filters for the events in this window" } },
		h("input", {
			id: "timeline-search",
			type: "search",
			class: "search",
			attrs: {
				"aria-label": "Filter by kind, producer or event id",
				placeholder: "filter kind, producer, id",
				value: state.filters.text,
				"data-focus": "search",
			},
			on: {
				// While an input method is composing, the box is left alone (a rebuilt box would drop the composition); the filter is
				// applied when the composition ends, and for plain typing on each key.
				input: (event) => {
					if (event.isComposing) return;
					actions.setFilters({ ...state.filters, text: (event.currentTarget as HTMLInputElement).value });
				},
				compositionend: (event) =>
					actions.setFilters({ ...state.filters, text: (event.currentTarget as HTMLInputElement).value }),
			},
		}),
		h(
			"div",
			{ class: "chips", attrs: { role: "group", "aria-label": "Categories in this window" } },
			...counts.map(({ category, count }) => {
				const on = state.filters.categories.has(category);
				return h(
					"button",
					{
						type: "button",
						class: `chip cat-${known(CATEGORY, category) === null ? "other" : category}`,
						attrs: { "aria-pressed": String(on), "data-focus": `category:${category}` },
						on: {
							click: () => {
								const next = new Set(state.filters.categories);
								if (on) next.delete(category);
								else next.add(category);
								actions.setFilters({ ...state.filters, categories: next });
							},
						},
					},
					`${known(CATEGORY, category) ?? category} ${count}`,
				);
			}),
		),
		h(
			"label",
			{ class: "check" },
			h("input", {
				type: "checkbox",
				attrs: {
					value: "flagged",
					"data-focus": "flagged",
					...(state.filters.flaggedOnly ? { checked: "checked" } : {}),
				},
				on: {
					change: (event) =>
						actions.setFilters({
							...state.filters,
							flaggedOnly: (event.currentTarget as HTMLInputElement).checked,
						}),
				},
			}),
			" flagged only",
		),
		sessionIds.length < 2
			? null
			: h(
					"select",
					{
						attrs: { "aria-label": "Session", "data-focus": "session" },
						on: {
							change: (event) => {
								const value = (event.currentTarget as HTMLSelectElement).value;
								actions.setFilters({ ...state.filters, session: value === "" ? null : value });
							},
						},
					},
					h("option", { attrs: { value: "" } }, "all sessions"),
					...sessionIds.map((id) =>
						h(
							"option",
							{ attrs: { value: id, ...(state.filters.session === id ? { selected: "selected" } : {}) } },
							id,
						),
					),
				),
		active
			? h(
					"button",
					{
						type: "button",
						class: "btn quiet",
						attrs: { "data-focus": "clear" },
						on: { click: () => actions.setFilters(NO_FILTERS) },
					},
					"clear filters",
				)
			: null,
	);
	// Typing re-renders this panel, so main.ts puts the caret back in the search box afterwards (it finds it by this id).
	const range =
		pager.firstPosition === null
			? "no events in this window"
			: `positions ${grouped(pager.firstPosition)}–${grouped(pager.lastPosition ?? 0)}`;
	const of = pager.total === null ? "position of the log unknown" : `of ${grouped(pager.total)} read`;
	const more = pager.hasMore === null ? "" : pager.hasMore ? " · more follow" : " · end of log";

	show(
		panel.body,
		condition.state === "degraded"
			? note(
					`${known(SOURCE_STATE, "degraded")?.meaning ?? ""}${condition.tornTail === null ? "" : ` ${grouped(condition.tornTail.bytes)} bytes follow the last verified event.`}${condition.sealedAt === null ? "" : ` The first record that failed verification is number ${grouped(condition.sealedAt)}.`}`,
					"warn",
				)
			: null,
		emptyMessage !== null && unreadable
			? note(emptyMessage, condition.state === "unopenable" ? "error" : "info")
			: emptyMessage !== null
				? note(emptyMessage)
				: h(
						"div",
						{ class: "timeline-wrap" },
						toolbar,
						h(
							"p",
							{ class: "window-line", attrs: { "aria-live": "polite" } },
							h("span", { class: "mono" }, range),
							" ",
							h("span", { class: "dim" }, `${of}${more}`),
							" · ",
							h(
								"span",
								{ class: "dim" },
								active
									? `${grouped(filtered.shown)} of ${grouped(filtered.inWindow)} in this window match`
									: `${grouped(filtered.inWindow)} in this window`,
							),
						),
						filtered.rows.length === 0
							? note(
									active
										? "No event in this window matches the filters. Other windows are not searched."
										: "This window holds no events.",
								)
							: h(
									"div",
									{ class: "table-scroll" },
									h(
										"table",
										{ class: "events" },
										h(
											"caption",
											{ class: "sr-only" },
											"Recorded events in storage order. The time column is the producer's clock.",
										),
										h(
											"colgroup",
											{},
											h("col", { class: "c-seq" }),
											h("col", { class: "c-time" }),
											h("col", { class: "c-cat" }),
											h("col", {}),
											h("col", { class: "c-producer" }),
											h("col", { class: "c-marks" }),
										),
										h(
											"thead",
											{},
											h(
												"tr",
												{},
												h(
													"th",
													{
														attrs: { scope: "col" },
														title: "Position in the event log: the only ordering",
													},
													"Position",
												),
												h(
													"th",
													{
														attrs: { scope: "col" },
														title: "The producer's own clock, as written. Not an ordering.",
													},
													"Recorded",
												),
												h("th", { attrs: { scope: "col" } }, "Category"),
												h("th", { attrs: { scope: "col" } }, "Kind"),
												h("th", { attrs: { scope: "col" } }, "Producer"),
												h(
													"th",
													{
														attrs: { scope: "col" },
														title: "Reported by the runtime for this event, never summed",
													},
													"Usage \u00b7 flags",
												),
											),
										),
										h(
											"tbody",
											{ on: { keydown: walk } },
											...filtered.rows.flatMap((entry, index) => {
												// A date row precedes the first row and every row whose producer-clock date differs from the row
												// before it. The clock can run backwards across entries and then the dates go back too: that is
												// what was recorded, and the position column is still the order.
												const date = splitClock(entry.recordedAt).date;
												const before =
													index === 0 ? undefined : splitClock(filtered.rows[index - 1]!.recordedAt).date;
												const divider =
													date !== null && date !== before
														? h(
																"tr",
																{ class: "date-row" },
																h(
																	"th",
																	{
																		attrs: {
																			colspan: "6",
																			scope: "colgroup",
																		},
																		title: "the producer's clock, not an ordering",
																	},
																	`${date} \u00b7 producer clock`,
																),
															)
														: null;
												const selected =
													state.selection?.kind === "event" &&
													state.selection.sequence === entry.storageSequence;
												return [divider, row(entry, selected, actions)];
											}),
										),
									),
								),
						h(
							"nav",
							{ class: "pager", attrs: { "aria-label": "Timeline pages" } },
							pagerButton("First", pager.firstAfter, actions, controlsLocked(state)),
							pagerButton("Previous", pager.previousAfter, actions, controlsLocked(state)),
							pagerButton("Next", pager.nextAfter, actions, controlsLocked(state)),
							pagerButton("Latest", pager.latestAfter, actions, controlsLocked(state)),
							h("span", { class: "dim small" }, "Each page is a new read of the whole log."),
						),
					),
	);
}
