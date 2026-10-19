// The sources panel: where every shown value was read from, and in what condition. The sources are independent histories: the
// event log and each registry were opened one after another and share no sequence and no snapshot boundary, so each is shown with its
// own condition and position and nothing is joined, summed or reduced to one health figure.
import { h, show } from "./dom.ts";
import {
	duration,
	eventLogSourceView,
	noteViews,
	registrySourceView,
	type SourceView,
	selectRuntime,
} from "./model.ts";
import type { AppState } from "./state.ts";
import { facts, note, stateBadge, textValue } from "./widgets.ts";

function card(view: SourceView, selected: boolean): HTMLElement {
	return h(
		"article",
		{ class: `source${selected ? " current" : ""}`, attrs: { "data-state": view.state } },
		h("header", {}, h("h3", {}, view.title), stateBadge(view.state)),
		// The legend in the inspector explains the conditions; a card repeats the meaning only where it matters.
		view.state === "readable" || view.state === "empty"
			? null
			: h(
					"p",
					{ class: "dim small" },
					view.described === null ? "A condition this build does not know." : view.described.meaning,
				),
		view.positioned
			? facts(view.facts.map((f) => [f.label, textValue(f.value, { mono: true })]))
			: note(
					"This source has no position: nothing was read from it, which is not the same as a log of length zero.",
				),
		view.tornTailBytes === null
			? null
			: h(
					"p",
					{ class: "small warn-text" },
					`Torn tail left in place: ${view.tornTailBytes.toLocaleString("en-US")} bytes.`,
				),
		view.sealedAt === null
			? null
			: h(
					"p",
					{ class: "small warn-text" },
					`First record that failed verification: number ${view.sealedAt.toLocaleString("en-US")}.`,
				),
		view.error === null ? null : h("p", { class: "small error-text" }, view.error),
	);
}

export function renderSources(panel: { body: HTMLElement; tools: HTMLElement }, state: AppState): void {
	show(panel.tools);
	const loaded = state.loaded;
	if (loaded === null) {
		show(panel.body, note("No snapshot has been read yet."));
		return;
	}
	const snapshot = loaded.snapshot;
	const selected = selectRuntime(snapshot, state.attachment);
	const timelineNotes = noteViews(snapshot.timeline.notes);
	show(
		panel.body,
		h(
			"p",
			{ class: "independent" },
			h("strong", {}, "Independent sources. "),
			"Opened one after another; no shared sequence or moment.",
		),
		card(eventLogSourceView(snapshot.timeline.source), true),
		...snapshot.runtimes.map((runtime) => card(registrySourceView(runtime.identity.source), runtime === selected)),
		snapshot.runtimes.length === 0
			? note("No attachment registry was found under this store; none is assumed.")
			: null,
		timelineNotes.length === 0
			? null
			: h(
					"section",
					{ class: "block" },
					h("h3", {}, "Timeline notes"),
					h("ul", { class: "notes" }, ...timelineNotes.map((n) => h("li", {}, n.text ?? h("code", {}, n.code)))),
				),
		h(
			"p",
			{ class: "dim small read-line" },
			`Read ${loaded.fetchedAt.toLocaleTimeString("en-GB")} by this browser's clock, in ${duration(loaded.durationMs)}. The projection is a view of recorded observations, not evidence in itself.`,
		),
	);
}
