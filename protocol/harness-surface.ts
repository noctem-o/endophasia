// The effective harness surface v0 (endo.harness-surface.v0): what the model server actually received from the harness
// in one request, as component digests. README "Evidence closure": record what the model experiences, not only which
// executable ran.
//
// One record is one observation of one captured request. It is derived from the recorded wire (adapters/openai-proxy/
// harness-surface.ts), never from a prompt template and never from configuration:
//
//   source        which capture event it came from: capture version, exchange, request digest, method and path
//   dialect       the wire dialect, when the endpoint and the body shape establish it; otherwise UNAVAILABLE with a reason
//   model         the model the request names; UNAVAILABLE when the wire names none (a configured model is another fact)
//   streaming     the request's `stream` flag; UNAVAILABLE when absent (what the server then does is not observed)
//   instructions  every system/developer message, in wire order: role, keyed digest, length
//   tools         every tool definition, in wire order: keyed digest and (a safe) name; an ordered digest and a
//                 membership digest, so "same tools, other order" is told apart from "different tools"
//   parameters    every other top-level field the request carried; a field the wire did not carry is absent, and that
//                 is all absence means: it never stands for the server's default
//   identity      one keyed digest over the exact basis `endoHarnessSurfaceIdentityBasisV0` returns
//
// The privacy boundary: the user's messages, the assistant's and the tool results are not read at all (task input is
// not harness surface). System/developer text and tool definitions are digested under the comparison-domain key and
// their text is not recorded; the request body stays in the keyed blob store, outside canonical evidence. A parameter's
// value is recorded only when its canonical JSON is short (`ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0`);
// otherwise its keyed digest stands for it. All digests of one record are under one key (`digestKey`); records under
// different keys are not comparable, and `compareEndoHarnessSurfacesV0` says so instead of reporting a difference.
//
// This file is the pure part (shapes, validator, the digest bases, the comparison); the digests themselves are made
// by the adapter, because the protocol layer holds no keys.

import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	endoBoundedDetailV0,
	endoFirstUnknownKeyV0,
} from "./versioned.ts";

export const ENDO_HARNESS_SURFACE_VERSION_V0 = "endo.harness-surface.v0";

/** The one wire dialect v0 recognizes: an OpenAI-compatible chat-completions request. */
export const ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0 = "openai.chat-completions";

/** The endpoint paths (query string removed) that establish the dialect. The path decides; the body shape then has to agree. */
export const ENDO_HARNESS_SURFACE_CHAT_PATHS_V0: readonly string[] = ["/v1/chat/completions", "/chat/completions"];

/** A parameter whose canonical JSON is longer than this is recorded by digest only. */
export const ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0 = 1024;

/** A tool name is recorded beside its digest only when it is this plain; any other name is recorded as null. */
export const ENDO_HARNESS_SURFACE_TOOL_NAME_PATTERN_V0 = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The top-level fields that are not parameters: each is recorded once, under its own coordinate. */
export const ENDO_HARNESS_SURFACE_NON_PARAMETER_FIELDS_V0: readonly string[] = ["messages", "tools", "model", "stream"];

/** The literal each digest is made over, so a component digest can equal no other keyed digest of the store. */
export const ENDO_HARNESS_SURFACE_BASES_V0 = {
	instruction: "endo.harness-surface.v0/instruction",
	instructions: "endo.harness-surface.v0/instructions",
	tool: "endo.harness-surface.v0/tool",
	tools: "endo.harness-surface.v0/tools",
	toolSet: "endo.harness-surface.v0/tool-set",
	parameter: "endo.harness-surface.v0/parameter",
	parameters: "endo.harness-surface.v0/parameters",
	header: "endo.harness-surface.v0/header",
	headers: "endo.harness-surface.v0/headers",
	identity: "endo.harness-surface.v0/identity",
} as const;

/**
 * Request headers the surface leaves out because they frame or route the transport, not the request: they differ per
 * connection (Host carries the proxy's port, Content-Length follows the task) without the model or server behavior
 * being asked for anything else. Every other recorded header is part of the surface; none is judged "behavior-affecting".
 */
