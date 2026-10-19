// The inspector: one selected event or capability, in full, with its provenance on demand. Nothing here is a new claim: every row is
// a field of the record the projection returned, with the basis it carries. The default view is the legend that says how to read
// the marks, so the page explains itself without a manual.
import type { EndoCockpitCapabilityViewV0, EndoCockpitTimelineEntryV0 } from "../../protocol/cockpit.ts";
import { h, show } from "./dom.ts";
import { capabilityStatusIcon } from "./icons.ts";
import {
	BASIS,
	CATEGORY,
	CHECK_KIND,
	CLASSIFICATION,
	CONFIDENCE,
	EVENT_SOURCE,
	FLAG,
	known,
	SOURCE_STATE,
	STATUS,
} from "./labels.ts";
import { abbreviated, describeRef, grouped, limitText, selectRuntime, usageView } from "./model.ts";
import type { AppState } from "./state.ts";
import { basisBadge, facts, note, stateBadge, textValue, unavailable } from "./widgets.ts";

const none = (text: string) => h("span", { class: "dim" }, text);

export function eventDetail(entry: EndoCockpitTimelineEntryV0): HTMLElement {
	const usage = usageView(entry.usage);
	const fieldRows = Object.entries(entry.fields);
	return h(
		"div",
		{ class: "detail" },
		h("h3", { class: "detail-title" }, `Event at position ${grouped(entry.storageSequence)}`),
		facts([
			["kind", textValue(entry.kind, { mono: true })],
			["category", known(CATEGORY, entry.category) ?? entry.category],
			["event id", textValue(entry.eventId, { mono: true })],
			["source class", known(EVENT_SOURCE, entry.source) ?? entry.source],
			["producer", textValue(entry.producer, { mono: true })],
			[
				"producer sequence",
				h("span", {}, grouped(entry.producerSequence), h("span", { class: "dim" }, " (within this producer only)")),
			],
			["recorded", h("span", { class: "mono" }, entry.recordedAt)],
			["session", entry.sessionId === null ? none("none recorded") : textValue(entry.sessionId, { mono: true })],
			["run", entry.runId === null ? none("none recorded") : textValue(entry.runId, { mono: true })],
			[
				"experiment",
				entry.experimentId === null ? none("none recorded") : textValue(entry.experimentId, { mono: true }),
			],
			[
				"derived from",
				entry.derivedFrom.length === 0
					? none("nothing")
					: h(
							"ul",
							{ class: "plain" },
							...entry.derivedFrom.map((id) => h("li", {}, textValue(id, { mono: true, keep: 36 }))),
						),
			],
		]),
		h(
			"p",
			{ class: "dim small" },
			"Position is the order. The recorded time is the producer's own clock and can run backwards.",
		),
		entry.flags.length === 0
			? null
			: h(
					"ul",
					{ class: "plain flags-list" },
					...entry.flags.map((flag) =>
						h(
							"li",
							{},
							h("span", { class: `flag flag-${flag}` }, known(FLAG, flag)?.label ?? flag),
							" ",
							known(FLAG, flag)?.meaning ?? "",
						),
					),
				),
		h(
			"section",
			{ class: "block" },
			h("h3", {}, "Presented fields"),
			fieldRows.length === 0
				? note("No payload field is approved for presentation for this kind.")
				: h(
						"table",
						{ class: "fields" },
						h(
							"thead",
							{},
							h(
								"tr",
								{},
								h("th", { attrs: { scope: "col" } }, "Field"),
								h("th", { attrs: { scope: "col" } }, "Value"),
							),
						),
						h(
							"tbody",
							{},
							...fieldRows.map(([name, field]) =>
								h(
									"tr",
									{},
									h("th", { attrs: { scope: "row" }, class: "mono" }, name),
									h(
										"td",
										{},
										field.basis === "unavailable"
											? unavailable(field.reason)
											: h(
													"span",
													{ class: "claim" },
													field.value === null
														? h(
																"span",
																{ class: "dim", title: "the record holds an explicit empty value" },
																"empty",
															)
														: typeof field.value === "string"
															? textValue(field.value, { mono: true })
															: h("span", { class: "mono" }, String(field.value)),
													basisBadge(field.basis),
												),
									),
								),
							),
						),
					),
			h(
				"p",
				{ class: "dim small" },
				entry.withheldFields === 0
					? "No payload key was withheld."
					: `${grouped(entry.withheldFields)} payload key${entry.withheldFields === 1 ? " was" : "s were"} recorded and not presented.`,
			),
		),
		h(
			"section",
			{ class: "block" },
			h("h3", {}, "Usage, as reported for this event"),
			usage.kind === "never"
				? none("This kind of event does not carry usage.")
				: usage.kind === "not-recorded"
					? unavailable(usage.reason)
					: h(
							"div",
							{},
							facts(
								usage.parts.map((p) => [
									p.label,
									p.recorded ? h("span", { class: "mono" }, p.value) : h("span", { class: "dim" }, p.value),
								]),
							),
							h("p", { class: "dim small" }, "Not added up: one call can be recorded by more than one event."),
						),
		),
		h(
			"details",
			{ class: "raw" },
			h("summary", {}, "Projection JSON of this entry"),
			h("pre", {}, JSON.stringify(entry, null, 2)),
		),
	);
}

