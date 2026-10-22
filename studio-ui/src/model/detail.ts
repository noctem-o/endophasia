// What the inspector and the runtime, capability and source panels say, as data. Every row is a field of a record the projection
// returned, with the basis it carries; nothing here is computed from anything else, and nothing is a new claim.
import type {
	EndoCockpitCapabilityViewV0,
	EndoCockpitChangeViewV0,
	EndoCockpitFingerprintViewV0,
	EndoCockpitNotificationViewV0,
	EndoCockpitRuntimeIdentityV0,
	EndoCockpitSnapshotV0,
	EndoCockpitTimelineEntryV0,
} from "../../../protocol/cockpit.ts";
import {
	type Cell,
	claimCell,
	dim,
	type Fact,
	mono,
	parts,
	plain,
	str,
	type TextModel,
	textCell,
	textModel,
	unavailableCell,
} from "./cells.ts";
import {
	abbreviated,
	attachmentChoices,
	CATEGORY,
	CHANGE_KIND,
	CHECK_KIND,
	CLASSIFICATION,
	CONFIDENCE,
	capabilityRows,
	DIFFERENCE,
	describeRef,
	EVENT_SOURCE,
	eventLogSourceView,
	FLAG,
	grouped,
	known,
	limitText,
	NOTIFICATION_KIND,
	noteViews,
	registrySourceView,
	SOURCE_STATE,
	STATUS,
	selectRuntime,
	statusCounts,
	usageView,
	VERSION_ORDER,
} from "./contract.ts";

// --- events ---------------------------------------------------------------------------------------------------------------

export interface FlagModel {
	flag: string;
	label: string;
	/** What the flag means, or "" for a flag this build does not know (shown as its raw name, never given a meaning). */
	meaning: string;
}

export const flagModel = (flag: string): FlagModel => ({
	flag,
	label: known(FLAG, flag)?.label ?? flag,
	meaning: known(FLAG, flag)?.meaning ?? "",
});

export interface FieldRow {
	name: string;
	cell: Cell;
}

export type UsageModel =
	| { kind: "never" }
	| { kind: "not-recorded"; reason: TextModel }
	| { kind: "reported"; facts: Fact[] };

export interface EventDetail {
	sequence: number;
	title: string;
	facts: Fact[];
	flags: FlagModel[];
	fields: FieldRow[];
	/** The sentence under the fields: how many payload keys the policy did not present. */
	withheldNote: string;
	usage: UsageModel;
	/** The entry as the projection returned it, for the disclosure. Text only. */
	raw: string;
}

const none = (text: string): Cell => dim(text);

export function eventDetail(entry: EndoCockpitTimelineEntryV0): EventDetail {
	const usage = usageView(entry.usage);
	return {
		sequence: entry.storageSequence,
		title: `Event at position ${grouped(entry.storageSequence)}`,
		facts: [
			{ label: "kind", cell: textCell(entry.kind, { mono: true }) },
			{ label: "category", cell: plain(known(CATEGORY, entry.category) ?? entry.category) },
			{ label: "event id", cell: textCell(entry.eventId, { mono: true }) },
			{ label: "source class", cell: plain(known(EVENT_SOURCE, entry.source) ?? entry.source) },
			{ label: "producer", cell: textCell(entry.producer, { mono: true }) },
			{
				label: "producer sequence",
				cell: parts(plain(grouped(entry.producerSequence)), dim(" (within this producer only)")),
			},
			{ label: "producer clock", cell: mono(entry.recordedAt) },
			{
				label: "session",
				cell: entry.sessionId === null ? none("none recorded") : textCell(entry.sessionId, { mono: true }),
			},
			{ label: "run", cell: entry.runId === null ? none("none recorded") : textCell(entry.runId, { mono: true }) },
			{
				label: "experiment",
				cell: entry.experimentId === null ? none("none recorded") : textCell(entry.experimentId, { mono: true }),
			},
			{
				label: "derived from",
				cell:
					entry.derivedFrom.length === 0
						? none("nothing")
						: { k: "list", items: entry.derivedFrom.map((id) => textCell(id, { mono: true, keep: 36 })) },
			},
		],
		flags: entry.flags.map(flagModel),
		fields: Object.entries(entry.fields).map(([name, field]) => ({
			name,
			cell:
				field.basis === "unavailable"
					? unavailableCell(field.reason)
					: claimCell(field, (value) =>
							value === null
								? { k: "dim", text: "empty", title: "the record holds an explicit empty value" }
								: typeof value === "string"
									? textCell(value, { mono: true })
									: mono(String(value)),
						),
		})),
		withheldNote:
			entry.withheldFields === 0
				? "No payload key was withheld."
				: `${grouped(entry.withheldFields)} payload key${entry.withheldFields === 1 ? " was" : "s were"} recorded and not presented.`,
		usage:
			usage.kind === "never"
				? { kind: "never" }
				: usage.kind === "not-recorded"
					? { kind: "not-recorded", reason: textModel(usage.reason) }
					: {
							kind: "reported",
							facts: usage.parts.map((p) => ({
								label: p.label,
								cell: p.recorded ? mono(p.value) : dim(p.value),
							})),
						},
		raw: JSON.stringify(entry, null, 2),
	};
}

