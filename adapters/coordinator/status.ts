import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	type EndophasiaExternalStatusV0,
	type EndophasiaStatusConfigV0,
	execEndophasiaV0,
	externalEndophasiaStatusV0,
} from "../../integrations/openclaw-endophasia-status/src/status-reader.ts";
import { validateEndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";
import { coordinatorStatusWorkerPathV0 } from "./project-status-worker.ts";

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
	if (
		/\b(?:or|consider|should|could|suggest)\s+(?:the operator\s+)?(?:grant|enable|add)\s+(?:a |the )?(?:shell|exec)\b/i.test(
			answer,
		)
	)
		return "tool-expansion-suggested" as const;
	if (
		view.sources.events.state !== "ready" &&
		/\bno (?:agent-reported activity or observed session |agent-reported |observed session |session )?activity (?:is |was )?recorded\b/i.test(
			answer,
		)
	)
		return "event-absence-unestablished" as const;
	if (
		view.projects.some((project) =>
			project.tasks.some(
				({ verification }) =>
					verification.incomplete || ["unavailable", "not-read", "not-current"].includes(verification.state),
			),
		) &&
		/\b(?:(?:zero|no) (?:verification |passing |failing )?(?:result|receipt|check|failure)s? (?:(?:is |was |were |are |has been |have been )?recorded|on file|exists?|ran)|no recorded (?:pass\/fail|checks?|receipts?))\b/i.test(
			answer,
		)
	)
		return "receipt-absence-unestablished" as const;
	return null;
}

export async function projectStatusCommandV0(root: string, id: string) {
	try {
		const store = resolve(root);
		const source = new DevelopTasksStoreV0(store).read();
		if (!source.ok || !source.exists) return { ok: false, reason: "tasks-unavailable" } as const;
		const project = source.file.projects.find((p) => p.id === id);
		if (project === undefined) return { ok: false, reason: "project-not-registered" } as const;
		const worker = coordinatorStatusWorkerPathV0;
		const codeRoot = realpathSync(resolve(dirname(worker), "../.."));
		const projectRoot = existsSync(project.path) ? realpathSync(project.path) : resolve(project.path);
		const mount = [
			codeRoot,
			...["develop", "events"].flatMap((name) => {
				const path = join(store, name);
				const stat = lstatSync(path, { throwIfNoEntry: false });
				if (stat === undefined) return [];
				if (!stat.isDirectory()) throw new TypeError("status source directory is not plain");
				return [path];
			}),
		];
		if (
			mount.some((path) => contains(realpathSync(path), projectRoot) || contains(projectRoot, realpathSync(path))) ||
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
		const mounts = mount.flatMap((path) => ["--ro-bind", path, path]);
		const args = coordinatorBwrapV0(mounts, [
			worker,
			store,
			id,
			project.path,
			head?.commit ?? "",
			head?.worktree ?? "",
			head?.commonDir ?? "",
			head === null ? "" : head.dirty.length === 0 ? "yes" : "no",
		]);
		return {
			ok: true,
			project,
			worker,
			store,
			mounts,
			command: { file: "/usr/bin/bwrap", args, env: COORDINATOR_ENV_V0 },
		} as const;
	} catch {
		return { ok: false, reason: "invalid-attachment" } as const;
	}
}

export async function readCoordinatorBriefStatusV0(root: string, id: string) {
	const prepared = await projectStatusCommandV0(root, id);
	if (!prepared.ok) return prepared;
	try {
		const ran = await execEndophasiaV0(prepared.command, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
		if (ran.error !== null || ran.code !== 0) return { ok: false, reason: ran.error ?? "exited-nonzero" } as const;
		const status = validateEndoCoordinatorStatusV0(JSON.parse(ran.stdout).coordinatorStatus);
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
		for (const project of view.projects) {
			for (const task of project.tasks) {
				if (task.verification.state !== "no-checks") continue;
				const canonicalTask = status.projects[0]?.tasks.find((candidate) => candidate.taskId === task.taskId);
				const verification = canonicalTask?.verification;
				if (verification && "receiptReadComplete" in verification && verification.receiptReadComplete === true)
					continue;
				task.verification = {
					...task.verification,
					state: "unavailable",
					freshness: "incomplete",
					incomplete: true,
				};
				task.gaps = [...task.gaps.filter((gap) => gap !== "no-check-recorded"), "receipt-coverage-not-established"];
			}
		}
		return {
			ok: true as const,
			view,
			evidence: {
				readAtMs: status.readAtMs,
				projectionSha256: sha256HexV0(canonicalEndoJsonV0(status)),
				modelViewSha256: sha256HexV0(canonicalEndoJsonV0(view)),
			},
		};
	} catch {
		return { ok: false, reason: "invalid-status" } as const;
	}
}
