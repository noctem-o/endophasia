// Deriving the effective harness surface (protocol/harness-surface.ts) from recorded wire evidence: one record per
// `capture.request` of the recording proxy, read from the capture log and its keyed blob store.
//
// Recognition is by endpoint first and shape second: the method is POST, the path (query removed) is a chat-completions
// path, the body is a JSON object, `messages` is a list of objects with string roles, and `tools`, when present, is a
// list. Anything else is UNAVAILABLE with the reason, and nothing about it is guessed. The user's, the assistant's and
// the tools' messages are never read; the system/developer messages and the tool definitions are digested whole.
//
// Digests cover the canonical JSON of the parsed value (runtime/contracts/canonical-json.ts), under the log's key and a
// per-purpose basis literal. So number formatting, key order, whitespace and duplicate object keys in the body do not
// separate two surfaces, while any change of a value does. The request digest remains the digest of the parsed body
// under {method, path} as the proxy recorded it.

import { join } from "node:path";
import {
	ENDO_HARNESS_SURFACE_BASES_V0,
	ENDO_HARNESS_SURFACE_CHAT_PATHS_V0,
	ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0,
	ENDO_HARNESS_SURFACE_HEADER_NAME_PATTERN_V0,
	ENDO_HARNESS_SURFACE_NON_PARAMETER_FIELDS_V0,
	ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0,
	ENDO_HARNESS_SURFACE_TOOL_NAME_PATTERN_V0,
	ENDO_HARNESS_SURFACE_TRANSPORT_HEADERS_V0,
	ENDO_HARNESS_SURFACE_VERSION_V0,
	type EndoHarnessSurfaceComponentsV0,
	type EndoHarnessSurfaceV0,
	endoHarnessSurfaceIdentityBasisV0,
	endoHarnessSurfaceValueBytesV0,
} from "../../protocol/harness-surface.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { readEndoCaptureEventsV0 } from "./capture-log.ts";

/** Everything one derivation needs from one recorded request. */
export interface EndoHarnessSurfaceInputV0 {
	key: EndoDigestKeyV0;
	captureVersion: string | null;
	exchange: number;
	eventId: string;
	method: string;
	path: string;
	requestDigest: EndoKeyedDigestV0;
	/** The recorded header list (`capture.request` payload `headers`); undefined when the capture has none. */
	headers?: unknown;
	/** The recorded request body; null when its blob is not available. */
	body: Uint8Array | null;
}

const SERVER_DEFAULTS_REASON =
	"the wire carries only what the harness sent; the server's resulting defaults are not on it, and a parameter the request omits is absent, not defaulted";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const bytesOf = (value: unknown): number => Buffer.byteLength(canonicalEndoJsonV0(value));

/** The surface's headers from the capture's recorded list: transport headers dropped, values digested, order removed. */
function headersOf(
	recorded: unknown,
	digest: (basis: string, fields: Record<string, unknown>) => string,
): EndoHarnessSurfaceComponentsV0["headers"] {
	if (!Array.isArray(recorded))
		return { status: "UNAVAILABLE", reason: "the capture recorded no request header list" };
	const items: { name: string; digest: string | null }[] = [];
	for (const header of recorded) {
		if (!isRecord(header) || typeof header.name !== "string")
			return { status: "UNAVAILABLE", reason: "a recorded header is not a name with a value or a redaction" };
		const name = header.name.toLowerCase();
		if (!ENDO_HARNESS_SURFACE_HEADER_NAME_PATTERN_V0.test(name))
			return { status: "UNAVAILABLE", reason: "a recorded header name is not a plain token" };
		if (ENDO_HARNESS_SURFACE_TRANSPORT_HEADERS_V0.includes(name)) continue;
		if (header.redacted === true) items.push({ name, digest: null });
		else if (typeof header.value === "string")
			items.push({ name, digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.header, { name, value: header.value }) });
		else return { status: "UNAVAILABLE", reason: "a recorded header has neither a value nor a redaction" };
	}
	items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.digest ?? "") < (b.digest ?? "") ? -1 : 1));
	return {
		status: "reported",
		value: { items, digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.headers, { items }) },
	};
}

type Recognized = { ok: true; components: EndoHarnessSurfaceComponentsV0 } | { ok: false; reason: string };

