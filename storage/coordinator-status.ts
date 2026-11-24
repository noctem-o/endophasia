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
import type { EndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import { ENDO_COORDINATOR_DEFAULT_STALE_AFTER_MS_V0 } from "../protocol/coordinator-status.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoCoordinatorAttentionReadV0,
	endoCoordinatorAttentionReadV0,
	endoCoordinatorStatusV0,
} from "../runtime/contracts/coordinator-status.ts";
import type { EndoSessionLogReadV0 } from "../runtime/contracts/develop-attempt-execution.ts";
import { endoDevelopAttentionViewV0 } from "../runtime/contracts/develop-attention.ts";
import { DevelopAttemptsStoreV0 } from "./develop-attempts.ts";
import { DevelopReceiptsStoreV0, ENDO_DEVELOP_RECEIPTS_DIRECTORY_V0 } from "./develop-receipts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "./event-store.ts";
import { checkDirectoriesSyncV0 } from "./write-once.ts";

export interface ReadEndoCoordinatorStatusOptionsV0 {
	root: string;
	/** Project ids to read; null or absent: every project in the task file. */
	projects?: readonly string[] | null;
	staleAfterMs?: number;
	now?: () => number;
	/** For tests: HEAD of a project's registered path, observed now; null when it cannot be. */
	current?: (directory: string) => Promise<EndoReceiptCurrentV0 | null>;
	budget?: {
		eventsBytes: number;
		attemptEntries: number;
		attemptBytes: number;
		receiptFiles: number;
		receiptBytes: number;
	};
	projectPath?: string;
}

/** The store's event log, opened read-only and read whole (the same read as cli/develop-service.ts, without importing cli/). */
function readEventLogReadOnly(root: string, maxReadBytes?: number): EndoSessionLogReadV0 {
	if (maxReadBytes !== undefined && checkDirectoriesSyncV0([join(root, "events")]) !== "ok")
		return { state: "unavailable" };
	if (!existsSync(join(root, "events", "events.log"))) return { state: "unavailable" };
	let store: ReturnType<typeof createEndoDurableEventStoreV0>;
	try {
		store = createEndoDurableEventStoreV0(root, {
			readOnly: true,
			...(maxReadBytes === undefined ? {} : { maxReadBytes }),
		});
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

/** One status reading of `root`, now. Read-only; see the header. */
export async function readEndoCoordinatorStatusV0(
	options: ReadEndoCoordinatorStatusOptionsV0,
): Promise<EndoCoordinatorStatusV0> {
	const now = options.now ?? Date.now;
	const current = options.current ?? (async () => null);
	const root = options.root;
	const tasksStore = new DevelopTasksStoreV0(root);
	const attemptsStore = new DevelopAttemptsStoreV0(root);
	const budget = options.budget;
	const receiptsStore = new (class extends DevelopReceiptsStoreV0 {
		override readAtMost(...args: Parameters<DevelopReceiptsStoreV0["readAtMost"]>) {
			try {
				return super.readAtMost(...args);
			} catch (error) {
				if (!(error instanceof Error) || !("syscall" in error) || error.syscall !== "lstat") throw error;
				return { ok: false as const, reason: "io" as const };
			}
		}
	})(root, { boundDirectoryReads: budget !== undefined });
	const tasks = tasksStore.read();
	const requested = options.projects === undefined || options.projects === null ? null : [...options.projects];
	if (budget !== undefined && requested?.length !== 1)
		throw new TypeError("bounded coordinator reads need one project");
	if (
		options.projectPath !== undefined &&
		tasks.ok &&
		tasks.file.projects.some((project) => requested?.includes(project.id) && project.path !== options.projectPath)
	)
		throw new TypeError("coordinator project scope changed");
	const attempts = attemptsStore.read(
		budget === undefined ? undefined : { entries: budget.attemptEntries, bytes: budget.attemptBytes },
	);
	const events = readEventLogReadOnly(root, budget?.eventsBytes);
	const verificationAttempts = attempts.ok
		? {
				...attempts,
				problems: attempts.problems.filter(
					(p) => p.reason !== "unknown-file" || ENDO_ATTEMPT_ID_PATTERN_V0.test(p.name.split(".", 3).join(".")),
				),
			}
		: { ok: false as const, reason: "io" as const };
	const attentionAttempts = new (class extends DevelopAttemptsStoreV0 {
		override read() {
			return verificationAttempts;
		}
	})(root);
	const attentionTasks = new (class extends DevelopTasksStoreV0 {
		override read() {
			return tasks;
		}
	})(root);
	const attention = new Map<string, EndoCoordinatorAttentionReadV0>();
	if (tasks.ok)
		for (const project of tasks.file.projects) {
			if (requested !== null && !requested.includes(project.id)) continue;
			const head = await current(project.path).catch(() => null);
			const observedAtMs = now();
			const view = endoDevelopAttentionViewV0(
				{ tasks: attentionTasks, attempts: attentionAttempts, receipts: receiptsStore },
				{ projectId: project.id, launchId: "coordinator-status" },
				head,
				budget === undefined
					? undefined
					: { maxReceiptFiles: budget.receiptFiles, maxReceiptBytes: budget.receiptBytes },
			);
			attention.set(project.id, endoCoordinatorAttentionReadV0(view, observedAtMs));
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
