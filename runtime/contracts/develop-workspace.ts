// The DEVELOP workspace service: the one application-level implementation of the operator's project and task operations, shared by every
// caller (the `endo` CLI, the Pi workbench's routes, and any later host). docs/develop-workspace-service.md is its decision record.
//
//   caller (CLI | workbench routes | a later host)
//        |   translates its own input (flags, an HTTP body) and its own refusals (text, a status code); authorises nothing here
//   DevelopWorkspaceServiceV0           operator scope: register a project, read, create a task, change a status
//        `-- forLaunch(config, host)    launch scope: one project, one launch directory, one launch's session facts
//   DevelopTasksStoreV0                 the lock, the atomic rewrite, validation, revisions, the transition rules (storage/develop-tasks.ts)
//   <root>/develop/tasks.json           endo.develop-tasks.v0 or .v1 (written in the version it was read in; v1 only by an explicit upgrade)
//
// It is a TypeScript library: no process, no server, no browser, no model and no harness are needed to use it, and it imports nothing from any
// adapter. It is NOT an authentication boundary. Whoever holds an object of it may make the changes it offers; who may hold one is
// decided by its caller: the CLI is the operator's own process, and the workbench broker hands the launch scope only to a request that already
// carries its pairing grant. What this module does guarantee is that every caller gets the same rules, and that the facts that make a session
// reference true (the launch, the connected session, its source) come from the HOST that constructed the launch scope, never from the data of
// a request: no operation here takes a session id, a launch id, a path or a project id from the caller's request.
//
// Two ways a reference is made, one per kind of source, and neither reachable from the other's scope:
// - LIVE (`pi-live`): the launch scope's `linkCurrentSession`, built from the launch host's own facts. A host that speaks for any other
//   source, `omp-saved` included, is `unsupported-source`: a launch can never mint a reference with a launch, an attachment or a connection
//   for a session it does not host.
// - OBSERVED (`omp-saved`): the operator scope's `linkObservedSession`, given an observation the CALLER established with its own observer
//   (the CLI resolves OMP's id in the directory the operator named). The launch scope has no such method, so no workbench request can reach it.
//   Here the observation's shape is checked (a closed source, OMP's id grammar, a scope digest, the format); that it is TRUE is the caller's
//   duty, exactly as the live host's facts are the host's.
//
// What none of its operations can do: send a prompt, steer, queue or stop, start, resume or select a session, open, list or write a file
// other than the task file, run Git or a shell, or approve anything. (Registering a project asks the caller's own read-only Git observation.)

