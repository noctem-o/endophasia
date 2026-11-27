// The Coordinator Model Pool configuration (`endo.coordinator-model-pool.v0`, docs/designs/coordinator-automation.md Appendix A,
// docs/designs/coordinator-model-pool-m1-implementation.md). An operator-written file naming the inference endpoints the Coordinator
// may use for one read-only advisory briefing. It is configuration, never authority: every member is `advisoryOnly: true`, a member
// confers no tool, project, store or execution access, and changing the selected member changes nothing the Coordinator may do.
//
// The schema is closed at every level. In M1 only `local-openai-compat` members are executable, and only on the literal IPv4 loopback
// origin `http://127.0.0.1:<port>`: no host names (no DNS), no IPv6, no alternative IPv4 spellings, no path, query, fragment or
// credentials. A `hosted-relay` member is parsed so M2 can add hosted providers without a new format, but M1 never contacts it.

import {
	type EndoCoordinatorResourceProfileV1,
	validateEndoCoordinatorResourceProfileV1,
} from "./coordinator-resource-policy.ts";
import { EndoInvalidRecordV0, endoBoundedDetailV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0 = "endo.coordinator-model-pool.v0";
export const ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1 = "endo.coordinator-model-pool.v1";

export const ENDO_COORDINATOR_MODEL_POOL_MEMBER_KINDS_V0 = ["local-openai-compat", "hosted-relay"] as const;
export type EndoCoordinatorModelPoolMemberKindV0 = (typeof ENDO_COORDINATOR_MODEL_POOL_MEMBER_KINDS_V0)[number];

/** `availability`: an ineligible member lets the next eligible one be selected. `none`: only the first member in order is considered. */
export const ENDO_COORDINATOR_MODEL_POOL_FALLBACKS_V0 = ["availability", "none"] as const;
/**
 * Whether a member whose model is healthy but not observed loaded (a router listing it unloaded or sleeping, or a server whose model
 * readiness is not observable) may be selected. `permit` lets the briefing's own request load it, as M0 does today; `refuse` skips it.
 * A health observation never loads a model either way.
 */
export const ENDO_COORDINATOR_MODEL_POOL_UNCONFIRMED_V0 = ["permit", "refuse"] as const;

export const ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0 = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Printable ASCII without spaces, as model identifiers are served by OpenAI-compatible servers. */
export const ENDO_COORDINATOR_MODEL_ID_PATTERN_V0 = /^[\x21-\x7e]{1,256}$/;

export const ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0 = Object.freeze({
	members: { min: 1, max: 16 },
	priority: { min: 0, max: 1000 },
	/** The M0 prompt bound is the ceiling: a pool may lower it, never raise it. */
	maxPromptBytes: { min: 1024, max: 8192 },
	/** The M0 generation bound is the ceiling. */
	maxOutputTokens: { min: 256, max: 2048 },
	/** The M0 agent deadline (135 s) is the ceiling. */
	timeoutMs: { min: 5000, max: 135_000 },
	/** The largest pool file read. */
	fileBytes: 64 * 1024,
});

export interface EndoCoordinatorModelPoolMemberV0 {
	readonly memberId: string;
	readonly kind: EndoCoordinatorModelPoolMemberKindV0;
	/** An origin: `http://127.0.0.1:<port>` for a local member; `https://<host>[:port]` for a hosted relay (never contacted in M1). */
	readonly endpoint: string;
	/** The exact model identifier sent in every request and required in the server's model listing and responses. */
	readonly modelId: string;
	/** Higher is preferred; equal priorities are ordered by `memberId`. */
	readonly priority: number;
	readonly maxPromptBytes: number;
	readonly maxOutputTokens: number;
	readonly timeoutMs: number;
	readonly advisoryOnly: true;
}

export interface EndoCoordinatorModelPoolV0 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0;
	readonly selection: {
		readonly fallback: (typeof ENDO_COORDINATOR_MODEL_POOL_FALLBACKS_V0)[number];
		readonly unconfirmedModel: (typeof ENDO_COORDINATOR_MODEL_POOL_UNCONFIRMED_V0)[number];
	};
	readonly members: readonly EndoCoordinatorModelPoolMemberV0[];
}

/**
 * Opt-in governed pool schema (`endo.coordinator-model-pool.v1`, COORDINATOR-REASONING-001).
 * Carries an explicit `resourceProfile` whose ceilings bound every member's `maxOutputTokens` and `timeoutMs`.
 * Existing V0 pools without `resourceProfile` keep their exact V0 limits (`<= 2048` tokens, `<= 135_000` ms).
 */
export interface EndoCoordinatorModelPoolV1 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1;
	readonly selection: {
		readonly fallback: (typeof ENDO_COORDINATOR_MODEL_POOL_FALLBACKS_V0)[number];
		readonly unconfirmedModel: (typeof ENDO_COORDINATOR_MODEL_POOL_UNCONFIRMED_V0)[number];
	};
	readonly resourceProfile: EndoCoordinatorResourceProfileV1;
	readonly members: readonly EndoCoordinatorModelPoolMemberV0[];
}

