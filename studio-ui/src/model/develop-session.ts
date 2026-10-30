// The neutral session presentation, built from what DEVELOP already holds. Pure: no DOM, no network, no clock, no randomness, no
// mutation of its input. Each projector reads a record the wire gates already validated (the workbench status; a recorded-session
// row) and returns the protocol's `EndoDevelopSessionV0`. The protocol is imported as types only, so completeness is the compiler's:
// a capability map missing an action does not type-check, and an absent field cannot become a "supported" action.
//
// Nothing here creates authority. Whether the page may ask for a prompt, a steer, a queue or a stop is decided by the broker's own
// `offers` and, at dispatch, by its admission and the operator's terminal approval; these capabilities only describe the same offers
// in the neutral vocabulary, and no control reads them. A live session and a recording of it are separate entries: this module never
// joins them by alias, name, path or time.
import type { EndoCockpitDevelopSessionRowV0 } from "../../../protocol/cockpit-develop.ts";
import type {
	EndoDevelopCapabilitiesV0,
	EndoDevelopCapabilityV0,
	EndoDevelopSessionV0,
	EndoDevelopStatusClaimV0,
	EndoDevelopSurfaceV0,
} from "../../../protocol/develop-session.ts";
import type { Offer, WorkbenchStatus } from "./workbench-wire.ts";

const supported = (via: string): EndoDevelopCapabilityV0 => ({ status: "supported", via, reason: null });
const unsupported = (reason: string): EndoDevelopCapabilityV0 => ({ status: "unsupported", via: null, reason });
const unavailable = (reason: string): EndoDevelopCapabilityV0 => ({ status: "unavailable", via: null, reason });

const BROKER = "pi-workbench-broker";
const NO_COORDINATION = (name: string): EndoDevelopCapabilitiesV0["coordinate"] => ({
	"list-children": unsupported(`${name} is a harness, not a coordinator: it has no child sessions to list.`),
	"dispatch-job": unsupported(`${name} is a harness, not a coordinator: it takes no jobs to hand out.`),
});

const offerCapability = (offer: Offer | undefined, connected: boolean): EndoDevelopCapabilityV0 =>
	!connected
		? unavailable("There is no admitted connection to this session now.")
		: offer === undefined
			? unavailable("The broker has not said what it offers.")
			: offer.offered
				? supported(BROKER)
				: unavailable(offer.reason ?? "The broker did not offer this.");

/** The live Pi workbench, as the broker last reported it. `unreachable`: the last attempt did not reach the broker at all. */
export function presentLivePi(status: WorkbenchStatus | null, unreachable: boolean): EndoDevelopSessionV0 {
	const known = status !== null && !unreachable;
	const connected = known && status.connection === "connected";
	const key: EndoDevelopSessionV0["identity"]["key"] =
		status === null
			? { status: "unavailable", reason: "No status has been read from the workbench yet." }
			: status.session !== null
				? { status: "established", id: status.session, scope: "source" }
				: // Before Pi has said which session it is, the only identity is this launch's, and the key says so.
					{ status: "established", id: status.launchId, scope: "launch" };
	const claim: EndoDevelopStatusClaimV0[] =
		connected && status.run !== "unknown"
			? [{ state: status.run === "active" ? "active" : "idle", basis: "reported", by: "pi", at: null }]
			: [];
	const offers = status?.offers;
	return {
		schemaVersion: "endo.develop-session.v0",
		identity: {
			source: "pi-live",
			key,
			alias: status?.session != null ? status.session.replace(/^endo\.session\./, "") : null,
		},
		integration: { label: "Pi workbench", type: "harness" },
		synthetic: false,
		runtime: { status: "established", value: { name: "Pi", version: null }, basis: "observed", by: "endophasia" },
		ownership: connected
			? { status: "established", value: "direct", basis: "observed", by: "endophasia" }
			: {
					status: "unavailable",
					reason: "Ownership is established while the broker holds the connection; it does not now.",
				},
		observation: connected
			? { mode: "live", reason: null }
			: {
					mode: "unavailable",
					reason: known
						? "The workbench reports no admitted connection to Pi."
						: "The workbench could not be reached, so nothing about the session is current.",
				},
		connection: connected
			? { state: "connected", reason: null }
			: known
				? { state: "disconnected", reason: "The workbench reports no admitted connection to Pi." }
				: {
						state: "unknown",
						reason: "The last read did not reach the workbench. That says nothing about the session.",
					},
		status: claim,
		capabilities: {
			observe: {
				"live-status": connected
					? supported(BROKER)
					: unavailable("There is no admitted connection to this session now."),
				"live-transcript": connected
					? supported(BROKER)
					: unavailable("There is no admitted connection to this session now."),
				lifecycle: unsupported(
					"A live session is not reduced to a recorded lifecycle; a recording is a separate entry.",
				),
				activity: unsupported(
					"A live session's recorded activity is read from its recording, which is a separate entry.",
				),
			},
			control: {
				prompt: offerCapability(offers?.prompt, connected),
				steer: offerCapability(offers?.steer, connected),
				queue: offerCapability(offers?.queue, connected),
				stop: offerCapability(offers?.stop, connected),
				resume: unsupported("Endophasia does not resume sessions."),
			},
			coordinate: NO_COORDINATION("Pi"),
		},
		evidence: status === null ? [] : [{ kind: "workbench-status.v0", producedBy: "pi-live", generation: null }],
	};
}

