// The only frontend fetch boundary: fixed relative Observe snapshots and opaque Compare selections.
// Requests use document.baseURI without printing or persisting its per-launch capability.
// Every outcome becomes a classified reply with fixed failure text; raw exceptions and URLs never reach the page.

import type { CompareRequest } from "./model/compare.ts";
import {
	type CompareReply,
	candidateCursor,
	compareFailure,
	opaqueSelector,
	readCandidates,
	readComparison,
} from "./model/compare-wire.ts";
import { classifyReply, type Reply } from "./model/contract.ts";
import type { DevelopRequest } from "./model/develop.ts";
import {
	activityCursor,
	type DevelopReply,
	developFailure,
	developSelector,
	readDevelopSession,
	readDevelopSessions,
	sessionsCursor,
} from "./model/develop-wire.ts";
import type { ReadRequest } from "./model/state.ts";

export interface Fetched {
	reply: Reply;
	/** How long the request took, by the browser's monotonic clock. */
	durationMs: number;
}

/** Compare requests use only opaque selections and a fixed relative route; no display identifier becomes a URL argument. */
export async function fetchCompare(request: CompareRequest, cancel: AbortSignal): Promise<CompareReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let route = "./api/v0/compare/candidates";
	if (request.kind === "more") {
		if (!candidateCursor(request.cursor))
			return {
				kind: "failure",
				message: "Invalid discovery continuation. Rediscover recordings.",
				invalid: true,
				retrySeconds: null,
			};
		route += `?cursor=${request.cursor}`;
	}
	if (request.kind === "compare") {
		for (const row of [request.pair.a, request.pair.b])
			if ((row.source !== "pi" && row.source !== "dsh") || !opaqueSelector(row.selector))
				return {
					kind: "failure",
					message: "Invalid selection. Rediscover recordings.",
					invalid: true,
					retrySeconds: null,
				};
		route = `./api/v0/compare/selected/${request.pair.a.source}/${request.pair.a.selector}/${request.pair.b.source}/${request.pair.b.selector}`;
	}
	try {
		const response = await fetch(new URL(route, document.baseURI), {
			method: "GET",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([cancel, timeout]),
		});
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			/* Status refusals still invalidate even when a refusal body is unreadable. */
		}
		if (response.status !== 200) return compareFailure(response.status, body, response.headers.get("retry-after"));
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		if (request.kind === "compare") {
			const record = readComparison(body);
			if (record !== null) return { kind: "comparison", record };
		} else {
			const record = readCandidates(body);
			if (record !== null) return { kind: "candidates", record };
		}
		return {
			kind: "failure",
			message: "Unsupported or malformed Compare response. Nothing from it was accepted.",
			invalid: true,
			retrySeconds: null,
		};
	} catch {
		return {
			kind: "failure",
			message: cancel.aborted
				? "Request interrupted. Retry explicitly."
				: timeout.aborted
					? "The request timed out. Retry explicitly."
					: "The response could not be read or the server could not be reached. Retry explicitly.",
			invalid: false,
			retrySeconds: null,
		};
	}
}

/** DEVELOP requests use only opaque server tokens and two fixed relative routes; a display alias is never a URL argument. */
export async function fetchDevelop(request: DevelopRequest, cancel: AbortSignal): Promise<DevelopReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const invalid = (message: string): DevelopReply => ({ kind: "failure", message, invalid: true, retrySeconds: null });
	let route = "./api/v0/develop/sessions";
	if (request.kind === "more") {
		if (!sessionsCursor(request.cursor)) return invalid("Invalid discovery continuation. Rediscover sessions.");
		route += `?cursor=${request.cursor}`;
	} else if (request.kind === "session" || request.kind === "events") {
		if (!developSelector(request.selector)) return invalid("Invalid selection. Rediscover sessions.");
		route = `./api/v0/develop/session/${request.selector}`;
		if (request.kind === "events") {
			if (!activityCursor(request.cursor)) return invalid("Invalid activity continuation. Rediscover sessions.");
			route += `?cursor=${request.cursor}`;
		}
	}
	try {
		const response = await fetch(new URL(route, document.baseURI), {
			method: "GET",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([cancel, timeout]),
		});
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			/* Status refusals still invalidate even when a refusal body is unreadable. */
		}
		if (response.status !== 200) return developFailure(response.status, body, response.headers.get("retry-after"));
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		if (request.kind === "list" || request.kind === "more") {
			const record = readDevelopSessions(body);
			if (record !== null) return { kind: "sessions", record };
		} else {
			const record = readDevelopSession(body);
			if (record !== null) return { kind: "session", record };
		}
		return invalid("Unsupported or malformed DEVELOP response. Nothing from it was accepted.");
	} catch {
		return {
			kind: "failure",
			message: cancel.aborted
				? "Request interrupted. Retry explicitly."
				: timeout.aborted
					? "The request timed out. Retry explicitly."
					: "The response could not be read or the server could not be reached. Retry explicitly.",
			invalid: false,
			retrySeconds: null,
		};
	}
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Request one snapshot, relative to the page's own address. Never throws: a failure is a `Reply`. */
export async function fetchSnapshot(request: ReadRequest): Promise<Fetched> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	try {
		const url = new URL(
			`./api/v0/snapshot?afterSequence=${request.afterSequence}&limit=${request.limit}`,
			document.baseURI,
		);
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: timeout,
		});
		const body = await response.text();
		return {
			reply: classifyReply(
				response.status,
				response.headers.get("retry-after"),
				response.headers.get("content-type"),
				body,
			),
			durationMs: performance.now() - started,
		};
	} catch {
		return {
			reply: { kind: "unreachable", reason: timeout.aborted ? "timeout" : "network" },
			durationMs: performance.now() - started,
		};
	}
}
