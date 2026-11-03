// The only frontend fetch boundary: fixed relative Observe snapshots and opaque Compare selections.
// Requests use document.baseURI without printing or persisting its per-launch capability.
// Every outcome becomes a classified reply with fixed failure text; raw exceptions and URLs never reach the page.

import type { EndoOmpSessionV0 } from "../../protocol/omp-observation.ts";
import { type AttemptsReply, readAttempts } from "./model/attempts-wire.ts";
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
import { type OmpList, ompSelector, readOmpSession, readOmpSessions } from "./model/omp-wire.ts";
import {
	type ProjectReply,
	type ProjectRequest,
	readWorkbenchDiff,
	readWorkbenchProject,
} from "./model/project-wire.ts";
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
import {
	isNoWorkspace,
	readWorkspace,
	type WorkspaceRefusal,
	type WorkspaceReply,
	type WorkspaceRequest,
} from "./model/workspace-wire.ts";

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

export type OmpRequest = { kind: "list" } | { kind: "session"; selector: string };
export type OmpReply =
	| { kind: "list"; record: OmpList }
	| { kind: "session"; record: EndoOmpSessionV0 }
	| { kind: "failure"; message: string; stale: boolean };

/**
 * Oh My Pi's saved sessions, as the server observed them: two fixed relative GET routes, the second named by an opaque selector the list
 * gave (never a path, a title or an id). Read only when the page asks.
 */
export async function fetchOmp(request: OmpRequest, cancel: AbortSignal): Promise<OmpReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let route = "./api/v0/develop/omp/sessions";
	if (request.kind === "session") {
		if (!ompSelector(request.selector))
			return { kind: "failure", message: "Invalid selection. Read the OMP sessions again.", stale: true };
		route = `./api/v0/develop/omp/session/${request.selector}`;
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
			/* a refusal is told by its status */
		}
		if (response.status === 404)
			return {
				kind: "failure",
				message:
					"That saved session is no longer where it was, or its file was replaced. Read the OMP sessions again.",
				stale: true,
			};
		if (response.status === 429)
			return {
				kind: "failure",
				message: "The server is pacing reads. Wait a moment, then read again.",
				stale: false,
			};
		if (response.status !== 200)
			return { kind: "failure", message: "The read failed. Nothing from it was accepted.", stale: false };
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		if (request.kind === "list") {
			const record = readOmpSessions(body);
			if (record !== null) return { kind: "list", record };
		} else {
			const record = readOmpSession(body);
			if (record !== null) return { kind: "session", record };
		}
		return {
			kind: "failure",
			message: "Unsupported or malformed OMP observation. Nothing from it was accepted.",
			stale: false,
		};
	} catch {
		return {
			kind: "failure",
			message: cancel.aborted
				? "Request interrupted. Read again explicitly."
				: "The response could not be read or the server could not be reached. Read again explicitly.",
			stale: false,
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

/**
 * The project routes: two GETs under the workbench prefix, behind the grant. A diff is asked for by (snapshot, entry number), both
 * validated here; no path, no command and no Git argument is ever built from anything the page holds. A reply is checked whole before
 * it is accepted, and a failure is a classified reply with no body text.
 */
export async function fetchProject(request: ProjectRequest, grant: string, cancel: AbortSignal): Promise<ProjectReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let route = "./api/v0/workbench/project";
	if (request.kind === "project-diff") {
		if (
			!/^[0-9a-f]{16}$/.test(request.snapshot) ||
			!Number.isSafeInteger(request.id) ||
			request.id < 0 ||
			request.id > 999_999
		)
			return { kind: "failure", status: 0, code: "bad-request", retrySeconds: null };
		route += `/diff?snapshot=${request.snapshot}&file=${request.id}`;
	}
	try {
		const response = await fetch(new URL(route, document.baseURI), {
			method: "GET",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			headers: { "X-Endo-Grant": grant },
			signal: AbortSignal.any([cancel, timeout]),
		});
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			/* a refusal whose body cannot be read is still a refusal */
		}
		const code =
			typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string"
				? ((json as { error: string }).error.match(/^[a-z-]{1,40}$/)?.[0] ?? "")
				: "";
		if (response.status === 404 && request.kind === "project") return { kind: "absent" };
		if (response.status === 200 && request.kind === "project" && isNoProject(json)) return { kind: "absent" };
		if (response.status === 409 && code === "stale-snapshot") return { kind: "stale" };
		if (response.status !== 200) {
			const retry = response.headers.get("retry-after");
			return {
				kind: "failure",
				status: response.status,
				code,
				retrySeconds:
					response.status === 429 && retry !== null && /^(0|[1-9][0-9]{0,3})$/.test(retry)
						? Math.min(3600, Number(retry))
						: null,
			};
		}
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		if (request.kind === "project") {
			const record = readWorkbenchProject(json);
			if (record !== null) return { kind: "project", record };
		} else {
			const record = readWorkbenchDiff(json);
			// A diff is only accepted for the entry that was asked for.
			if (record !== null && record.snapshot === request.snapshot && record.id === request.id)
				return { kind: "diff", record };
		}
		return { kind: "failure", status: 200, code: "invalid", retrySeconds: null };
	} catch {
		return { kind: "failure", status: 0, code: "unreachable", retrySeconds: null };
	}
}