export type EndoCoordinatorModelPoolAnyV1 = EndoCoordinatorModelPoolV0 | EndoCoordinatorModelPoolV1;

const MEMBER_KEYS_V0 = [
	"memberId",
	"kind",
	"endpoint",
	"modelId",
	"priority",
	"maxPromptBytes",
	"maxOutputTokens",
	"timeoutMs",
	"advisoryOnly",
] as const;

const plain = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const fail = (detail: string): never => {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
};

function closed(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
	if (!plain(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, keys);
	if (unknown !== undefined) fail(`${at} has an unknown field ${JSON.stringify(String(unknown))}`);
	for (const key of keys) if (!Object.hasOwn(record, key)) fail(`${at}.${key} is required`);
	return record;
}

function integer(value: unknown, at: string, range: { min: number; max: number }): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < range.min || value > range.max)
		fail(`${at} must be an integer from ${range.min} to ${range.max}`);
	return value as number;
}

function oneOf<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
		fail(`${at} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
	return value as T;
}

/**
 * The loopback origin of a local member, or a reason it is refused. Only the exact text `http://127.0.0.1:<port>` (port 1..65535,
 * no leading zero) is accepted: the URL parser's normalisation is not trusted to decide, so `http://127.1:8091`,
 * `http://0x7f.0.0.1:8091`, `http://2130706433:8091`, `http://localhost:8091`, `http://[::1]:8091`, `http://[::ffff:127.0.0.1]:8091`,
 * a trailing slash, userinfo, a path, a query or a fragment are all refused before any connection.
 */
export function endoCoordinatorLoopbackOriginV0(
	text: unknown,
): { ok: true; port: number } | { ok: false; reason: string } {
	if (typeof text !== "string") return { ok: false, reason: "the endpoint must be a string" };
	const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(text);
	if (match === null)
		return {
			ok: false,
			reason:
				"a local member's endpoint must be exactly http://127.0.0.1:<port> (no host name, IPv6, path or trailing slash)",
		};
	const port = Number(match[1]);
	if (port > 65535) return { ok: false, reason: "the endpoint's port must be 1..65535" };
	return { ok: true, port };
}

/** A hosted relay's origin: https, a host, no credentials, path, query or fragment. Parsed for M2; M1 never connects to it. */
function hostedOrigin(text: unknown, at: string): string {
	if (typeof text !== "string" || text.length > 256) return fail(`${at} must be an https origin`);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return fail(`${at} must be an https origin`);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.origin !== text
	)
		fail(`${at} must be an https origin exactly as written (https://host[:port], nothing else)`);
	return text;
}

function member(
	value: unknown,
	at: string,
	bounds: {
		readonly maxOutputTokens: { readonly min: number; readonly max: number };
		readonly timeoutMs: { readonly min: number; readonly max: number };
	} = ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0,
): EndoCoordinatorModelPoolMemberV0 {
	const m = closed(value, at, MEMBER_KEYS_V0);
	const limits = ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0;
	if (typeof m.memberId !== "string" || !ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0.test(m.memberId))
		fail(`${at}.memberId must be 1-64 lowercase letters, digits or inner hyphens`);
	const kind = oneOf(m.kind, `${at}.kind`, ENDO_COORDINATOR_MODEL_POOL_MEMBER_KINDS_V0);
	let endpoint: string;
	if (kind === "local-openai-compat") {
		const origin = endoCoordinatorLoopbackOriginV0(m.endpoint);
		if (!origin.ok) fail(`${at}.endpoint: ${origin.reason}`);
		endpoint = m.endpoint as string;
	} else endpoint = hostedOrigin(m.endpoint, `${at}.endpoint`);
	if (typeof m.modelId !== "string" || !ENDO_COORDINATOR_MODEL_ID_PATTERN_V0.test(m.modelId))
		fail(`${at}.modelId must be 1-256 printable ASCII characters without spaces`);
	if (m.advisoryOnly !== true)
		fail(`${at}.advisoryOnly must be true: a pool member never confers execution authority`);
	return Object.freeze({
		memberId: m.memberId as string,
		kind,
		endpoint,
		modelId: m.modelId as string,
		priority: integer(m.priority, `${at}.priority`, limits.priority),
		maxPromptBytes: integer(m.maxPromptBytes, `${at}.maxPromptBytes`, limits.maxPromptBytes),
		maxOutputTokens: integer(m.maxOutputTokens, `${at}.maxOutputTokens`, bounds.maxOutputTokens),
		timeoutMs: integer(m.timeoutMs, `${at}.timeoutMs`, bounds.timeoutMs),
		advisoryOnly: true,
	});
}

function validateUniqueMembers(members: readonly EndoCoordinatorModelPoolMemberV0[]): void {
	const ids = new Set<string>();
	const targets = new Set<string>();
	for (const m of members) {
		if (ids.has(m.memberId)) fail(`pool.members: memberId ${JSON.stringify(m.memberId)} is declared more than once`);
		ids.add(m.memberId);
		const target = JSON.stringify([m.endpoint, m.modelId]);
		if (targets.has(target))
			fail(
				`pool.members: ${JSON.stringify(m.memberId)} repeats another member's endpoint and modelId, which is ambiguous`,
			);
		targets.add(target);
	}
}