function recognize(
	key: EndoDigestKeyV0,
	parsed: Record<string, unknown>,
	target: string,
	recordedHeaders: unknown,
): Recognized {
	const { messages, tools } = parsed;
	if (!Array.isArray(messages)) return { ok: false, reason: "the body has no `messages` list" };
	if (tools !== undefined && !Array.isArray(tools))
		return { ok: false, reason: "`tools` is present and is not a list" };
	if (
		"model" in parsed &&
		!(typeof parsed.model === "string" && parsed.model.length > 0 && parsed.model.length <= 512)
	)
		return { ok: false, reason: "the request's `model` is not a plain string" };
	if ("stream" in parsed && typeof parsed.stream !== "boolean")
		return { ok: false, reason: "the request's `stream` is not a boolean" };
	for (const message of messages)
		if (!isRecord(message) || typeof message.role !== "string")
			return { ok: false, reason: "a message is not an object with a string role" };

	const digest = (basis: string, fields: Record<string, unknown>): string =>
		key.digest({ basis, ...fields } as JsonValueV0).value;

	const instructions: EndoHarnessSurfaceComponentsV0["instructions"]["items"] = [];
	for (const [position, message] of messages.entries()) {
		const role = (message as { role: string }).role;
		if (role === "system" || role === "developer")
			instructions.push({
				position,
				role,
				bytes: bytesOf(message),
				digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.instruction, { message }),
			});
	}
	const toolItems = (tools ?? []).map((tool) => {
		const name = isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined;
		return {
			name: typeof name === "string" && ENDO_HARNESS_SURFACE_TOOL_NAME_PATTERN_V0.test(name) ? name : null,
			digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.tool, { tool }),
		};
	});
	// Built with Object.fromEntries: a JSON key such as "__proto__" is an own property there, never the prototype setter.
	const parameterValues: Record<string, unknown> = Object.fromEntries(
		Object.keys(parsed)
			.sort()
			.filter((name) => !ENDO_HARNESS_SURFACE_NON_PARAMETER_FIELDS_V0.includes(name))
			.map((name) => [name, parsed[name]]),
	);
	const fields: EndoHarnessSurfaceComponentsV0["parameters"]["fields"] = Object.fromEntries(
		Object.entries(parameterValues).map(([name, value]) => [
			name,
			{
				digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.parameter, { name, value }),
				...(endoHarnessSurfaceValueBytesV0(value, ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0) <=
				ENDO_HARNESS_SURFACE_PARAMETER_VALUE_MAX_BYTES_V0
					? { value: value as JsonValueV0 }
					: {}),
			},
		]),
	);

	const model = parsed.model;
	const stream = parsed.stream;
	const partial: Omit<EndoHarnessSurfaceComponentsV0, "identity"> = {
		model:
			typeof model === "string"
				? { status: "reported", value: model }
				: { status: "UNAVAILABLE", reason: "the request names no model" },
		streaming:
			typeof stream === "boolean"
				? { status: "reported", value: stream }
				: { status: "UNAVAILABLE", reason: "the request carries no `stream` field" },
		instructions: {
			items: instructions,
			orderedDigest: digest(ENDO_HARNESS_SURFACE_BASES_V0.instructions, {
				items: instructions.map((item) => ({ role: item.role, digest: item.digest })),
			}),
		},
		tools: {
			present: tools !== undefined,
			count: toolItems.length,
			items: toolItems,
			orderedDigest: digest(ENDO_HARNESS_SURFACE_BASES_V0.tools, {
				present: tools !== undefined,
				items: toolItems.map((item) => item.digest),
			}),
			membershipDigest: digest(ENDO_HARNESS_SURFACE_BASES_V0.toolSet, {
				items: toolItems.map((item) => item.digest).sort(),
			}),
		},
		parameters: { digest: digest(ENDO_HARNESS_SURFACE_BASES_V0.parameters, { fields: parameterValues }), fields },
		headers: headersOf(recordedHeaders, digest),
		serverDefaults: { status: "UNAVAILABLE", reason: SERVER_DEFAULTS_REASON },
	};
	const identity = key.digest(
		endoHarnessSurfaceIdentityBasisV0(partial, ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0, target),
	).value;
	return { ok: true, components: { ...partial, identity } };
}