// --- capabilities ---------------------------------------------------------------------------------------------------------

export interface LimitModel {
	/** The sentence for a code this build knows, or null (the raw code is shown). */
	text: string | null;
	code: string;
	refs: string;
}

export interface CapabilityDetail {
	name: TextModel;
	status: string;
	statusLabel: string;
	statusMeaning: string;
	facts: Fact[];
	limits: LimitModel[];
	/** Said when `limits` is empty: why, and what that does not establish. */
	noLimitsText: string;
	evidence: Fact[] | null;
	noEvidenceText: string;
	limitations: TextModel[];
}

export function capabilityDetail(capability: EndoCockpitCapabilityViewV0): CapabilityDetail {
	const evidence = capability.evidence;
	const status = known(STATUS, capability.status);
	return {
		name: textModel(capability.capability, { mono: true }),
		status: capability.status,
		statusLabel: status?.label ?? capability.status,
		statusMeaning: status?.meaning ?? "a status this build does not know",
		facts: [
			{
				label: "classification (state)",
				cell:
					capability.classification === null
						? none("none recorded")
						: plain(known(CLASSIFICATION, capability.classification) ?? capability.classification),
			},
			{ label: "requires", cell: plain(known(CHECK_KIND, capability.requires) ?? capability.requires) },
			{ label: "recorded reason", cell: textCell(capability.reason) },
			{ label: "record", cell: dim(describeRef(capability.ref)) },
		],
		limits: capability.limits.map((limit) => ({
			text: limitText(limit.code),
			code: limit.code,
			refs: limit.refs.length === 0 ? "" : limit.refs.map(describeRef).join("; "),
		})),
		noLimitsText:
			capability.status === "unverified"
				? "Limits are not derived for an unverified capability: it is recorded without current evidence."
				: "No derived limit applies: the recorded status, classification, evidence and fingerprints agree on every point the projection checks. That is not a verification of the capability.",
		evidence:
			evidence === null
				? null
				: [
						{ label: "check", cell: mono(`${str(evidence.check.name)} ${str(evidence.check.version)}`) },
						{
							label: "kind of check",
							cell: plain(known(CHECK_KIND, evidence.check.kind) ?? evidence.check.kind),
						},
						{ label: "evidence recorded", cell: mono(evidence.at) },
						{
							label: "classification (evidence)",
							cell: plain(known(CLASSIFICATION, evidence.classification) ?? evidence.classification),
						},
						{ label: "evidence record", cell: textCell(evidence.id, { mono: true, keep: 30 }) },
						{
							label: "recorded against",
							cell: textCell(evidence.dependencies.fingerprintId, { mono: true, keep: 30 }),
						},
						{
							label: "identity",
							cell: parts(
								mono(
									abbreviated(evidence.dependencies.identityDigest, 16),
									evidence.dependencies.identityDigest,
								),
								plain(
									` · ${known(CONFIDENCE, evidence.dependencies.confidence) ?? evidence.dependencies.confidence}`,
								),
							),
						},
						{
							label: "versions",
							cell: mono(
								`adapter ${evidence.dependencies.adapterVersion} · mapping ${evidence.dependencies.mappingVersion} · suite ${evidence.dependencies.suiteVersion}`,
							),
						},
						{
							label: "extension",
							cell:
								evidence.dependencies.extension === null
									? none("none")
									: mono(
											`${str(evidence.dependencies.extension.id)} ${str(evidence.dependencies.extension.version)}`,
										),
						},
						{
							label: "rests on",
							cell:
								evidence.supporting.length === 0
									? none("nothing recorded")
									: dim(
											`${grouped(evidence.supporting.length)} digest${evidence.supporting.length === 1 ? "" : "s"} (opaque)`,
											evidence.supporting.join("\n"),
										),
						},
						{
							label: "not presented",
							cell: evidence.withheld.length === 0 ? none("nothing") : dim(evidence.withheld.join(", ")),
						},
					],
		noEvidenceText:
			capability.status === "unverified"
				? "None: this capability is recorded as unverified."
				: "The state cites no evidence record that is present in the registry.",
		limitations: capability.limitations.map((l) => textModel(l)),
	};
}

