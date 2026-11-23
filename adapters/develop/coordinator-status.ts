// Read-only adapter for COORDINATOR-STATUS-001 (docs/designs/coordinator-status.md). Reads the DEVELOP task file, the attempt records,
// the verification receipts and the event log of one store root, observes each permitted project's HEAD once with the read-only Git
// observer, and hands everything to the pure projection (runtime/contracts/coordinator-status.ts).
//
// Strictly read-only:
// - Writes zero files and creates zero directories (the event log is opened `{ readOnly: true }`; Git runs with optional locks off).
// - Never moves a task, records an observation or receipt, sends a prompt, launches or attaches to an agent, or changes an approval.
// - Never connects to the control endpoint (`<root>/control/endpoint.sock`): that is a command channel, not a status source.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { GitRevisionObserverV0 } from "../../adapters/git/revision-observer.ts";
import type { EndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import {
	ENDO_COORDINATOR_DEFAULT_STALE_AFTER_MS_V0,
	ENDO_COORDINATOR_LIMITS_V0,
} from "../../protocol/coordinator-status.ts";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import {
	type EndoCoordinatorAttentionReadV0,
	endoCoordinatorStatusV0,
} from "../../runtime/contracts/coordinator-status.ts";
import type { EndoSessionLogReadV0 } from "../../runtime/contracts/develop-attempt-execution.ts";
import { endoDevelopAttentionViewV0 } from "../../runtime/contracts/develop-attention.ts";
import { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0, ENDO_DEVELOP_RECEIPTS_DIRECTORY_V0 } from "../../storage/develop-receipts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0 } from "../../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../../storage/event-store.ts";

export interface ReadEndoCoordinatorStatusOptionsV0 {
	root: string;
	/** Project ids to read; null or absent: every project in the task file. */
	projects?: readonly string[] | null;
	staleAfterMs?: number;
	now?: () => number;
	/** For tests: HEAD of a project's registered path, observed now; null when it cannot be. */
	current?: (directory: string) => Promise<EndoReceiptCurrentV0 | null>;
}

/** The store's event log, opened read-only and read whole (the same read as cli/develop-service.ts, without importing cli/). */
function readEventLogReadOnly(root: string): EndoSessionLogReadV0 {
	if (!existsSync(join(root, "events", "events.log"))) return { state: "unavailable" };
	let store: ReturnType<typeof createEndoDurableEventStoreV0>;
	try {
		store = createEndoDurableEventStoreV0(root, { readOnly: true });
	} catch {
		return { state: "unavailable" };
	}
	try {
		const recovery = store.recovery();
		const events: EndoEventV0[] = [];
		while (events.length < store.length) {
			const page = store.page({ afterSequence: events.length, limit: 10_000 });
			if (page.events.length === 0) return { state: "unavailable" };
			events.push(...page.events);
		}
		return { state: recovery.truncated || recovery.sealed ? "partial" : "complete", events };
	} catch {
		return { state: "unavailable" };
	} finally {
		store.close();
	}
}

async function headOf(directory: string): Promise<EndoReceiptCurrentV0 | null> {
	const seen = await new GitRevisionObserverV0().observe(directory, { within: true });
	if (!seen.ok) return null;
	const o = seen.observation;
	return { worktree: o.worktree, commonDir: o.commonDir, commit: o.commit, clean: o.dirty.length === 0 };
}

export function endoCoordinatorStaleAfterV0(seconds: string): number {
	if (!/^[1-9][0-9]*$/.test(seconds)) throw new TypeError("--stale-after takes a whole number of seconds");
	const ms = Number(seconds) * 1000;
	if (ms < ENDO_COORDINATOR_LIMITS_V0.minStaleAfterMs || ms > ENDO_COORDINATOR_LIMITS_V0.maxStaleAfterMs)
		throw new TypeError("--stale-after must be between 1 second and 7 days");
	return ms;
}

/** One status reading of `root`, now. Read-only; see the header. */
export async function readEndoCoordinatorStatusV0(
	options: ReadEndoCoordinatorStatusOptionsV0,
): Promise<EndoCoordinatorStatusV0> {
	const now = options.now ?? Date.now;
	const current = options.current ?? headOf;
	const root = options.root;
	const tasksStore = new DevelopTasksStoreV0(root);
	const attemptsStore = new DevelopAttemptsStoreV0(root);
	const receiptsStore = new DevelopReceiptsStoreV0(root);
	const tasks = tasksStore.read();
	const attempts = attemptsStore.read();
	const events = readEventLogReadOnly(root);
	const requested = options.projects === undefined || options.projects === null ? null : [...options.projects];
	const attention = new Map<string, EndoCoordinatorAttentionReadV0>();
	if (tasks.ok)
		for (const project of tasks.file.projects) {
			if (requested !== null && !requested.includes(project.id)) continue;
			const head = await current(project.path).catch(() => null);
			const observedAtMs = now();
			const view = endoDevelopAttentionViewV0(
				{ tasks: tasksStore, attempts: attemptsStore, receipts: receiptsStore },
				{ projectId: project.id, launchId: "coordinator-status" },
				head,
			);
			attention.set(project.id, { view, observedAtMs });
		}
	return endoCoordinatorStatusV0({
		readAtMs: now(),
		staleAfterMs: options.staleAfterMs ?? ENDO_COORDINATOR_DEFAULT_STALE_AFTER_MS_V0,
		requested,
		tasks,
		attempts,
		events,
		attention,
		presence: {
			attempts: existsSync(attemptsStore.directory),
			receipts: existsSync(join(root, ENDO_DEVELOP_DIRECTORY_V0, ENDO_DEVELOP_RECEIPTS_DIRECTORY_V0)),
		},
	});
}