export const ENDO_HARNESS_SURFACE_TRANSPORT_HEADERS_V0: readonly string[] = [
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"expect",
];

/** A header name as the surface records it (lowercase token); anything else makes the headers UNAVAILABLE. */
export const ENDO_HARNESS_SURFACE_HEADER_NAME_PATTERN_V0 = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

export type EndoHarnessSurfaceObservedV0<T> =
	| { status: "reported"; value: T }
	| { status: "UNAVAILABLE"; reason: string };

export interface EndoHarnessSurfaceInstructionV0 {
	/** The message's index in the request's `messages`: where it sat, not part of the identity. */
	position: number;
	role: "system" | "developer";
	/** UTF-8 length of the canonical JSON of the message (the value that was digested). */
	bytes: number;
	digest: string;
}

export interface EndoHarnessSurfaceToolV0 {
	/** `function.name` when it is a plain identifier, else null. */
	name: string | null;
	digest: string;
}

export interface EndoHarnessSurfaceParameterV0 {
	/** The keyed digest of this one parameter (always present). */
	digest: string;
	/** The value itself, when its canonical JSON is at most the byte limit. */
	value?: JsonValueV0;
}

export interface EndoHarnessSurfaceHeaderV0 {
	/** Lowercased name, as recorded (names are not secret). */
	name: string;
	/** The keyed digest of the value; null when the capture redacted it (presence is known, the value is not). */
	digest: string | null;
}

export interface EndoHarnessSurfaceComponentsV0 {
	model: EndoHarnessSurfaceObservedV0<string>;
	streaming: EndoHarnessSurfaceObservedV0<boolean>;
	instructions: { items: EndoHarnessSurfaceInstructionV0[]; orderedDigest: string };
	tools: {
		/** Whether the request carried a `tools` field at all. */
		present: boolean;
		count: number;
		items: EndoHarnessSurfaceToolV0[];
		/** Over the tool digests in wire order. The model-facing fact. */
		orderedDigest: string;
		/** Over the sorted tool digests (duplicates kept). Equal membership with a different ordered digest is a reordering. */
		membershipDigest: string;
	};
	parameters: {
		/** Over the full values of every parameter, by name. */
		digest: string;
		fields: Record<string, EndoHarnessSurfaceParameterV0>;
	};
	/**
	 * Every recorded request header but the transport ones (`ENDO_HARNESS_SURFACE_TRANSPORT_HEADERS_V0`), sorted by
	 * name and digest. Order on the wire is not part of it. UNAVAILABLE when the capture recorded no header list.
	 */
	headers: EndoHarnessSurfaceObservedV0<{ items: EndoHarnessSurfaceHeaderV0[]; digest: string }>;
	/** The server's resulting defaults are not on the wire. */
	serverDefaults: { status: "UNAVAILABLE"; reason: string };
	/** The keyed digest of the identity basis. */
	identity: string;
}

export interface EndoHarnessSurfaceV0 {
	schemaVersion: typeof ENDO_HARNESS_SURFACE_VERSION_V0;
	source: {
		/** The capture version the log declared when the request was recorded; null when the log declared none. */
		captureVersion: string | null;
		exchange: number;
		/** The capture.request event's id. */
		eventId: string;
		method: string;
		path: string;
		/** The cassette-matching request digest (HMAC over {method, path, body}), value only; the key is `digestKey`. */
		requestDigest: string;
	};
	/** The domain of every digest in this record. */
	digestKey: { algorithm: "hmac-sha256"; keyId: string };
	dialect: EndoHarnessSurfaceObservedV0<typeof ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0>;
	/** Reported exactly when the dialect is. */
	components: EndoHarnessSurfaceObservedV0<EndoHarnessSurfaceComponentsV0>;
}

