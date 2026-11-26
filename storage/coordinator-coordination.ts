// Read-only gatherer for the companion coordination projection (`endo.coordinator-coordination.v0`). Reads the task file, the
// coordination file, the attempt records, the receipts of attempts in scope and (on the host only) route reservations, asks the CALLER
// to re-verify candidates and observe worktrees, and hands everything to the pure projection (runtime/contracts/develop-coordination.ts).
//
// Strictly read-only: writes zero files, creates zero directories, takes no lock (a reader never waits on a writer and never holds one),
// starts no process itself. Each file is one atomic snapshot; nothing makes the files consistent WITH each other, which the projection
// states (`basis.consistency: per-file-snapshot`). Storage reaches no adapter: Git and protected-run re-verification are injected.

import { join } from "node:path";
import type {
	EndoCandidateIdentityReadingV0,
	EndoCoordinationGapV0,
	EndoCoordinatorCoordinationV0,
} from "../protocol/coordinator-coordination.ts";
import type { EndoCandidateRefV0 } from "../protocol/develop-coordination.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import {
	type EndoCoordinationProjectionInputV0,
	type EndoCoordinationTaskFactV0,
	type EndoReceiptSourceV0,
	endoCoordinationProjectionV0,
	endoRouteEvidenceForAttemptV0,
} from "../runtime/contracts/develop-coordination.ts";
import { DevelopAttemptRoutesStoreV0 } from "./develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0 } from "./develop-attempts.ts";
import { DevelopCoordinationStoreV0, type EndoCoordinationReadV0 } from "./develop-coordination.ts";
import { DevelopReceiptsStoreV0 } from "./develop-receipts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";

export interface ReadEndoCoordinatorCoordinationOptionsV0 {
	root: string;
	/** Project ids to read; null: every registered project. A bounded (sandboxed) read must name exactly one. */
	projects: readonly string[] | null;
	now?: () => number;
	/** Re-verify one candidate now (Git commit/tree, or the protected association). Absent: every candidate reads `unavailable`. */
	identity?: (candidate: EndoCandidateRefV0) => Promise<EndoCandidateIdentityReadingV0>;
	/** The live HEAD of a worktree path, observed now; null when it cannot be. Absent: no worktree is observed. */
	workspace?: (path: string) => Promise<EndoReceiptCurrentV0 | null>;
	/** `unknown`: route reservations are not readable here (the sandbox does not mount them). Default: read them. */
	routes?: "read" | "unknown";
	/** An already-read coordination file (a sandbox reads its descriptor-pinned copy through the normal path; tests inject). */
	coordination?: EndoCoordinationReadV0;
	budget?: { attemptEntries: number; attemptBytes: number; receiptFiles: number; receiptBytes: number };
	/** Gaps the caller knows of (for example, Git is unavailable in a sandbox). */
	gaps?: readonly EndoCoordinationGapV0[];
}

export async function readEndoCoordinatorCoordinationV0(
	options: ReadEndoCoordinatorCoordinationOptionsV0,
): Promise<EndoCoordinatorCoordinationV0> {
	const now = options.now ?? Date.now;
	const { root, budget } = options;
	if (budget !== undefined && options.projects?.length !== 1)
		throw new TypeError("bounded coordination reads need one project");
	const gaps = new Set<EndoCoordinationGapV0>(options.gaps ?? []);
	const tasksRead = new DevelopTasksStoreV0(root).read();
	const coordinationRead = options.coordination ?? new DevelopCoordinationStoreV0(root).read();
	const attemptsRead = new DevelopAttemptsStoreV0(root).read(
		budget === undefined ? undefined : { entries: budget.attemptEntries, bytes: budget.attemptBytes },
	);
	const registered = tasksRead.ok ? tasksRead.file.projects.map((p) => p.id) : null;
	const scope = new Set(options.projects ?? registered ?? []);
	const byId = new Map<string, EndoCoordinationTaskFactV0>();
	if (tasksRead.ok)
		for (const t of tasksRead.file.tasks)
			if (scope.has(t.projectId)) byId.set(t.id, { projectId: t.projectId, status: t.status, revision: t.revision });

	// Receipts of the in-scope attempts only, under one shared budget when bounded; anything short of a complete read is `ok: false`.
	const receiptsStore = new DevelopReceiptsStoreV0(root, { boundDirectoryReads: budget !== undefined });
	const receipts = new Map<string, EndoReceiptSourceV0>();
	let files = budget?.receiptFiles ?? 0;
	let bytes = budget?.receiptBytes ?? 0;
	if (attemptsRead.ok)
		for (const entry of attemptsRead.entries) {
			if (!scope.has(entry.attempt.projectId)) continue;
			const id = entry.attempt.id;
			if (budget === undefined) {
				const read = receiptsStore.read(id);
				receipts.set(
					id,
					read.ok ? { ok: true, receipts: read.receipts, problems: read.problems.length } : { ok: false },
				);
				continue;
			}
			let read: ReturnType<DevelopReceiptsStoreV0["readAtMost"]>;
			try {
				read = receiptsStore.readAtMost(id, { files: Math.max(files, 0), bytes: Math.max(bytes, 0) });
			} catch {
				read = { ok: false, reason: "io" };
			}
			if (!read.ok) {
				if (read.reason === "too-many") gaps.add("receipts-truncated");
				receipts.set(id, { ok: false });
				continue;
			}
			files -= read.enumerated ?? read.receipts.length + read.problems.length;
			bytes -= read.bytes ?? 0;
			receipts.set(id, { ok: true, receipts: read.receipts, problems: read.problems.length });
		}

	const coordination: EndoCoordinationProjectionInputV0["coordination"] = !coordinationRead.ok
		? { state: "unreadable", reason: coordinationRead.reason }
		: coordinationRead.exists
			? { state: "ready", file: coordinationRead.file }
			: { state: "absent" };
	const identity = new Map<string, EndoCandidateIdentityReadingV0>();
	const workspaces = new Map<string, EndoReceiptCurrentV0 | null>();
	if (coordination.state === "ready")
		for (const entry of coordination.file.taskCandidates) {
			if (!scope.has(entry.projectId)) continue;
			for (const c of entry.candidates) {
				identity.set(
					c.candidateId,
					options.identity === undefined
						? "unavailable"
						: await options.identity(c).catch(() => "unavailable" as const),
				);
				if (c.kind === "git-commit" && options.workspace !== undefined && !workspaces.has(c.worktreePath))
					workspaces.set(c.worktreePath, await options.workspace(c.worktreePath).catch(() => null));
			}
		}
	const routes = DevelopAttemptRoutesStoreV0.forRoot(root);
	const developDir = join(root, ENDO_DEVELOP_DIRECTORY_V0);
	return endoCoordinationProjectionV0({
		readAtMs: now(),
		requested: options.projects === null ? null : [...options.projects],
		registeredProjects: registered,
		coordination,
		tasks: tasksRead.ok ? { ok: true, byId } : { ok: false },
		attempts: attemptsRead.ok
			? { ok: true, entries: attemptsRead.entries, problems: attemptsRead.problems }
			: { ok: false, reason: attemptsRead.reason },
		receipts: (attemptId) => receipts.get(attemptId) ?? { ok: false },
		route: (attemptId) => {
			if (options.routes === "unknown") return { state: "unknown", reason: "unavailable" };
			return endoRouteEvidenceForAttemptV0(developDir, routes, attemptId);
		},
		identity,
		workspaces,
		gaps: [...gaps],
	});
}
