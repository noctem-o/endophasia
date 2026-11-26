// The workspace host (docs/designs/workspace-host.md): the handler `endo workspace open` gives the cockpit server for `api/v0/workbench/*`.
// It makes the operator's registered project, its tasks and their evidence usable from a browser with NO agent running: no Pi, no
// provider, no model and no harness executable is needed, started or contacted. It is not an agent runtime and offers no command surface.
//
//   GET  status            this host's launch id, whether a page is paired, and `harness: null`. No grant needed.
//   POST pair {code}       exchange the one-time code shown on the host's terminal for the grant (runtime/contracts/workbench-pairing.ts).
//   ---- everything below needs the grant, and an answer that awaited anything is sent only if the grant STILL holds ----
//   workspace/...          the operator's project, tasks, attempts, receipts and attention overview (runtime/contracts/workspace-routes.ts,
//                          over runtime/contracts/develop-workspace.ts): the same routes, rules and refusals as the Pi workbench's.
//   project, project/diff  the registered directory's Git context and one changed file's diff. READ ONLY.
//   anything else          404. There is no transcript, prompt, intervention or check route here: not disabled, absent.
//
// Authority. The grant lets a page read the project's work and make the task changes the service offers (create, edit, set a status,
// choose a task, remove a reference). It cannot link a session: this host has none (`session: null`), so the service answers
// `no-session` and nothing is written; it cannot impersonate one either, since no request names a session. It cannot choose a project, a
// store, a directory or a repository: the operator fixed all of them when starting the host. Only the operator's terminal issues codes,
// revokes the grant and stops the host.
//
// It imports no harness adapter (tests/endo-workspace-host.test.ts checks the static import closure of `endo workspace open`).

import { randomBytes } from "node:crypto";
import type { EndoCockpitWorkbenchRequestV0, EndoCockpitWorkbenchV0 } from "../protocol/workbench-http.ts";
import { ENDO_WORKSPACE_HOST_STATUS_SCHEMA_V0, type EndoWorkspaceHostStatusV0 } from "../protocol/workspace-host.ts";
import type { DevelopLaunchHostV0, DevelopLaunchWorkspaceV0 } from "../runtime/contracts/develop-workspace.ts";
import { EndoPairingV0 } from "../runtime/contracts/workbench-pairing.ts";
import {
	type EndoProjectSourceV0,
	EndoWorkspaceRoutesV0,
	endoProjectRouteV0,
} from "../runtime/contracts/workspace-routes.ts";
import { EndoCockpitCoordinatorV0, type EndoCoordinatorHeadV0 } from "./coordinator.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (status: number, error: string) => ({ status, body: { error } });

export interface EndoWorkspaceHostOptionsV0 {
	/**
	 * Opens the launch scope of the ONE project the operator named, given this host's facts. The host's facts say there is no session
	 * (`session: null`): nothing can be linked, and every recorded reference is historical.
	 */
	open(host: DevelopLaunchHostV0): DevelopLaunchWorkspaceV0;
	/** The registered directory's Git context, read-only. Without it the project routes answer one constant. */
	project?: EndoProjectSourceV0;
	/** The presented alias of a session id (the cockpit's own), so a historical reference links to its recording. */
	aliasOf?: (sessionId: string) => string;
	now?: () => number;
	/** How long a pairing code lives. Default 10 minutes. */
	pairingWindowMs?: number;
	/** How long a grant lives. Default 1 hour. */
	grantMs?: number;
}

export class EndoWorkspaceHostV0 implements EndoCockpitWorkbenchV0 {
	readonly launchId = randomBytes(8).toString("hex");
	readonly #routes: EndoWorkspaceRoutesV0;
	readonly #pairing: EndoPairingV0;
	readonly #project: EndoProjectSourceV0 | undefined;
	readonly #coordinator = new EndoCockpitCoordinatorV0();
	#closed = false;

