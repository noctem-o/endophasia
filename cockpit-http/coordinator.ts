import { realpathSync } from "node:fs";
import { validateEndoCoordinatorCoordinationV0 } from "../protocol/coordinator-coordination.ts";
import { validateEndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import { validateEndoCoordinatorStudioOperationsV0 } from "../protocol/coordinator-studio-operations.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import { readEndoCoordinatorCoordinationV0 } from "../storage/coordinator-coordination.ts";
import { readEndoCoordinatorStatusV0 } from "../storage/coordinator-status.ts";
import { readEndoCoordinatorStudioOperationsV0 } from "../storage/coordinator-studio-operations.ts";
import {
	primaryGitCommonDirSyncV0,
	revalidateRegisteredSiblingPointerSyncV0,
} from "../storage/git-worktree-pointer.ts";

const real = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

export class EndoCockpitCoordinatorV0 {
	#busy = false;
	#coordinationBusy = false;
	#operationsBusy = false;

	async read(
		root: string,
		project: { id: string; path: string; observedGitRoot: string | null },
		observe: EndoCoordinatorHeadV0,
	) {
		if (this.#busy) return { status: 429, body: { error: "too-many-requests" } };
		this.#busy = true;
		try {
			const status = await readEndoCoordinatorStatusV0({
				root,
				projects: [project.id],
				projectPath: project.path,
				current: async (directory) => {
					if (project.observedGitRoot === null) return null;
					const head = await observe(directory);
					return head?.worktree === project.observedGitRoot ? head : null;
				},
				budget: {
					eventsBytes: 4 * 1024 * 1024,
					attemptEntries: 512,
					attemptBytes: 8 * 1024 * 1024,
					receiptFiles: 256,
					receiptBytes: 4 * 1024 * 1024,
				},
			});
			for (const project of status.projects)
				for (const task of project.tasks)
					for (const result of task.verification.results) result.command = "Command arguments withheld";
			const body = validateEndoCoordinatorStatusV0(status);
			if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
				return { status: 503, body: { error: "unavailable" } };
			return { status: 200, body };
		} catch {
			return { status: 503, body: { error: "unavailable" } };
		} finally {
			this.#busy = false;
		}
	}

	/**
	 * Read-only companion coordination projection for one paired project (`endo.coordinator-coordination.v0`, E2-F).
	 * Observes ONLY the project's primary checkout and explicitly registered sibling worktrees (never following
	 * symlinks or unregistered `.git` pointers). Writes nothing and grants nothing.
	 */
	async readCoordination(
		root: string,
		project: { id: string; path: string; observedGitRoot: string | null },
		observe: EndoCoordinatorHeadV0,
	) {
		if (this.#coordinationBusy) return { status: 429, body: { error: "too-many-requests" } };
		this.#coordinationBusy = true;
		try {
			const primaryReal = real(project.path);
			let cachedPrimaryCommonDir: string | null | undefined;
			const resolvePrimaryCommonDir = async (): Promise<string | null> => {
				if (cachedPrimaryCommonDir !== undefined) return cachedPrimaryCommonDir;
				if (project.observedGitRoot === null || primaryReal === null) {
					cachedPrimaryCommonDir = null;
					return null;
				}
				const syncDir = primaryGitCommonDirSyncV0(primaryReal);
				if (syncDir !== null) {
					cachedPrimaryCommonDir = syncDir;
					return syncDir;
				}
				const head = await observe(primaryReal);
				cachedPrimaryCommonDir = head?.worktree === project.observedGitRoot ? head.commonDir : null;
				return cachedPrimaryCommonDir;
			};
			const projection = await readEndoCoordinatorCoordinationV0({
				root,
				projects: [project.id],
				workspace: async (directory) => {
					if (project.observedGitRoot === null || primaryReal === null) return null;
					if (directory !== primaryReal) return null;
					const head = await observe(directory);
					if (head?.worktree === project.observedGitRoot) {
						cachedPrimaryCommonDir = head.commonDir;
						return head;
					}
					return null;
				},
				registeredWorktree: async (wt) => {
					if (wt.projectId !== project.id) return null;
					const primaryCommonDir = await resolvePrimaryCommonDir();
					if (primaryCommonDir === null) return null;
					// Validate canonical path, `.git` pointer, `<commonDir>/worktrees/` containment, bidirectional
					// `<gitDir>/gitdir`, `<gitDir>/commondir`, and exact `gitDir`/`commonDir` BEFORE invoking `git`.
					const checked = revalidateRegisteredSiblingPointerSyncV0(wt, primaryCommonDir);
					if (!checked.ok) return null;
					const head = await observe(wt.worktreePath);
					if (head === null || head.worktree !== wt.worktreePath || head.commonDir !== primaryCommonDir)
						return null;
					return head;
				},
				budget: {
					attemptEntries: 512,
					attemptBytes: 8 * 1024 * 1024,
					receiptFiles: 256,
					receiptBytes: 4 * 1024 * 1024,
					reviewFiles: 256,
					reviewBytes: 2 * 1024 * 1024,
					eventsBytes: 4 * 1024 * 1024,
				},
			});
			const body = validateEndoCoordinatorCoordinationV0(projection);
			if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
				return { status: 503, body: { error: "unavailable" } };
			return { status: 200, body };
		} catch {
			return { status: 503, body: { error: "unavailable" } };
		} finally {
			this.#coordinationBusy = false;
		}
	}

	/**
	 * Strictly project-scoped, lock-free, read-only operational projection (`endo.coordinator-studio-operations.v0`, F1).
	 * Reads recorded S1 resources, S1 store observation schedules, and authorized-project S2 schedules/history/proposals.
	 * Never wakes a model, probes an endpoint, executes a schedule, or mutates store state.
	 */
	async readOperations(root: string, project: { id: string; path: string; observedGitRoot: string | null }) {
		if (this.#operationsBusy) return { status: 429, body: { error: "too-many-requests" } };
		this.#operationsBusy = true;
		try {
			// Yield once so concurrent overlapping /operations requests observe `#operationsBusy` and receive 429 (S1).
			await new Promise<void>((resolve) => setImmediate(resolve));
			const projection = readEndoCoordinatorStudioOperationsV0({
				root,
				projectId: project.id,
			});
			const body = validateEndoCoordinatorStudioOperationsV0(projection);
			if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
				return { status: 503, body: { error: "unavailable" } };
			return { status: 200, body };
		} catch {
			return { status: 503, body: { error: "unavailable" } };
		} finally {
			this.#operationsBusy = false;
		}
	}
}

export type EndoCoordinatorHeadV0 = (path: string) => Promise<EndoReceiptCurrentV0 | null>;