/**
 * Validate a parsed pool document. Returns a deep-frozen copy holding only the declared fields, or throws `EndoInvalidRecordV0`
 * naming the first problem. Duplicate member identities and two members naming the same endpoint and model are refused as ambiguous.
 */
export function parseEndoCoordinatorModelPoolV0(value: unknown): EndoCoordinatorModelPoolV0 {
	const pool = closed(value, "pool", ["schemaVersion", "selection", "members"]);
	if (pool.schemaVersion !== ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0)
		fail(`pool.schemaVersion must be ${JSON.stringify(ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0)}`);
	const selection = closed(pool.selection, "pool.selection", ["fallback", "unconfirmedModel"]);
	if (!Array.isArray(pool.members)) return fail("pool.members must be an array");
	const { min, max } = ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.members;
	if (pool.members.length < min || pool.members.length > max) fail(`pool.members must hold ${min} to ${max} members`);
	const members = pool.members.map((m, i) => member(m, `pool.members[${i}]`));
	validateUniqueMembers(members);
	return Object.freeze({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
		selection: Object.freeze({
			fallback: oneOf(selection.fallback, "pool.selection.fallback", ENDO_COORDINATOR_MODEL_POOL_FALLBACKS_V0),
			unconfirmedModel: oneOf(
				selection.unconfirmedModel,
				"pool.selection.unconfirmedModel",
				ENDO_COORDINATOR_MODEL_POOL_UNCONFIRMED_V0,
			),
		}),
		members: Object.freeze(members),
	});
}

/**
 * Validate an opt-in governed V1 pool (`endo.coordinator-model-pool.v1`). Requires an explicit inference-capable `resourceProfile`
 * (`reflex` is refused because a model pool configures inference endpoints) and enforces that every member stays within the
 * profile's `maxOutputTokensPerRequest` and `modelExecutionTimeoutMs`.
 */
export function parseEndoCoordinatorModelPoolV1(value: unknown): EndoCoordinatorModelPoolV1 {
	const pool = closed(value, "pool", ["schemaVersion", "selection", "resourceProfile", "members"]);
	if (pool.schemaVersion !== ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1)
		fail(`pool.schemaVersion must be ${JSON.stringify(ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1)}`);
	const selection = closed(pool.selection, "pool.selection", ["fallback", "unconfirmedModel"]);
	const resourceProfile = validateEndoCoordinatorResourceProfileV1(pool.resourceProfile, "pool.resourceProfile");
	if (resourceProfile.tier === "reflex")
		fail('pool.resourceProfile.tier cannot be "reflex": a model pool configures inference members');
	if (!Array.isArray(pool.members)) return fail("pool.members must be an array");
	const { min, max } = ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.members;
	if (pool.members.length < min || pool.members.length > max) fail(`pool.members must hold ${min} to ${max} members`);
	const bounds = {
		maxOutputTokens: {
			min: ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.maxOutputTokens.min,
			max: resourceProfile.maxOutputTokensPerRequest,
		},
		timeoutMs: {
			min: ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.timeoutMs.min,
			max: resourceProfile.modelExecutionTimeoutMs,
		},
	};
	const members = pool.members.map((m, i) => member(m, `pool.members[${i}]`, bounds));
	validateUniqueMembers(members);
	return Object.freeze({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
		selection: Object.freeze({
			fallback: oneOf(selection.fallback, "pool.selection.fallback", ENDO_COORDINATOR_MODEL_POOL_FALLBACKS_V0),
			unconfirmedModel: oneOf(
				selection.unconfirmedModel,
				"pool.selection.unconfirmedModel",
				ENDO_COORDINATOR_MODEL_POOL_UNCONFIRMED_V0,
			),
		}),
		resourceProfile,
		members: Object.freeze(members),
	});
}

/** Parse either a V0 pool (strict V0 limits) or an explicit V1 governed pool (`endo.coordinator-model-pool.v1`). */
export function parseEndoCoordinatorModelPoolAnyV1(value: unknown): EndoCoordinatorModelPoolAnyV1 {
	if (!plain(value)) fail("pool must be a JSON object");
	const schemaVersion = (value as Record<string, unknown>).schemaVersion;
	if (schemaVersion === ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1) return parseEndoCoordinatorModelPoolV1(value);
	return parseEndoCoordinatorModelPoolV0(value);
}

/** Members in selection order: priority descending, then `memberId` by code unit. Independent of the file's member order. */
export function orderedCoordinatorPoolMembersV0(
	pool: EndoCoordinatorModelPoolAnyV1,
): readonly EndoCoordinatorModelPoolMemberV0[] {
	return [...pool.members].sort((a, b) =>
		a.priority !== b.priority
			? b.priority - a.priority
			: a.memberId < b.memberId
				? -1
				: a.memberId > b.memberId
					? 1
					: 0,
	);
}