// --- runtime --------------------------------------------------------------------------------------------------------------

export interface NoteModel {
	text: string | null;
	code: string;
	refs: string;
}

const notes = (list: Parameters<typeof noteViews>[0]): NoteModel[] =>
	noteViews(list).map((n) => ({ text: n.text, code: n.code, refs: n.refs.join("; ") }));

function fingerprintFacts(view: EndoCockpitFingerprintViewV0): Fact[] {
	return [
		{ label: "fingerprint", cell: textCell(view.id, { mono: true, keep: 28 }) },
		{
			label: "observed at",
			cell: mono(view.observedAt, "the time the attachment recorded for this observation"),
		},
		{ label: "version", cell: claimCell(view.version, (v) => textCell(v, { mono: true })) },
		{
			label: "identity",
			cell: claimCell(view.identity, (v) =>
				parts(
					mono(abbreviated(v.digest, 16), v.digest),
					plain(` · ${known(CONFIDENCE, v.confidence) ?? v.confidence}`),
				),
			),
		},
		{
			label: "entrypoint",
			cell: claimCell(view.entrypoint, (v) =>
				parts(mono(abbreviated(v.sha256, 16), v.sha256), plain(` · ${grouped(v.bytes)} bytes`)),
			),
		},
		{
			label: "package",
			cell: claimCell(view.package, (v) => textCell(`${str(v.name)} ${str(v.version)}`, { mono: true })),
		},
		{
			label: "withheld",
			cell:
				view.withheld.length === 0
					? dim("nothing")
					: {
							k: "disclosure",
							summary: `${view.withheld.length} recorded field${view.withheld.length === 1 ? "" : "s"}, not presented`,
							body: view.withheld.join(", "),
							title: "recorded, and withheld by the privacy policy",
						},
		},
	];
}

function changeFacts(view: EndoCockpitChangeViewV0): Fact[] {
	const versionOf = (o: EndoCockpitChangeViewV0["previous"]) =>
		o === null ? "none" : o.version === null ? "no version reported" : str(o.version);
	return [
		{ label: "kind", cell: plain(known(CHANGE_KIND, view.kind) ?? view.kind) },
		{ label: "recorded", cell: mono(view.at) },
		{
			label: "differences",
			cell:
				view.differences.length === 0
					? dim("none recorded")
					: plain(view.differences.map((d) => known(DIFFERENCE, d) ?? d).join(", ")),
		},
		{ label: "version order", cell: plain(known(VERSION_ORDER, view.versionOrder) ?? view.versionOrder) },
		{ label: "version", cell: mono(`${versionOf(view.previous)} → ${versionOf(view.current)}`) },
		{
			label: "failure text",
			cell:
				view.failure === "withheld"
					? { k: "text", text: textModel("withheld: looks like a path, address or credential") }
					: dim("none recorded"),
		},
	];
}