	constructor(options: EndoWorkspaceHostOptionsV0) {
		this.#pairing = new EndoPairingV0({
			now: options.now ?? Date.now,
			pairingWindowMs: options.pairingWindowMs ?? 10 * 60_000,
			grantMs: options.grantMs ?? 60 * 60_000,
			closed: () => this.#closed,
		});
		this.#project = options.project;
		this.#routes = new EndoWorkspaceRoutesV0(
			options.open({
				launchId: this.launchId,
				// Not a session's attachment: the label this host records nowhere, since it can make no session reference.
				attachment: "workspace",
				session: null,
				...(options.aliasOf === undefined ? {} : { aliasOf: options.aliasOf }),
			}),
		);
	}

	/** What the page will be told of the project now, for the terminal's own account at start. */
	workspaceView() {
		return this.#routes.view();
	}

	/** A new one-time pairing code (for the host's own terminal), replacing any earlier one. */
	issuePairingCode(): { code: string; expiresAtMs: number } {
		return this.#pairing.issue();
	}

	/** The operator's `revoke`: the page that holds the grant can no longer read or change anything. */
	revoke(): void {
		this.#pairing.revoke();
	}

	#status(): EndoWorkspaceHostStatusV0 {
		return {
			schemaVersion: ENDO_WORKSPACE_HOST_STATUS_SCHEMA_V0,
			launchId: this.launchId,
			host: "workspace",
			harness: null,
			paired: !this.#closed && this.#pairing.paired(),
			changes: this.#project !== undefined,
		};
	}

	async handle(
		request: EndoCockpitWorkbenchRequestV0,
		coordinator?: { root: string; observe: EndoCoordinatorHeadV0 },
	): Promise<{ status: number; body: unknown }> {
		const [a, b, c] = request.route;
		if (a === "status" && b === undefined && request.method === "GET" && request.query === "")
			return { status: 200, body: this.#status() };
		if (a === "pair" && b === undefined && request.method === "POST" && request.query === "")
			return this.#pairing.pair(isRecord(request.body) ? request.body.code : undefined);
		if (!this.#pairing.granted(request.grant)) return refuse(401, "grant-required");
		let answer: { status: number; body: unknown } | null = null;
		const isCoordinatorStatus = a === "workspace" && b === "coordinator" && request.route.length === 2;
		const isCoordinatorCoordination =
			a === "workspace" && b === "coordinator" && c === "coordination" && request.route.length === 3;
		if ((isCoordinatorStatus || isCoordinatorCoordination) && coordinator !== undefined) {
			if (request.method !== "GET" || request.query !== "") return refuse(400, "bad-request");
			const project = this.#routes.view().project;
			if (project?.launch !== "same") return refuse(403, "forbidden");
			answer = isCoordinatorStatus
				? await this.#coordinator.read(coordinator.root, project, coordinator.observe)
				: await this.#coordinator.readCoordination(coordinator.root, project, coordinator.observe);
			if (!this.#pairing.granted(request.grant)) return refuse(401, "grant-required");
			const current = this.#routes.view().project;
			if (
				current?.launch !== "same" ||
				current.id !== project.id ||
				current.path !== project.path ||
				current.observedGitRoot !== project.observedGitRoot
			)
				return refuse(403, "forbidden");
		} else if (a === "workspace")
			answer = await this.#routes.route(request.route, request.method, request.query, request.body);
		else if (a === "project")
			answer = await endoProjectRouteV0(this.#project, request.route, request.method, request.query);
		if (answer === null) return refuse(404, "not-found");
		// A read that waited (Git, for the attempts, the overview and the project) answers only if the grant it was asked under still holds:
		// a pairing revoked, replaced or expired meanwhile gets the refusal, never data that would look current.
		return this.#pairing.granted(request.grant) ? answer : refuse(401, "grant-required");
	}

	/** Stop: no grant, no code, nothing answered but the status. Idempotent. */
	close(): void {
		this.#closed = true;
		this.#pairing.clear();
		this.#project?.dispose?.();
	}
}