/** What `identity` is the keyed digest of. Plain JSON; the adapter's digest of exactly this value is the identity. */
export function endoHarnessSurfaceIdentityBasisV0(
	components: Omit<EndoHarnessSurfaceComponentsV0, "identity">,
	dialect: string,
	target: string,
): JsonValueV0 {
	return {
		basis: ENDO_HARNESS_SURFACE_BASES_V0.identity,
		dialect,
		// The request target as sent (path and query): a route or query parameter may select other server behavior.
		target,
		model: components.model,
		streaming: components.streaming,
		instructions: components.instructions.orderedDigest,
		tools: { present: components.tools.present, ordered: components.tools.orderedDigest },
		parameters: components.parameters.digest,
		headers:
			components.headers.status === "reported" ? { digest: components.headers.value.digest } : components.headers,
	};
}

// --- the validator -------------------------------------------------------------------------------------------------

type Problem = string | null;

const HEX = /^[0-9a-f]{64}$/;
const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The recording proxy's HTTP parser bound on a request head (adapters/openai-proxy/http1.ts MAX_HEAD). */
const CAPTURE_HEAD_MAX = 256 * 1024;
const isText = (value: unknown, max = 4096): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;
/** A digest key id (protocol/ imports nothing outside protocol/; a test pins this to runtime/contracts/keyed-digest.ts). */
export const ENDO_HARNESS_SURFACE_KEY_ID_PATTERN_V0 = /^(?:endo\.digest-key\.[0-9a-f]{32}|[a-z][a-z0-9-]{0,62})$/;

/**
 * The size a parameter value is measured by, in bytes: its compact JSON (no whitespace; key order does not change the
 * length). One measure for the producer and the validator, taken iteratively so a deeply nested value cannot exhaust
 * the stack, and stopping once it passes `stopAfter`.
 */
export function endoHarnessSurfaceValueBytesV0(value: unknown, stopAfter = Number.POSITIVE_INFINITY): number {
	const encoder = new TextEncoder();
	const stack: unknown[] = [value];
	let total = 0;
	while (stack.length > 0 && total <= stopAfter) {
		const v = stack.pop();
		if (typeof v === "string") total += encoder.encode(JSON.stringify(v)).length;
		else if (Array.isArray(v)) {
			total += 2 + Math.max(0, v.length - 1);
			for (const item of v) stack.push(item);
		} else if (typeof v === "object" && v !== null) {
			const keys = Object.keys(v);
			total += 2 + Math.max(0, keys.length - 1);
			for (const key of keys) {
				total += encoder.encode(JSON.stringify(key)).length + 1;
				stack.push((v as Record<string, unknown>)[key]);
			}
		} else total += String(JSON.stringify(v)).length;
	}
	return total;
}

const isObject = (value: unknown): value is Record<string, unknown> => isPlainJsonObjectV0(value);

function closed(value: unknown, allowed: readonly string[], what: string): Problem {
	if (!isObject(value)) return `${what} is not a JSON object`;
	const unknown = endoFirstUnknownKeyV0(value, allowed);
	return unknown === undefined ? null : `${what}: unknown field ${JSON.stringify(String(unknown).slice(0, 40))}`;
}

function observedProblem(value: unknown, what: string, valueOk: (v: unknown) => boolean): Problem {
	if (!isObject(value)) return `${what} is not a JSON object`;
	if (value.status === "reported") {
		const shape = closed(value, ["status", "value"], what);
		if (shape !== null) return shape;
		return valueOk(value.value) ? null : `${what}.value is malformed`;
	}
	if (value.status === "UNAVAILABLE") {
		const shape = closed(value, ["status", "reason"], what);
		if (shape !== null) return shape;
		return isText(value.reason, 512) ? null : `${what}.reason must be a non-empty string`;
	}
	return `${what}.status must be reported or UNAVAILABLE`;
}

function isStrictJson(value: unknown): boolean {
	const pending: unknown[] = [value];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === null || typeof next === "string" || typeof next === "boolean") continue;
		if (typeof next === "number") {
			if (!Number.isFinite(next)) return false;
			continue;
		}
		if (typeof next !== "object" || !(Array.isArray(next) || isObject(next)) || seen.has(next)) return false;
		seen.add(next);
		for (const item of Array.isArray(next) ? next : Object.values(next)) pending.push(item);
	}
	return true;
}

