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
import type { EndoOmpSessionRowV0 } from "../../../protocol/omp-observation.ts";
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
				// Relayed when the model supplies it in structured form (Pi's thinking blocks); a turn without any had none supplied.
				"live-reasoning": connected
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
				"live-reasoning": unsupported("Reasoning is never recorded: it is held only in the live session's memory."),
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

const OMP_KEY_WORDS: Record<Extract<EndoOmpSessionRowV0["key"], { status: "unavailable" }>["reason"], string> = {
	"duplicate-id":
		"Two saved files in the selected directory carry this session id, so neither is treated as that session.",
	"malformed-id": "The file's header does not carry a well-formed session id, and none is made up for it.",
	"no-header": "The file could not be read as an OMP session, so it has no session id here.",
};
const OMP_NO_CONTROL =
	"Endophasia only reads OMP's saved files. It has no path to the OMP process, and a saved file is not one to control.";

/**
 * One Oh My Pi saved session, as Endophasia observed its file (adapters/omp, served only when the operator named the directory). The
 * file is OMP's own record, so the status says what OMP RECORDED (its turn at the last saved entry) or REPORTED (its own exit record),
 * never what a process is doing now: no file time is read as one, and liveness is not established at all. Nothing here is controllable.
 */
export function presentOmpSaved(row: EndoOmpSessionRowV0): EndoDevelopSessionV0 {
	const source = "omp-saved";
	const readable = row.state === "readable";
	const lastAt = row.lastEntryAt;
	const status: EndoDevelopStatusClaimV0[] = !readable
		? []
		: row.exit !== null
			? [
					{
						// A signal exit is an interruption; a normal exit, or one of a kind this version does not know, is an end OMP recorded.
						state: row.exit.kind === "signal" ? "interrupted" : "ended",
						basis: "reported",
						by: "omp",
						at: row.exit.at,
					},
				]
			: row.turn === "empty"
				? []
				: [{ state: row.turn === "open" ? "active" : "idle", basis: "recorded", by: source, at: lastAt }];
	const why =
		row.state === "unsupported-version"
			? "The file is in an OMP session format this version does not read."
			: row.state === "readable"
				? null
				: "The file could not be read as a stable OMP session.";
	return {
		schemaVersion: "endo.develop-session.v0",
		identity: {
			source,
			key:
				row.key.status === "established"
					? { status: "established", id: row.key.id, scope: "source" }
					: { status: "unavailable", reason: OMP_KEY_WORDS[row.key.reason] },
			alias: row.alias,
		},
		integration: { label: "Oh My Pi saved session", type: "harness" },
		synthetic: false,
		// That the file is OMP's is the operator's statement (the directory they named) and a format match; the runtime is a recorded fact
		// only when the entries themselves name the OMP version that wrote them.
		runtime:
			row.runtimeVersions.length === 0
				? {
						status: "unavailable",
						reason:
							"No entry in the file records which OMP version wrote it; the directory was named as OMP's by the operator.",
					}
				: {
						status: "established",
						value: { name: "Oh My Pi", version: row.runtimeVersions[row.runtimeVersions.length - 1]! },
						basis: "recorded",
						by: source,
					},
		ownership: { status: "established", value: "external", basis: "recorded", by: source },
		observation: { mode: "recorded", reason: null },
		connection: {
			state: "not-applicable",
			reason:
				"A saved file is not a connection. Whether an OMP process holds this session now cannot be told from it.",
		},
		status,
		capabilities: {
			observe: {
				"live-status": unsupported("Only the saved file is read; no OMP process is asked anything."),
				"live-transcript": unsupported(
					"No transcript is shown: only counts and kinds of committed entries, without their text.",
				),
				"live-reasoning": unsupported("Model-provided reasoning is not read from OMP's files."),
				lifecycle: why === null ? supported("omp-saved-observer") : unavailable(why),
				activity: why === null ? supported("omp-saved-observer") : unavailable(why),
			},
			control: {
				prompt: unsupported(OMP_NO_CONTROL),
				steer: unsupported(OMP_NO_CONTROL),
				queue: unsupported(OMP_NO_CONTROL),
				stop: unsupported(OMP_NO_CONTROL),
				resume: unsupported(OMP_NO_CONTROL),
			},
			coordinate: NO_COORDINATION("Oh My Pi, as observed here,"),
		},
		evidence: [{ kind: "omp-saved-session.v0", producedBy: source, generation: null }],
	};
}

