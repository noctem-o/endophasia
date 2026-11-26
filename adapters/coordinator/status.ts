import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type EndophasiaExternalStatusV0,
	type EndophasiaStatusConfigV0,
	externalEndophasiaStatusV0,
} from "../../integrations/openclaw-endophasia-status/src/status-reader.ts";
import {
	ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
	ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
	validateEndoCoordinatorCoordinationV0,
} from "../../protocol/coordinator-coordination.ts";
import { validateEndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";
import { coordinatorStatusWorkerPathV0 } from "./project-status-worker.ts";
import { CoordinatorStoreMountErrorV0, pinCoordinatorStoreV0 } from "./status-mounts.ts";

export const COORDINATOR_ENV_V0 = { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" };

export function coordinatorBwrapV0(mounts: readonly string[], command: readonly string[], cwd = "/") {
	const node = realpathSync(process.execPath);
	return [
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--ro-bind",
		"/usr",
		"/usr",
		...["/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache"].flatMap((path) => ["--ro-bind-try", path, path]),
		...(!node.startsWith("/usr/") ? ["--ro-bind", node, node] : []),
		"--tmpfs",
		"/tmp",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--cap-drop",
		"ALL",
		"--clearenv",
		...Object.entries(COORDINATOR_ENV_V0).flatMap(([name, value]) => ["--setenv", name, value]),
		...mounts,
		"--chdir",
		cwd,
		"--",
		node,
		...command,
	];
}

const contains = (dir: string, path: string) => {
	const rel = relative(dir, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

export function coordinatorAnswerRefusalV0(answer: string, view: EndophasiaExternalStatusV0) {
	const tasks = view.projects.flatMap((project) => project.tasks);
	const text = answer.replaceAll(/[*_`]/g, "");
	if (
		/(?<!\bnot )\b(?:grant(?:ing)?|give|allow|enable|add)\s+(?:(?:the )?coordinator\s+)?(?:a |the )?(?:shell|exec)\b/i.test(
			text,
		)
	)
		return "tool-expansion-suggested" as const;
	if (
		tasks.some(({ verification }) => verification.state === "failing") &&
		/(?<!\bno )\b(?:verification|checks?|tests?|task)(?:\s+(?:is|are|was|were|looks?|looked|came back|has been|have been|has|have))?\s+(?:(?:fully|all)\s+)?(?:clean|passing|verified|passed)\b|\b(?:HEAD|project) (?:is|was|has been) (?:fully )?verified\b|(?:^|[.!?]\s+)\s*(?:fully )?verified\b/im.test(
			text,
		)
	)
		return "verification-positive-contradiction" as const;
	if (
		view.sources.events.state !== "ready" &&
		/\bno (?:(?:agent-reported activity or observed session |agent-reported |observed session |session )?activity (?:is |was )?recorded|sessions? (?:have |has )?reported activity)|\bthere (?:has been|was|is) no session activity\b/i.test(
			text,
		)
	)
		return "event-absence-unestablished" as const;
	if (
		tasks.some(
			({ verification }) =>
				verification.incomplete || ["unavailable", "not-read", "not-current"].includes(verification.state),
		) &&
		/\b(?:(?:0|zero|no) (?:current[- ]head )?(?:verification |passing |failing )?(?:result|receipt|check|failure)s? (?:(?:is |was |were |are |has been |have been )?(?:recorded|found)|on file|exists?|ran|(?:has |have )?run|at (?:current )?HEAD)|no recorded (?:pass\/fail|checks?|receipts?))\b/i.test(
			text,
		)
	)
		return "receipt-absence-unestablished" as const;
	return null;
}

export async function projectStatusCommandV0(root: string, id: string) {
	try {
		const store = existsSync(root) ? realpathSync(root) : resolve(root);
		const source = new DevelopTasksStoreV0(store).read();
		if (!source.ok || !source.exists) return { ok: false, reason: "tasks-unavailable" } as const;
		const project = source.file.projects.find((p) => p.id === id);
		if (project === undefined) return { ok: false, reason: "project-not-registered" } as const;
		const worker = coordinatorStatusWorkerPathV0;
		const codeRoot = realpathSync(resolve(dirname(worker), "../.."));
		const projectRoot = existsSync(project.path) ? realpathSync(project.path) : resolve(project.path);
		const mount = [codeRoot, join(store, "develop"), join(store, "events")];
		if (
			mount.some((path) => contains(path, projectRoot) || contains(projectRoot, path)) ||
			contains("/usr", projectRoot) ||
			contains(projectRoot, "/usr")
		)
			return { ok: false, reason: "project-mount-overlap" } as const;
		const gitDir = join(projectRoot, ".git");
		const git = lstatSync(gitDir, { throwIfNoEntry: false });
		if (git !== undefined && (!git.isDirectory() || lstatSync(join(gitDir, "commondir"), { throwIfNoEntry: false })))
			return { ok: false, reason: "project-git-layout-refused" } as const;
		const observed = await new GitRevisionObserverV0({
			gitPath: "/usr/bin/git",
			env: { HOME: "/nonexistent" },
		}).observe(projectRoot);
		const head = observed.ok && !observed.observation.linked ? observed.observation : null;
		const snapshot = pinCoordinatorStoreV0(store, id);
		const mounts = ["--ro-bind", codeRoot, codeRoot, ...snapshot.mounts];
		let args: string[];
		try {
			args = coordinatorBwrapV0(mounts, [
				worker,
				store,
				id,
				project.path,
				head?.commit ?? "",
				head?.worktree ?? "",
				head?.commonDir ?? "",
				head === null ? "" : head.dirty.length === 0 ? "yes" : "no",
				...(snapshot.coordinationUnsafe ? ["unsafe-coordination"] : []),
				...(snapshot.reviewsUnsafe ? ["unsafe-reviews"] : []),
			]);
		} catch (error) {
			snapshot.close();
			throw error;
		}
		return {
			ok: true,
			project,
			worker,
			store,
			mounts,
			fds: snapshot.fds,
			close: snapshot.close,
			command: { file: "/usr/bin/bwrap", args, env: COORDINATOR_ENV_V0 },
		} as const;
	} catch (error) {
		if (error instanceof CoordinatorStoreMountErrorV0) return { ok: false, reason: error.reason } as const;
		return { ok: false, reason: "invalid-attachment" } as const;
	}
}

export async function readCoordinatorBriefStatusV0(root: string, id: string) {
	const prepared = await projectStatusCommandV0(root, id);
	if (!prepared.ok) return prepared;
	try {
		const ran = spawnSync(prepared.command.file, prepared.command.args, {
			env: prepared.command.env,
			stdio: ["ignore", "pipe", "pipe", ...prepared.fds],
			timeout: 20_000,
			killSignal: "SIGKILL",
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8",
		});
		const code = (ran.error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOBUFS") return { ok: false, reason: "output-too-large" } as const;
		if (code === "ETIMEDOUT") return { ok: false, reason: "timed-out" } as const;
		if (ran.error || ran.status !== 0) return { ok: false, reason: "sandbox-unavailable" } as const;
		const parsed = JSON.parse(ran.stdout) as { coordinatorStatus?: unknown; coordinatorCoordination?: unknown };
		const status = validateEndoCoordinatorStatusV0(parsed.coordinatorStatus);
		// The companion projection is held to the same disclosure rule: exactly the one project asked for, or nothing is used.
		let coordination: ReturnType<typeof validateEndoCoordinatorCoordinationV0>;
		try {
			coordination = validateEndoCoordinatorCoordinationV0(parsed.coordinatorCoordination);
			if (
				coordination.scope.requested?.length !== 1 ||
				coordination.scope.requested[0] !== id ||
				coordination.projects.some((p) => p.id !== id)
			)
				throw new TypeError("unexpected scope");
		} catch {
			coordination = validateEndoCoordinatorCoordinationV0({
				schemaVersion: ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
				readAtMs: status.readAtMs,
				authority: ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
				basis: { liveness: "not-observed", consistency: "per-file-snapshot", attribution: "unsigned-local-record" },
				scope: { requested: [id] },
				source: { state: "unreadable", reason: "invalid-companion", revision: null },
				projects: [],
				gaps: ["coordination-unreadable"],
			});
		}
		if (
			status.scope.requested?.length !== 1 ||
			status.scope.requested[0] !== id ||
			status.projects.length !== 1 ||
			status.projects[0]?.id !== id
		)
			return { ok: false, reason: "invalid-status-scope" } as const;
		const config: EndophasiaStatusConfigV0 = {
			endo: { node: process.execPath, entry: prepared.worker },
			storeRoot: prepared.store,
			projects: [{ id, root: prepared.project.path }],
		};
		const view = externalEndophasiaStatusV0(status, config);
		return {
			ok: true as const,
			view,
			// Validated and project-scoped, but NOT part of the model view in E1: the OpenClaw-facing view is unchanged.
			coordination,
			evidence: {
				readAtMs: status.readAtMs,
				projectionSha256: sha256HexV0(canonicalEndoJsonV0(status)),
				modelViewSha256: sha256HexV0(canonicalEndoJsonV0(view)),
			},
		};
	} catch {
		return { ok: false, reason: "invalid-status" } as const;
	} finally {
		prepared.close();
	}
}
