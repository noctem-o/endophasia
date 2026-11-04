// The workspace routes: the operator's project and task metadata, and the read-only project context, served to a PAIRED page and nothing
// else. Shared by every host that serves `api/v0/workbench/*` (the Pi workbench, adapters/pi/workbench.ts, and the workspace host,
// cockpit-http/workspace-host.ts), which forward the routes below here AFTER their own grant check. It imports no harness adapter, and it
// is deliberately the opposite of a command surface:
//
//   GET  workspace                      the registered project, its tasks and the explicit session references. Needs the grant.
//   GET  workspace/attempts             the work attempts of the SELECTED task, with their briefs (read-only; none are made here).
//   GET  workspace/attention            every open task's attempt and check summary, for triage (read-only; nothing is decided here).
//   POST workspace/tasks/create         {title, description?, acceptance?}              add a task (and select it).
//   POST workspace/tasks/update         {taskId, expectedRevision, title?, description?, acceptance?}
//   POST workspace/tasks/status         {taskId, expectedRevision, to, note?}           the operator's own status change.
//   POST workspace/tasks/select         {taskId | null}                                 remember which task they are working on.
//   POST workspace/tasks/link-session   {taskId, expectedRevision}                      reference the session THIS host serves (a host
//                                                                                       with no session answers `no-session`).
//   POST workspace/tasks/unlink-session {taskId, expectedRevision, linkId}
//   GET  project                        the launch directory's Git context (`endoProjectRouteV0`). READ ONLY.
//   GET  project/diff?snapshot=&file=   one changed file's diff, for an entry of that snapshot. READ ONLY.
//
// It is a TRANSLATION layer only: it checks the shape of the request (exact keys, an id is a string, a revision is a count), calls the shared
// workspace service (runtime/contracts/develop-workspace.ts), and turns its answer into a status code. The meaning of every operation (what is
// writable, what a transition may be, what a stale revision is, how a session reference is built and when it is current) is the service's,
// the same one the `endo` CLI uses. The authorisation is the host's grant, checked before this module is reached.
//
// What none of them can do: send a prompt, steer, queue or stop, start or resume or select a session, open or write a file, run Git or a
// shell, read a transcript, or approve anything. The page names a task by id and a revision; it never names a project, a path, a session
// or a launch: those are the launch scope's, fixed by the operator's `--project`, the launch directory and the host's own state.

import type { EndoDiffOutcomeV0, EndoWorkbenchProjectV0 } from "../../protocol/workbench-project.ts";
import type {
	DevelopLaunchWorkspaceV0,
	DevelopWorkspaceRefusalV0,
	DevelopWorkspaceResultV0,
} from "./develop-workspace.ts";

