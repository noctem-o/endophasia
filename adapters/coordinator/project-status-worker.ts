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
	const [root, id, path, commit, worktree, commonDir, clean, ...flags] = argv;
	const allowedFlags = new Set(["unsafe-coordination", "unsafe-reviews"]);
	if (
		argv.length < 7 ||
		argv.length > 9 ||
		!flags.every((f) => allowedFlags.has(f)) ||
		new Set(flags).size !== flags.length ||
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
	return {
		root,
		id,
		path,
		head,
		unsafeCoordination: flags.includes("unsafe-coordination"),
		unsafeReviews: flags.includes("unsafe-reviews"),
	};
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
 * The companion coordination projection, inside the same sandbox: the descriptor-pinned `develop/coordination.json` (when it exists),
 * the pinned task file, attempts, receipts, and ONLY the requested project's advisory reviews. No Git and no protected run directory
 * is reachable here, so every candidate's identity reads `unavailable` (with the gaps saying why) and route reservations read `unknown`;
 * the one worktree HEAD known is the host's observation of the project's own path. Nothing here establishes liveness.
 */
export async function projectCoordinationWorkerV0(argv: readonly string[]) {
	const { root, id, head, unsafeCoordination, unsafeReviews } = parse(argv);
	return readEndoCoordinatorCoordinationV0({
		root,
		projects: [id],
		workspace: async (directory) => (head !== null && directory === head.worktree ? head : null),
		routes: "unknown",
		...(unsafeReviews ? { reviews: "unreadable" as const } : {}),
		...(unsafeCoordination ? { coordination: { ok: false as const, reason: "unsafe-path" as const } } : {}),
		budget: {
			attemptEntries: BUDGET.attemptEntries,
			attemptBytes: BUDGET.attemptBytes,
			receiptFiles: BUDGET.receiptFiles,
			receiptBytes: BUDGET.receiptBytes,
			reviewFiles: 256,
			reviewBytes: 2 * 1024 * 1024,
			eventsBytes: BUDGET.eventsBytes,
		},
		gaps: ["git-unavailable", "protected-runs-unavailable"],
	});
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const coordinatorStatus = await projectStatusWorkerV0(argv);
	const coordinatorCoordination = await projectCoordinationWorkerV0(argv).catch(() => null);
	const output = canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorStatus, coordinatorCoordination })));
	process.stdout.write(
		Buffer.byteLength(output) < 4 * 1024 * 1024
			? output
			: canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorStatus }))),
	);
}
