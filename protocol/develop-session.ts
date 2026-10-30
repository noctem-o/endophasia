// The DEVELOP session surface v0 (`endo.develop-session-surface.v0`): the one neutral shape in which DEVELOP presents a session, whatever
// produced it - a harness Endophasia owns (Pi), an imported recording (DSH), an externally owned session, or a child of a meta-harness.
//
// It is a PRESENTATION CONTRACT, not durable evidence and not an authority. Nothing here is written to the event store, nothing here
// authorises an action, and no field is a fact Endophasia has not been given: a field that is not established says so, in a closed form
// that cannot be read as an affirmative.
//
//   Identity      source-qualified key, with its SCOPE (a key made for one launch or one verified log generation is not a stable id),
//                 and a display alias that is never a key.
//   Facts         runtime, ownership: established with a BASIS (observed / reported / recorded) and who said it, or unavailable.
//   Status        a list of claims, at most one per basis. "Reported" and "observed" are never merged into one value.
//   Observation   live, recorded or unavailable; a recording is never proof of a live process. `connection` is Endophasia's own read path
//                 to the source's feed (for the Pi workbench, the broker's admitted connection); it is not the source's claim about itself.
//                 The test-only shapes model a hypothetical feed: they connect to nothing.
//   Capabilities  observe / control / coordinate, each a closed set of actions. Every action key must be present; "supported" must name
//                 the path that serves it; anything else carries its reason. An absent key is a rejected record, never a yes.
//                 A capability is an ADVERTISEMENT. Authority is decided at dispatch by the owning broker's own admission.
//   Relations     parent/child edges in a separate list, each with its own basis and the party that claimed it. No edge is ever
//                 derived from a name, a path or a time.
//   Evidence      references to the projections the presentation was built from, each held only by a session of the source that
//                 produced it. A coordinator cannot hold a child's evidence under its own name.
//
// Validation rules (the surface validator, in order; the first failure is returned):
//   1. Closed shape and versions. No unknown member anywhere.
//   2. Unique keys: two sessions with the same source, scope and id are refused. A key is never shared between sessions.
//   3. Unique aliases within a source: an alias that two keys share would let a reader merge them, so the surface is refused.
//   4. Control is supported only for a session that is live AND directly owned. A recording, an unreachable session and a session some
//      other process owns have no supported control action. (Coordination describes what a coordinator offers its own children; it
//      confers no control, and a child's capabilities are read from the child alone.)
//   4b. A governed control path belongs to one source: `pi-workbench-broker` is admitted only on `pi-live`. A session of any other
//      source cannot name another integration's broker as its path, whatever it says about its ownership.
//   5. Every edge names two sessions of this surface, is not a self-edge, is not a duplicate, and does not close a cycle. A session has
//      at most one parent in v0 (two parents are conflicting claims, so the surface is refused rather than choosing one).
//   6. An edge is claimed by one party it concerns (its parent or its child) as "reported", or by "endophasia" as "observed".
//   7. Synthetic sessions (test shapes) are refused unless the caller says it is validating a fixture.
//
// The protocol imports only the protocol.

import { isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_DEVELOP_SESSION_SCHEMA_V0 = "endo.develop-session.v0";
export const ENDO_DEVELOP_SURFACE_SCHEMA_V0 = "endo.develop-session-surface.v0";

export const ENDO_DEVELOP_INTEGRATION_TYPES_V0 = ["harness", "meta-harness", "external-host"] as const;
export type EndoDevelopIntegrationTypeV0 = (typeof ENDO_DEVELOP_INTEGRATION_TYPES_V0)[number];

export const ENDO_DEVELOP_BASES_V0 = ["observed", "reported", "recorded"] as const;
export type EndoDevelopBasisV0 = (typeof ENDO_DEVELOP_BASES_V0)[number];

export const ENDO_DEVELOP_KEY_SCOPES_V0 = ["source", "launch", "generation"] as const;
export type EndoDevelopKeyScopeV0 = (typeof ENDO_DEVELOP_KEY_SCOPES_V0)[number];

export const ENDO_DEVELOP_OWNERSHIPS_V0 = ["direct", "external", "imported"] as const;
export type EndoDevelopOwnershipV0 = (typeof ENDO_DEVELOP_OWNERSHIPS_V0)[number];

export const ENDO_DEVELOP_STATUS_STATES_V0 = [
	"active",
	"idle",
	"ended",
	"interrupted",
	"detached",
	"not-observed",
] as const;
export type EndoDevelopStatusStateV0 = (typeof ENDO_DEVELOP_STATUS_STATES_V0)[number];

export const ENDO_DEVELOP_OBSERVATION_MODES_V0 = ["live", "recorded", "unavailable"] as const;
export const ENDO_DEVELOP_CONNECTIONS_V0 = ["connected", "disconnected", "unknown", "not-applicable"] as const;

/** The closed action sets. A capability map must hold every one of its group's actions. */
export const ENDO_DEVELOP_ACTIONS_V0 = {
	observe: ["live-status", "live-transcript", "live-reasoning", "lifecycle", "activity"],
	control: ["prompt", "steer", "queue", "stop", "resume"],
	coordinate: ["list-children", "dispatch-job"],
} as const;
export type EndoDevelopCapabilityGroupV0 = keyof typeof ENDO_DEVELOP_ACTIONS_V0;
export type EndoDevelopActionV0<G extends EndoDevelopCapabilityGroupV0> = (typeof ENDO_DEVELOP_ACTIONS_V0)[G][number];

export type EndoDevelopFactV0<T> =
	| { status: "established"; value: T; basis: EndoDevelopBasisV0; by: string }
	| { status: "unavailable"; reason: string };

/**
 * One action. "supported" says only that the source offers it and through which path; it is not an authorisation, not a grant and
 * not a promise that the next attempt is admitted. "unsupported" is a standing fact about the source; "unavailable" is a condition now.
 */
export type EndoDevelopCapabilityV0 =
	| { status: "supported"; via: string; reason: null }
	| { status: "unsupported" | "unavailable"; via: null; reason: string };

export type EndoDevelopCapabilitiesV0 = {
	[G in EndoDevelopCapabilityGroupV0]: Record<EndoDevelopActionV0<G>, EndoDevelopCapabilityV0>;
};

export interface EndoDevelopStatusClaimV0 {
	state: EndoDevelopStatusStateV0;
	basis: EndoDevelopBasisV0;
	/** Who established it: an integration id, never a session's own display alias. */
	by: string;
	/** When the claimant says it held, or null. A claimant's clock is not an order. */
	at: string | null;
}

export interface EndoDevelopEvidenceRefV0 {
	/** A projection or record family, e.g. `cockpit-develop-session.1`, `workbench-status.v0`, or `test-fixture`. */
	kind: string;
	/** The source that produced it. Must be the holding session's own source. */
	producedBy: string;
	/** A verified-generation token when the evidence is a recording's projection, else null. */
	generation: string | null;
}

export interface EndoDevelopSessionV0 {
	schemaVersion: typeof ENDO_DEVELOP_SESSION_SCHEMA_V0;
	identity: {
		/** The integration that presents the session; the namespace of the key. */
		source: string;
		key:
			| { status: "established"; id: string; scope: EndoDevelopKeyScopeV0 }
			| { status: "unavailable"; reason: string };
		/** Display only. Never a lookup key and never compared for identity. */
		alias: string | null;
	};
	integration: { label: string; type: EndoDevelopIntegrationTypeV0 };
	/** True for a test-only shape. A production surface never carries one. */
	synthetic: boolean;
	runtime: EndoDevelopFactV0<{ name: string; version: string | null }>;
	ownership: EndoDevelopFactV0<EndoDevelopOwnershipV0>;
	observation: { mode: "live" | "recorded" | "unavailable"; reason: string | null };
	connection: { state: (typeof ENDO_DEVELOP_CONNECTIONS_V0)[number]; reason: string | null };
	/** Claims about what the session is doing, at most one per basis. Empty means nothing is established. */
	status: EndoDevelopStatusClaimV0[];
	capabilities: EndoDevelopCapabilitiesV0;
	evidence: EndoDevelopEvidenceRefV0[];
}

export interface EndoDevelopRelationV0 {
	/** Global keys: `<source>:<scope>:<id>`. */
	parent: string;
	child: string;
	basis: "reported" | "observed";
	/** Who claimed it: the parent's or the child's global key (reported), or `endophasia` (observed). */
	by: string;
}

export interface EndoDevelopSurfaceV0 {
	schemaVersion: typeof ENDO_DEVELOP_SURFACE_SCHEMA_V0;
	sessions: EndoDevelopSessionV0[];
	relations: EndoDevelopRelationV0[];
}

/** The global key of a session, or null when its key is not established. */
export const endoDevelopKeyV0 = (session: EndoDevelopSessionV0): string | null =>
	session.identity.key.status === "established"
		? `${session.identity.source}:${session.identity.key.scope}:${session.identity.key.id}`
		: null;

/** Governed paths and the one source each is admitted for. A path not listed here is only a name. */
const GOVERNED_PATHS: Readonly<Record<string, string>> = { "pi-workbench-broker": "pi-live" };

const SOURCE = /^[a-z][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT_MAX = 400;

const isText = (value: unknown, max = TEXT_MAX): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	typeof value === "string" && (list as readonly string[]).includes(value);
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
const isDate = (value: unknown): boolean =>
	typeof value === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value) &&
	!Number.isNaN(Date.parse(value));

function factProblem(name: string, value: unknown, valid: (v: unknown) => boolean): string | null {
	if (isPlainJsonObjectV0(value) && (value as Record<string, unknown>).status === "unavailable")
		return exact(value, ["status", "reason"]) && isText((value as Record<string, unknown>).reason)
			? null
			: `${name}: an unavailable fact is exactly a status and a reason`;
	if (!exact(value, ["status", "value", "basis", "by"]) || value.status !== "established")
		return `${name}: must be established with a basis or unavailable with a reason`;
	if (!valid(value.value)) return `${name}: unknown value`;
	if (!oneOf(ENDO_DEVELOP_BASES_V0, value.basis)) return `${name}: unknown basis`;
	return typeof value.by === "string" && SOURCE.test(value.by) ? null : `${name}: by must name an integration`;
}

function capabilityProblem(path: string, value: unknown): string | null {
	if (!isPlainJsonObjectV0(value)) return `${path}: missing`;
	const record = value as Record<string, unknown>;
	if (!exact(record, ["status", "via", "reason"])) return `${path}: unexpected members`;
	if (record.status === "supported")
		return typeof record.via === "string" && SOURCE.test(record.via) && record.reason === null
			? null
			: `${path}: a supported action names its path and carries no reason`;
	if (record.status === "unsupported" || record.status === "unavailable")
		return record.via === null && isText(record.reason)
			? null
			: `${path}: an action that is not supported carries its reason`;
	return `${path}: unknown status`;
}

/** Null when the session satisfies the per-session rules, or the first problem. Surface-wide rules are in the surface validator. */
export function endoDevelopSessionProblemV0(value: unknown): string | null {
	if (
		!exact(value, [
			"schemaVersion",
			"identity",
			"integration",
			"synthetic",
			"runtime",
			"ownership",
			"observation",
			"connection",
			"status",
			"capabilities",
			"evidence",
		]) ||
		value.schemaVersion !== ENDO_DEVELOP_SESSION_SCHEMA_V0
	)
		return "not a v0 session";
	const s = value as unknown as EndoDevelopSessionV0;
	if (
		!exact(s.identity, ["source", "key", "alias"]) ||
		typeof s.identity.source !== "string" ||
		!SOURCE.test(s.identity.source)
	)
		return "identity: source must name an integration";
	const key = s.identity.key as unknown;
	if (isPlainJsonObjectV0(key) && (key as Record<string, unknown>).status === "unavailable") {
		if (!exact(key, ["status", "reason"]) || !isText((key as Record<string, unknown>).reason))
			return "identity: an unavailable key is exactly a status and a reason";
	} else if (
		!exact(key, ["status", "id", "scope"]) ||
		key.status !== "established" ||
		typeof key.id !== "string" ||
		!ID.test(key.id) ||
		!oneOf(ENDO_DEVELOP_KEY_SCOPES_V0, key.scope)
	)
		return "identity: an established key has an id and a scope";
	if (s.identity.alias !== null && !isText(s.identity.alias, 128)) return "identity: alias must be text or null";
	if (
		!exact(s.integration, ["label", "type"]) ||
		!isText(s.integration.label, 64) ||
		!oneOf(ENDO_DEVELOP_INTEGRATION_TYPES_V0, s.integration.type)
	)
		return "integration: label and type are required";
	if (typeof s.synthetic !== "boolean") return "synthetic must be a boolean";
	const runtime = factProblem("runtime", s.runtime, (v) => {
		const r = v as Record<string, unknown>;
		return exact(r, ["name", "version"]) && isText(r.name, 64) && (r.version === null || isText(r.version, 64));
	});
	if (runtime !== null) return runtime;
	const ownership = factProblem("ownership", s.ownership, (v) => oneOf(ENDO_DEVELOP_OWNERSHIPS_V0, v));
	if (ownership !== null) return ownership;
	if (!exact(s.observation, ["mode", "reason"]) || !oneOf(ENDO_DEVELOP_OBSERVATION_MODES_V0, s.observation.mode))
		return "observation: unknown mode";
	if (
		(s.observation.mode === "unavailable") !== (s.observation.reason !== null) ||
		(s.observation.reason !== null && !isText(s.observation.reason))
	)
		return "observation: unavailable observation carries a reason, and only it does";
	if (!exact(s.connection, ["state", "reason"]) || !oneOf(ENDO_DEVELOP_CONNECTIONS_V0, s.connection.state))
		return "connection: unknown state";
	if (
		(s.connection.state === "connected") !== (s.connection.reason === null) ||
		(s.connection.reason !== null && !isText(s.connection.reason))
	)
		return "connection: anything but connected carries a reason";
	// A recording is not a connection; a live observation is a connection; an unreachable one is neither.
	if (s.observation.mode === "live" && s.connection.state !== "connected")
		return "a live observation is a connected one";
	if (s.observation.mode === "recorded" && s.connection.state !== "not-applicable")
		return "a recording has no connection to describe";
	if (
		s.observation.mode === "unavailable" &&
		(s.connection.state === "connected" || s.connection.state === "not-applicable")
	)
		return "unavailable observation is a disconnected or unknown connection";
	if (!Array.isArray(s.status)) return "status must be a list of claims";
	const seen = new Set<string>();
	for (const claim of s.status as unknown[]) {
		if (!exact(claim, ["state", "basis", "by", "at"])) return "status: unexpected members";
		if (!oneOf(ENDO_DEVELOP_STATUS_STATES_V0, claim.state) || !oneOf(ENDO_DEVELOP_BASES_V0, claim.basis))
			return "status: unknown state or basis";
		if (typeof claim.by !== "string" || !SOURCE.test(claim.by)) return "status: by must name an integration";
		if (claim.at !== null && !isDate(claim.at)) return "status: at must be a UTC date or null";
		if (seen.has(claim.basis as string))
			return `status: two ${claim.basis as string} claims would be merged into one`;
		seen.add(claim.basis as string);
		// A recorded claim needs a recording; an unreachable session has no current claim at all.
		if (claim.basis === "recorded" && s.observation.mode !== "recorded")
			return "status: a recorded claim is for a recording";
		if (claim.basis !== "recorded" && s.observation.mode === "recorded" && claim.basis === "observed")
			return "status: a recording is not observed live";
		if (s.observation.mode === "unavailable")
			return "status: nothing is established while observation is unavailable";
	}
	if (!exact(s.capabilities, Object.keys(ENDO_DEVELOP_ACTIONS_V0))) return "capabilities: every group is required";
	let controlSupported = false;
	for (const group of Object.keys(ENDO_DEVELOP_ACTIONS_V0) as EndoDevelopCapabilityGroupV0[]) {
		const actions = ENDO_DEVELOP_ACTIONS_V0[group];
		const map = s.capabilities[group] as unknown;
		if (!exact(map, actions)) return `capabilities.${group}: exactly the actions ${actions.join(", ")}`;
		for (const action of actions) {
			const problem = capabilityProblem(`capabilities.${group}.${action}`, (map as Record<string, unknown>)[action]);
			if (problem !== null) return problem;
			if (group === "control" && (map as Record<string, EndoDevelopCapabilityV0>)[action]!.status === "supported")
				controlSupported = true;
		}
	}
	// Rule 4: governed action exists only on a live session that Endophasia's own path owns.
	if (controlSupported) {
		const direct =
			s.ownership.status === "established" && s.ownership.value === "direct" && s.observation.mode === "live";
		if (!direct) return "capabilities: control is supported only for a live, directly owned session";
	}
	// Rule 4b: a governed path serves only the source it belongs to.
	for (const group of Object.keys(ENDO_DEVELOP_ACTIONS_V0) as EndoDevelopCapabilityGroupV0[])
		for (const cap of Object.values(s.capabilities[group]) as EndoDevelopCapabilityV0[]) {
			const owner = cap.status === "supported" ? GOVERNED_PATHS[cap.via] : undefined;
			if (owner !== undefined && owner !== s.identity.source)
				return `capabilities: ${cap.via} is the path of ${owner} only`;
		}
	if (!Array.isArray(s.evidence)) return "evidence must be a list";
	for (const ref of s.evidence as unknown[]) {
		if (!exact(ref, ["kind", "producedBy", "generation"])) return "evidence: unexpected members";
		if (!isText(ref.kind, 96)) return "evidence: kind is required";
		if (ref.producedBy !== s.identity.source)
			return "evidence: a session holds only evidence produced by its own source";
		if (ref.generation !== null && !isText(ref.generation, 128))
			return "evidence: generation must be a token or null";
	}
	return null;
}

export interface EndoDevelopSurfaceOptionsV0 {
	/** Validating a test fixture: synthetic sessions are admitted. A production surface leaves this false. */
	allowSynthetic?: boolean;
}

/** Null when the surface satisfies every rule in the header, or the first problem. Pure: no store, no clock, no network. */
export function endoDevelopSurfaceProblemV0(value: unknown, options: EndoDevelopSurfaceOptionsV0 = {}): string | null {
	if (
		!exact(value, ["schemaVersion", "sessions", "relations"]) ||
		value.schemaVersion !== ENDO_DEVELOP_SURFACE_SCHEMA_V0
	)
		return "not a v0 surface";
	if (!Array.isArray(value.sessions) || !Array.isArray(value.relations)) return "sessions and relations must be lists";
	const sessions = value.sessions as EndoDevelopSessionV0[];
	const keys = new Map<string, EndoDevelopSessionV0>();
	const aliases = new Set<string>();
	for (const session of sessions) {
		const problem = endoDevelopSessionProblemV0(session);
		if (problem !== null) return problem;
		if (session.synthetic && options.allowSynthetic !== true)
			return "a synthetic session is not admitted on a production surface";
		const key = endoDevelopKeyV0(session);
		if (key !== null) {
			if (keys.has(key)) return `duplicate session key ${key}`;
			keys.set(key, session);
		}
		if (session.identity.alias !== null) {
			const scoped = `${session.identity.source}\u0000${session.identity.alias}`;
			if (aliases.has(scoped))
				return `alias ${session.identity.alias} is shared by two sessions of ${session.identity.source}`;
			aliases.add(scoped);
		}
	}
	const parentOf = new Map<string, string>();
	const edges = new Set<string>();
	for (const relation of value.relations as unknown[]) {
		if (!exact(relation, ["parent", "child", "basis", "by"])) return "relation: unexpected members";
		const { parent, child, basis, by } = relation as unknown as EndoDevelopRelationV0;
		if (typeof parent !== "string" || typeof child !== "string" || typeof by !== "string")
			return "relation: keys are text";
		if (!keys.has(parent) || !keys.has(child)) return "relation: both ends must be sessions of this surface";
		if (parent === child) return "relation: a session is not its own parent";
		if (basis !== "reported" && basis !== "observed") return "relation: unknown basis";
		if (basis === "observed" ? by !== "endophasia" : by !== parent && by !== child)
			return "relation: claimed by an end of the edge (reported) or by endophasia (observed)";
		const id = `${parent}\u0000${child}\u0000${by}`;
		if (edges.has(id)) return "relation: duplicate claim";
		edges.add(id);
		const known = parentOf.get(child);
		if (known !== undefined && known !== parent) return `relation: ${child} has two parents`;
		parentOf.set(child, parent);
	}
	for (const start of parentOf.keys()) {
		const seen = new Set<string>([start]);
		for (let at = parentOf.get(start); at !== undefined; at = parentOf.get(at)) {
			if (seen.has(at)) return "relation: a cycle";
			seen.add(at);
		}
	}
	return null;
}

/** The children claimed for a parent, each with the basis it was claimed on. Reads edges only: no name, path or time is consulted. */
export function endoDevelopChildrenV0(surface: EndoDevelopSurfaceV0, parentKey: string): EndoDevelopRelationV0[] {
	return surface.relations.filter((relation) => relation.parent === parentKey);
}
