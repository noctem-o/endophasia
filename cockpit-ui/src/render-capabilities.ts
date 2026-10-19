// The capability panel: the registry's latest capability state, status by status as recorded. A status is shown verbatim and never
// recomputed; `limits` are the projection's reasons a status cannot be taken at face value, and are only counted here and spelled
// out in the inspector. There is no score and no total: a count of records per recorded status is the most it says.
import { h, show } from "./dom.ts";
import { capabilityStatusIcon } from "./icons.ts";
import { CLASSIFICATION, known, STATUS } from "./labels.ts";
import { capabilityRows, noteViews, selectRuntime, statusCounts } from "./model.ts";
import type { Actions, AppState } from "./state.ts";
import { note, textValue } from "./widgets.ts";

const CURRENCY = {
	current: ["current", "The state was recorded for the latest recorded fingerprint."],
	stale: ["stale", "A newer fingerprint was recorded without a state following it."],
	unknown: [
		"unknown",
		"The state names no fingerprint, or none is recorded, so whether it is for the latest cannot be told.",
	],
} as const;

export function renderCapabilities(
	panel: { body: HTMLElement; tools: HTMLElement },
	state: AppState,
	actions: Actions,
): void {
	show(panel.tools);
	const snapshot = state.loaded?.snapshot ?? null;
	const runtime = snapshot === null ? null : selectRuntime(snapshot, state.attachment);
	if (runtime === null) {
		show(
			panel.body,
			note(snapshot === null ? "No snapshot has been read yet." : "No attachment registry was found."),
		);
		return;
	}
	const capabilities = runtime.capabilities;
	const notes = noteViews(capabilities.notes);
	const record = capabilities.state;
	if (record === null) {
		show(
			panel.body,
			note(
				capabilities.source.condition.state === "unopenable"
					? "The registry could not be opened, so no capability state can be shown. This is not a runtime without capabilities."
					: "No capability state is recorded. This is not a statement that nothing is supported.",
				capabilities.source.condition.state === "unopenable" ? "error" : "info",
			),
			notes.length === 0
				? null
				: h("ul", { class: "notes" }, ...notes.map((n) => h("li", {}, n.text ?? h("code", {}, n.code)))),
		);
		return;
	}
	const rows = capabilityRows(capabilities);
	const currency = known(CURRENCY, record.currency);
	show(
		panel.body,
		h(
			"div",
			{ class: "cap-state" },
			h(
				"span",
				{
					class: `currency currency-${currency === null ? "unknown" : record.currency}`,
					title: currency?.[1] ?? "",
				},
				currency?.[0] ?? record.currency,
			),
			h("span", { class: "dim" }, " state recorded "),
			h("span", { class: "mono iso" }, record.recordedAt),
		),
		h(
			"p",
			{ class: "dim small" },
			"For fingerprint ",
			record.fingerprintId === null
				? h("span", { class: "withheld" }, "none named")
				: textValue(record.fingerprintId, { mono: true, keep: 20 }),
			". Latest recorded: ",
			record.latestFingerprintId === null ? "none" : textValue(record.latestFingerprintId, { mono: true, keep: 20 }),
			".",
		),
		rows.length === 0
			? note("The state records no capabilities.")
			: h(
					"p",
					{ class: "counts", attrs: { "aria-label": "capabilities by recorded status" } },
					...statusCounts(rows).flatMap((c) => [
						h(
							"span",
							{ class: "count", attrs: { "data-status": c.status } },
							capabilityStatusIcon(c.status),
							` ${c.count} ${c.label}`,
						),
					]),
				),
		h(
			"ul",
			{ class: "caplist" },
			...rows.map((row) => {
				const selected = state.selection?.kind === "capability" && state.selection.name === row.capability;
				const classification =
					row.classification === null ? null : (known(CLASSIFICATION, row.classification) ?? row.classification);
				return h(
					"li",
					{},
					h(
						"button",
						{
							type: "button",
							class: "caprow",
							attrs: { "aria-pressed": String(selected), "data-status": row.status, "data-key": row.capability },
							title: known(STATUS, row.status)?.meaning,
							on: { click: () => actions.select({ kind: "capability", name: row.capability }) },
						},
						h("span", { class: "cap-status" }, capabilityStatusIcon(row.status)),
						h("span", { class: "cap-name" }, textValue(row.capability, { mono: true })),
						h("span", { class: "cap-status-label" }, row.statusLabel),
						h(
							"span",
							{
								class: row.classification === null ? "cap-class none" : "cap-class",
								title: "the classification this capability state records (the cited evidence records its own: see the inspector)",
							},
							classification ?? "unclassified",
						),
						row.limits === 0
							? null
							: h(
									"span",
									{ class: "cap-limits", title: "reasons this status cannot be taken at face value" },
									`${row.limits} limit${row.limits === 1 ? "" : "s"}`,
								),
					),
				);
			}),
		),
		notes.length === 0
			? null
			: h("ul", { class: "notes" }, ...notes.map((n) => h("li", {}, n.text ?? h("code", {}, n.code)))),
	);
}