function componentsProblem(value: unknown): Problem {
	const shape = closed(
		value,
		["model", "streaming", "instructions", "tools", "parameters", "headers", "serverDefaults", "identity"],
		"components",
	);
	if (shape !== null) return shape;
	const c = value as Record<string, unknown>;
	const model = observedProblem(c.model, "components.model", (v) => isText(v, 512));
	if (model !== null) return model;
	const streaming = observedProblem(c.streaming, "components.streaming", (v) => typeof v === "boolean");
	if (streaming !== null) return streaming;
	const instructions = closed(c.instructions, ["items", "orderedDigest"], "components.instructions");
	if (instructions !== null) return instructions;
	const ins = c.instructions as Record<string, unknown>;
	if (!isHex(ins.orderedDigest)) return "components.instructions.orderedDigest must be 64 lowercase hex digits";
	if (!Array.isArray(ins.items)) return "components.instructions.items must be a list";
	for (const [index, item] of ins.items.entries()) {
		const itemShape = closed(item, ["position", "role", "bytes", "digest"], `instructions.items[${index}]`);
		if (itemShape !== null) return itemShape;
		const i = item as Record<string, unknown>;
		if (!isCount(i.position) || !isCount(i.bytes) || !isHex(i.digest))
			return `instructions.items[${index}] is malformed`;
		if (i.role !== "system" && i.role !== "developer") return `instructions.items[${index}].role is unknown`;
	}
	const tools = closed(
		c.tools,
		["present", "count", "items", "orderedDigest", "membershipDigest"],
		"components.tools",
	);
	if (tools !== null) return tools;
	const t = c.tools as Record<string, unknown>;
	if (typeof t.present !== "boolean") return "components.tools.present must be a boolean";
	if (!isHex(t.orderedDigest) || !isHex(t.membershipDigest))
		return "components.tools digests must be 64 lowercase hex digits";
	if (!Array.isArray(t.items) || t.count !== t.items.length)
		return "components.tools.count must equal the number of items";
	if (!t.present && t.items.length !== 0) return "components.tools: an absent tools field has no items";
	for (const [index, item] of t.items.entries()) {
		const itemShape = closed(item, ["name", "digest"], `tools.items[${index}]`);
		if (itemShape !== null) return itemShape;
		const i = item as Record<string, unknown>;
		if (!isHex(i.digest)) return `tools.items[${index}].digest must be 64 lowercase hex digits`;
		if (i.name !== null && !(typeof i.name === "string" && ENDO_HARNESS_SURFACE_TOOL_NAME_PATTERN_V0.test(i.name)))
			return `tools.items[${index}].name must be a plain identifier or null`;
	}
	const parameters = closed(c.parameters, ["digest", "fields"], "components.parameters");
	if (parameters !== null) return parameters;
	const p = c.parameters as Record<string, unknown>;
	if (!isHex(p.digest)) return "components.parameters.digest must be 64 lowercase hex digits";
	if (!isObject(p.fields)) return "components.parameters.fields is not a JSON object";
	for (const [name, field] of Object.entries(p.fields)) {
		if (ENDO_HARNESS_SURFACE_NON_PARAMETER_FIELDS_V0.includes(name))
			return `components.parameters.fields: ${JSON.stringify(name)} is recorded under its own coordinate`;
		const fieldShape = closed(field, ["digest", "value"], `parameters.fields.${JSON.stringify(name.slice(0, 40))}`);
		if (fieldShape !== null) return fieldShape;
		const f = field as Record<string, unknown>;
		if (!isHex(f.digest)) return "a parameter digest must be 64 lowercase hex digits";
		if ("value" in f && !isStrictJson(f.value)) return "a parameter value must be strict JSON";
		if (
			"value" in f &&
			endoHarnessSurfaceValueBytesV0(f.value, ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0) >
				ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0
		)
			return "a parameter value over the size limit is recorded by its digest only";
	}
	const headers = observedProblem(c.headers, "components.headers", (v) => {
		if (!isObject(v) || endoFirstUnknownKeyV0(v, ["items", "digest"]) !== undefined || !isHex(v.digest)) return false;
		if (!Array.isArray(v.items)) return false;
		return v.items.every(
			(item) =>
				isObject(item) &&
				endoFirstUnknownKeyV0(item, ["name", "digest"]) === undefined &&
				typeof item.name === "string" &&
				ENDO_HARNESS_SURFACE_HEADER_NAME_PATTERN_V0.test(item.name) &&
				!ENDO_HARNESS_SURFACE_TRANSPORT_HEADERS_V0.includes(item.name) &&
				(item.digest === null || isHex(item.digest)),
		);
	});
	if (headers !== null) return headers;
	const defaults = closed(c.serverDefaults, ["status", "reason"], "components.serverDefaults");
	if (defaults !== null) return defaults;
	const d = c.serverDefaults as Record<string, unknown>;
	if (d.status !== "UNAVAILABLE" || !isText(d.reason, 512))
		return "components.serverDefaults must be UNAVAILABLE with a reason";
	return isHex(c.identity) ? null : "components.identity must be 64 lowercase hex digits";
}

