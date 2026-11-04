// Browser wire gate for the workspace routes (protocol/develop-tasks.ts, served by runtime/contracts/workspace-routes.ts). The broker is
// authoritative for what a project, a task and a reference are; this checks that a body has exactly the shape the renderers read and
// refuses it whole when it does not. The words are the operator's own: they are only ever shown as text, and are re-checked for the
// control and bidirectional characters the server already refuses.
import type {
	EndoDevelopSessionRefViewV1,
	EndoDevelopStatusChangeV0,
	EndoDevelopTaskStatusV0,
	EndoDevelopTaskViewV1,
	EndoDevelopWorkspaceViewV1,
} from "../../../protocol/develop-tasks.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type {
	EndoDevelopSessionRefViewV1 as SessionRef,
	EndoDevelopStatusChangeV0 as StatusChange,
	EndoDevelopTaskStatusV0 as TaskStatus,
	EndoDevelopTaskViewV1 as Task,
	EndoDevelopWorkspaceViewV1 as Workspace,
} from "../../../protocol/develop-tasks.ts";

/** The read model this page reads. A body of any other version (v0 included) is refused whole. */
export const WORKSPACE_SCHEMA = "endo.develop-workspace.v1";

/** These mirror the protocol's closed lists; a contract test holds them equal. */
export const TASK_STATUSES: readonly EndoDevelopTaskStatusV0[] = ["open", "in-progress", "blocked", "review", "done"];
export const UNREADABLE_REASONS = [
	"malformed",
	"unsupported-version",
	"invalid",
	"too-large",
	"unsafe-path",
	"io",
] as const;

/** Text the page will show: bounded, and without the characters that could make a line say something other than it is. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const words =
	(max: number, multiline: boolean): Check =>
	(v) =>
		typeof v === "string" && v.length <= max && !(multiline ? UNSAFE : /[\u0000-\u001f]/).test(v) && !UNSAFE.test(v);
const oneLine = (max: number): Check => words(max, false);
const status: Check = one(...TASK_STATUSES);
const hex =
	(n: number): Check =>
	(v) =>
		typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const stamp: Check = (v) => count(v) && v <= 8.64e15;
const path: Check = (v) => oneLine(1024)(v) && (v as string).startsWith("/");

const change: Check = (v) =>
	shape(v, { atMs: stamp, from: eitherNull(status), to: status, note: eitherNull(oneLine(280)) });
/**
 * A reference, by its source, to exactly one closed shape. A Pi reference is `current` or `historical` with its attachment and launch; an OMP
 * reference is `saved`, with neither: one that claims `current`, a launch or an attachment is refused, and the whole view with it.
 */
const reference: Check = (v) =>
	typeof v === "object" && v !== null && (v as { source?: unknown }).source === "omp-saved"
		? ompReference(v)
		: piReference(v);
const ompReference: Check = (v) =>
	shape(v, {
		linkId: hex(16),
		source: one("omp-saved"),
		alias: eitherNull((x) => typeof x === "string" && /^omp [0-9A-Za-z._:-]{4,8}$/.test(x)),
		scopeLabel: hex(8),
		linkedAtMs: stamp,
		linkedBy: one("operator"),
		via: one("cli"),
		relation: one("saved"),
	});
const piReference: Check = (v) =>
	shape(v, {
		linkId: hex(16),
		source: one("pi-live"),
		alias: eitherNull(oneLine(300)),
		// The harness registry's grammar for an attachment name: a dotted kind, at most 128 characters.
		attachment: (x) => typeof x === "string" && x.length <= 128 && /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(x),
		launchId: hex(16),
		linkedAtMs: stamp,
		linkedBy: one("operator"),
		relation: one("current", "historical"),
	});
const task: Check = (v) =>
	shape(v, {
		id: (x) => typeof x === "string" && /^endo\.task\.[0-9a-f]{32}$/.test(x),
		projectId: (x) => typeof x === "string" && /^endo\.project\.[0-9a-f]{32}$/.test(x),
		title: (x) => oneLine(120)(x) && (x as string).length > 0,
		description: words(4000, true),
		acceptance: words(4000, true),
		status,
		createdAtMs: stamp,
		updatedAtMs: stamp,
		revision: count,
		history: (x) => list(change)(x) && (x as unknown[]).length <= 50,
		sessions: (x) => list(reference)(x) && (x as unknown[]).length <= 20,
		next: (x) => list(status)(x) && (x as unknown[]).length <= 5,
	});