/** Structural status of a live Codex App Server controller (mirrors `CodexLiveControllerStatusV0` without importing adapters). */
export interface CodexLivePresentationStatusV0 {
	readonly source: "codex-live";
	readonly controlPath: "codex-live-controller";
	readonly version: string | null;
	readonly connection: "connected" | "disconnected" | "reconnecting" | "unknown" | "not-applicable";
	readonly connectionReason: string | null;
	readonly launchId: string;
	readonly threadId: string | null;
	readonly activeTurnId: string | null;
	readonly capabilities: {
		readonly prompt: { readonly admitted: boolean; readonly reason: string | null };
		readonly steer: { readonly admitted: boolean; readonly reason: string | null };
		readonly stop: { readonly admitted: boolean; readonly reason: string | null };
	};
}

const CODEX_CONTROLLER = "codex-live-controller";

/**
 * One live Codex App Server session, projected into `EndoDevelopSessionV0`.
 * Preserves Codex's native boundaries explicitly: Strict-only `codex-live-controller`, `queue` and `resume`
 * unsupported (never faked to look like Pi), and honest connection/ownership standing.
 */
export function presentLiveCodex(
	status: CodexLivePresentationStatusV0 | null,
	unreachable = false,
): EndoDevelopSessionV0 {
	const known = status !== null && !unreachable;
	const connected = known && status.connection === "connected";
	const key: EndoDevelopSessionV0["identity"]["key"] =
		status === null
			? { status: "unavailable", reason: "No status has been read from the Codex controller yet." }
			: status.threadId !== null
				? { status: "established", id: `endo.session.codex.${status.threadId}`, scope: "source" }
				: { status: "established", id: status.launchId, scope: "launch" };
	const owned = connected && status.threadId !== null;
	const claim: EndoDevelopStatusClaimV0[] = connected
		? [{ state: status.activeTurnId !== null ? "active" : "idle", basis: "observed", by: "endophasia", at: null }]
		: [];
	const codexControl = (
		cap: { readonly admitted: boolean; readonly reason: string | null } | undefined,
		fallback: string,
	): EndoDevelopCapabilityV0 =>
		!owned
			? unavailable("There is no admitted live connection to an owned Codex thread now.")
			: cap?.admitted
				? supported(CODEX_CONTROLLER)
				: unavailable(cap?.reason ?? fallback);
	const connection: EndoDevelopSessionV0["connection"] = connected
		? { state: "connected", reason: null }
		: known
			? {
					state:
						status.connection === "reconnecting" || status.connection === "not-applicable"
							? "unknown"
							: status.connection,
					reason: status.connectionReason ?? "The Codex controller reports no active connection.",
				}
			: {
					state: "unknown",
					reason: "The Codex controller could not be reached. That says nothing about the underlying process.",
				};
	return {
		schemaVersion: "endo.develop-session.v0",
		identity: {
			source: "codex-live",
			key,
			alias: status?.threadId ?? null,
		},
		integration: { label: "Codex App Server", type: "harness" },
		synthetic: false,
		runtime: {
			status: "established",
			value: { name: "Codex", version: status?.version ?? null },
			basis: "observed",
			by: "endophasia",
		},
		ownership:
			connected && status.threadId !== null
				? { status: "established", value: "direct", basis: "observed", by: "endophasia" }
				: {
						status: "unavailable",
						reason:
							"Direct ownership holds only while Endophasia holds the live connection to its owned Codex thread.",
					},
		observation: connected
			? { mode: "live", reason: null }
			: {
					mode: "unavailable",
					reason: known
						? (status.connectionReason ?? "The Codex controller reports no active connection.")
						: "The Codex controller could not be reached, so nothing about the session is current.",
				},
		connection,
		status: claim,
		capabilities: {
			observe: {
				"live-status": connected
					? supported(CODEX_CONTROLLER)
					: unavailable("There is no admitted live connection to this Codex thread now."),
				"live-transcript": connected
					? supported(CODEX_CONTROLLER)
					: unavailable("There is no admitted live connection to this Codex thread now."),
				"live-reasoning": connected
					? supported(CODEX_CONTROLLER)
					: unavailable("There is no admitted live connection to this Codex thread now."),
				lifecycle: unsupported(
					"A live Codex session is not reduced to a recorded lifecycle; its durable recording is separate.",
				),
				activity: unsupported(
					"A live Codex session's recorded activity is read from its durable recording, which is separate.",
				),
			},
			control: {
				prompt: codexControl(status?.capabilities.prompt, "Prompt capability is not currently admitted for Codex."),
				steer: codexControl(status?.capabilities.steer, "Steer capability is not currently admitted for Codex."),
				queue: unsupported("Codex App Server exposes no Pi-equivalent follow_up queue RPC."),
				stop: codexControl(
					status?.capabilities.stop,
					"Targeted stop capability is not currently admitted for Codex.",
				),
				resume: unsupported("DEVELOP-CODEX-LIVE-001 launches explicitly owned fresh threads only."),
			},
			coordinate: NO_COORDINATION("Codex"),
		},
		evidence: status === null ? [] : [{ kind: "codex-live-status.v0", producedBy: "codex-live", generation: null }],
	};
}