/** Why `value` is not a valid endo.harness-surface.v0, or null. */
export function endoHarnessSurfaceProblemV0(value: unknown): Problem {
	const shape = closed(
		value,
		["schemaVersion", "source", "digestKey", "dialect", "components"],
		"the harness surface",
	);
	if (shape !== null) return shape;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== ENDO_HARNESS_SURFACE_VERSION_V0)
		return `schemaVersion must be ${ENDO_HARNESS_SURFACE_VERSION_V0}`;
	const source = closed(
		v.source,
		["captureVersion", "exchange", "eventId", "method", "path", "requestDigest"],
		"source",
	);
	if (source !== null) return source;
	const s = v.source as Record<string, unknown>;
	if (s.captureVersion !== null && !isText(s.captureVersion, 64))
		return "source.captureVersion must be a string or null";
	if (!isCount(s.exchange)) return "source.exchange must be a non-negative integer";
	// The method and target are bounded by the capture parser's head limit (256 KiB), not a smaller one: the complete
	// target is part of the identity, so a target the parser recorded must be a target this record can hold.
	if (!isText(s.eventId, 256) || !isText(s.method, CAPTURE_HEAD_MAX) || !isText(s.path, CAPTURE_HEAD_MAX))
		return "source.eventId, method and path must be non-empty strings";
	if (!isHex(s.requestDigest)) return "source.requestDigest must be 64 lowercase hex digits";
	const key = closed(v.digestKey, ["algorithm", "keyId"], "digestKey");
	if (key !== null) return key;
	const k = v.digestKey as Record<string, unknown>;
	if (k.algorithm !== "hmac-sha256" || !isText(k.keyId, 128) || !ENDO_HARNESS_SURFACE_KEY_ID_PATTERN_V0.test(k.keyId))
		return "digestKey must name hmac-sha256 and a key id";
	const dialect = observedProblem(v.dialect, "dialect", (d) => d === ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0);
	if (dialect !== null) return dialect;
	const d = v.dialect as { status: string };
	const components = v.components as { status?: unknown } | null;
	if (!isObject(v.components)) return "components is not a JSON object";
	if (d.status !== components?.status) return "components are reported exactly when the dialect is";
	if (d.status === "reported") {
		// Endpoint recognition establishes the dialect: a reported dialect belongs to a POST to a chat-completions path.
		const pathname = (s.path as string).split("?")[0]!;
		if (s.method !== "POST" || !ENDO_HARNESS_SURFACE_CHAT_PATHS_V0.includes(pathname))
			return "a reported dialect requires a POST to a chat-completions path as its source";
		const wrapper = closed(v.components, ["status", "value"], "components");
		return wrapper ?? componentsProblem((v.components as { value: unknown }).value);
	}
	return observedProblem(v.components, "components", () => false);
}

const ownField = (fields: Record<string, EndoHarnessSurfaceParameterV0>, name: string) =>
	Object.hasOwn(fields, name) ? fields[name] : undefined;