const reply = (status: number, body: unknown) => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body has exactly the keys it must and may have, and no others. */
function keysOk(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(body);
	return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const HTTP: Record<DevelopWorkspaceRefusalV0, [number, string]> = {
	"not-found": [404, "not-found"],
	"stale-revision": [409, "stale-revision"],
	"invalid-transition": [409, "invalid-transition"],
	"bad-request": [400, "bad-request"],
	limit: [409, "limit-reached"],
	duplicate: [409, "duplicate"],
	unreadable: [409, "unreadable"],
	busy: [503, "busy"],
	"storage-failed": [503, "storage-failed"],
	"read-only": [409, "read-only"],
	"no-session": [409, "no-session"],
	"unsupported-source": [409, "unsupported-source"],
	unavailable: [503, "unavailable"],
	// A live Pi link is recordable in a v0 file, so the workbench never asks for an upgrade; mapped for completeness.
	"upgrade-required": [409, "upgrade-required"],
	// Registration is the CLI's alone; a launch scope cannot reach it.
	"not-a-directory": [400, "bad-request"],
};

export class EndoWorkspaceRoutesV0 {
	readonly #workspace: DevelopLaunchWorkspaceV0;

	constructor(workspace: DevelopLaunchWorkspaceV0) {
		this.#workspace = workspace;
	}

	/** The workspace as the page sees it, read from the file now. */
	view() {
		return this.#workspace.view();
	}

	/**
	 * A route under `workspace/`, as a host serves it: the attempts read here, everything else by `handle`. The host has already
	 * checked the grant. The attempts: GET only, no query, no further path, and nothing in the request chooses the project, the task or the
	 * directory their receipts are compared with (the launch's project, the task selected in the file, the launch's own directory). A
	 * launch given no attempt records has no such route. Asynchronous only because the receipts are compared with the launch directory's
	 * HEAD, read now (read-only Git).
	 */
	async route(
		route: readonly string[],
		method: "GET" | "POST",
		query: string,
		body: unknown,
	): Promise<{ status: number; body: unknown }> {
		const [, a, b] = route;
		if (method === "GET" && a === "attempts" && b === undefined) {
			const attempts = await this.#workspace.attemptsView();
			if (attempts === null) return refuse(404, "not-found");
			return query === "" ? reply(200, attempts) : refuse(400, "bad-request");
		}
		// The attention projection: the same rules. Nothing in the request chooses the project, a task or the directory compared with.
		if (method === "GET" && a === "attention" && b === undefined) {
			if (query !== "") return refuse(400, "bad-request");
			const attention = await this.#workspace.attentionView();
			return attention === null ? refuse(404, "not-found") : reply(200, attention);
		}
		return this.handle(route, method, query, body);
	}

	/** A route under `workspace/` other than the attempts (see `route`). The host has already checked the grant. */
	handle(
		route: readonly string[],
		method: "GET" | "POST",
		query: string,
		body: unknown,
	): { status: number; body: unknown } {
		const [, a, b, ...more] = route;
		if (method === "GET") {
			// The attempts: no query, no further path, and nothing in the request chooses the project or the task (the launch's project, and the
			// task selected in the file). A launch given no attempt records has no such route.
			// The attempts are served by `route` (asynchronously); `handle` alone does not serve them.
			if ((a === "attempts" || a === "attention") && b === undefined) return refuse(404, "not-found");
			if (a !== undefined || query !== "")
				return refuse(a === undefined ? 400 : 404, a === undefined ? "bad-request" : "not-found");
			return reply(200, this.view());
		}
		if (a !== "tasks" || b === undefined || more.length > 0 || query !== "") return refuse(404, "not-found");
		if (!isRecord(body)) return refuse(400, "bad-request");
		const w = this.#workspace;
		// Reading is allowed in every state; changing is allowed only when the file is readable and the project is the one this process was
		// launched in. Asked first, before the body's shape, so a read-only workspace answers every change the same way.
		const refused = w.writeRefusal();
		if (refused !== null) return this.#answer(refused);
		const revisionOf = (v: unknown): number =>
			typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : Number.NaN;
		const taskOf = (v: unknown): string | null => (typeof v === "string" ? v : null);
		switch (b) {
			case "create": {
				if (!keysOk(body, ["title"], ["description", "acceptance"])) return refuse(400, "bad-request");
				return this.#answer(
					w.createTask(
						{ title: body.title, description: body.description, acceptance: body.acceptance },
						{ select: true },
					),
				);
			}
			case "update": {
				if (!keysOk(body, ["taskId", "expectedRevision"], ["title", "description", "acceptance"]))
					return refuse(400, "bad-request");
				const id = taskOf(body.taskId);
				if (id === null) return refuse(400, "bad-request");
				return this.#answer(
					w.updateTask(id, revisionOf(body.expectedRevision), {
						title: body.title,
						description: body.description,
						acceptance: body.acceptance,
					}),
				);
			}
			case "status": {
				if (!keysOk(body, ["taskId", "expectedRevision", "to"], ["note"])) return refuse(400, "bad-request");
				const id = taskOf(body.taskId);
				if (id === null) return refuse(400, "bad-request");
				return this.#answer(w.setStatus(id, revisionOf(body.expectedRevision), body.to, body.note));
			}
			case "select": {
				if (!keysOk(body, ["taskId"])) return refuse(400, "bad-request");
				if (body.taskId !== null && typeof body.taskId !== "string") return refuse(400, "bad-request");
				return this.#answer(w.selectTask(body.taskId));
			}
			case "link-session": {
				// Nothing the page sent describes the session: the body has a task id and a revision, and no other key is accepted.
				if (!keysOk(body, ["taskId", "expectedRevision"])) return refuse(400, "bad-request");
				const id = taskOf(body.taskId);
				if (id === null) return refuse(400, "bad-request");
				return this.#answer(w.linkCurrentSession(id, revisionOf(body.expectedRevision)));
			}
			case "unlink-session": {
				if (!keysOk(body, ["taskId", "expectedRevision", "linkId"])) return refuse(400, "bad-request");
				const id = taskOf(body.taskId);
				if (id === null || typeof body.linkId !== "string") return refuse(400, "bad-request");
				return this.#answer(w.unlinkSession(id, revisionOf(body.expectedRevision), body.linkId));
			}
			default:
				return refuse(404, "not-found");
		}
	}

	/** A change made: the whole workspace again. A refusal: its status code, its closed name, and its closed reason when it has one. */
	#answer<T>(result: DevelopWorkspaceResultV0<T>): { status: number; body: unknown } {
		if (result.ok) return reply(200, this.view());
		const [status, error] = HTTP[result.code];
		return reply(status, result.reason === undefined ? { error } : { error, reason: result.reason });
	}
}