const RECORDED_STATE: Record<
	NonNullable<EndoCockpitDevelopSessionRowV0["recorded"]>["state"],
	EndoDevelopStatusClaimV0["state"]
> = {
	"not-observed": "not-observed",
	idle: "idle",
	running: "active",
	interrupted: "interrupted",
	detached: "detached",
};
const NOT_INSPECTABLE: Record<NonNullable<EndoCockpitDevelopSessionRowV0["reason"]>, string> = {
	"several-attachments": "Several Pi attachments recorded this session, so it is not reduced.",
	"import-incomplete": "The DSH import is incomplete or not recorded as clean, so it is not qualified.",
	"not-qualified": "The recording could not be qualified for inspection.",
};

/** One recorded session, from the listing's own row and the verified generation it was read under. */
export function presentRecorded(row: EndoCockpitDevelopSessionRowV0, generation: string | null): EndoDevelopSessionV0 {
	const source = row.source === "pi" ? "pi-recorded" : "dsh-recorded";
	const name = row.source === "pi" ? "Pi" : "DSH";
	const inspectable = row.selector !== null && row.recorded !== null;
	const why = NOT_INSPECTABLE[row.reason ?? "not-qualified"];
	const noControl =
		row.source === "pi"
			? "A recording is read-only. Its last recorded state, even a run left open, does not make a process to control."
			: "A DSH recording is read-only, and Endophasia has no control path to DSH at all.";
	return {
		schemaVersion: "endo.develop-session.v0",
		identity: {
			source,
			key: inspectable
				? { status: "established", id: row.selector!, scope: "generation" }
				: { status: "unavailable", reason: why },
			alias: row.session.replace(/^endo\.session\./, ""),
		},
		integration: { label: row.label, type: "harness" },
		synthetic: false,
		runtime: { status: "established", value: { name, version: null }, basis: "recorded", by: source },
		ownership: { status: "established", value: "imported", basis: "recorded", by: source },
		observation: { mode: "recorded", reason: null },
		connection: { state: "not-applicable", reason: "A recording has no connection." },
		status:
			row.recorded === null
				? []
				: [{ state: RECORDED_STATE[row.recorded.state], basis: "recorded", by: source, at: row.lastRecordedAt }],
		capabilities: {
			observe: {
				"live-status": unsupported("A recording has no live process to ask."),
				"live-transcript": unsupported("A recording has no live conversation."),
				lifecycle: inspectable ? supported("cockpit-develop") : unavailable(why),
				activity: inspectable ? supported("cockpit-develop") : unavailable(why),
			},
			control: {
				prompt: unsupported(noControl),
				steer: unsupported(noControl),
				queue: unsupported(noControl),
				stop: unsupported(noControl),
				resume: unsupported(noControl),
			},
			coordinate: NO_COORDINATION(name),
		},
		evidence: [{ kind: "cockpit-develop-sessions.1", producedBy: source, generation }],
	};
}

/** Everything DEVELOP shows, as one surface: no relation is derived, because nothing here establishes one. */
export function developSurface(
	live: { status: WorkbenchStatus | null; unreachable: boolean } | null,
	rows: readonly EndoCockpitDevelopSessionRowV0[],
	generation: string | null,
): EndoDevelopSurfaceV0 {
	return {
		schemaVersion: "endo.develop-session-surface.v0",
		sessions: [
			...(live === null ? [] : [presentLivePi(live.status, live.unreachable)]),
			...rows.map((row) => presentRecorded(row, generation)),
		],
		relations: [],
	};
}

/** Words for a presentation. Fixed vocabulary: every word is chosen here, none comes from a source. */
export const OBSERVATION_WORDS = {
	live: "Live: attached and observed now",
	recorded: "Recorded only: read from a recording, not a process",
	unavailable: "Not observable now",
} as const;
export const OWNERSHIP_WORDS = {
	direct: "Owned directly: this Endophasia process holds the session's connection",
	external: "Owned by another process",
	imported: "Imported from a recording",
} as const;
export const BASIS_WORDS = {
	observed: "observed by Endophasia",
	reported: "reported by the runtime",
	recorded: "as recorded",
} as const;
export const GROUP_WORDS = {
	observe: "Observation",
	control: "Control",
	coordinate: "Coordination",
} as const;
