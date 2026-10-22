// EndoCockpitSnapshotV0 -> ObserveViewModel: the one place a validated projection becomes what the Observe workspace draws.
//
// Pure and deterministic. It reads no DOM, no network and no clock; it never mutates the snapshot; it supports exactly the
// projection versions reply.ts admits (the classifier refuses any other before a snapshot reaches here); and it never turns an absence
// into a fact: a null stays "not recorded", a source without a position stays positionless, a window stays a window. It invents no
// session outcome, no duration, no confidence and no completion status, because the projection records none.
import type { EndoCockpitSnapshotV0 } from "../../../protocol/cockpit.ts";
import { type BasisMark, basisMark } from "./cells.ts";
import { type Filters, FLAG, SOURCE_STATE, STATUS } from "./contract.ts";
import {
	type CapabilitiesModel,
	type CapabilityDetail,
	capabilitiesModel,
	capabilityDetail,
	type EventDetail,
	eventDetail,
	type RuntimeModel,
	runtimeModel,
	type SourceCondition,
	type SourcesModel,
	sourcesModel,
} from "./detail.ts";
import { type TimelineModel, timelineModel } from "./timeline.ts";
import type { Selection } from "./types.ts";

export interface ObserveInput {
	snapshot: EndoCockpitSnapshotV0;
	/** The attachment the operator chose (or null for the first the snapshot lists). */
	attachment: string | null;
	selection: Selection;
	filters: Filters;
	/** The page size of the read that produced the snapshot: the pager's step. */
	limit: number;
}

/** A source that is not simply readable, said wherever the page is, however narrow: an absent, degraded or unopenable source is never out of sight. */
export interface AttentionItem {
	id: string;
	title: string;
	condition: SourceCondition;
	text: string;
}

export interface LegendModel {
	bases: BasisMark[];
	conditions: { state: string; label: string; meaning: string }[];
	statuses: { status: string; label: string; meaning: string }[];
	marks: { markClass: string; label: string; meaning: string }[];
	flags: { flag: string; label: string; meaning: string }[];
}

export type InspectorModel =
	| { kind: "legend" }
	| { kind: "event"; detail: EventDetail; hiddenByFilters: boolean }
	| { kind: "capability"; detail: CapabilityDetail }
	| { kind: "gone"; text: string };

export interface ObserveViewModel {
	runtime: RuntimeModel;
	capabilities: CapabilitiesModel;
	sources: SourcesModel;
	timeline: TimelineModel;
	inspector: InspectorModel;
	attention: AttentionItem[];
	/** The attachment actually shown: the chosen one if the snapshot lists it, else the first, else null. */
	attachment: string | null;
}

export function toObserveViewModel(input: ObserveInput): ObserveViewModel {
	const { snapshot, selection } = input;
	const runtime = runtimeModel(snapshot, input.attachment);
	const shown = runtime.attachment?.name ?? null;
	const sources = sourcesModel(snapshot, shown);
	const selectedCapability = selection?.kind === "capability" ? selection.name : null;
	const timeline = timelineModel(snapshot, { filters: input.filters, selection, limit: input.limit });
	return {
		runtime,
		capabilities: capabilitiesModel(snapshot, shown, selectedCapability),
		sources,
		timeline,
		inspector: inspectorModel(snapshot, shown, selection, timeline),
		attention: attentionOf(sources),
		attachment: shown,
	};
}

/** Every source that is not readable or empty, with what its condition means and what the projection recorded about it. */
export function attentionOf(sources: SourcesModel): AttentionItem[] {
	return sources.cards
		.filter((card) => card.condition.state !== "readable" && card.condition.state !== "empty")
		.map((card) => ({
			id: card.id,
			title: card.title,
			condition: card.condition,
			text: [
				card.meaning,
				card.tornTail,
				card.sealedAt,
				card.error,
				card.positioned ? null : "It has no position: nothing was read from it.",
			]
				.filter((part): part is string => part !== null)
				.join(" "),
		}));
}

