// Pure model-relay admission policy and digest helpers (EVAL-ISO-002 / EVAL-ISO-003).
// Separate from the live Unix-socket relay (`adapters/sandbox/model-relay.ts`) so read-only verifiers and Studio observers
// never import network or proxy-server modules.

import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

/** One route a relay admits: a method and an exact request target (no query string, no prefix match). */
export interface EndoModelRouteV0 {
	readonly method: string;
	readonly path: string;
}

/**
 * The routes Pi 1.5.0 uses against an `openai-completions` provider, measured from Pi itself inside the sandbox
 * (tests/protected-model-relay.test.ts records every request a real Pi made). Nothing else is needed for a run.
 */
export const ENDO_PI_MODEL_ROUTES_V0: readonly EndoModelRouteV0[] = Object.freeze([
	Object.freeze({ method: "POST", path: "/v1/chat/completions" }),
]);

export interface EndoModelRelayPolicyV0 {
	readonly routes: readonly EndoModelRouteV0[];
	/** Every admitted request's JSON body names exactly this model: the agent cannot select, or make a router load, another. */
	readonly model: string;
	/** The largest admitted request body. At most the governed proxy's own bound. */
	readonly maxRequestBytes: number;
	/** All bytes through the relay, both ways, for the whole session: past it, connections are dropped. */
	readonly maxTransferredBytes: number;
	/** Connections open at once through the socket. */
	readonly maxConnections: number;
	/**
	 * Connections accepted through the socket over the relay's whole life. Each accepted connection is recorded (its close is a durable
	 * capture event), even one that sends nothing and so counts against no byte bound: without this, a sandbox could grow the host's log
	 * without limit by connecting and closing (Codex, #134).
	 */
	readonly maxTotalConnections: number;
	/**
	 * Requests admitted to the model server over the relay's whole life. Each admitted exchange writes several durable capture events and
	 * its bodies, so many small requests over one kept-alive connection could grow the host's log far beyond the bytes on the wire, within
	 * both the transfer and the connection bounds. Past this, a request is refused like any other: its connection is closed and the model
	 * server never sees it (Codex, #134).
	 */
	readonly maxExchanges: number;
	/**
	 * The generation bound (EVAL-ISO-003). When set, a request is admitted only if it asks for at most this many generated tokens, in
	 * `max_tokens`, `max_completion_tokens` or llama.cpp's own `n_predict` (at least one present, every one present an integer from 1 to
	 * this: llama.cpp reads `n_predict` before the others, so `{"max_tokens":1,"n_predict":-1}` ran unbounded, measured), and for one
	 * choice (`n` and llama.cpp's `n_cmpl` each absent or 1). Requests are refused, never rewritten: the recording keeps what the agent sent. It bounds what is asked of the
	 * model server, which is a hard cap only where the server honours the field (measured for llama.cpp b11429, both fields:
	 * docs/protected-model-access.md). Absent: no bound, as in policies recorded before it existed.
	 */
	readonly maxCompletionTokens?: number;
}

export type EndoModelRefusalReasonV0 = "route" | "size" | "body" | "model" | "generation";

/**
 * The request fields that bound generation, as the servers known here read them: OpenAI's two, and llama.cpp's `n_predict`, which it
 * prefers to both (measured, b11429). A server that reads yet another field is not bounded by this policy.
 */
const GENERATION_FIELDS_V0 = ["max_tokens", "max_completion_tokens", "n_predict"] as const;

/** The judge, pure: whether one complete request may reach the model server. */
export function admitModelRequestV0(
	policy: EndoModelRelayPolicyV0,
	request: { readonly method: string; readonly path: string; readonly body: Uint8Array },
): { admitted: true } | { admitted: false; reason: EndoModelRefusalReasonV0 } {
	if (!policy.routes.some((route) => route.method === request.method && route.path === request.path))
		return { admitted: false, reason: "route" };
	if (request.body.length > policy.maxRequestBytes) return { admitted: false, reason: "size" };
	let body: unknown;
	try {
		body = JSON.parse(Buffer.from(request.body).toString("utf8"));
	} catch {
		return { admitted: false, reason: "body" };
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { admitted: false, reason: "body" };
	// The relay forwards the original bytes. With a key repeated (`{"model":"x","model":"y"}`), JSON.parse keeps the last value, but
	// another parser may keep the first (RFC 8259 §4): a request whose top-level keys repeat is refused (Codex, #134).
	if (topLevelKeysRepeat(Buffer.from(request.body).toString("utf8"))) return { admitted: false, reason: "body" };
	if ((body as { model?: unknown }).model !== policy.model) return { admitted: false, reason: "model" };
	if (
		policy.maxCompletionTokens !== undefined &&
		!generationBounded(body as Record<string, unknown>, policy.maxCompletionTokens)
	)
		return { admitted: false, reason: "generation" };
	return { admitted: true };
}

/** Whether a request body asks for at most `max` generated tokens, for one choice (see EndoModelRelayPolicyV0.maxCompletionTokens). */
function generationBounded(body: Record<string, unknown>, max: number): boolean {
	const present = GENERATION_FIELDS_V0.filter((field) => Object.hasOwn(body, field));
	if (present.length === 0) return false;
	for (const field of present) {
		const value = body[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) return false;
	}
	// One choice, by either name: llama.cpp reads `n_cmpl` first and `n` only as its fallback alias (b11429, tools/server/server-schema.cpp;
	// up to the server's slots), so `{"n":1,"n_cmpl":4}` asks for four completions (Stage 0 review).
	return ["n", "n_cmpl"].every((field) => !Object.hasOwn(body, field) || body[field] === 1);
}

/**
 * Whether a JSON object's top-level keys repeat, comparing keys after their escapes are decoded (`"model"` and `"mod\u0065l"` are the
 * same key). The text is already known to parse as an object.
 */
function topLevelKeysRepeat(text: string): boolean {
	const seen = new Set<string>();
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const literal = text.slice(i, j + 1);
			if (depth === 1) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k] as string)) k++;
				if (text[k] === ":") {
					const key = JSON.parse(literal) as string;
					if (seen.has(key)) return true;
					seen.add(key);
				}
			}
			i = j;
		} else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth--;
	}
	return false;
}

/** A policy's identity: the digest of its canonical JSON. A record names the policy by it. */
export function modelRelayPolicyDigestV0(policy: EndoModelRelayPolicyV0): string {
	return sha256HexV0(canonicalEndoJsonV0(policyJson(policy)));
}

const policyJson = (policy: EndoModelRelayPolicyV0) => ({
	routes: [...policy.routes]
		.map((route) => ({ method: route.method, path: route.path }))
		// By UTF-16 code units, never the locale: a digest must not depend on where it is computed (Codex, #134).
		.sort((a, b) => {
			const x = `${a.method} ${a.path}`;
			const y = `${b.method} ${b.path}`;
			return x < y ? -1 : x > y ? 1 : 0;
		}),
	model: policy.model,
	maxRequestBytes: policy.maxRequestBytes,
	maxTransferredBytes: policy.maxTransferredBytes,
	maxConnections: policy.maxConnections,
	// Absent from policies recorded before the lifetime bound existed: their digest is computed as it was then. A running relay always has
	// it (checkPolicy requires it).
	...(policy.maxTotalConnections === undefined ? {} : { maxTotalConnections: policy.maxTotalConnections }),
	// Likewise for the exchange bound, added later still.
	...(policy.maxExchanges === undefined ? {} : { maxExchanges: policy.maxExchanges }),
	// And for the generation bound (EVAL-ISO-003): a policy without one keeps its earlier digest.
	...(policy.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: policy.maxCompletionTokens }),
});
