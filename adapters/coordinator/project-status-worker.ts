import { fileURLToPath } from "node:url";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import { readEndoCoordinatorStatusV0 } from "../../storage/coordinator-status.ts";

export const coordinatorStatusWorkerPathV0 = fileURLToPath(import.meta.url);

export async function projectStatusWorkerV0(argv: readonly string[]) {
	const [root, id, path, commit, worktree, commonDir, clean] = argv;
	if (
		argv.length !== 7 ||
		!root?.startsWith("/") ||
		id === undefined ||
		!ENDO_PROJECT_ID_PATTERN_V0.test(id) ||
		!path?.startsWith("/") ||
		(commit === "" && (worktree !== "" || commonDir !== "" || clean !== "")) ||
		(commit !== "" &&
			(commit === undefined ||
				!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) ||
				!worktree?.startsWith("/") ||
				!commonDir?.startsWith("/") ||
				(clean !== "yes" && clean !== "no")))
	)
		throw new TypeError("invalid scope or HEAD observation");
	const head: EndoReceiptCurrentV0 | null =
		commit === "" ? null : { commit: commit!, worktree: worktree!, commonDir: commonDir!, clean: clean === "yes" };
	return readEndoCoordinatorStatusV0({
		root,
		projects: [id],
		projectPath: path,
		current: async (directory) => (directory === path ? head : null),
		budget: {
			eventsBytes: 8 * 1024 * 1024,
			attemptEntries: 1_024,
			attemptBytes: 4 * 1024 * 1024,
			receiptFiles: 1_024,
			receiptBytes: 8 * 1024 * 1024,
		},
	});
}

if (import.meta.main) {
	const coordinatorStatus = await projectStatusWorkerV0(process.argv.slice(2));
	process.stdout.write(canonicalEndoJsonV0({ coordinatorStatus }));
}