const WORKSPACE_REFUSALS: readonly WorkspaceRefusal[] = [
	"grant-required",
	"read-only",
	"stale-revision",
	"invalid-transition",
	"bad-request",
	"not-found",
	"limit-reached",
	"no-session",
	"unreadable",
	"busy",
	"storage-failed",
	"unavailable",
];

/**
 * The workspace routes: the operator's project and task metadata, behind the grant. One GET, and POSTs to a closed list of six task
 * operations. A body is built from a task id and a revision the page holds plus the operator's own words; the page never names a project,
 * a path, a session, a launch or a status of its own making, and nothing here reaches the agent. A reply is checked whole before it is
 * accepted, and a failure is a classified reply with no body text.
 */
export async function fetchWorkspace(
	request: WorkspaceRequest,
	grant: string,
	cancel: AbortSignal,
): Promise<WorkspaceReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const bad: WorkspaceReply = { kind: "failure", status: 0, code: "bad-request" };
	let route = "./api/v0/workbench/workspace";
	let body: string | null = null;
	const id = (v: string): boolean => /^endo\.task\.[0-9a-f]{32}$/.test(v);
	const revision = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
	if (request.kind !== "read") {
		if (request.kind === "create") {
			route += "/tasks/create";
			body = JSON.stringify({
				title: request.title,
				description: request.description,
				acceptance: request.acceptance,
			});
		} else if (request.kind === "select") {
			if (request.taskId !== null && !id(request.taskId)) return bad;
			route += "/tasks/select";
			body = JSON.stringify({ taskId: request.taskId });
		} else {
			if (!id(request.taskId) || !revision(request.revision)) return bad;
			if (request.kind === "update") {
				route += "/tasks/update";
				// Only the fields the operator changed are sent: a field they did not touch is never written back from an old copy.
				body = JSON.stringify({
					taskId: request.taskId,
					expectedRevision: request.revision,
					...(request.title === undefined ? {} : { title: request.title }),
					...(request.description === undefined ? {} : { description: request.description }),
					...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
				});
			} else if (request.kind === "status") {
				route += "/tasks/status";
				body = JSON.stringify({
					taskId: request.taskId,
					expectedRevision: request.revision,
					to: request.to,
					...(request.note === "" ? {} : { note: request.note }),
				});
			} else if (request.kind === "link") {
				route += "/tasks/link-session";
				body = JSON.stringify({ taskId: request.taskId, expectedRevision: request.revision });
			} else {
				if (!/^[0-9a-f]{16}$/.test(request.linkId)) return bad;
				route += "/tasks/unlink-session";
				body = JSON.stringify({
					taskId: request.taskId,
					expectedRevision: request.revision,
					linkId: request.linkId,
				});
			}
		}
	}
	try {
		const response = await fetch(new URL(route, document.baseURI), {
			method: body === null ? "GET" : "POST",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			headers: { "X-Endo-Grant": grant, ...(body === null ? {} : { "Content-Type": "application/json" }) },
			...(body === null ? {} : { body }),
			signal: AbortSignal.any([cancel, timeout]),
		});
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			/* a refusal whose body cannot be read is still a refusal */
		}
		if (response.status === 404 && request.kind === "read") return { kind: "absent" };
		if (response.status === 200 && request.kind === "read" && isNoWorkspace(json)) return { kind: "absent" };
		if (response.status !== 200) {
			const named =
				typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string"
					? (json as { error: string }).error
					: "";
			const code = WORKSPACE_REFUSALS.find((c) => c === named) ?? "other";
			return { kind: "failure", status: response.status, code };
		}
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		const record = readWorkspace(json);
		if (record !== null) return { kind: "workspace", record };
		return { kind: "failure", status: 200, code: "invalid" };
	} catch {
		return { kind: "failure", status: 0, code: "unreachable" };
	}
}

/**
 * The work attempts of the task selected in this launch's project: one GET, behind the grant, with no query and no body. The page names no
 * project, task or attempt, and cannot make or record one: there is no route for it. A reply is checked whole before it is accepted.
 */
export async function fetchAttempts(grant: string, cancel: AbortSignal): Promise<AttemptsReply> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(new URL("./api/v0/workbench/workspace/attempts", document.baseURI), {
			method: "GET",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			headers: { "X-Endo-Grant": grant },
			signal: AbortSignal.any([cancel, timeout]),
		});
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			/* a refusal whose body cannot be read is still a refusal */
		}
		if (response.status === 404) return { kind: "absent" };
		if (response.status === 401) return { kind: "failure", status: 401, code: "grant-required" };
		if (response.status !== 200) return { kind: "failure", status: response.status, code: "other" };
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			throw new Error("content type");
		const record = readAttempts(json);
		return record === null ? { kind: "failure", status: 200, code: "invalid" } : { kind: "attempts", record };
	} catch {
		return { kind: "failure", status: 0, code: "unreachable" };
	}
}

/** A workbench started without a project context answers the project route with one constant. */
const isNoProject = (v: unknown): boolean =>
	typeof v === "object" &&
	v !== null &&
	Object.keys(v).sort().join() === "available,schemaVersion" &&
	(v as { available: unknown }).available === false &&
	(v as { schemaVersion: unknown }).schemaVersion === "endo.workbench-project.v0";

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
