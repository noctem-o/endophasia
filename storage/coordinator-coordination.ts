// Read-only gatherer for the companion coordination projection (`endo.coordinator-coordination.v0`). Reads the task file,
// the coordination file, the attempt records, the receipts of attempts in scope, project-scoped advisory reviews (E2-D),
// and (on the host only) route reservations and adapter authorizations (E2-A), asks the CALLER to re-verify candidates
// and observe registered worktrees, and hands everything to the pure projection (runtime/contracts/develop-coordination.ts).
//
// Strictly read-only: writes zero files, creates zero directories, takes no lock (a reader never waits on a writer and
// never holds one), starts no process itself. Each file is one atomic snapshot; nothing makes the files consistent WITH
// each other, which the projection states (`basis.consistency: per-file-snapshot`). Storage reaches no adapter: Git and
// protected-run re-verification are injected.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	EndoCandidateIdentityReadingV0,
	EndoCoordinationGapV0,
	EndoCoordinatorCoordinationV0,
} from "../protocol/coordinator-coordination.ts";
import type { EndoCandidateRefV0, EndoRegisteredWorktreeV0 } from "../protocol/develop-coordination.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoCoordinationProjectionInputV0,
	type EndoCoordinationProjectReviewsInputV0,
	type EndoCoordinationSessionActivityInputV0,
	type EndoCoordinationTaskFactV0,
	type EndoReceiptSourceV0,
	endoCoordinationProjectionV0,
	endoRouteEvidenceForAttemptV0,
} from "../runtime/contracts/develop-coordination.ts";
import { DevelopAdapterAuthorizationsStoreV0 } from "./develop-adapter-authorizations.ts";
import { DevelopAttemptRoutesStoreV0 } from "./develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0 } from "./develop-attempts.ts";
import { DevelopCoordinationStoreV0, type EndoCoordinationReadV0 } from "./develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "./develop-coordination-reviews.ts";
import { DevelopReceiptsStoreV0 } from "./develop-receipts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "./event-store.ts";
import { checkDirectoriesSyncV0 } from "./write-once.ts";

export interface ReadEndoCoordinatorCoordinationOptionsV0 {
	root: string;
	/** Project ids to read; null: every registered project. A bounded (sandboxed) read must name exactly one. */
	projects: readonly string[] | null;
	now?: () => number;
	/** Re-verify one candidate now (Git commit/tree, or the protected association). Absent: every candidate reads `unavailable`. */
	identity?: (candidate: EndoCandidateRefV0) => Promise<EndoCandidateIdentityReadingV0>;
	/** The live HEAD of a worktree path, observed now; null when it cannot be. Absent: no worktree is observed. */
	workspace?: (path: string) => Promise<EndoReceiptCurrentV0 | null>;
	/** Optional strict observer for explicitly registered sibling worktrees (defaults to `workspace(wt.worktreePath)`). */
	registeredWorktree?: (worktree: EndoRegisteredWorktreeV0) => Promise<EndoReceiptCurrentV0 | null>;
	/** `unknown`: route reservations and adapter authorizations are not readable here (the sandbox does not mount them). Default: read them. */
	routes?: "read" | "unknown";
	/** `unreadable`: reviews directory was unsafe in the sandbox; otherwise read project-scoped reviews. */
	reviews?: "read" | "unreadable";
	/** An already-read coordination file (a sandbox reads its descriptor-pinned copy through the normal path; tests inject). */
	coordination?: EndoCoordinationReadV0;
	budget?: {
		attemptEntries: number;
		attemptBytes: number;
		receiptFiles: number;
		receiptBytes: number;
		reviewFiles?: number;
		reviewBytes?: number;
		eventsBytes?: number;
	};
	/** Gaps the caller knows of (for example, Git is unavailable in a sandbox). */
	gaps?: readonly EndoCoordinationGapV0[];
}