function inspectorModel(
	snapshot: EndoCockpitSnapshotV0,
	attachment: string | null,
	selection: Selection,
	timeline: TimelineModel,
): InspectorModel {
	if (selection === null) return { kind: "legend" };
	if (selection.kind === "event") {
		const entry = snapshot.timeline.entries.find(
			(e) => e.storageSequence === selection.sequence && e.eventId === selection.eventId,
		);
		return entry === undefined
			? { kind: "gone", text: "That event is not in the window now on screen. Select one from the timeline." }
			: {
					kind: "event",
					detail: eventDetail(entry),
					hiddenByFilters: !timeline.rows.some((row) => row.sequence === entry.storageSequence),
				};
	}
	const runtime =
		attachment === null ? undefined : snapshot.runtimes.find((r) => r.identity.source.attachment === attachment);
	const capability = runtime?.capabilities.capabilities.find((c) => c.capability === selection.name);
	return capability === undefined
		? { kind: "gone", text: "That capability is not in the state now on screen. Select one from the list." }
		: { kind: "capability", detail: capabilityDetail(capability) };
}

/**
 * Whether the page can show everything this snapshot lets the operator reach, without a further read. Selecting any event, switching
 * to any attachment and opening any capability each draw from the snapshot already held, so each of those views is built here, for
 * every event, every attachment and every capability, under the filters now set and under none. A snapshot that any of them cannot
 * build is a failed read now, not a broken panel later. (The components format nothing: what is built here is what is drawn.)
 */
export function checkDisplayable(snapshot: EndoCockpitSnapshotV0, filters: Filters, limit: number): boolean {
	try {
		const noFilters: Filters = { categories: new Set(), text: "", flaggedOnly: false, session: null };
		for (const entry of snapshot.timeline.entries) eventDetail(entry);
		for (const active of [filters, noFilters])
			toObserveViewModel({ snapshot, attachment: null, selection: null, filters: active, limit });
		for (const runtime of snapshot.runtimes) {
			toObserveViewModel({
				snapshot,
				attachment: runtime.identity.source.attachment,
				selection: null,
				filters: noFilters,
				limit,
			});
			for (const capability of runtime.capabilities.capabilities) capabilityDetail(capability);
		}
		return true;
	} catch {
		return false;
	}
}

const ABOUT_MARKS: LegendModel["marks"] = [
	{
		markClass: "observed",
		label: "observed",
		meaning: "Every presented field of the event is observed directly by Endophasia.",
	},
	{
		markClass: "reported",
		label: "reported",
		meaning: "Every presented field is reported by the runtime. Not independently verified.",
	},
	{ markClass: "derived", label: "derived", meaning: "Every presented field is computed from other recorded values." },
	{
		markClass: "inferred",
		label: "inferred",
		meaning: "Every presented field is inferred. No version of the contract produces this yet.",
	},
	{
		markClass: "mixed",
		label: "mixed",
		meaning: "The presented fields are known in more than one way: see the inspector.",
	},
	{ markClass: "unavailable", label: "unavailable", meaning: "Every presented field is a claim without a value." },
	{
		markClass: "unknown",
		label: "a basis this build does not know",
		meaning:
			"The presented fields carry a basis this build has no wording for. It is shown as what it is and given no meaning.",
	},
	{
		markClass: "envelope",
		label: "envelope only",
		meaning:
			"No payload field is approved for presentation for this kind. The event is recorded; nothing about its content is shown.",
	},
];

/** What the inspector shows before anything is selected: how to read the marks. Static, and the same for every store. */
export function legendModel(): LegendModel {
	return {
		bases: (["observed", "reported", "derived", "unavailable"] as const).map(basisMark),
		conditions: (Object.keys(SOURCE_STATE) as (keyof typeof SOURCE_STATE)[]).map((state) => ({
			state,
			label: SOURCE_STATE[state].label,
			meaning: SOURCE_STATE[state].meaning,
		})),
		statuses: (Object.keys(STATUS) as (keyof typeof STATUS)[]).map((status) => ({
			status,
			label: STATUS[status].label,
			meaning: STATUS[status].meaning,
		})),
		marks: ABOUT_MARKS,
		flags: (Object.keys(FLAG) as (keyof typeof FLAG)[]).map((flag) => ({
			flag,
			label: FLAG[flag].label,
			meaning: FLAG[flag].meaning,
		})),
	};
}
