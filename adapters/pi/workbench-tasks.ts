// The workbench's task routes: the operator's project and task metadata, served to a PAIRED page and nothing else. This module is part of
// the broker's request surface (adapters/pi/workbench.ts forwards the routes below to it AFTER its grant check), and it is deliberately
// the opposite of a command surface:
//
//   GET  workspace                      the registered project, its tasks and the explicit session references. Needs the grant.
//   POST workspace/tasks/create         {title, description?, acceptance?}              add a task (and select it).
//   POST workspace/tasks/update         {taskId, expectedRevision, title?, description?, acceptance?}
//   POST workspace/tasks/status         {taskId, expectedRevision, to, note?}           the operator's own status change.
//   POST workspace/tasks/select         {taskId | null}                                 remember which task they are working on.
//   POST workspace/tasks/link-session   {taskId, expectedRevision}                      reference the session THIS workbench serves.
//   POST workspace/tasks/unlink-session {taskId, expectedRevision, linkId}
//
// It is a TRANSLATION layer only: it checks the shape of the request (exact keys, an id is a string, a revision is a count), calls the shared
// workspace service (runtime/contracts/develop-workspace.ts), and turns its answer into a status code. The meaning of every operation (what is
// writable, what a transition may be, what a stale revision is, how a session reference is built and when it is current) is the service's,
// the same one the `endo` CLI uses. The authorisation is the broker's grant, checked before this module is reached.
//
// What none of them can do: send a prompt, steer, queue or stop, start or resume or select a session, open or write a file, run Git or a
// shell, read the transcript, or approve anything. The page names a task by id and a revision; it never names a project, a path, a session
// or a launch: those are the launch scope's, fixed by the operator's `--project`, the launch directory and the broker's own state.

import type {
	DevelopLaunchWorkspaceV0,
	DevelopWorkspaceRefusalV0,
	DevelopWorkspaceResultV0,
} from "../../runtime/contracts/develop-workspace.ts";

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

export class WorkbenchTasksV0 {
	readonly #workspace: DevelopLaunchWorkspaceV0;

	constructor(workspace: DevelopLaunchWorkspaceV0) {
		this.#workspace = workspace;
	}

	/** The workspace as the page sees it, read from the file now. */
	view() {
		return this.#workspace.view();
	}

	/** A route under `workspace/`. The broker has already checked the grant. */
	handle(
		route: readonly string[],
		method: "GET" | "POST",
		query: string,
		body: unknown,
	): { status: number; body: unknown } {
		const [, a, b, ...more] = route;
		if (method === "GET") {
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
