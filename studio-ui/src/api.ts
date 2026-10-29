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
import {
	readWorkbenchCommand,
	readWorkbenchGrant,
	readWorkbenchIntervention,
	readWorkbenchStatus,
	readWorkbenchTranscript,
	type WorkbenchReply,
	type WorkbenchRequest,
	workbenchFailure,
} from "./model/workbench-wire.ts";

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

/**
 * The workbench routes: one fixed prefix, a closed list, GET or POST. The grant (held in the page's memory, never in a URL, a cookie or
 * storage) goes in one header; a command is a JSON POST, which the browser sends with its own Origin. A request is built here from
 * validated pieces, never from a display value.
 */
export async function fetchWorkbench(
	request: WorkbenchRequest,
	grant: string | null,
	cancel: AbortSignal,
): Promise<WorkbenchReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const bad = (message: string): WorkbenchReply => ({
		kind: "failure",
		status: 0,
		code: "bad-request",
		message,
		retrySeconds: null,
	});
	let route = "./api/v0/workbench/status";
	let body: string | null = null;
	if (request.kind === "transcript") {
		if (!Number.isSafeInteger(request.after) || request.after < 0) return bad("Invalid transcript position.");
		route = `./api/v0/workbench/transcript${request.after === 0 ? "" : `?after=${request.after}`}`;
	} else if (request.kind === "pair") {
		if (!/^[A-Za-z0-9-]{1,16}$/.test(request.code)) return bad("A pairing code is letters, digits and one hyphen.");
		route = "./api/v0/workbench/pair";
		body = JSON.stringify({ code: request.code });
	} else if (request.kind === "propose") {
		route = "./api/v0/workbench/prompt/propose";
		body = JSON.stringify({ message: request.message });
	} else if (request.kind === "intervene") {
		const stop = request.operation === "stop";
		if (stop !== (request.message === null)) return bad("Steer and queue need a message; stop carries none.");
		route = "./api/v0/workbench/intervention/propose";
		body = JSON.stringify(stop ? { operation: "stop" } : { operation: request.operation, message: request.message });
	} else if (request.kind === "withdraw" || request.kind === "check") {
		if (!/^endo\.evidence\.intervention\.proposal\.[0-9a-f]{64}$/.test(request.proposalId))
			return bad("Invalid intervention reference.");
		route = `./api/v0/workbench/intervention/${request.kind === "withdraw" ? "discard" : "check"}`;
		body = JSON.stringify({ proposalId: request.proposalId });
	} else if (request.kind === "command" || request.kind === "discard") {
		if (!/^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/.test(request.proposalId))
			return bad("Invalid prompt reference.");
		if (request.kind === "command") route = `./api/v0/workbench/prompt/${request.proposalId}`;
		else {
			route = "./api/v0/workbench/prompt/discard";
			body = JSON.stringify({ proposalId: request.proposalId });
		}
	}
	try {
		const response = await fetch(new URL(route, document.baseURI), {
			method: body === null ? "GET" : "POST",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			headers: {
				...(grant === null ? {} : { "X-Endo-Grant": grant }),
				...(body === null ? {} : { "Content-Type": "application/json" }),
			},
			...(body === null ? {} : { body }),
			signal: AbortSignal.any([cancel, timeout]),
		});
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			/* a refusal whose body cannot be read is still a refusal */
		}
		if (response.status === 404 && request.kind === "status") return { kind: "absent" };
		if (response.status === 200 && request.kind === "status" && isNoWorkbench(json)) return { kind: "absent" };
		if (response.status !== 200 && response.status !== 202)
			return workbenchFailure(response.status, json, response.headers.get("retry-after"));
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		if (request.kind === "status") {
			const record = readWorkbenchStatus(json);
			if (record !== null) return { kind: "status", record };
		} else if (request.kind === "transcript") {
			const record = readWorkbenchTranscript(json);
			if (record !== null) return { kind: "transcript", record };
		} else if (request.kind === "pair") {
			const record = readWorkbenchGrant(json);
			if (record !== null) return { kind: "grant", record };
		} else if (request.kind === "intervene" || request.kind === "withdraw" || request.kind === "check") {
			const record = readWorkbenchIntervention(json);
			if (record !== null) return { kind: "intervention", record };
		} else {
			const record = readWorkbenchCommand(json);
			if (record !== null) return { kind: "command", record };
		}
		return {
			kind: "failure",
			status: response.status,
			code: "",
			message: "Unsupported or malformed workbench response. Nothing from it was accepted.",
			retrySeconds: null,
		};
	} catch {
		return {
			kind: "failure",
			status: 0,
			code: "",
			message: cancel.aborted
				? "Request interrupted."
				: timeout.aborted
					? "The request timed out."
					: "The workbench could not be reached. It may have ended: that is not shown by this message alone.",
			retrySeconds: null,
		};
	}
}

/** The read-only server's constant answer: this server has no workbench. */
const isNoWorkbench = (v: unknown): boolean =>
	typeof v === "object" &&
	v !== null &&
	Object.keys(v).sort().join() === "available,schemaVersion" &&
	(v as { available: unknown }).available === false &&
	(v as { schemaVersion: unknown }).schemaVersion === "endo.workbench-status.v0";

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