function notificationFacts(view: EndoCockpitNotificationViewV0): Fact[] {
	return [
		{ label: "kind", cell: plain(known(NOTIFICATION_KIND, view.kind) ?? view.kind) },
		{ label: "recorded", cell: mono(view.at) },
		{ label: "title", cell: textCell(view.title) },
		{ label: "lines", cell: dim(`${grouped(view.lineCount)} recorded, not presented`) },
	];
}

export interface SourceCondition {
	state: string;
	/** The state's wording, or null for a state this build does not know (shown as its raw text). */
	label: string | null;
	meaning: string | null;
}

export const sourceCondition = (state: string): SourceCondition => {
	const described = known(SOURCE_STATE, state);
	return { state, label: described?.label ?? null, meaning: described?.meaning ?? null };
};

export interface RuntimeModel {
	choices: { attachment: string; label: string; selected: boolean }[];
	/** Null: the snapshot lists no attachment. */
	attachment: null | {
		name: string;
		condition: SourceCondition;
		unopenableText: string | null;
		runtime: Cell;
		currentText: string | null;
		current: Fact[] | null;
		lastChange: Fact[] | null;
		lastNotification: Fact[] | null;
		neitherRecorded: boolean;
		previousDifferent: Fact[] | null;
		notes: NoteModel[];
	};
	noRegistryText: string;
}

export function runtimeModel(snapshot: EndoCockpitSnapshotV0, attachment: string | null): RuntimeModel {
	const choices = attachmentChoices(snapshot);
	const runtime = selectRuntime(snapshot, attachment);
	const chosen = runtime?.identity.source.attachment ?? null;
	const base = {
		choices: choices.map((c) => ({
			attachment: c.attachment,
			label: `${c.attachment} · ${c.state}`,
			selected: c.attachment === chosen,
		})),
		noRegistryText:
			"No attachment registry was found under this store. A registry that does not exist is not listed, and nothing is assumed about it.",
	};
	if (runtime === null) return { ...base, attachment: null };
	const identity: EndoCockpitRuntimeIdentityV0 = runtime.identity;
	const condition = identity.source.condition;
	return {
		...base,
		attachment: {
			name: identity.source.attachment,
			condition: sourceCondition(condition.state),
			unopenableText:
				condition.state === "unopenable"
					? `The registry could not be opened${condition.error === null ? "" : `: ${condition.error.message}`}. Nothing is projected from it; this is not an empty registry.`
					: null,
			runtime: claimCell(identity.runtime, (v) => textCell(v, { mono: true })),
			currentText:
				identity.current === null
					? condition.state === "absent"
						? "This attachment has no registry yet."
						: "No fingerprint is recorded."
					: null,
			current: identity.current === null ? null : fingerprintFacts(identity.current),
			lastChange: identity.lastChange === null ? null : changeFacts(identity.lastChange),
			lastNotification: identity.lastNotification === null ? null : notificationFacts(identity.lastNotification),
			neitherRecorded: identity.lastChange === null && identity.lastNotification === null,
			previousDifferent: identity.previousDifferent === null ? null : fingerprintFacts(identity.previousDifferent),
			notes: notes(identity.notes),
		},
	};
}

// --- capability list ------------------------------------------------------------------------------------------------------

const CURRENCY = {
	current: ["current", "The state was recorded for the latest recorded fingerprint."],
	stale: ["stale", "A newer fingerprint was recorded without a state following it."],
	unknown: [
		"unknown",
		"The state names no fingerprint, or none is recorded, so whether it is for the latest cannot be told.",
	],
} as const;

export interface CapabilityRowModel {
	name: TextModel;
	/** The raw name, the identity of the row. */
	key: string;
	status: string;
	statusLabel: string;
	statusMeaning: string;
	classification: string;
	hasClassification: boolean;
	limits: number;
	selected: boolean;
}

export type CapabilitiesModel =
	| { kind: "no-registry"; text: string }
	| { kind: "no-state"; text: string; tone: "info" | "error"; notes: NoteModel[] }
	| {
			kind: "state";
			currency: { label: string; meaning: string; tone: string };
			recordedAt: string;
			fingerprint: TextModel | null;
			latest: TextModel | null;
			counts: { status: string; label: string; count: number }[];
			rows: CapabilityRowModel[];
			emptyText: string;
			notes: NoteModel[];
	  };

