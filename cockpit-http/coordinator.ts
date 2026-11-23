import { validateEndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import { readEndoCoordinatorStatusV0 } from "../storage/coordinator-status.ts";

export class EndoCockpitCoordinatorV0 {
	#busy = false;

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
}

export type EndoCoordinatorHeadV0 = (path: string) => Promise<EndoReceiptCurrentV0 | null>;
