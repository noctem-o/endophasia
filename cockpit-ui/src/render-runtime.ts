// The runtime panel: which runtime an attachment records, as its registry projects it. Every value is a claim with its basis or an
// explicit unavailable mark; nothing here is computed from anything else.
import type {
	EndoCockpitChangeViewV0,
	EndoCockpitFingerprintViewV0,
	EndoCockpitNotificationViewV0,
	EndoCockpitRuntimeIdentityV0,
} from "../../protocol/cockpit.ts";
import { h, show } from "./dom.ts";
import { CHANGE_KIND, CONFIDENCE, DIFFERENCE, known, NOTIFICATION_KIND, VERSION_ORDER } from "./labels.ts";
import { abbreviated, attachmentChoices, grouped, noteViews, selectRuntime } from "./model.ts";
import type { Actions, AppState } from "./state.ts";
import { claim, facts, note, noteItem, stateBadge, textValue } from "./widgets.ts";

function fingerprint(view: EndoCockpitFingerprintViewV0): HTMLElement {
	return facts([
		["fingerprint", textValue(view.id, { mono: true, keep: 28 })],
		[
			"observed at",
			h(
				"span",
				{ class: "mono iso", title: "the time the attachment recorded for this observation" },
				view.observedAt,
			),
		],
		["version", claim(view.version, (v) => textValue(v, { mono: true }))],
		[
			"identity",
			claim(view.identity, (v) =>
				h(
					"span",
					{},
					h("span", { class: "mono", title: v.digest }, abbreviated(v.digest, 16)),
					" · ",
					known(CONFIDENCE, v.confidence) ?? v.confidence,
				),
			),
		],
		[
			"entrypoint",
			claim(view.entrypoint, (v) =>
				h(
					"span",
					{},
					h("span", { class: "mono", title: v.sha256 }, abbreviated(v.sha256, 16)),
					` · ${grouped(v.bytes)} bytes`,
				),
			),
		],
		["package", claim(view.package, (v) => textValue(`${v.name} ${v.version}`, { mono: true }))],
		[
			"withheld",
			view.withheld.length === 0
				? h("span", { class: "dim" }, "nothing")
				: h(
						"details",
						{ class: "dim" },
						h(
							"summary",
							{ title: "recorded, and withheld by the privacy policy" },
							`${view.withheld.length} recorded field${view.withheld.length === 1 ? "" : "s"}, not presented`,
						),
						h("span", { class: "mono small" }, view.withheld.join(", ")),
					),
		],
	]);
}

function change(view: EndoCockpitChangeViewV0): HTMLElement {
	const versionOf = (o: EndoCockpitChangeViewV0["previous"]) =>
		o === null ? "none" : o.version === null ? "no version reported" : o.version;
	return facts([
		["kind", known(CHANGE_KIND, view.kind) ?? view.kind],
		["recorded", h("span", { class: "mono iso" }, view.at)],
		[
			"differences",
			view.differences.length === 0
				? h("span", { class: "dim" }, "none recorded")
				: view.differences.map((d) => known(DIFFERENCE, d) ?? d).join(", "),
		],
		["version order", known(VERSION_ORDER, view.versionOrder) ?? view.versionOrder],
		["version", h("span", { class: "mono" }, `${versionOf(view.previous)} → ${versionOf(view.current)}`)],
		[
			"failure text",
			view.failure === "withheld"
				? h("span", { class: "withheld", title: "recorded, not presented: it can name local paths" }, "withheld")
				: h("span", { class: "dim" }, "none recorded"),
		],
	]);
}

function notification(view: EndoCockpitNotificationViewV0): HTMLElement {
	return facts([
		["kind", known(NOTIFICATION_KIND, view.kind) ?? view.kind],
		["recorded", h("span", { class: "mono iso" }, view.at)],
		["title", textValue(view.title)],
		["lines", h("span", { class: "dim" }, `${grouped(view.lineCount)} recorded, not presented`)],
	]);
}

function section(title: string, ...content: (HTMLElement | null)[]): HTMLElement {
	return h("section", { class: "block" }, h("h3", {}, title), ...content);
}

export function renderRuntime(
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
	const choices = attachmentChoices(snapshot);
	const runtime = selectRuntime(snapshot, state.attachment);
	show(
		panel.tools,
		choices.length < 2
			? null
			: h(
					"label",
					{ class: "select-label" },
					h("span", { class: "sr-only" }, "Attachment"),
					h(
						"select",
						{
							attrs: { "aria-label": "Attachment", "data-focus": "attachment" },
							on: {
								change: (event) => actions.selectAttachment((event.currentTarget as HTMLSelectElement).value),
							},
						},
						...choices.map((c) =>
							h(
								"option",
								{
									attrs: {
										value: c.attachment,
										...(c.attachment === runtime?.identity.source.attachment ? { selected: "selected" } : {}),
									},
								},
								`${c.attachment} · ${c.state}`,
							),
						),
					),
				),
	);
	if (runtime === null) {
		show(
			panel.body,
			note(
				"No attachment registry was found under this store. A registry that does not exist is not listed, and nothing is assumed about it.",
			),
		);
		return;
	}
	const identity: EndoCockpitRuntimeIdentityV0 = runtime.identity;
	const notes = noteViews(identity.notes);
	show(
		panel.body,
		h(
			"div",
			{ class: "source-line" },
			stateBadge(identity.source.condition.state),
			h("span", { class: "mono dim" }, `registry · ${identity.source.attachment}`),
		),
		identity.source.condition.state === "unopenable"
			? note(
					`The registry could not be opened${identity.source.condition.error === null ? "" : `: ${identity.source.condition.error.message}`}. Nothing is projected from it; this is not an empty registry.`,
					"error",
				)
			: null,
		facts([["runtime", claim(identity.runtime, (v) => textValue(v, { mono: true }))]]),
		section(
			"Current fingerprint",
			identity.current === null
				? note(
						identity.source.condition.state === "absent"
							? "This attachment has no registry yet."
							: "No fingerprint is recorded.",
					)
				: fingerprint(identity.current),
		),
		identity.lastChange === null && identity.lastNotification === null
			? facts([
					["last change", h("span", { class: "dim" }, "none recorded")],
					["notification", h("span", { class: "dim" }, "none recorded")],
				])
			: null,
		identity.lastChange === null ? null : section("Last recorded change", change(identity.lastChange)),
		identity.lastNotification === null ? null : section("Last notification", notification(identity.lastNotification)),
		identity.previousDifferent === null
			? null
			: section("Latest earlier observation with a different identity", fingerprint(identity.previousDifferent)),
		notes.length === 0 ? null : h("ul", { class: "notes" }, ...notes.map(noteItem)),
	);
}