/**
 * The project context a host may serve: two READS about its launch directory (adapters/git/project-inspector.ts). It is not part of any
 * command surface: it can change nothing, takes no path from the page, and says nothing about who made a change.
 */
export interface EndoProjectSourceV0 {
	overview(): Promise<EndoWorkbenchProjectV0>;
	diff(snapshot: string, id: number): Promise<EndoDiffOutcomeV0>;
	/** The host is done with it: drop what was read. */
	dispose?(): void;
}

/**
 * `GET project` and `GET project/diff?snapshot=<16 hex>&file=<n>`, as a host serves them after its grant check; null for any other route
 * under `project` (the host answers not-found). A host without a project source answers the bare `project` route with one constant (so a
 * page can ask quietly) and nothing else.
 */
export async function endoProjectRouteV0(
	project: EndoProjectSourceV0 | undefined,
	route: readonly string[],
	method: "GET" | "POST",
	query: string,
): Promise<{ status: number; body: unknown } | null> {
	const [a, b, ...more] = route;
	if (a !== "project" || method !== "GET" || more.length > 0) return null;
	if (project === undefined)
		return b === undefined && query === ""
			? reply(200, { available: false, schemaVersion: "endo.workbench-project.v0" })
			: null;
	try {
		if (b === undefined && query === "") {
			const overview = await project.overview();
			// Busy is not a read: it says nothing about the worktree, so it is not served as one (the page keeps what it had).
			if (overview.state === "unavailable" && overview.reason === "busy") return refuse(429, "busy");
			return reply(200, overview);
		}
		if (b === "diff") {
			const match = /^snapshot=([0-9a-f]{16})&file=(0|[1-9][0-9]{0,5})$/.exec(query);
			if (match === null) return refuse(400, "bad-request");
			const outcome = await project.diff(match[1] as string, Number(match[2]));
			if (outcome.kind === "diff") return reply(200, outcome.diff);
			if (outcome.kind === "stale") return refuse(409, "stale-snapshot");
			if (outcome.kind === "busy") return refuse(429, "busy");
			return refuse(400, "bad-request");
		}
	} catch {
		return refuse(503, "unavailable");
	}
	return null;
}
