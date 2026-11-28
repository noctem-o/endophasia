// The DEVELOP workspace service as a host process builds it: the task file, the work attempts and their verification receipts in one store
// root, receipts compared with a directory's HEAD by the read-only Git revision observer. Shared by both hosts of the workspace routes,
// `endo harness attach --workbench` (cli/workbench.ts) and `endo workspace open` (cli/workspace.ts), so the two read the same records the
// same way. Nothing here runs a check, writes a receipt or reaches a harness.

import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { gitStateReaderV0 } from "../adapters/git/state-observer.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import type { EndoSessionLogReadV0 } from "../runtime/contracts/develop-attempt-execution.ts";
import { DevelopObservationsServiceV0 } from "../runtime/contracts/develop-observations.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopObservationsStoreV0 } from "../storage/develop-observations.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { readEndoLegacySessionLogV0 } from "../storage/event-store-read.ts";
import { endoVersionV0 } from "./help.ts";

/**
 * The store's event log, opened READ-ONLY (nothing is created, cut or repaired) and read whole, for the attempt-execution view
 * (docs/designs/develop-attempt-execution.md). A torn tail (an append in progress in the attached process, or damage) or a frame that failed
 * verification gives the verified prefix as `partial`; an absent or unopenable log is `unavailable`. Called only when an attempt that was
 * authorised to be sent is being shown.
 */
export function endoSessionLogV0(root: string): EndoSessionLogReadV0 {
	return readEndoLegacySessionLogV0(root);
}

/** A directory's HEAD for comparing receipts with, observed now (read-only Git); null when it cannot be. */
export async function endoReceiptCurrentV0(directory: string): Promise<EndoReceiptCurrentV0 | null> {
	const seen = await new GitRevisionObserverV0().observe(directory, { within: true });
	if (!seen.ok) return null;
	const o = seen.observation;
	return { worktree: o.worktree, commonDir: o.commonDir, commit: o.commit, clean: o.dirty.length === 0 };
}

/**
 * The attempt observations over `root` (docs/designs/develop-candidate-provenance.md), with the read-only Git state reader. `timeoutMs`
 * bounds one observation (the workbench gives a shorter one before a send, so a slow tree never holds an approved send for long).
 */
export function endoDevelopObservationsV0(
	root: string,
	options: { timeoutMs?: number } = {},
): DevelopObservationsServiceV0 {
	return new DevelopObservationsServiceV0(
		new DevelopTasksStoreV0(root),
		new DevelopAttemptsStoreV0(root),
		new DevelopObservationsStoreV0(root),
		{
			reader: gitStateReaderV0(new GitRevisionObserverV0()),
			version: endoVersionV0(),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		},
	);
}

/** The service over `root`'s task file, with its attempts and their receipts read-only beside it. */
export function endoDevelopServiceV0(root: string): DevelopWorkspaceServiceV0 {
	return new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), {
		// The work attempts, read-only here: the page sees the selected task's attempts and briefs; it cannot make or record one.
		attempts: new DevelopAttemptsStoreV0(root),
		// Their verification receipts, read-only, compared with the HEAD of the launch's own directory. Nothing here runs a check.
		receipts: { store: new DevelopReceiptsStoreV0(root), current: endoReceiptCurrentV0 },
		// The session log, read-only, for attempts that were authorised to be sent to Pi: what their sessions recorded. Nothing is written.
		sessionLog: () => endoSessionLogV0(root),
		// What Git showed around each attempt, read-only, compared with the launch's own directory. Nothing here records an observation.
		observations: endoDevelopObservationsV0(root),
	});
}