export function capabilityDetail(capability: EndoCockpitCapabilityViewV0): HTMLElement {
	const evidence = capability.evidence;
	return h(
		"div",
		{ class: "detail" },
		h("h3", { class: "detail-title" }, textValue(capability.capability, { mono: true })),
		facts([
			[
				"recorded status",
				h(
					"span",
					{ class: "status-line", attrs: { "data-status": capability.status } },
					capabilityStatusIcon(capability.status),
					" ",
					known(STATUS, capability.status)?.label ?? capability.status,
					h(
						"span",
						{ class: "dim" },
						` — ${known(STATUS, capability.status)?.meaning ?? "a status this build does not know"}`,
					),
				),
			],
			[
				"classification",
				capability.classification === null
					? none("none recorded")
					: (known(CLASSIFICATION, capability.classification) ?? capability.classification),
			],
			["requires", known(CHECK_KIND, capability.requires) ?? capability.requires],
			["recorded reason", textValue(capability.reason)],
			["record", h("span", { class: "dim small" }, describeRef(capability.ref))],
		]),
		h(
			"section",
			{ class: "block" },
			h("h3", {}, "Limits on this status"),
			capability.limits.length === 0
				? none(
						capability.status === "unverified"
							? "Limits are not derived for an unverified capability: it is recorded without current evidence."
							: "No derived limit applies: the recorded status, classification, evidence and fingerprints agree on every point the projection checks. That is not a verification of the capability.",
					)
				: h(
						"ul",
						{ class: "limits" },
						...capability.limits.map((limit) =>
							h(
								"li",
								{},
								limitText(limit.code) ?? h("code", {}, limit.code),
								limit.refs.length === 0
									? null
									: h("span", { class: "dim small" }, ` (${limit.refs.map(describeRef).join("; ")})`),
							),
						),
					),
		),
		h(
			"section",
			{ class: "block" },
			h("h3", {}, "Evidence"),
			evidence === null
				? none(
						capability.status === "unverified"
							? "None: this capability is recorded as unverified."
							: "The state cites no evidence record that is present in the registry.",
					)
				: h(
						"div",
						{},
						facts([
							["check", h("span", { class: "mono" }, `${evidence.check.name} ${evidence.check.version}`)],
							["kind of check", known(CHECK_KIND, evidence.check.kind) ?? evidence.check.kind],
							["recorded", h("span", { class: "mono" }, evidence.at)],
							["classification", known(CLASSIFICATION, evidence.classification) ?? evidence.classification],
							["evidence record", textValue(evidence.id, { mono: true, keep: 30 })],
							["recorded against", textValue(evidence.dependencies.fingerprintId, { mono: true, keep: 30 })],
							[
								"identity",
								h(
									"span",
									{},
									h(
										"span",
										{ class: "mono", title: evidence.dependencies.identityDigest },
										abbreviated(evidence.dependencies.identityDigest, 16),
									),
									` · ${known(CONFIDENCE, evidence.dependencies.confidence) ?? evidence.dependencies.confidence}`,
								),
							],
							[
								"versions",
								h(
									"span",
									{ class: "mono" },
									`adapter ${evidence.dependencies.adapterVersion} · mapping ${evidence.dependencies.mappingVersion} · suite ${evidence.dependencies.suiteVersion}`,
								),
							],
							[
								"extension",
								evidence.dependencies.extension === null
									? none("none")
									: h(
											"span",
											{ class: "mono" },
											`${evidence.dependencies.extension.id} ${evidence.dependencies.extension.version}`,
										),
							],
							[
								"rests on",
								evidence.supporting.length === 0
									? none("nothing recorded")
									: h(
											"span",
											{ class: "dim", title: evidence.supporting.join("\n") },
											`${grouped(evidence.supporting.length)} digest${evidence.supporting.length === 1 ? "" : "s"} (opaque)`,
										),
							],
							[
								"not presented",
								evidence.withheld.length === 0
									? none("nothing")
									: h("span", { class: "dim" }, evidence.withheld.join(", ")),
							],
						]),
					),
			capability.limitations.length === 0
				? null
				: h(
						"div",
						{},
						h("h4", {}, "Limitations the evidence states"),
						h("ul", { class: "plain" }, ...capability.limitations.map((l) => h("li", {}, textValue(l)))),
					),
		),
	);
}