import { realpathSync, statSync } from "node:fs";
import type { EndoDevelopAttemptsViewV1 } from "../../protocol/develop-attempts.ts";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import {
	ENDO_DEVELOP_OMP_FORMAT_V1,
	ENDO_DEVELOP_OMP_SCOPE_PATTERN_V1,
	ENDO_DEVELOP_WORKSPACE_SCHEMA_V1,
	ENDO_LAUNCH_ID_PATTERN_V0,
	type EndoDevelopPiSessionRefV1,
	type EndoDevelopProjectV0,
	type EndoDevelopTasksFileV1,
	type EndoDevelopTaskV1,
	type EndoDevelopTaskViewV1,
	type EndoDevelopUnreadableReasonV0,
	type EndoDevelopWorkspaceViewV1,
	endoDevelopNextStatusesV0,
	endoDevelopOmpAliasV1,
	endoDevelopOmpScopeLabelV1,
	isEndoDevelopLiveSourceV1,
	isEndoDevelopObservedSourceV1,
	isEndoDevelopOmpSessionIdV1,
	isEndoDevelopSessionIdV0,
} from "../../protocol/develop-tasks.ts";
import type { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import type { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";
import type {
	DevelopTasksStoreV0,
	EndoDevelopTasksFormatV1,
	EndoTasksRefusalV0,
	EndoTasksResultV0,
	EndoTasksUpgradeV1,
} from "../../storage/develop-tasks.ts";
import { DevelopAttemptsServiceV0 } from "./develop-attempts.ts";

export type EndoDevelopReadOnlyReasonV0 = NonNullable<EndoDevelopWorkspaceViewV1["readOnlyReason"]>;

/**
 * Why an operation was refused. Nothing was written for any of them. The store's own refusals, plus:
 * - `read-only`: the launch scope cannot change this workspace now (`reason` says why: the file, the project, the directory).
 * - `no-session`: a link was asked for and the host has no connected session.
 * - `unsupported-source`: the host's sessions are not of a LIVE source this file can record, or an observation is not of an OBSERVED one.
 * - `unavailable`: the host's own facts are not well formed (an internal fault of the host, never the requester's).
 * - `not-a-directory`: a project was to be registered at a path that is not an existing directory.
 */
export type DevelopWorkspaceRefusalV0 =
	| EndoTasksRefusalV0
	| "read-only"
	| "no-session"
	| "unsupported-source"
	| "unavailable"
	| "not-a-directory";

export type DevelopWorkspaceResultV0<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code: DevelopWorkspaceRefusalV0;
			reason?: EndoDevelopUnreadableReasonV0 | EndoDevelopReadOnlyReasonV0;
	  };

/** What the operator configured for one launch: the project they named and the directory the process was launched in. */
export interface DevelopLaunchConfigV0 {
	projectId: string;
	launchDirectory: string;
}

/**
 * What only the host that runs the launch knows, read from its own state at the moment of each call. The service never asks a request for
 * any of these, and a host that cannot vouch for a fact says so (`session: null`) rather than guess it.
 */
export interface DevelopLaunchHostV0 {
	/** The host's own random id for this launch: a session reference is current only when it names this launch. */
	launchId: string;
	/** The attachment name the host's session belongs to (for example `pi.default`). */
	attachment: string;
	/**
	 * The host's session, if it has one: the source it speaks for, and the session connected now (its canonical id, from the host's own
	 * mapping), or null when none is. `session: null`: this host has no session it can vouch for, so nothing can be linked and every
	 * recorded reference is historical.
	 */
	session: { source: string; current(): { sessionId: string } | null } | null;
	/** The presented alias of a session id (a label for the page, never a key). */
	aliasOf?: (sessionId: string) => string;
}

export interface DevelopWorkspaceServiceOptionsV0 {
	/**
	 * What Git says the worktree root of a directory is, read-only, or null: supplied by the caller that registers projects (the CLI gives the
	 * existing Git project inspector), so this module reaches no adapter. Without it a registration records no observation (null).
	 */
	observeGitRoot?: (directory: string) => Promise<string | null>;
	/**
	 * The work-attempt records (storage/develop-attempts.ts). Given, a launch scope offers `attemptsView()`, the one read-only view of the
	 * launch project's selected task's attempts; not given, it offers none (`null`), and the workbench's attempts route is not found.
	 */
	attempts?: DevelopAttemptsStoreV0;
	/**
	 * The verification receipts (storage/develop-receipts.ts), shown read-only under each attempt in `attemptsView()`, and how the launch
	 * directory's HEAD is observed to compare them with (the caller gives the read-only Git revision observer; this module reaches no
	 * adapter). The directory observed is always the launch's own, never one a request or a receipt names.
	 */
	receipts?: {
		store: DevelopReceiptsStoreV0;
		current: (directory: string) => Promise<EndoReceiptCurrentV0 | null>;
	};
}

const realpath = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

const fromStore = <T>(result: EndoTasksResultV0<T>): DevelopWorkspaceResultV0<T> =>
	result.ok
		? { ok: true, value: result.value }
		: result.reason === undefined
			? { ok: false, code: result.code }
			: { ok: false, code: result.code, reason: result.reason };

/**
 * What an operator's caller established about a saved session with its OWN observer, before asking for a link: the source, the session's id as
 * that source wrote it, the scope (which directory the operator named, as a digest), and the format the observer read. Never a path, a
 * selector, a title or any content. The service checks its shape; the caller is responsible for its truth (see the header).
 */
export interface DevelopObservedSessionV1 {
	source: "omp-saved";
	sessionId: string;
	scope: string;
	format: typeof ENDO_DEVELOP_OMP_FORMAT_V1;
}

/** The file as the operator inspects it before an upgrade: its version on disk and what it holds. Counts only. */
export interface DevelopWorkspaceInspectionV1 {
	format: EndoDevelopTasksFormatV1;
	exists: boolean;
	revision: number;
	projects: number;
	tasks: number;
	references: { "pi-live": number; "omp-saved": number };
}

/** Module-private: only `forLaunch` can open a launch scope, so a scope always comes from a service object. */
const OPEN: unique symbol = Symbol("develop-launch-scope");

/** The operator scope: what the operator's own process (the CLI) may do. A launch scope is made from it, for one project and one launch. */
export class DevelopWorkspaceServiceV0 {
	readonly #store: DevelopTasksStoreV0;
	readonly #observeGitRoot: (directory: string) => Promise<string | null>;
	readonly #attempts: DevelopAttemptsStoreV0 | null;
	readonly #receipts: DevelopWorkspaceServiceOptionsV0["receipts"] | null;

	constructor(store: DevelopTasksStoreV0, options: DevelopWorkspaceServiceOptionsV0 = {}) {
		this.#store = store;
		this.#observeGitRoot = options.observeGitRoot ?? (async () => null);
		this.#attempts = options.attempts ?? null;
		this.#receipts = options.receipts ?? null;
	}

	/** The whole file (as the v1 model), read now; an unreadable file is a refusal with its closed reason (and it was not changed). */
	read(): DevelopWorkspaceResultV0<EndoDevelopTasksFileV1> {
		const read = this.#store.read();
		return read.ok ? { ok: true, value: read.file } : { ok: false, code: "unreadable", reason: read.reason };
	}

	/** The file's version on disk and its counts, read now. Writes nothing. */
	inspect(): DevelopWorkspaceResultV0<DevelopWorkspaceInspectionV1> {
		const read = this.#store.read();
		if (!read.ok) return { ok: false, code: "unreadable", reason: read.reason };
		const refs = read.file.tasks.flatMap((t) => t.sessions);
		return {
			ok: true,
			value: {
				format: read.format,
				exists: read.exists,
				revision: read.file.revision,
				projects: read.file.projects.length,
				tasks: read.file.tasks.length,
				references: {
					"pi-live": refs.filter((r) => r.source === "pi-live").length,
					"omp-saved": refs.filter((r) => r.source === "omp-saved").length,
				},
			},
		};
	}

	/** The operator's explicit upgrade of a v0 file to v1 (`endo task upgrade --apply`). A v1 or missing file is unchanged. */
	upgrade(expectedRevision?: number): DevelopWorkspaceResultV0<EndoTasksUpgradeV1> {
		return fromStore(this.#store.upgrade(expectedRevision));
	}

	/**
	 * Link a task to a saved session the caller's own observer established (see `DevelopObservedSessionV1`). The operator's process only: a
	 * launch scope has no such operation. Idempotent per source, scope and session id. A live source is refused here: a live reference is made
	 * only by the launch host that serves the session.
	 */
	linkObservedSession(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		observed: DevelopObservedSessionV1,
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		if (!isEndoDevelopObservedSourceV1(observed.source)) return { ok: false, code: "unsupported-source" };
		if (
			!isEndoDevelopOmpSessionIdV1(observed.sessionId) ||
			typeof observed.scope !== "string" ||
			!ENDO_DEVELOP_OMP_SCOPE_PATTERN_V1.test(observed.scope) ||
			observed.format !== ENDO_DEVELOP_OMP_FORMAT_V1
		)
			return { ok: false, code: "bad-request" };
		return fromStore(
			this.#store.linkSession(projectId, taskId, expectedRevision, {
				source: "omp-saved",
				sessionId: observed.sessionId,
				scope: observed.scope,
				observedFormat: ENDO_DEVELOP_OMP_FORMAT_V1,
				linkedBy: "operator",
				via: "cli",
			}),
		);
	}

	/** Remove one reference, of any source, by its link id: the operator's own act. The session is not touched. */
	unlinkSession(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		linkId: string,
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return fromStore(this.#store.unlinkSession(projectId, taskId, expectedRevision, linkId));
	}

	/** One registered project's tasks. */
	tasks(projectId: string): DevelopWorkspaceResultV0<EndoDevelopTaskV1[]> {
		const read = this.read();
		if (!read.ok) return read;
		if (!read.value.projects.some((p) => p.id === projectId)) return { ok: false, code: "not-found" };
		return { ok: true, value: read.value.tasks.filter((t) => t.projectId === projectId) };
	}

	/** One task of one project. */
	task(projectId: string, taskId: string): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		const tasks = this.tasks(projectId);
		if (!tasks.ok) return tasks;
		const found = tasks.value.find((t) => t.id === taskId);
		return found === undefined ? { ok: false, code: "not-found" } : { ok: true, value: found };
	}

	/**
	 * Register a project: the operator's explicit statement that this directory is this project. The path is resolved to the place the system
	 * calls it and must be an existing directory; Git is asked once, read-only, what the worktree root there is (an observation, not a
	 * condition). The directory is not opened, listed or run, and the registration grants no access to anything.
	 */
	async registerProject(input: {
		name: string;
		path: string;
	}): Promise<DevelopWorkspaceResultV0<EndoDevelopProjectV0>> {
		let path: string;
		try {
			path = realpathSync(input.path);
			if (!statSync(path).isDirectory()) return { ok: false, code: "not-a-directory" };
		} catch {
			return { ok: false, code: "not-a-directory" };
		}
		const observedGitRoot = await this.#observeGitRoot(path);
		return fromStore(this.#store.registerProject({ name: input.name, path, observedGitRoot }));
	}

	createTask(
		projectId: string,
		input: { title: unknown; description?: unknown; acceptance?: unknown },
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return fromStore(this.#store.createTask(projectId, input));
	}

	/** The operator's own status change, against the revision they saw. The transition rules are the file's (protocol/develop-tasks.ts). */
	setStatus(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		to: unknown,
		note?: unknown,
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return fromStore(this.#store.setStatus(projectId, taskId, expectedRevision, to, note));
	}

	/**
	 * The launch scope for one project and one launch. `config` is what the operator configured; `host` is what the host running the launch
	 * knows. The scope can change only that project, and only while the launch directory is the project's registered one.
	 */
	forLaunch(config: DevelopLaunchConfigV0, host: DevelopLaunchHostV0): DevelopLaunchWorkspaceV0 {
		return new DevelopLaunchWorkspaceV0(OPEN, this.#store, config, host, this.#attempts, this.#receipts);
	}
}

/**
 * The launch scope: one registered project, as seen from one launch. It cannot register a project or reach another project's tasks, and
 * it holds no session: it asks its host, at each call, which session is connected now.
 */
export class DevelopLaunchWorkspaceV0 {
	readonly #store: DevelopTasksStoreV0;
	readonly #config: Readonly<DevelopLaunchConfigV0>;
	readonly #host: DevelopLaunchHostV0;
	readonly #attempts: DevelopAttemptsServiceV0 | null;
	readonly #receipts: DevelopWorkspaceServiceOptionsV0["receipts"] | null;

	/** Opened only by `DevelopWorkspaceServiceV0.forLaunch`: the token is private to this module. */
	constructor(
		token: typeof OPEN,
		store: DevelopTasksStoreV0,
		config: DevelopLaunchConfigV0,
		host: DevelopLaunchHostV0,
		attempts: DevelopAttemptsStoreV0 | null = null,
		receipts: DevelopWorkspaceServiceOptionsV0["receipts"] | null = null,
	) {
		if (token !== OPEN) throw new TypeError("a launch scope is opened by DevelopWorkspaceServiceV0.forLaunch");
		this.#store = store;
		this.#config = Object.freeze({ ...config });
		this.#host = host;
		this.#attempts = attempts === null ? null : new DevelopAttemptsServiceV0(store, attempts);
		this.#receipts = receipts;
	}

	/**
	 * The attempts of the task this launch's project has selected (docs/designs/develop-work-attempts.md), read now; null when this launch
	 * was given no attempt records. Read-only, in every state of the workspace: a launch scope cannot prepare or record an attempt. The project
	 * is this launch's and the task is the one selected in the task file; nothing a request says chooses either. Each attempt's receipts are
	 * compared with the HEAD of this launch's own directory, observed now (read-only Git), when this launch was given receipts.
	 */
	async attemptsView(): Promise<EndoDevelopAttemptsViewV1 | null> {
		if (this.#attempts === null) return null;
		const receipts = this.#receipts;
		if (receipts === null || receipts === undefined) return this.#attempts.viewFor(this.#config.projectId);
		const current = await receipts.current(this.#config.launchDirectory).catch(() => null);
		return this.#attempts.viewFor(this.#config.projectId, { store: receipts.store, current });
	}

	/** The connected session, when the host speaks for a LIVE source this file can record. An observed source is never connected. */
	#connected(): { source: EndoDevelopPiSessionRefV1["source"]; sessionId: string } | null {
		const session = this.#host.session;
		if (session === null || !isEndoDevelopLiveSourceV1(session.source)) return null;
		const now = session.current();
		return now === null ? null : { source: session.source, sessionId: now.sessionId };
	}

	/** The workspace as a launch sees it, read from the file now: `endo.develop-workspace.v1`. */
	view(): EndoDevelopWorkspaceViewV1 {
		const base = {
			schemaVersion: ENDO_DEVELOP_WORKSPACE_SCHEMA_V1 as typeof ENDO_DEVELOP_WORKSPACE_SCHEMA_V1,
			available: true as const,
			launchId: this.#host.launchId,
		};
		const closed = {
			project: null,
			writable: false,
			linkable: false,
			tasks: [],
			selectedTaskId: null,
		};
		const read = this.#store.read();
		if (!read.ok)
			return {
				...base,
				state: "unreadable",
				reason: read.reason,
				revision: 0,
				readOnlyReason: "unreadable",
				...closed,
			};
		const project = read.file.projects.find((p) => p.id === this.#config.projectId);
		if (project === undefined)
			return {
				...base,
				state: "unknown-project",
				reason: null,
				revision: read.file.revision,
				readOnlyReason: "unknown-project",
				...closed,
			};
		const launch = this.#launchRelation(project);
		const connected = this.#connected();
		const writable = launch === "same";
		return {
			...base,
			state: "ready",
			reason: null,
			revision: read.file.revision,
			project: {
				id: project.id,
				name: project.name,
				path: project.path,
				observedGitRoot: project.observedGitRoot,
				launch,
			},
			writable,
			readOnlyReason: writable ? null : launch === "missing" ? "project-missing" : "project-mismatch",
			linkable: writable && connected !== null,
			tasks: this.#tasksView(
				read.file.tasks.filter((t) => t.projectId === project.id),
				connected,
			),
			selectedTaskId: project.selectedTaskId,
		};
	}

	/**
	 * Null when a change may be made now, or the refusal that every change would get: the file is unreadable, the project is not
	 * registered, or the launch directory is not the registered one. A caller may ask before it even reads its request.
	 */
	writeRefusal(): DevelopWorkspaceResultV0<never> | null {
		const view = this.view();
		return view.writable ? null : { ok: false, code: "read-only", reason: view.readOnlyReason ?? "unreadable" };
	}

	/** The registered directory against the launch directory (links resolved on both sides, at this moment). Exact equality. */
	#launchRelation(project: EndoDevelopProjectV0): "same" | "different" | "missing" {
		const registered = realpath(project.path);
		if (registered === null) return "missing";
		return realpath(this.#config.launchDirectory) === registered ? "same" : "different";
	}

	/**
	 * The tasks as the page sees them. An OMP label is the id's last 8 characters; when two different linked OMP ids end alike, neither gets a
	 * label (as in the observer's own list), so a label never stands for two sessions.
	 */
	#tasksView(
		tasks: EndoDevelopTaskV1[],
		connected: { source: EndoDevelopPiSessionRefV1["source"]; sessionId: string } | null,
	): EndoDevelopTaskViewV1[] {
		const ends = new Map<string, Set<string>>();
		for (const t of tasks)
			for (const s of t.sessions)
				if (s.source === "omp-saved") {
					const end = s.sessionId.slice(-8);
					ends.set(end, (ends.get(end) ?? new Set<string>()).add(s.sessionId));
				}
		const labelled = (id: string): boolean => (ends.get(id.slice(-8))?.size ?? 0) <= 1;
		return tasks.map((t) => this.#taskView(t, connected, labelled));
	}

	#taskView(
		task: EndoDevelopTaskV1,
		connected: { source: EndoDevelopPiSessionRefV1["source"]; sessionId: string } | null,
		labelled: (ompId: string) => boolean,
	): EndoDevelopTaskViewV1 {
		const launchId = this.#host.launchId;
		return {
			...task,
			next: [...endoDevelopNextStatusesV0(task.status)],
			sessions: task.sessions.map((s) =>
				s.source === "omp-saved"
					? {
							// Saved, always: decided by the source before any launch or session is compared. No id, no scope digest, no path.
							linkId: s.linkId,
							source: s.source,
							alias: labelled(s.sessionId) ? endoDevelopOmpAliasV1(s.sessionId) : null,
							scopeLabel: endoDevelopOmpScopeLabelV1(s.scope),
							linkedAtMs: s.linkedAtMs,
							linkedBy: s.linkedBy,
							via: s.via,
							relation: "saved" as const,
						}
					: {
							linkId: s.linkId,
							source: s.source,
							alias: this.#host.aliasOf?.(s.sessionId) ?? null,
							attachment: s.attachment,
							launchId: s.launchId,
							linkedAtMs: s.linkedAtMs,
							linkedBy: s.linkedBy,
							// Current only if the reference was made in THIS launch, to the session of the same source connected now. A session id can
							// survive a restart; the launch cannot, so a reference from another launch is a historical claim whatever the ids say.
							relation:
								connected !== null &&
								s.launchId === launchId &&
								s.source === connected.source &&
								s.sessionId === connected.sessionId
									? ("current" as const)
									: ("historical" as const),
						},
			),
		};
	}

	/** Every change: refused whole unless the workspace is writable now, then made by the store against a fresh read of the file. */
	#change<T>(make: (projectId: string) => EndoTasksResultV0<T>): DevelopWorkspaceResultV0<T> {
		const refused = this.writeRefusal();
		if (refused !== null) return refused;
		return fromStore(make(this.#config.projectId));
	}

	/** Add a task to this project. `select`: creating and choosing it is one act and one write. */
	createTask(
		input: { title: unknown; description?: unknown; acceptance?: unknown },
		options: { select?: boolean } = {},
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return this.#change((projectId) => this.#store.createTask(projectId, input, options));
	}

	updateTask(
		taskId: string,
		expectedRevision: number,
		patch: { title?: unknown; description?: unknown; acceptance?: unknown },
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return this.#change((projectId) => this.#store.updateTask(projectId, taskId, expectedRevision, patch));
	}

	setStatus(
		taskId: string,
		expectedRevision: number,
		to: unknown,
		note?: unknown,
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return this.#change((projectId) => this.#store.setStatus(projectId, taskId, expectedRevision, to, note));
	}

	selectTask(taskId: string | null): DevelopWorkspaceResultV0<EndoDevelopProjectV0> {
		return this.#change((projectId) => this.#store.selectTask(projectId, taskId));
	}

	/**
	 * Link the task to the session connected NOW, as the host reports it. The caller names only the task and the revision it saw; the
	 * reference (source, session id, attachment, launch) is built here from the host's facts. A reference grants nothing: it is not a handle
	 * to the session and nothing reads it to control one.
	 */
	linkCurrentSession(taskId: string, expectedRevision: number): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		const refused = this.writeRefusal();
		if (refused !== null) return refused;
		const session = this.#host.session;
		if (session !== null && !isEndoDevelopLiveSourceV1(session.source))
			return { ok: false, code: "unsupported-source" };
		const connected = this.#connected();
		if (connected === null) return { ok: false, code: "no-session" };
		if (
			!ENDO_LAUNCH_ID_PATTERN_V0.test(this.#host.launchId) ||
			!isEndoDevelopSessionIdV0(connected.source, connected.sessionId)
		)
			return { ok: false, code: "unavailable" };
		const ref: Omit<EndoDevelopPiSessionRefV1, "linkId" | "linkedAtMs"> = {
			source: connected.source,
			sessionId: connected.sessionId,
			attachment: this.#host.attachment,
			launchId: this.#host.launchId,
			linkedBy: "operator",
			// A live reference is made one way: by the workbench that serves the session (exactly v0's record).
			via: "workbench",
		};
		return fromStore(this.#store.linkSession(this.#config.projectId, taskId, expectedRevision, ref));
	}

	unlinkSession(
		taskId: string,
		expectedRevision: number,
		linkId: string,
	): DevelopWorkspaceResultV0<EndoDevelopTaskV1> {
		return this.#change((projectId) => this.#store.unlinkSession(projectId, taskId, expectedRevision, linkId));
	}
}