/** The validator for a version table: the value unchanged, or an `EndoInvalidRecordV0`. */
export function endoHarnessSurfaceValidatorV0(value: unknown): EndoHarnessSurfaceV0 {
	const problem = endoHarnessSurfaceProblemV0(value);
	if (problem !== null) throw new EndoInvalidRecordV0(endoBoundedDetailV0(problem));
	return value as EndoHarnessSurfaceV0;
}

/** The harness-surface versions this reader knows. */
export const ENDO_HARNESS_SURFACE_VERSIONS_V0 = defineEndoVersionTableV0<EndoHarnessSurfaceV0>("endo.harness-surface", [
	[ENDO_HARNESS_SURFACE_VERSION_V0, endoHarnessSurfaceValidatorV0],
]);

// --- comparison ----------------------------------------------------------------------------------------------------

/** The major coordinates a surface comparison can name. No coordinate carries content. */
export type EndoHarnessSurfaceCoordinateV0 =
	| "dialect"
	| "target"
	| "model"
	| "streaming"
	| "instructions"
	| "tool-definitions"
	| "tool-order"
	| "parameters"
	| "headers";

export type EndoHarnessSurfaceComparisonV0 =
	| { comparable: false; reason: string }
	| {
			comparable: true;
			same: boolean;
			/** The coordinates that differ, in a fixed order. */
			differs: EndoHarnessSurfaceCoordinateV0[];
			/** The parameter names that differ (present on one side only, or with other digests). */
			parameterNames: string[];
	  };

/** Two observations are the same by their members, not by the order a serializer wrote them in. */
const sameObservation = (
	a: { status: string; value?: unknown; reason?: string },
	b: { status: string; value?: unknown; reason?: string },
): boolean => a.status === b.status && a.value === b.value && a.reason === b.reason;

/**
 * Compare two surfaces. Digests under different keys are in different domains, so nothing follows from them:
 * the answer is "not comparable", never "different". An unrecognized surface (no components) is not comparable either.
 */
export function compareEndoHarnessSurfacesV0(
	a: EndoHarnessSurfaceV0,
	b: EndoHarnessSurfaceV0,
): EndoHarnessSurfaceComparisonV0 {
	if (a.digestKey.keyId !== b.digestKey.keyId)
		return {
			comparable: false,
			reason: "the surfaces were digested under different keys (different digest domains)",
		};
	if (a.components.status !== "reported" || b.components.status !== "reported")
		return { comparable: false, reason: "a surface was not recognized, so it has no components to compare" };
	const x = a.components.value;
	const y = b.components.value;
	const differs: EndoHarnessSurfaceCoordinateV0[] = [];
	if (a.dialect.status === "reported" && b.dialect.status === "reported" && a.dialect.value !== b.dialect.value)
		differs.push("dialect");
	if (a.source.path !== b.source.path) differs.push("target");
	if (!sameObservation(x.model, y.model)) differs.push("model");
	if (!sameObservation(x.streaming, y.streaming)) differs.push("streaming");
	if (x.instructions.orderedDigest !== y.instructions.orderedDigest) differs.push("instructions");
	if (x.tools.present !== y.tools.present || x.tools.membershipDigest !== y.tools.membershipDigest)
		differs.push("tool-definitions");
	else if (x.tools.orderedDigest !== y.tools.orderedDigest) differs.push("tool-order");
	const headerDigest = (o: typeof x.headers) => (o.status === "reported" ? o.value.digest : `UNAVAILABLE:${o.reason}`);
	if (headerDigest(x.headers) !== headerDigest(y.headers)) differs.push("headers");
	const parameterNames: string[] = [];
	if (x.parameters.digest !== y.parameters.digest) {
		differs.push("parameters");
		for (const name of new Set([...Object.keys(x.parameters.fields), ...Object.keys(y.parameters.fields)]))
			if (ownField(x.parameters.fields, name)?.digest !== ownField(y.parameters.fields, name)?.digest)
				parameterNames.push(name);
	}
	return { comparable: true, same: differs.length === 0, differs, parameterNames: parameterNames.sort() };
}