/** Project any live workbench status (`pi` or `codex`) into the neutral `EndoDevelopSessionV0` presentation model. */
export function presentLiveWorkbenchSession(status: WorkbenchStatus | null, unreachable = false): EndoDevelopSessionV0 {
	if (status?.harness === "codex") {
		const c = status.codex;
		return presentLiveCodex(
			{
				source: "codex-live",
				controlPath: "codex-live-controller",
				version: c?.version ?? null,
				connection: status.connection,
				connectionReason: c?.connectionReason ?? null,
				launchId: status.launchId,
				threadId: c?.threadId ?? null,
				activeTurnId: c?.activeTurnId ?? null,
				capabilities: {
					prompt: { admitted: status.offers.prompt.offered, reason: status.offers.prompt.reason },
					steer: { admitted: status.offers.steer.offered, reason: status.offers.steer.reason },
					stop: { admitted: status.offers.stop.offered, reason: status.offers.stop.reason },
				},
			},
			unreachable,
		);
	}
	return presentLivePi(status, unreachable);
}

/** Everything DEVELOP shows, as one surface: no relation is derived, because nothing here establishes one. */
export function developSurface(
	live: { status: WorkbenchStatus | null; unreachable: boolean } | null,
	rows: readonly EndoCockpitDevelopSessionRowV0[],
	generation: string | null,
	omp: readonly EndoOmpSessionRowV0[] = [],
	codexLive: { status: CodexLivePresentationStatusV0 | null; unreachable: boolean } | null = null,
): EndoDevelopSurfaceV0 {
	return {
		schemaVersion: "endo.develop-session-surface.v0",
		sessions: [
			...(live === null ? [] : [presentLiveWorkbenchSession(live.status, live.unreachable)]),
			...(codexLive === null ? [] : [presentLiveCodex(codexLive.status, codexLive.unreachable)]),
			...rows.map((row) => presentRecorded(row, generation)),
			...omp.map((row) => presentOmpSaved(row)),
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