function readOfflineSessionActivity(
	root: string,
	sessionKeys: ReadonlySet<string>,
	maxEventsBytes?: number,
): Map<string, EndoCoordinationSessionActivityInputV0> {
	const result = new Map<string, EndoCoordinationSessionActivityInputV0>();
	if (sessionKeys.size === 0) return result;
	const logPath = join(root, "events", "events.log");
	if (maxEventsBytes !== undefined && checkDirectoriesSyncV0([join(root, "events")]) !== "ok") {
		for (const key of sessionKeys) {
			result.set(key, { lastRecordedAtMs: null, observedInstanceIds: [], eventsAvailable: false });
		}
		return result;
	}
	if (!existsSync(logPath)) {
		for (const key of sessionKeys) {
			result.set(key, { lastRecordedAtMs: null, observedInstanceIds: [], eventsAvailable: false });
		}
		return result;
	}
	let store: ReturnType<typeof createEndoDurableEventStoreV0> | undefined;
	try {
		store = createEndoDurableEventStoreV0(root, {
			readOnly: true,
			...(maxEventsBytes === undefined ? {} : { maxReadBytes: maxEventsBytes }),
		});
		// If the durable event log is sealed or truncated, offline session activity is incomplete and MUST NOT
		// claim `recorded-match` from a prefix (Adversarial Finding #7B).
		const recovery = store.recovery();
		if (recovery.sealed || recovery.truncated) {
			for (const key of sessionKeys) {
				result.set(key, { lastRecordedAtMs: null, observedInstanceIds: [], eventsAvailable: false });
			}
			return result;
		}
		const events: EndoEventV0[] = [];
		while (events.length < store.length) {
			const page = store.page({ afterSequence: events.length, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
		}
		const bySessionId = new Map<string, { lastRecordedAtMs: number | null; instanceIds: string[] }>();
		for (const ev of events) {
			const sid = ev.coordinates.sessionId;
			if (sid === undefined) continue;
			const at = Date.parse(ev.at);
			const atMs = Number.isFinite(at) && at >= 0 ? Math.trunc(at) : null;
			const cur = bySessionId.get(sid) ?? { lastRecordedAtMs: null, instanceIds: [] };
			if (atMs !== null && (cur.lastRecordedAtMs === null || atMs > cur.lastRecordedAtMs)) {
				cur.lastRecordedAtMs = atMs;
			}
			const payload = ev.payload as Record<string, unknown>;
			const inst =
				typeof payload.instanceId === "string" && payload.instanceId.length > 0 ? payload.instanceId : null;
			if (inst !== null && !cur.instanceIds.includes(inst)) {
				cur.instanceIds.push(inst);
			}
			bySessionId.set(sid, cur);
		}
		for (const key of sessionKeys) {
			// Session keys have format `<source>:<scope>:<id>` where `<id>` is `endo.session.*` or a native thread/session id.
			const parts = key.split(":");
			const nativeId = parts.length >= 3 ? parts.slice(2).join(":") : key;
			const source = parts[0] ?? "";
			const candidates = [
				nativeId,
				source === "codex-live" ? `endo.session.codex.${nativeId}` : "",
				source === "pi-live" ? `endo.session.pi.${nativeId}` : "",
			].filter((x) => x.length > 0);
			let matched: { lastRecordedAtMs: number | null; instanceIds: string[] } | undefined;
			for (const c of candidates) {
				matched = bySessionId.get(c);
				if (matched !== undefined) break;
			}
			result.set(key, {
				lastRecordedAtMs: matched?.lastRecordedAtMs ?? null,
				observedInstanceIds: matched?.instanceIds ?? [],
				eventsAvailable: true,
			});
		}
	} catch {
		for (const key of sessionKeys) {
			result.set(key, { lastRecordedAtMs: null, observedInstanceIds: [], eventsAvailable: false });
		}
	} finally {
		store?.close();
	}
	return result;
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

	// Project-scoped advisory reviews (E2-D): read ONLY for projects in scope.
	const reviewsStore = new DevelopCoordinationReviewsStoreV0(root);
	const reviewsMap = new Map<string, EndoCoordinationProjectReviewsInputV0>();
	const scopedProjectIds =
		options.projects !== null ? [...new Set(options.projects)] : registered === null ? [] : [...registered];
	for (const projectId of scopedProjectIds) {
		if (options.reviews === "unreadable") {
			reviewsMap.set(projectId, { ok: false });
			continue;
		}
		const reviewBudget =
			budget === undefined
				? undefined
				: { files: budget.reviewFiles ?? 256, bytes: budget.reviewBytes ?? 2 * 1024 * 1024 };
		const read = reviewsStore.readProject(projectId, reviewBudget);
		if (!read.ok) {
			if (read.reason === "too-many") gaps.add("reviews-truncated");
			reviewsMap.set(projectId, { ok: false });
		} else {
			reviewsMap.set(projectId, {
				ok: true,
				reviews: read.reviews,
				problems: read.problems.length,
				truncated: read.truncated,
			});
		}
	}

	const coordination: EndoCoordinationProjectionInputV0["coordination"] = !coordinationRead.ok
		? { state: "unreadable", reason: coordinationRead.reason }
		: coordinationRead.exists
			? { state: "ready", file: coordinationRead.file }
			: { state: "absent" };
	const identity = new Map<string, EndoCandidateIdentityReadingV0>();
	const workspaces = new Map<string, EndoReceiptCurrentV0 | null>();
	const sessionKeys = new Set<string>();
	if (coordination.state === "ready") {
		for (const wt of coordination.file.registeredWorktrees ?? []) {
			if (!scope.has(wt.projectId)) continue;
			if (!workspaces.has(wt.worktreePath)) {
				const obs =
					options.registeredWorktree !== undefined
						? await options.registeredWorktree(wt).catch(() => null)
						: options.workspace !== undefined
							? await options.workspace(wt.worktreePath).catch(() => null)
							: null;
				if (options.registeredWorktree !== undefined || options.workspace !== undefined) {
					workspaces.set(wt.worktreePath, obs);
				}
			}
		}
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
		for (const a of coordination.file.assignments) {
			if (!scope.has(a.projectId)) continue;
			if (a.session !== null) sessionKeys.add(a.session.sessionKey);
		}
	}

	const sessionActivity = readOfflineSessionActivity(root, sessionKeys, budget?.eventsBytes);
	const routes = DevelopAttemptRoutesStoreV0.forRoot(root);
	const adapterAuths = DevelopAdapterAuthorizationsStoreV0.forRoot(root);
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
		...(options.routes === "unknown" ? {} : { adapterAuthorizations: (attemptId) => adapterAuths.read(attemptId) }),
		reviews: reviewsMap,
		sessionActivity,
		identity,
		workspaces,
		gaps: [...gaps],
	});
}
