import { fileURLToPath } from "node:url";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import { readEndoCoordinatorCoordinationV0 } from "../../storage/coordinator-coordination.ts";
import { readEndoCoordinatorStatusV0 } from "../../storage/coordinator-status.ts";

export const coordinatorStatusWorkerPathV0 = fileURLToPath(import.meta.url);

const BUDGET = {
	eventsBytes: 8 * 1024 * 1024,
	attemptEntries: 1_024,
	attemptBytes: 4 * 1024 * 1024,
	receiptFiles: 1_024,
	receiptBytes: 8 * 1024 * 1024,
};

function parse(argv: readonly string[]) {
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
	return { root, id, path, head };
}

export async function projectStatusWorkerV0(argv: readonly string[]) {
	const { root, id, path, head } = parse(argv);
	return readEndoCoordinatorStatusV0({
		root,
		projects: [id],
		projectPath: path,
		current: async (directory) => (directory === path ? head : null),
		budget: BUDGET,
	});
}

/**
 * The companion coordination projection, inside the same sandbox: the descriptor-pinned `develop/coordination.json` (when it exists), the
 * pinned task file, attempts and receipts. No Git and no protected run directory is reachable here, so every candidate's identity reads
 * `unavailable` (with the gaps saying why) and route reservations read `unknown`; the one worktree HEAD known is the host's observation
 * of the project's own path. Nothing here establishes liveness.
 */
export async function projectCoordinationWorkerV0(argv: readonly string[]) {
	const { root, id, head } = parse(argv);
	return readEndoCoordinatorCoordinationV0({
		root,
		projects: [id],
		workspace: async (directory) => (head !== null && directory === head.worktree ? head : null),
		routes: "unknown",
		budget: {
			attemptEntries: BUDGET.attemptEntries,
			attemptBytes: BUDGET.attemptBytes,
			receiptFiles: BUDGET.receiptFiles,
			receiptBytes: BUDGET.receiptBytes,
		},
		gaps: ["git-unavailable", "protected-runs-unavailable"],
	});
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const coordinatorStatus = await projectStatusWorkerV0(argv);
	const coordinatorCoordination = await projectCoordinationWorkerV0(argv);
	process.stdout.write(
		canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorStatus, coordinatorCoordination }))),
	);
}