export function readWorkspace(v: unknown): EndoDevelopWorkspaceViewV1 | null {
	if (
		!shape(v, {
			schemaVersion: one(WORKSPACE_SCHEMA),
			available: one(true),
			launchId: hex(16),
			state: one("ready", "unknown-project", "unreadable"),
			reason: eitherNull(one(...UNREADABLE_REASONS)),
			revision: count,
			project: eitherNull((p) =>
				shape(p, {
					id: (x) => typeof x === "string" && /^endo\.project\.[0-9a-f]{32}$/.test(x),
					name: (x) => oneLine(80)(x) && (x as string).length > 0,
					path,
					observedGitRoot: eitherNull(path),
					launch: one("same", "different", "missing"),
				}),
			),
			writable: (x) => typeof x === "boolean",
			readOnlyReason: eitherNull(one("unreadable", "project-mismatch", "project-missing", "unknown-project")),
			linkable: (x) => typeof x === "boolean",
			tasks: (x) => list(task)(x) && (x as unknown[]).length <= 300,
			selectedTaskId: eitherNull((x) => typeof x === "string" && /^endo\.task\.[0-9a-f]{32}$/.test(x)),
		})
	)
		return null;
	const view = v as unknown as EndoDevelopWorkspaceViewV1;
	// Coherence the renderers rely on: a ready workspace names its project; the others have no tasks; the ids are unique; a selection is a task shown.
	if ((view.state === "ready") !== (view.project !== null)) return null;
	if (view.state !== "ready" && (view.tasks.length > 0 || view.writable || view.selectedTaskId !== null)) return null;
	if (view.writable && (view.state !== "ready" || view.readOnlyReason !== null || view.project?.launch !== "same"))
		return null;
	if (!view.writable && view.readOnlyReason === null) return null;
	if (view.linkable && !view.writable) return null;
	if (new Set(view.tasks.map((t) => t.id)).size !== view.tasks.length) return null;
	if (view.selectedTaskId !== null && !view.tasks.some((t) => t.id === view.selectedTaskId)) return null;
	for (const t of view.tasks) if (view.project !== null && t.projectId !== view.project.id) return null;
	return view;
}

/** A workbench started without `--project` answers the workspace route with one constant. */
export const isNoWorkspace = (v: unknown): boolean =>
	typeof v === "object" &&
	v !== null &&
	Object.keys(v).sort().join() === "available,schemaVersion" &&
	(v as { available: unknown }).available === false &&
	(v as { schemaVersion: unknown }).schemaVersion === WORKSPACE_SCHEMA;

/** What the page may ask. The task id and the revision come from a view the page holds; nothing else (no project, path, session or launch) is ever sent. */
export type WorkspaceRequest =
	| { kind: "read" }
	| { kind: "create"; title: string; description: string; acceptance: string }
	| { kind: "update"; taskId: string; revision: number; title?: string; description?: string; acceptance?: string }
	| { kind: "status"; taskId: string; revision: number; to: EndoDevelopTaskStatusV0; note: string }
	| { kind: "select"; taskId: string | null }
	| { kind: "link"; taskId: string; revision: number }
	| { kind: "unlink"; taskId: string; revision: number; linkId: string };

export type WorkspaceRefusal =
	| "grant-required"
	| "read-only"
	| "stale-revision"
	| "invalid-transition"
	| "bad-request"
	| "not-found"
	| "limit-reached"
	| "no-session"
	| "unreadable"
	| "busy"
	| "storage-failed"
	| "unavailable"
	| "invalid"
	| "unreachable"
	| "other";

export type WorkspaceReply =
	| { kind: "workspace"; record: EndoDevelopWorkspaceViewV1 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: WorkspaceRefusal };

export type { EndoDevelopSessionRefViewV1, EndoDevelopStatusChangeV0, EndoDevelopTaskViewV1 };
