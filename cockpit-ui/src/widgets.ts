// Small parts the panels share: the marks that keep one kind of claim visibly different from another.
import type { EndoCockpitBasisV0 } from "../../protocol/cockpit.ts";
import { type Child, h } from "./dom.ts";
import { sourceStateIcon } from "./icons.ts";
import { ALIAS_PATTERN, BASIS, known, SOURCE_STATE, WITHHELD_TEXT } from "./labels.ts";
import { abbreviated, type NoteView, presentText } from "./model.ts";

/** How a value is known: observed, reported, derived, or unavailable. Text as well as colour, with the meaning on hover. */
export function basisBadge(basis: EndoCockpitBasisV0 | "unavailable"): HTMLElement {
	const described = known(BASIS, basis);
	return h(
		"span",
		{
			class: `basis basis-${described === null ? "unknown" : basis}`,
			title: described?.meaning ?? "A basis this build does not know.",
		},
		h("span", { attrs: { "aria-hidden": "true" } }, described?.short ?? "?"),
		h("span", { class: "sr-only" }, described?.label ?? `unknown basis ${basis}`),
	);
}

/** A source's condition with its own shape and word, and what it means on hover. */
export function stateBadge(state: string): HTMLElement {
	const described = known(SOURCE_STATE, state);
	return h(
		"span",
		{
			class: `state state-${described === null ? "unknown" : state}`,
			title: described?.meaning ?? "A condition this build does not know.",
		},
		sourceStateIcon(state),
		h("span", {}, described?.label ?? state),
	);
}

/** A string from the contract: ordinary text, the withheld marker, or a generated alias, each plainly different. */
export function textValue(value: string, options: { mono?: boolean; keep?: number } = {}): HTMLElement {
	const presented = presentText(value);
	if (presented.kind === "withheld") return h("span", { class: "withheld", title: WITHHELD_TEXT }, "withheld");
	const shown = options.keep === undefined ? value : abbreviated(value, options.keep);
	if (presented.kind === "alias") {
		// The alias is a stand-in: show the start of its token, with the whole value on hover.
		const token = ALIAS_PATTERN.exec(value)?.[0] ?? value;
		return h(
			"span",
			{ class: "alias", title: `${value}\n(a generated alias: the original is not presented)` },
			h("span", { class: "alias-tag" }, "alias"),
			h("code", {}, `${token.slice(0, 17)}\u2026`),
		);
	}
	return h("span", { class: options.mono === true ? "mono" : "", title: value }, shown);
}

/** A value that is not there, with the reason the record gives. Never a blank and never a zero. */
export function unavailable(reason: string): HTMLElement {
	return h(
		"span",
		{ class: "unavailable" },
		basisBadge("unavailable"),
		h("span", { class: "reason" }, textValue(reason)),
	);
}

/** A claim: its value with its basis, or the unavailable mark and its reason. */
export function claim<T>(
	value: { basis: EndoCockpitBasisV0; value: T } | { basis: "unavailable"; reason: string },
	show: (value: T) => Child,
): HTMLElement {
	return value.basis === "unavailable"
		? unavailable(value.reason)
		: h("span", { class: "claim" }, h("span", { class: "claim-value" }, show(value.value)), basisBadge(value.basis));
}

/** A definition list of label and value rows. */
export function facts(rows: readonly [string, Child][]): HTMLElement {
	return h("dl", { class: "facts" }, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]));
}

/** A panel with a header (title, optional subtitle and tools) and a body. */
export function panel(
	id: string,
	title: string,
	options: { subtitle?: string; tools?: Child; className?: string } = {},
): { root: HTMLElement; body: HTMLElement; tools: HTMLElement } {
	const body = h("div", { class: "panel-body" });
	const tools = h("div", { class: "panel-tools" }, options.tools ?? null);
	const root = h(
		"section",
		{ class: `panel ${options.className ?? ""}`.trim(), id, attrs: { "aria-labelledby": `${id}-title` } },
		h(
			"header",
			{ class: "panel-head" },
			h(
				"div",
				{ class: "panel-titles" },
				h("h2", { id: `${id}-title` }, title),
				options.subtitle === undefined ? null : h("p", { class: "panel-sub" }, options.subtitle),
			),
			tools,
		),
		body,
	);
	return { root, body, tools };
}

/** A note as a list item: its sentence (or its raw code when this build has none), then, subdued, the records it was drawn from as the model describes them, in the order given. */
export function noteItem(view: NoteView): HTMLElement {
	return h(
		"li",
		{},
		view.text ?? h("code", {}, view.code),
		view.refs.length === 0 ? null : h("span", { class: "dim" }, ` (${view.refs.join("; ")})`),
	);
}

export function note(text: string, kind: "info" | "warn" | "error" = "info"): HTMLElement {
	return h("p", { class: `note note-${kind}`, attrs: { role: kind === "error" ? "alert" : "note" } }, text);
}