/** The harness surface of one recorded request: recognized, or UNAVAILABLE with the reason. */
export function deriveEndoHarnessSurfaceV0(input: EndoHarnessSurfaceInputV0): EndoHarnessSurfaceV0 {
	const base = {
		schemaVersion: ENDO_HARNESS_SURFACE_VERSION_V0 as typeof ENDO_HARNESS_SURFACE_VERSION_V0,
		source: {
			captureVersion: input.captureVersion,
			exchange: input.exchange,
			eventId: input.eventId,
			method: input.method,
			path: input.path,
			requestDigest: input.requestDigest.value,
		},
		digestKey: { algorithm: "hmac-sha256" as const, keyId: input.key.keyId },
	};
	const unavailable = (reason: string): EndoHarnessSurfaceV0 => ({
		...base,
		dialect: { status: "UNAVAILABLE", reason },
		components: { status: "UNAVAILABLE", reason: "no recognized dialect" },
	});
	if (input.requestDigest.keyId !== input.key.keyId)
		return unavailable("the request was digested under another key than the one given");
	const pathname = input.path.split("?")[0]!;
	if (input.method !== "POST" || !ENDO_HARNESS_SURFACE_CHAT_PATHS_V0.includes(pathname))
		return unavailable(
			`${input.method.slice(0, 64)} ${pathname.slice(0, 200)} is not a recognized chat-completions endpoint`,
		);
	if (input.body === null) return unavailable("the request body is not in the blob store");
	let parsed: unknown;
	try {
		// Fatal decoding, as the request digest does: invalid UTF-8 is opaque bytes, not a JSON body with U+FFFD in it.
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
	} catch {
		return unavailable("the request body is not UTF-8 JSON");
	}
	if (!isRecord(parsed)) return unavailable("the request body is not a JSON object");
	let recognized: Recognized;
	try {
		// The whole tree, ignored messages included: a body with a value that has no canonical form is opaque to the
		// request digest, so it is not a surface (1e400 parses to Infinity).
		canonicalEndoJsonV0(parsed);
		recognized = recognize(input.key, parsed, input.path, input.headers);
	} catch {
		// A value JSON.parse accepts but canonical JSON cannot carry (an overflowing number such as 1e400).
		return unavailable("the request body holds a value with no canonical form (for example a non-finite number)");
	}
	if (!recognized.ok) return unavailable(recognized.reason);
	return {
		...base,
		dialect: { status: "reported", value: ENDO_HARNESS_SURFACE_DIALECT_CHAT_COMPLETIONS_V0 },
		components: { status: "reported", value: recognized.components },
	};
}

/**
 * The harness surface of every request the recording proxy captured under `storeRoot`, in capture order. Only
 * `capture:record` requests count (a replay's served requests are not a recording of the harness).
 */
export function harnessSurfacesOfCaptureV0(storeRoot: string, key: EndoDigestKeyV0): EndoHarnessSurfaceV0[] {
	const blobs = createEndoBlobStoreV0(join(storeRoot, "capture"), key, { readOnly: true });
	const surfaces: EndoHarnessSurfaceV0[] = [];
	let captureVersion: string | null = null;
	for (const event of readEndoCaptureEventsV0(storeRoot)) {
		if (event.producer !== "capture:record") continue;
		const payload = event.payload as Record<string, unknown>;
		if (event.kind === "capture.started") {
			captureVersion = typeof payload.capture === "string" ? payload.capture : null;
			continue;
		}
		if (event.kind !== "capture.request") continue;
		const body = payload.body as { digest: EndoKeyedDigestV0 };
		let bytes: Uint8Array | null = null;
		try {
			bytes = blobs.get(body.digest);
		} catch {
			bytes = null;
		}
		surfaces.push(
			deriveEndoHarnessSurfaceV0({
				key,
				captureVersion,
				exchange: payload.exchange as number,
				eventId: event.id,
				method: payload.method as string,
				path: payload.path as string,
				requestDigest: payload.requestDigest as EndoKeyedDigestV0,
				headers: payload.headers,
				body: bytes,
			}),
		);
	}
	return surfaces;
}

/**
 * The request parameters a surface stands for, in the shape trials recorded them before the surface existed (every
 * top-level field but `messages` and `tools`, as the harness sent it): the single basis is the surface, and this is a
 * view of it. A field recorded by digest only, or an unrecognized surface, is reported as such rather than invented.
 */
export function requestParametersOfEndoHarnessSurfaceV0(surface: EndoHarnessSurfaceV0): JsonValueV0 {
	if (surface.components.status !== "reported") return { unparsed: true };
	const c = surface.components.value;
	const entries: [string, JsonValueV0][] = [];
	if (c.model.status === "reported") entries.push(["model", c.model.value]);
	if (c.streaming.status === "reported") entries.push(["stream", c.streaming.value]);
	for (const [name, field] of Object.entries(c.parameters.fields))
		entries.push([name, "value" in field ? (field.value as JsonValueV0) : { digestOnly: field.digest }]);
	return Object.fromEntries(entries);
}