function legend(): HTMLElement {
	return h(
		"div",
		{ class: "legend" },
		h("p", { class: "lead" }, "Select an event or a capability to see exactly what was recorded, and where."),
		h("h3", {}, "How a value is known"),
		h(
			"ul",
			{ class: "plain" },
			...(["observed", "reported", "derived", "unavailable"] as const).map((basis) =>
				h("li", {}, basisBadge(basis), " ", h("span", { class: "dim" }, BASIS[basis].meaning)),
			),
		),
		h("h3", {}, "Source conditions"),
		h(
			"ul",
			{ class: "plain" },
			...(Object.keys(SOURCE_STATE) as (keyof typeof SOURCE_STATE)[]).map((state) =>
				h("li", {}, stateBadge(state), " ", h("span", { class: "dim" }, SOURCE_STATE[state].meaning)),
			),
		),
		h("h3", {}, "Recorded capability status"),
		h(
			"ul",
			{ class: "plain" },
			...(Object.keys(STATUS) as (keyof typeof STATUS)[]).map((status) =>
				h(
					"li",
					{ attrs: { "data-status": status } },
					capabilityStatusIcon(status),
					" ",
					STATUS[status].label,
					" ",
					h("span", { class: "dim" }, STATUS[status].meaning),
				),
			),
		),
		h(
			"p",
			{ class: "dim small" },
			"The timeline is in storage order. Recorded times are the producers' own clocks. A projection of records is not evidence in itself.",
		),
	);
}

export function renderInspector(panel: { body: HTMLElement; tools: HTMLElement }, state: AppState): void {
	show(panel.tools);
	const snapshot = state.loaded?.snapshot ?? null;
	const selection = state.selection;
	if (snapshot === null || selection === null) {
		show(panel.body, legend());
		return;
	}
	if (selection.kind === "event") {
		const entry = snapshot.timeline.entries.find((e) => e.storageSequence === selection.sequence);
		show(
			panel.body,
			entry === undefined
				? note("That event is not in the window now on screen. Select one from the timeline.", "warn")
				: eventDetail(entry),
		);
		return;
	}
	const runtime = selectRuntime(snapshot, state.attachment);
	const capability = runtime?.capabilities.capabilities.find((c) => c.capability === selection.name);
	show(
		panel.body,
		capability === undefined
			? note("That capability is not in the state now on screen. Select one from the list.", "warn")
			: capabilityDetail(capability),
	);
}