export function capabilitiesModel(
	snapshot: EndoCockpitSnapshotV0,
	attachment: string | null,
	selectedCapability: string | null,
): CapabilitiesModel {
	const runtime = selectRuntime(snapshot, attachment);
	if (runtime === null) return { kind: "no-registry", text: "No attachment registry was found." };
	const capabilities = runtime.capabilities;
	const record = capabilities.state;
	if (record === null) {
		const unopenable = capabilities.source.condition.state === "unopenable";
		return {
			kind: "no-state",
			text: unopenable
				? "The registry could not be opened, so no capability state can be shown. This is not a runtime without capabilities."
				: "No capability state is recorded. This is not a statement that nothing is supported.",
			tone: unopenable ? "error" : "info",
			notes: notes(capabilities.notes),
		};
	}
	const rows = capabilityRows(capabilities);
	const currency = known(CURRENCY, record.currency);
	return {
		kind: "state",
		currency: {
			label: currency?.[0] ?? record.currency,
			meaning: currency?.[1] ?? "",
			tone: currency === null ? "unknown" : record.currency,
		},
		recordedAt: record.recordedAt,
		fingerprint: record.fingerprintId === null ? null : textModel(record.fingerprintId, { mono: true, keep: 20 }),
		latest:
			record.latestFingerprintId === null ? null : textModel(record.latestFingerprintId, { mono: true, keep: 20 }),
		counts: statusCounts(rows),
		rows: rows.map((row) => ({
			name: textModel(row.capability, { mono: true }),
			key: row.capability,
			status: row.status,
			statusLabel: row.statusLabel,
			statusMeaning: known(STATUS, row.status)?.meaning ?? "",
			classification:
				row.classification === null
					? "unclassified"
					: (known(CLASSIFICATION, row.classification) ?? row.classification),
			hasClassification: row.classification !== null,
			limits: row.limits,
			selected: selectedCapability === row.capability,
		})),
		emptyText: "The state records no capabilities.",
		notes: notes(capabilities.notes),
	};
}

// --- sources --------------------------------------------------------------------------------------------------------------

export interface SourceCardModel {
	id: string;
	title: string;
	condition: SourceCondition;
	current: boolean;
	/** The condition's meaning, shown on the card only where it matters (not for readable or empty). */
	meaning: string | null;
	positioned: boolean;
	facts: Fact[];
	tornTail: string | null;
	sealedAt: string | null;
	error: string | null;
}

export interface SourcesModel {
	cards: SourceCardModel[];
	noRegistryText: string | null;
	timelineNotes: NoteModel[];
}

export function sourcesModel(snapshot: EndoCockpitSnapshotV0, attachment: string | null): SourcesModel {
	const selected = selectRuntime(snapshot, attachment);
	const card = (view: ReturnType<typeof eventLogSourceView>, current: boolean): SourceCardModel => ({
		id: view.id,
		title: view.title,
		condition: sourceCondition(view.state),
		current,
		meaning:
			view.state === "readable" || view.state === "empty"
				? null
				: (view.described?.meaning ?? "A condition this build does not know."),
		positioned: view.positioned,
		facts: view.facts.map((f) => ({
			label: f.label,
			cell: textCell(f.value, { mono: true, ...(f.keep === undefined ? {} : { keep: f.keep }) }),
		})),
		tornTail: view.tornTailBytes === null ? null : `Torn tail left in place: ${grouped(view.tornTailBytes)} bytes.`,
		sealedAt:
			view.sealedAt === null ? null : `First record that failed verification: number ${grouped(view.sealedAt)}.`,
		error: view.error,
	});
	return {
		cards: [
			card(eventLogSourceView(snapshot.timeline.source), true),
			...snapshot.runtimes.map((runtime) => card(registrySourceView(runtime.identity.source), runtime === selected)),
		],
		noRegistryText:
			snapshot.runtimes.length === 0 ? "No attachment registry was found under this store; none is assumed." : null,
		timelineNotes: notes(snapshot.timeline.notes),
	};
}
