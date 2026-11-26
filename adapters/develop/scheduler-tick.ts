// Deterministic three-phase fenced scheduler tick runner (`runEndoSchedulerTickV0`, S1-C,
// docs/designs/coordinator-automation.md Appendix B, docs/designs/coordinator-automation-s1-implementation.md).
//
// Three-phase lifecycle:
//   Phase 1 (Claim, under brief `automation.lock.<n>`):
//     - Acquire or advance durable expiring lease (`lease.json`, monotonic `epoch`).
//     - Evaluate due schedules deterministically against `claimNowMs = now()`.
//     - Apply missed-run policies (`skip-and-report` vs `coalesce-once`) in O(1) math.
//     - Create write-once `.claimed.json` (and `missed-skipped` `.outcome.json`) via `link(2)`.
//     - Advance `cursor.lastConsumedWindowStartMs` on claimed/skipped schedules.
//     - Release `automation.lock.<n>` BEFORE any I/O probes run.
//   Phase 2 (Observe, outside ALL locks):
//     - Run bounded, zero-LLM deterministic observations:
//         * M1 `probeLocalEndpointV0` for local pool members (max 16 probes, concurrency <= 4, NEVER hosted, NEVER /slots|/metrics|router /models).
//         * Read-only E2 offline session liveness (`endoOfflineSessionLivenessV0`) & coordination worktree/hazard projection (NEVER acquires `session-attachment.lock`).
//         * Read-only local event-store turn counts (`controller-ledger-estimate`, lower bound only) + operator-declared reset windows.
//         * Passive in-process host OS CPU/RAM hardware observation or injected `observeHardware` seam.
//   Phase 3 (Publish, under brief `automation.lock.<n>`):
//     - Evaluate fresh publication clock `publishNowMs = now()` (NEVER reuses Phase 1's timestamp).
//     - Verify lease holder, monotonic `epoch`, unexpired TTL, non-regressed clock, and monotonic `resources.json` epoch;
//       on mismatch, refuse with `stale-lease-epoch` and ZERO writes.
//     - Verify each claimed schedule still exists, is enabled, and matches its claimed `scheduleRevision`;
//       disabled/removed/revised schedules are recorded as `cancelled-schedule-changed` bound to their claimed revision.
//     - Atomically publish `resources.json`, write write-once `.outcome.json` records, prune old terminal fire pairs
//       (never deleting `claimed-incomplete`), and release `lease.json`.
//
// Invariants:
// - Zero LLM inference (`tokensConsumed: 0`), zero completion requests, zero hosted polling, zero credential access.
// - Zero agent dispatch, zero `.route.json` claims, zero task/coordination/worktree mutations.
// - Never acquires `tasks.lock.<n>`, `coordination.lock.<n>`, or `events/session-attachment.lock`.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { arch, cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import {
	type EndoCoordinatorModelPoolMemberV0,
	type EndoCoordinatorModelPoolV0,
	orderedCoordinatorPoolMembersV0,
} from "../../protocol/coordinator-model-pool.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_AUTOMATION_LIMITS_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
	ENDO_HOLDER_ID_PATTERN_V0,
	type EndoAllowanceStandingV0,
	type EndoAllowanceWindowObservationV0,
	type EndoDevelopAutomationLeaseV0,
	type EndoDevelopResourceDeclarationsFileV0,
	type EndoDevelopResourceObservationV0,
	type EndoDevelopScheduleFireClaimV0,
	type EndoDevelopScheduleFireOutcomeV0,
	type EndoDevelopScheduleV0,
	type EndoHardwareDeviceObservationV0,
	type EndoHardwareObservationSnapshotV0,
	type EndoObservedLocalEndpointV0,
	type EndoProjectionSummaryObservationV0,
	type EndoProviderAllowanceObservationV0,
	type EndoWorktreeObservationSummaryV0,
	validateEndoDevelopResourceObservationV0,
} from "../../protocol/develop-automation.ts";
import {
	type EndoSessionLivenessObservationV0,
	validateEndoSessionLivenessObservationV0,
} from "../../protocol/develop-session-liveness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	coordinatorModelPoolSha256V0,
	type EndoCoordinatorMemberObserverV0,
} from "../../runtime/contracts/coordinator-model-pool.ts";
import {
	endoScheduleFireIdempotencyKeyV0,
	endoScheduleTriggerCursorV0,
	evaluateEndoScheduleDueV0,
} from "../../runtime/contracts/develop-automation.ts";
import { endoOfflineSessionLivenessV0 } from "../../runtime/contracts/develop-session-liveness.ts";
import { readEndoCoordinatorCoordinationV0 } from "../../storage/coordinator-coordination.ts";
import { readEndoCoordinatorStatusV0 as readStoreCoordinatorStatusV0 } from "../../storage/coordinator-status.ts";
import {
	DevelopAutomationStoreV0,
	type EndoDevelopAutomationStoreOptionsV0,
} from "../../storage/develop-automation.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../../storage/event-store.ts";
import { checkDirectoriesSyncV0 } from "../../storage/write-once.ts";
import { probeLocalEndpointV0 } from "../coordinator/model-pool-probe.ts";

export interface EndoHardwareObserverInputV0 {
	readonly nowMs: number;
	readonly staleAfterMs: number;
	readonly localEndpoints: readonly EndoObservedLocalEndpointV0[];
	readonly signal?: AbortSignal;
}

/** Clean extension seam (S1-F) for passive hardware observation (future NVML/DRM GPU memory probes, CPU decision models). */
export type EndoHardwareObserverV0 = (
	input: EndoHardwareObserverInputV0,
) => Promise<EndoHardwareObservationSnapshotV0> | EndoHardwareObservationSnapshotV0;

export interface EndoProjectionObservationV0 {
	readonly summary: EndoProjectionSummaryObservationV0;
	readonly sessions: readonly EndoSessionLivenessObservationV0[];
	readonly worktrees: readonly EndoWorktreeObservationSummaryV0[];
}

export interface EndoSchedulerProbesV0 {
	/** Local model endpoint observer (defaults to M1's passive `probeLocalEndpointV0`). */
	readonly observeLocalMember?: EndoCoordinatorMemberObserverV0;
	/** Passive hardware observer seam (defaults to in-process `node:os` CPU/RAM only; zero subprocesses, zero GPU driver calls). */
	readonly observeHardware?: EndoHardwareObserverV0;
	/** Read-only status/coordination projection observer (defaults to lock-free store readers). */
	readonly observeProjection?: (args: {
		readonly root: string;
		readonly nowMs: number;
		readonly includeStatusHash: boolean;
		readonly signal?: AbortSignal;
	}) => Promise<EndoProjectionObservationV0>;
	/** Optional live controller adapter observations (defaults to `[]`, relying on offline projections). */
	readonly observeLiveAdapters?: () => readonly EndoSessionLivenessObservationV0[];
	/** Optional read-only provider turn-count lower bound extractor (defaults to read-only event log scan). */
	readonly observeLocalTurnLedger?: (args: {
		readonly root: string;
		readonly nowMs: number;
	}) => ReadonlyMap<string, number>;
}

/** Deterministic lifecycle hooks for multi-process & crash-boundary tests only. Never set in production. */
export interface EndoSchedulerTickHooksV0 {
	readonly afterPhase1Claim?: (info: {
		readonly leaseEpoch: number;
		readonly holderId: string;
		readonly claimedKeys: readonly string[];
	}) => void | Promise<void>;
	readonly beforePhase2Probes?: (info: {
		readonly leaseEpoch: number;
		readonly holderId: string;
	}) => void | Promise<void>;
	readonly afterPhase2Probes?: (info: {
		readonly leaseEpoch: number;
		readonly holderId: string;
	}) => void | Promise<void>;
	readonly beforePublishResources?: () => void;
	readonly afterPublishResources?: () => void;
	readonly beforeWriteOutcome?: (idempotencyKey: string) => void;
	readonly afterWriteOutcome?: (idempotencyKey: string) => void;
	readonly beforeReleaseLease?: () => void;
	readonly afterReleaseLease?: () => void;
}

export interface RunEndoSchedulerTickOptionsV0 {
	readonly root: string;
	/** Injectable wall clock evaluated separately at Phase 1 (claim), Phase 2 (observe), and Phase 3 (publish). */
	readonly now?: () => number;
	/** Optional validated M1 model pool to observe passively during `observe-health`. Never probes hosted members. */
	readonly pool?: EndoCoordinatorModelPoolV0 | null;
	readonly poolSource?: "file" | "m0-default" | "none";
	/** Optional model-member -> physical device attribution map (S1-F). */
	readonly deviceAttribution?: ReadonlyMap<string, string>;
	readonly leaseTtlMs?: number;
	readonly tickBudgetMs?: number;
	readonly staleAfterMs?: number;
	readonly onTimeGraceMs?: number;
	readonly maxFirePairsRetained?: number;
	readonly holderId?: string;
	readonly signal?: AbortSignal;
	readonly probes?: EndoSchedulerProbesV0;
	readonly storeOptions?: Omit<EndoDevelopAutomationStoreOptionsV0, "now">;
	readonly hooks?: EndoSchedulerTickHooksV0;
}

export type EndoSchedulerTickRefusalV0 =
	| "lock-busy"
	| "lease-held"
	| "stale-lease-epoch"
	| "unreadable"
	| "unsafe-path"
	| "storage-failed"
	| "commit-uncertain";

export type EndoSchedulerTickResultV0 =
	| {
			readonly ok: true;
			readonly schemaVersion: "endo.scheduler-tick-result.v0";
			readonly holderId: string;
			readonly leaseEpoch: number;
			readonly claimNowMs: number;
			readonly publishNowMs: number;
			readonly claimed: readonly EndoDevelopScheduleFireClaimV0[];
			readonly missedSkipped: readonly EndoDevelopScheduleFireOutcomeV0[];
			readonly outcomes: readonly EndoDevelopScheduleFireOutcomeV0[];
			readonly publishedResources: boolean;
			readonly observationDigest: string | null;
			readonly prunedFireCount: number;
			readonly tokensConsumed: 0;
	  }
	| {
			readonly ok: false;
			readonly schemaVersion: "endo.scheduler-tick-result.v0";
			readonly refusal: EndoSchedulerTickRefusalV0;
			readonly detail: string;
			readonly holderId: string;
			readonly leaseEpoch: number | null;
			readonly activeLease?: { readonly holderId: string; readonly epoch: number; readonly expiresAtMs: number };
			readonly tokensConsumed: 0;
	  };

const L = ENDO_DEVELOP_AUTOMATION_LIMITS_V0;

/** Run an async mapper over `items` with strictly bounded concurrency (`<= maxConcurrency`). */
async function mapBoundedConcurrency<T, R>(
	items: readonly T[],
	maxConcurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
		for (;;) {
			const idx = next;
			next += 1;
			if (idx >= items.length) break;
			results[idx] = await fn(items[idx]!, idx);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Default passive hardware observer (S1-F): uses ONLY in-process `node:os` memory/CPU queries.
 * Spawns zero subprocesses, makes zero GPU driver/NVML calls, and cannot wake, load, unload, or reconfigure models.
 */
export function passiveHostOsHardwareObserverV0(input: EndoHardwareObserverInputV0): EndoHardwareObservationSnapshotV0 {
	const total = Math.max(0, Math.trunc(totalmem()));
	const free = Math.max(0, Math.min(total, Math.trunc(freemem())));
	const used = Math.max(0, total - free);
	const cpuList = cpus();
	const cpuLabel = `${arch()} (${cpuList.length} logical CPUs)`.slice(0, 128);

	// Group attributed local endpoints by deviceId so shared-device contention is tracked honestly.
	const membersByDevice = new Map<string, string[]>();
	for (const ep of input.localEndpoints) {
		if (ep.deviceId === null) continue;
		const list = membersByDevice.get(ep.deviceId) ?? [];
		if (!list.includes(ep.memberId)) list.push(ep.memberId);
		membersByDevice.set(ep.deviceId, list);
	}

	const devices: EndoHardwareDeviceObservationV0[] = [];
	const cpuMembers = membersByDevice.get("cpu-host") ?? [];
	devices.push({
		deviceId: "cpu-host",
		kind: "cpu",
		backendFamily: "cpu",
		label: cpuLabel,
		memoryTotalBytes: total,
		memoryUsedBytes: used,
		memoryFreeBytes: free,
		memoryBasis: "controller-observed",
		attributedModelMemberIds: cpuMembers.slice(0, L.maxAttributedMembersPerDevice),
		sharedDeviceContention:
			cpuMembers.length > 1 ? "shared-multiple-members" : cpuMembers.length === 1 ? "none-observed" : "unknown",
		activeResourceLeaseIds: [],
		supportsCpuOnlyDecisionModel: true,
	});

	for (const [deviceId, memberIds] of membersByDevice.entries()) {
		if (deviceId === "cpu-host") continue;
		if (devices.length >= L.maxHardwareDevicesObserved) break;
		devices.push({
			deviceId,
			kind: "accelerator-unknown",
			backendFamily: null,
			label: "attributed local accelerator (memory unobserved in S1)",
			memoryTotalBytes: null,
			memoryUsedBytes: null,
			memoryFreeBytes: null,
			memoryBasis: "unknown",
			attributedModelMemberIds: memberIds.slice(0, L.maxAttributedMembersPerDevice),
			sharedDeviceContention: memberIds.length > 1 ? "shared-multiple-members" : "none-observed",
			activeResourceLeaseIds: [],
			supportsCpuOnlyDecisionModel: false,
		});
	}

	return {
		mode: "passive-host-os-only",
		observedAtMs: input.nowMs,
		staleAfterMs: input.staleAfterMs,
		devices,
	};
}

/**
 * Default read-only local event-log turn counter (strictly lower bound; NEVER acquires `session-attachment.lock`).
 */
function defaultObserveLocalTurnLedger(args: {
	readonly root: string;
	readonly nowMs: number;
}): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	const eventsDir = join(args.root, "events");
	const logPath = join(eventsDir, "events.log");
	if (checkDirectoriesSyncV0([eventsDir]) !== "ok" || !existsSync(logPath)) return counts;
	let store: ReturnType<typeof createEndoDurableEventStoreV0> | undefined;
	try {
		store = createEndoDurableEventStoreV0(args.root, {
			readOnly: true,
			maxReadBytes: 4 * 1024 * 1024,
		});
		let cursor = 0;
		while (cursor < store.length) {
			const page = store.page({ afterSequence: cursor, limit: 10_000 });
			if (page.events.length === 0) break;
			for (const ev of page.events) {
				// Count canonical live-adapter turn-start events without double-counting derived lifecycle or dispatch events (Codex P2 #1).
				if (ev.kind === "codex.turn-started") {
					counts.set("codex-subscription", (counts.get("codex-subscription") ?? 0) + 1);
				} else if (ev.kind === "agent.turn-started") {
					const sid = ev.coordinates.sessionId ?? "";
					const provider = sid.includes(".codex.")
						? "codex-subscription"
						: sid.includes(".pi.") || ev.producer.startsWith("pi")
							? "pi-harness"
							: "local-session";
					counts.set(provider, (counts.get(provider) ?? 0) + 1);
				}
			}
			cursor += page.events.length;
		}
	} catch {
		// Unreadable/oversized event log degrades cleanly to empty lower-bound counts.
	} finally {
		store?.close();
	}
	return counts;
}

/**
 * Default lock-free read-only projection observer (status + coordination + offline E2-E session liveness + worktrees).
 * Never acquires `tasks.lock.<n>`, `coordination.lock.<n>`, or `events/session-attachment.lock`, and never runs Git mutations.
 */
async function defaultObserveProjection(args: {
	readonly root: string;
	readonly nowMs: number;
	readonly includeStatusHash: boolean;
	readonly signal?: AbortSignal;
}): Promise<EndoProjectionObservationV0> {
	const gaps = new Set<string>();
	const sessions: EndoSessionLivenessObservationV0[] = [];
	const worktrees: EndoWorktreeObservationSummaryV0[] = [];
	let statusSha256: string | null = null;
	let coordinationSha256: string | null = null;
	let projectCount = 0;
	let activeAssignmentCount = 0;
	let unresolvedHazardCount = 0;

	if (args.signal?.aborted) {
		gaps.add("observation-cancelled");
		return {
			summary: {
				statusSha256,
				coordinationSha256,
				projectCount,
				activeAssignmentCount,
				unresolvedHazardCount,
				gaps: [...gaps],
			},
			sessions,
			worktrees,
		};
	}

	const MAX_PROJECTS_PER_TICK = 16;
	const COORD_BUDGET = {
		attemptEntries: 512,
		attemptBytes: 8 * 1024 * 1024,
		receiptFiles: 256,
		receiptBytes: 4 * 1024 * 1024,
		reviewFiles: 256,
		reviewBytes: 2 * 1024 * 1024,
		eventsBytes: 4 * 1024 * 1024,
	};
	const STATUS_BUDGET = {
		eventsBytes: 4 * 1024 * 1024,
		attemptEntries: 512,
		attemptBytes: 8 * 1024 * 1024,
		receiptFiles: 256,
		receiptBytes: 4 * 1024 * 1024,
	};

	const tasksRead = new DevelopTasksStoreV0(args.root).read();
	if (!tasksRead.ok) {
		gaps.add("tasks-unreadable");
	}
	const projectIds = tasksRead.ok
		? [...tasksRead.file.projects.map((p) => p.id)].sort().slice(0, MAX_PROJECTS_PER_TICK)
		: [];
	if (tasksRead.ok && tasksRead.file.projects.length > MAX_PROJECTS_PER_TICK) {
		gaps.add("projects-truncated");
	}

	try {
		const seenSessions = new Set<string>();
		const worktreeMap = new Map<
			string,
			{
				projectId: string;
				worktreePath: string;
				worktreeId: string | null;
				activeHazardCount: number;
				writeConflictCount: number;
				driftedCandidateCount: number;
			}
		>();

		if (projectIds.length === 0) {
			coordinationSha256 = sha256HexV0(
				canonicalEndoJsonV0({
					projects: [],
					tasksState: tasksRead.ok ? (tasksRead.exists ? "empty" : "absent") : "unreadable",
				}),
			);
		} else {
			// Bounded per-project coordination reads (Adversarial H1: `readEndoCoordinatorCoordinationV0` requires 1 project with budget).
			const perProjectCoords: unknown[] = [];
			for (const projectId of projectIds) {
				if (args.signal?.aborted) {
					gaps.add("observation-cancelled");
					break;
				}
				const coord = await readEndoCoordinatorCoordinationV0({
					root: args.root,
					projects: [projectId],
					now: () => args.nowMs,
					routes: "read",
					budget: COORD_BUDGET,
				});
				perProjectCoords.push(JSON.parse(JSON.stringify(coord)));
				for (const g of coord.gaps) gaps.add(g);

				for (const p of coord.projects) {
					projectCount += 1;
					for (const wt of p.registeredWorktrees ?? []) {
						const k = `${p.id}:${wt.worktreePath}`;
						worktreeMap.set(k, {
							projectId: p.id,
							worktreePath: wt.worktreePath,
							worktreeId: wt.worktreeId,
							activeHazardCount: 0,
							writeConflictCount: 0,
							driftedCandidateCount: 0,
						});
					}
					for (const a of p.assignments) {
						if (a.state === "active") activeAssignmentCount += 1;
						const hazardActive = a.hazard === "liveness-unverified";
						if (hazardActive) unresolvedHazardCount += 1;
						const k = `${p.id}:${a.workspace.worktreePath}`;
						const entry = worktreeMap.get(k) ?? {
							projectId: p.id,
							worktreePath: a.workspace.worktreePath,
							worktreeId: null,
							activeHazardCount: 0,
							writeConflictCount: 0,
							driftedCandidateCount: 0,
						};
						if (hazardActive) entry.activeHazardCount += 1;
						worktreeMap.set(k, entry);

						if (a.session !== null) {
							const sk = `${a.session.source}:${a.session.sessionKey}`;
							if (!seenSessions.has(sk) && sessions.length < L.maxSessionsObserved) {
								seenSessions.add(sk);
								sessions.push(
									endoOfflineSessionLivenessV0({
										observedAtMs: args.nowMs,
										source: a.session.source,
										harnessFamily: a.intendedHarnessFamily,
										sessionKey: a.session.sessionKey,
										attachmentId: null,
										instanceId: null,
										runtimeFingerprintId: null,
										lastRecordedAtMs: a.session.lastRecordedAtMs ?? null,
										eventsAvailable: a.session.livenessState !== "unsupported-observation",
									}),
								);
							}
						}
					}
					for (const conflict of p.conflicts) {
						const k = `${p.id}:${conflict.worktreePath}`;
						const entry = worktreeMap.get(k) ?? {
							projectId: p.id,
							worktreePath: conflict.worktreePath,
							worktreeId: null,
							activeHazardCount: 0,
							writeConflictCount: 0,
							driftedCandidateCount: 0,
						};
						entry.writeConflictCount += 1;
						worktreeMap.set(k, entry);
					}
					for (const task of p.tasks) {
						for (const cand of task.candidates) {
							if (
								cand.workspace === "dirty-at-candidate" ||
								cand.workspace === "moved-from-candidate" ||
								cand.workspace === "other-repository"
							) {
								const firstWt = [...worktreeMap.values()].find((w) => w.projectId === p.id);
								if (firstWt !== undefined) firstWt.driftedCandidateCount += 1;
							}
						}
					}
				}
			}
			coordinationSha256 = sha256HexV0(canonicalEndoJsonV0(perProjectCoords as never));
		}

		for (const entry of worktreeMap.values()) {
			if (worktrees.length >= L.maxWorktreesObserved) break;
			worktrees.push({
				...entry,
				observedAtMs: args.nowMs,
				basis: "recorded",
			});
		}
	} catch {
		gaps.add("coordination-observation-unavailable");
	}

	if (args.includeStatusHash && !args.signal?.aborted) {
		try {
			if (projectIds.length === 0) {
				statusSha256 = sha256HexV0(
					canonicalEndoJsonV0({
						projects: [],
						tasksState: tasksRead.ok ? (tasksRead.exists ? "empty" : "absent") : "unreadable",
					}),
				);
			} else {
				// Bounded per-project status reads (Adversarial H1: `readStoreCoordinatorStatusV0` requires 1 project with budget).
				const perProjectStatus: unknown[] = [];
				for (const projectId of projectIds) {
					if (args.signal?.aborted) {
						gaps.add("observation-cancelled");
						break;
					}
					const status = await readStoreCoordinatorStatusV0({
						root: args.root,
						projects: [projectId],
						now: () => args.nowMs,
						budget: STATUS_BUDGET,
					});
					perProjectStatus.push(JSON.parse(JSON.stringify(status)));
				}
				statusSha256 = sha256HexV0(canonicalEndoJsonV0(perProjectStatus as never));
			}
		} catch {
			gaps.add("status-observation-unavailable");
		}
	}

	return {
		summary: {
			statusSha256,
			coordinationSha256,
			projectCount,
			activeAssignmentCount,
			unresolvedHazardCount,
			gaps: [...gaps].slice(0, L.maxProjectionGaps),
		},
		sessions,
		worktrees,
	};
}

/** Build honest provider allowance observations from local endpoint probes, operator declarations, and local turn ledger. */
function buildProviderObservations(args: {
	readonly nowMs: number;
	readonly staleAfterMs: number;
	readonly localEndpoints: readonly EndoObservedLocalEndpointV0[];
	readonly declarations: EndoDevelopResourceDeclarationsFileV0 | null;
	readonly turnLedger: ReadonlyMap<string, number>;
}): { readonly providers: EndoProviderAllowanceObservationV0[]; readonly truncated: boolean } {
	const byProvider = new Map<string, EndoProviderAllowanceObservationV0>();
	let truncated = false;

	// Reserve one slot for controller-observed `local-inference` when local endpoints were probed so operator
	// declarations cannot starve local health reporting (Codex P2 #4).
	const reserveLocalSlot = args.localEndpoints.length > 0 ? 1 : 0;
	const maxNonLocalProviders = Math.max(0, L.maxProvidersObserved - reserveLocalSlot);

	// 1. Operator-declared windows (never promote expired reset estimate to confirmed availability).
	if (args.declarations !== null) {
		const grouped = new Map<string, (typeof args.declarations.declarations)[number][]>();
		for (const d of args.declarations.declarations) {
			const list = grouped.get(d.providerId) ?? [];
			list.push(d);
			grouped.set(d.providerId, list);
		}
		const sortedProviderIds = [...grouped.keys()].sort();
		for (const providerId of sortedProviderIds) {
			if (byProvider.size >= maxNonLocalProviders) {
				truncated = true;
				break;
			}
			const decls = grouped.get(providerId)!;
			const first = decls[0]!;
			const windows: EndoAllowanceWindowObservationV0[] = decls
				.slice(0, L.maxAllowanceWindowsPerProvider)
				.map((d) => ({
					windowKind: d.windowKind,
					standing: d.standing,
					resetAtMs: d.resetAtMs,
					resetBasis: "operator-declared",
					availabilityConfirmed: false,
					remainingEstimate: null,
					limitEstimate: null,
					unit: "unknown",
				}));
			const anyFutureExhausted = decls.some(
				(d) => d.standing === "exhausted-until-reset" && d.resetAtMs > args.nowMs,
			);
			const anyFutureApproaching = decls.some((d) => d.standing === "approaching-limit" && d.resetAtMs > args.nowMs);
			// Once an operator-declared reset window has elapsed, standing degrades to `unknown` (never confirmed `available`).
			const standing: EndoAllowanceStandingV0 = anyFutureExhausted
				? "exhausted-until-reset"
				: anyFutureApproaching
					? "approaching-limit"
					: "unknown";
			const turns = args.turnLedger.get(providerId);
			byProvider.set(providerId, {
				providerId,
				surfaceKind: first.surfaceKind,
				quotaPoolId: first.quotaPoolId,
				standing,
				basis: "operator-declared",
				observedAtMs: args.nowMs,
				staleAfterMs: args.staleAfterMs,
				windows,
				localLedgerLowerBound:
					turns === undefined
						? null
						: { recordedTurns: turns, recordedAtMs: args.nowMs, note: "local-endophasia-lower-bound-only" },
				detail:
					standing === "unknown" && decls.some((d) => d.resetAtMs <= args.nowMs)
						? "Operator-declared reset time has elapsed; availability remains unconfirmed until authoritatively observed."
						: (first.note ??
							"Operator-declared allowance window; not an authoritative provider API measurement."),
			});
		}
	}

	// 2. Local turn-ledger lower bounds for providers without operator declarations (e.g., Codex/Pi turns in local store).
	for (const [providerId, turns] of [...args.turnLedger.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (byProvider.has(providerId)) continue;
		if (byProvider.size >= maxNonLocalProviders) {
			truncated = true;
			continue;
		}
		byProvider.set(providerId, {
			providerId,
			surfaceKind: providerId.includes("subscription") ? "subscription-window" : "unknown",
			quotaPoolId: null,
			standing: "unknown",
			basis: "controller-ledger-estimate",
			observedAtMs: args.nowMs,
			staleAfterMs: args.staleAfterMs,
			windows: [],
			localLedgerLowerBound: {
				recordedTurns: turns,
				recordedAtMs: args.nowMs,
				note: "local-endophasia-lower-bound-only",
			},
			detail: "Local Endophasia turn count is a lower bound only; subscription allowance remains unknown.",
		});
	}

	// 3. Local inference compute summary from passive endpoint observations (never promotes unknown capacity to `available`).
	if (
		args.localEndpoints.length > 0 &&
		!byProvider.has("local-inference") &&
		byProvider.size < L.maxProvidersObserved
	) {
		const degraded = args.localEndpoints.some(
			(e) =>
				e.readiness === "loading" ||
				e.readiness === "saturated" ||
				e.readiness === "unhealthy" ||
				e.readiness === "unreachable" ||
				e.readiness === "probe-refused" ||
				e.readiness === "model-unavailable",
		);
		const allConfirmedReady = args.localEndpoints.every((e) => e.readiness === "ready");
		const standing: EndoAllowanceStandingV0 = degraded
			? "degraded-endpoint"
			: allConfirmedReady
				? "available"
				: "unknown";
		const sharedEndpoints = new Set(args.localEndpoints.map((e) => e.endpoint)).size < args.localEndpoints.length;
		byProvider.set("local-inference", {
			providerId: "local-inference",
			surfaceKind: "local-compute",
			quotaPoolId: sharedEndpoints ? "local-shared-endpoint" : null,
			standing,
			basis: "controller-observed",
			observedAtMs: args.nowMs,
			staleAfterMs: args.staleAfterMs,
			windows: [
				{
					windowKind: "local-vram",
					standing: standing === "degraded-endpoint" ? "degraded-endpoint" : "unknown",
					resetAtMs: null,
					resetBasis: "unknown",
					availabilityConfirmed: false,
					remainingEstimate: null,
					limitEstimate: null,
					unit: "bytes",
				},
			],
			localLedgerLowerBound: null,
			detail:
				standing === "degraded-endpoint"
					? "One or more observed local inference endpoints reported loading, saturated, unhealthy, or unreachable."
					: standing === "available"
						? "All observed local inference endpoints confirmed free capacity passively."
						: "Local endpoint health observed passively; inference capacity remains unconfirmed (zero side-effect probe policy).",
		});
	}

	return {
		providers: [...byProvider.values()].sort((a, b) =>
			a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
		),
		truncated,
	};
}

/**
 * Execute one deterministic, three-phase fenced scheduler tick (`COORDINATOR-AUTOMATION-S1`).
 *
 * Guarantees:
 * - Zero LLM inference (`tokensConsumed: 0`).
 * - Never holds `automation.lock.<n>` during Phase 2 probes.
 * - Refuses Phase 3 publication with `stale-lease-epoch` and zero writes if superseded or expired.
 * - Never mutates tasks, coordination records, `.route.json`, authorizations, worktrees, or `session-attachment.lock`.
 */
export async function runEndoSchedulerTickV0(
	options: RunEndoSchedulerTickOptionsV0,
): Promise<EndoSchedulerTickResultV0> {
	const now = options.now ?? Date.now;
	const leaseTtlMs = options.leaseTtlMs ?? L.defaultLeaseTtlMs;
	const tickBudgetMs = options.tickBudgetMs ?? L.defaultTickBudgetMs;
	const staleAfterMs = options.staleAfterMs ?? L.defaultStaleAfterMs;
	const onTimeGraceMs = options.onTimeGraceMs ?? L.defaultOnTimeGraceMs;
	const maxFirePairsRetained = options.maxFirePairsRetained ?? L.maxFirePairsRetained;

	if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < L.minLeaseTtlMs || leaseTtlMs > L.maxLeaseTtlMs)
		throw new TypeError(`leaseTtlMs must be an integer from ${L.minLeaseTtlMs} to ${L.maxLeaseTtlMs}`);
	if (!Number.isSafeInteger(tickBudgetMs) || tickBudgetMs < L.minTickBudgetMs || tickBudgetMs > L.maxTickBudgetMs)
		throw new TypeError(`tickBudgetMs must be an integer from ${L.minTickBudgetMs} to ${L.maxTickBudgetMs}`);
	if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < L.minStaleAfterMs || staleAfterMs > L.maxStaleAfterMs)
		throw new TypeError(`staleAfterMs must be an integer from ${L.minStaleAfterMs} to ${L.maxStaleAfterMs}`);
	if (!Number.isSafeInteger(onTimeGraceMs) || onTimeGraceMs < 0 || onTimeGraceMs > 86_400_000)
		throw new TypeError("onTimeGraceMs must be an integer from 0 to 86400000");
	if (
		!Number.isSafeInteger(maxFirePairsRetained) ||
		maxFirePairsRetained < 1 ||
		maxFirePairsRetained > L.maxFireDirectoryEntries
	)
		throw new TypeError(`maxFirePairsRetained must be an integer from 1 to ${L.maxFireDirectoryEntries}`);

	const holderId = options.holderId ?? `endo.tick.${process.pid}.${randomBytes(6).toString("hex")}`;
	if (!ENDO_HOLDER_ID_PATTERN_V0.test(holderId))
		throw new TypeError("holderId must be 1-128 printable ASCII characters");
	const store = new DevelopAutomationStoreV0(options.root, { ...options.storeOptions, now });

	const refuse = (
		refusal: EndoSchedulerTickRefusalV0,
		detail: string,
		leaseEpoch: number | null,
		activeLease?: { readonly holderId: string; readonly epoch: number; readonly expiresAtMs: number },
	): EndoSchedulerTickResultV0 => ({
		ok: false,
		schemaVersion: "endo.scheduler-tick-result.v0",
		refusal,
		detail,
		holderId,
		leaseEpoch,
		...(activeLease === undefined ? {} : { activeLease }),
		tokensConsumed: 0,
	});

	// ---- Phase 1: Claim (brief `automation.lock.<n>`) ----------------------------------------------------------------------------

	const phase1 = store.withAutomationLockSync((s) => {
		// Capture Phase 1 clock and monotonic start INSIDE the lock to eliminate pre-lock wait skew (Adversarial H3).
		const claimNowMs = now();
		const monotonicStartMs = performance.now();

		const schedulesRead = s.readSchedules();
		if (!schedulesRead.ok) {
			return {
				ok: false as const,
				refusal: (schedulesRead.reason === "unsafe-path"
					? "unsafe-path"
					: "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `schedules.json ${schedulesRead.reason}: ${schedulesRead.detail}`,
				leaseEpoch: null,
			};
		}
		const leaseRead = s.readLease();
		if (!leaseRead.ok) {
			return {
				ok: false as const,
				refusal: (leaseRead.reason === "unsafe-path" ? "unsafe-path" : "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `lease.json ${leaseRead.reason}: ${leaseRead.detail}`,
				leaseEpoch: null,
			};
		}
		const existingResourcesRead = s.readResources();
		if (!existingResourcesRead.ok) {
			return {
				ok: false as const,
				refusal: (existingResourcesRead.reason === "unsafe-path"
					? "unsafe-path"
					: "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `resources.json ${existingResourcesRead.reason}: ${existingResourcesRead.detail}`,
				leaseEpoch: null,
			};
		}

		const existingLease = leaseRead.exists ? leaseRead.value : null;
		// Backward-clock-jump unbrick guard (Adversarial M3): if an unreleased lease was acquired strictly further in the
		// future than maxLeaseTtlMs (e.g. RTC jumped backward by hours), the old holder can never pass Phase 3's
		// `publishNowMs < acquiredAtMs` fence; advancing epoch safely unblocks the scheduler.
		const leaseFromImpossibleFuture =
			existingLease !== null && existingLease.acquiredAtMs - claimNowMs > L.maxLeaseTtlMs;
		if (
			existingLease !== null &&
			existingLease.releasedAtMs === null &&
			claimNowMs < existingLease.expiresAtMs &&
			!leaseFromImpossibleFuture
		) {
			return {
				ok: false as const,
				refusal: "lease-held" as const,
				detail: `active duty lease held by ${existingLease.holderId} (epoch ${existingLease.epoch}) until ${existingLease.expiresAtMs}`,
				leaseEpoch: existingLease.epoch,
				activeLease: {
					holderId: existingLease.holderId,
					epoch: existingLease.epoch,
					expiresAtMs: existingLease.expiresAtMs,
				},
			};
		}

		// Acquire or advance durable lease epoch past both lease.json and resources.json (Adversarial M2).
		const existingResourcesEpoch = existingResourcesRead.exists ? existingResourcesRead.value.leaseEpoch : 0;
		const myEpoch = Math.max(existingLease?.epoch ?? 0, existingResourcesEpoch) + 1;
		const acquiredLease: EndoDevelopAutomationLeaseV0 = {
			schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
			holderId,
			epoch: myEpoch,
			acquiredAtMs: claimNowMs,
			expiresAtMs: claimNowMs + leaseTtlMs,
			releasedAtMs: null,
		};
		const leaseWrite = s.writeLease(acquiredLease);
		if (leaseWrite !== "committed") {
			return {
				ok: false as const,
				refusal: leaseWrite as EndoSchedulerTickRefusalV0,
				detail: `failed to persist lease.json (${leaseWrite})`,
				leaseEpoch: myEpoch,
			};
		}
		const releaseOnPhase1Error = (): void => {
			try {
				s.writeLease({ ...acquiredLease, releasedAtMs: claimNowMs });
			} catch {
				// best-effort rollback of our own uncommitted epoch
			}
		};

		const claimed: EndoDevelopScheduleFireClaimV0[] = [];
		const missedSkipped: EndoDevelopScheduleFireOutcomeV0[] = [];

		if (schedulesRead.exists && schedulesRead.value.schedules.length > 0) {
			const file = schedulesRead.value;
			let schedulesDirty = false;
			const updatedSchedules: EndoDevelopScheduleV0[] = [];

			const evaluatedSlice = file.schedules.slice(0, L.maxDueSchedulesPerTick);
			const untouchedTail = file.schedules.slice(L.maxDueSchedulesPerTick);

			for (const schedule of evaluatedSlice) {
				const evalResult = evaluateEndoScheduleDueV0(schedule, claimNowMs, { onTimeGraceMs });
				const triggerCursor = endoScheduleTriggerCursorV0(schedule.trigger);

				if (evalResult.kind === "missed-skip") {
					const idempotencyKey = endoScheduleFireIdempotencyKeyV0({
						scheduleId: schedule.scheduleId,
						windowStartMs: evalResult.latestMissedWindowStartMs,
						triggerCursor,
					});
					// Adversarial M5: if a prior crashed worker already linked `.claimed.json` for this exact window before
					// `schedules.json` updated, preserve the honest `claimed-incomplete` record rather than writing a conflicting
					// `missed-skipped` outcome at a different epoch.
					const priorClaim = s.readFireClaim(idempotencyKey);
					const preservePriorClaim = priorClaim.ok && priorClaim.exists;
					if (!preservePriorClaim) {
						const outcomeRecord: EndoDevelopScheduleFireOutcomeV0 = {
							schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
							idempotencyKey,
							scheduleId: schedule.scheduleId,
							scheduleRevision: schedule.revision,
							actionKind: schedule.actionKind,
							windowStartMs: evalResult.latestMissedWindowStartMs,
							completedAtMs: claimNowMs,
							leaseEpoch: myEpoch,
							holderId,
							status: "missed-skipped",
							missedWindowCount: evalResult.missedWindowCount,
							observationDigest: null,
							detail: `skipped ${evalResult.missedWindowCount} missed window(s) under skip-and-report policy`,
							tokensConsumed: 0,
						};
						const written = s.writeFireOutcomeOnce(outcomeRecord);
						if (written === "failed") {
							releaseOnPhase1Error();
							return {
								ok: false as const,
								refusal: "storage-failed" as const,
								detail: `failed to write missed-skipped outcome for ${schedule.scheduleId}`,
								leaseEpoch: myEpoch,
							};
						}
						if (written === "created") missedSkipped.push(outcomeRecord);
					}
					schedulesDirty = true;
					updatedSchedules.push({
						...schedule,
						cursor: {
							lastEvaluatedAtMs: claimNowMs,
							lastConsumedWindowStartMs: Math.max(
								schedule.cursor.lastConsumedWindowStartMs ?? 0,
								evalResult.latestMissedWindowStartMs,
							),
							completedOnce: schedule.trigger.kind === "once" ? true : schedule.cursor.completedOnce,
							lastFireIdempotencyKey: idempotencyKey,
							lastFireStatus: preservePriorClaim ? schedule.cursor.lastFireStatus : "missed-skipped",
						},
					});
					continue;
				}

				if (evalResult.kind === "due-fire") {
					// Record audit trail for earlier missed windows before an on-time window under skip-and-report.
					if (
						evalResult.missedWindowsBefore > 0 &&
						schedule.missedRunPolicy === "skip-and-report" &&
						evalResult.latestMissedBeforeWindowStartMs !== null
					) {
						const missedKey = endoScheduleFireIdempotencyKeyV0({
							scheduleId: schedule.scheduleId,
							windowStartMs: evalResult.latestMissedBeforeWindowStartMs,
							triggerCursor,
						});
						const priorMissedClaim = s.readFireClaim(missedKey);
						if (!(priorMissedClaim.ok && priorMissedClaim.exists)) {
							const missedOutcome: EndoDevelopScheduleFireOutcomeV0 = {
								schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
								idempotencyKey: missedKey,
								scheduleId: schedule.scheduleId,
								scheduleRevision: schedule.revision,
								actionKind: schedule.actionKind,
								windowStartMs: evalResult.latestMissedBeforeWindowStartMs,
								completedAtMs: claimNowMs,
								leaseEpoch: myEpoch,
								holderId,
								status: "missed-skipped",
								missedWindowCount: evalResult.missedWindowsBefore,
								observationDigest: null,
								detail: `skipped ${evalResult.missedWindowsBefore} missed window(s) prior to on-time window`,
								tokensConsumed: 0,
							};
							const mw = s.writeFireOutcomeOnce(missedOutcome);
							if (mw === "failed") {
								releaseOnPhase1Error();
								return {
									ok: false as const,
									refusal: "storage-failed" as const,
									detail: `failed to write pre-fire missed-skipped outcome for ${schedule.scheduleId}`,
									leaseEpoch: myEpoch,
								};
							}
							if (mw === "created") missedSkipped.push(missedOutcome);
						}
					}

					const idempotencyKey = endoScheduleFireIdempotencyKeyV0({
						scheduleId: schedule.scheduleId,
						windowStartMs: evalResult.windowStartMs,
						triggerCursor,
					});
					const claimRecord: EndoDevelopScheduleFireClaimV0 = {
						schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
						idempotencyKey,
						scheduleId: schedule.scheduleId,
						scheduleRevision: schedule.revision,
						actionKind: schedule.actionKind,
						triggerKind: schedule.trigger.kind,
						triggerCursor,
						windowStartMs: evalResult.windowStartMs,
						missedWindowsBefore: evalResult.missedWindowsBefore,
						claimedAtMs: claimNowMs,
						leaseEpoch: myEpoch,
						holderId,
					};
					const claimWrite = s.writeFireClaimOnce(claimRecord);
					if (claimWrite === "failed") {
						releaseOnPhase1Error();
						return {
							ok: false as const,
							refusal: "storage-failed" as const,
							detail: `failed to write fire claim for ${schedule.scheduleId}`,
							leaseEpoch: myEpoch,
						};
					}
					if (claimWrite === "created") claimed.push(claimRecord);
					// Advance cursor even on `exists` (crash recovery after prior claim before schedules.json persisted).
					schedulesDirty = true;
					updatedSchedules.push({
						...schedule,
						cursor: {
							lastEvaluatedAtMs: claimNowMs,
							lastConsumedWindowStartMs: Math.max(
								schedule.cursor.lastConsumedWindowStartMs ?? 0,
								evalResult.windowStartMs,
							),
							completedOnce: schedule.trigger.kind === "once" ? true : schedule.cursor.completedOnce,
							lastFireIdempotencyKey: idempotencyKey,
							lastFireStatus: schedule.cursor.lastFireStatus,
						},
					});
					continue;
				}

				updatedSchedules.push(schedule);
			}

			if (schedulesDirty) {
				const schedWrite = s.writeSchedules({
					...file,
					updatedAtMs: Math.max(file.updatedAtMs, claimNowMs),
					schedules: [...updatedSchedules, ...untouchedTail],
				});
				if (schedWrite !== "committed") {
					releaseOnPhase1Error();
					return {
						ok: false as const,
						refusal: schedWrite as EndoSchedulerTickRefusalV0,
						detail: `failed to persist schedule cursor update (${schedWrite})`,
						leaseEpoch: myEpoch,
					};
				}
			}
		}

		// If nothing was claimed for Phase 2 probes, prune any skipped terminal fires under the lock (Codex P2 #2)
		// and release the lease immediately.
		let phase1PrunedFireCount = 0;
		if (claimed.length === 0) {
			if (missedSkipped.length > 0) {
				phase1PrunedFireCount = s.pruneRetainedFires(maxFirePairsRetained).prunedKeys.length;
			}
			const releasedLease: EndoDevelopAutomationLeaseV0 = { ...acquiredLease, releasedAtMs: claimNowMs };
			const rel = s.writeLease(releasedLease);
			if (rel !== "committed") {
				return {
					ok: false as const,
					refusal: rel as EndoSchedulerTickRefusalV0,
					detail: `failed to release idle lease (${rel})`,
					leaseEpoch: myEpoch,
				};
			}
		}

		return {
			ok: true as const,
			claimNowMs,
			monotonicStartMs,
			leaseEpoch: myEpoch,
			acquiredLease,
			claimed,
			missedSkipped,
			phase1PrunedFireCount,
		};
	});

	if (!phase1.ok) {
		return refuse(
			phase1.code === "busy" ? "lock-busy" : phase1.code,
			`failed to acquire automation.lock (${phase1.code})`,
			null,
		);
	}
	if (!phase1.result.ok) {
		return refuse(phase1.result.refusal, phase1.result.detail, phase1.result.leaseEpoch, phase1.result.activeLease);
	}

	const {
		claimNowMs,
		monotonicStartMs,
		leaseEpoch: myEpoch,
		claimed,
		missedSkipped,
		phase1PrunedFireCount,
	} = phase1.result;

	if (claimed.length === 0) {
		return {
			ok: true,
			schemaVersion: "endo.scheduler-tick-result.v0",
			holderId,
			leaseEpoch: myEpoch,
			claimNowMs,
			publishNowMs: claimNowMs,
			claimed: [],
			missedSkipped,
			outcomes: [],
			publishedResources: false,
			observationDigest: null,
			prunedFireCount: phase1PrunedFireCount,
			tokensConsumed: 0,
		};
	}

	// ---- Phase 2: Observe (OUTSIDE ALL LOCKS) ------------------------------------------------------------------------------------

	await options.hooks?.afterPhase1Claim?.({
		leaseEpoch: myEpoch,
		holderId,
		claimedKeys: claimed.map((c) => c.idempotencyKey),
	});
	await options.hooks?.beforePhase2Probes?.({ leaseEpoch: myEpoch, holderId });

	const needsHealth = claimed.some((c) => c.actionKind === "observe-health");
	const needsProjection = claimed.some((c) => c.actionKind === "refresh-projection");

	const phase2Deadline = AbortSignal.timeout(tickBudgetMs);
	const phase2Signal =
		options.signal === undefined ? phase2Deadline : AbortSignal.any([phase2Deadline, options.signal]);
	const phase2StartMs = performance.now();

	let observationSnapshot: EndoDevelopResourceObservationV0 | null = null;
	let phase2FailureDetail: string | null = null;

	try {
		const observeNowMs = now();

		// 1. Local model pool endpoints (strictly passive via M1 `probeLocalEndpointV0`, never hosted, bounded concurrency).
		const pool = needsHealth ? (options.pool ?? null) : null;
		const poolSource = needsHealth ? (options.poolSource ?? (pool === null ? "none" : "file")) : "none";
		const poolSha256 = pool === null ? null : coordinatorModelPoolSha256V0(pool);
		let localEndpoints: EndoObservedLocalEndpointV0[] = [];

		if (needsHealth && pool !== null && !phase2Signal.aborted) {
			const localMembers: EndoCoordinatorModelPoolMemberV0[] = orderedCoordinatorPoolMembersV0(pool)
				.filter((m) => m.kind === "local-openai-compat")
				.slice(0, L.maxProbesPerTick);

			const observeMember: EndoCoordinatorMemberObserverV0 =
				options.probes?.observeLocalMember ??
				((member) => {
					const remaining = Math.max(
						1,
						Math.min(3_000, Math.floor(tickBudgetMs - (performance.now() - phase2StartMs))),
					);
					return probeLocalEndpointV0(member, { deadlineMs: remaining, signal: phase2Signal, now });
				});

			const rawObservations = await mapBoundedConcurrency(localMembers, L.maxProbeConcurrency, async (member) => {
				try {
					return await observeMember(member);
				} catch {
					return Object.freeze({
						memberId: member.memberId,
						endpoint: member.endpoint,
						modelId: member.modelId,
						basis: "controller-observed" as const,
						observedAtMs: now(),
						elapsedMs: 0,
						readiness: "unreachable" as const,
						detail: "connect-failed" as const,
						backend: "unknown" as const,
						build: null,
						requests: Object.freeze([]),
						inferenceTokens: 0 as const,
					});
				}
			});

			localEndpoints = rawObservations.slice(0, L.maxLocalEndpointsObserved).map((obs) => ({
				memberId: obs.memberId,
				endpoint: obs.endpoint,
				modelId: obs.modelId,
				basis: "controller-observed" as const,
				observedAtMs: obs.observedAtMs,
				staleAfterMs,
				elapsedMs: Math.max(0, Math.min(300_000, Math.trunc(obs.elapsedMs))),
				readiness: obs.readiness,
				detail: obs.detail,
				backend: obs.backend,
				build: obs.build,
				requests: obs.requests.slice(0, L.maxRequestsPerEndpointProbe),
				deviceId: options.deviceAttribution?.get(obs.memberId) ?? null,
				inferenceTokens: 0 as const,
			}));
		}

		// 2. Read-only projection + offline E2-E liveness + worktrees (never touches `session-attachment.lock`).
		const observeProjection = options.probes?.observeProjection ?? defaultObserveProjection;
		const projection = await observeProjection({
			root: options.root,
			nowMs: observeNowMs,
			includeStatusHash: needsProjection,
			signal: phase2Signal,
		});

		const liveAdapterObs = (options.probes?.observeLiveAdapters?.() ?? []).map((o) =>
			validateEndoSessionLivenessObservationV0(o),
		);
		const mergedSessions = [...liveAdapterObs, ...projection.sessions].slice(0, L.maxSessionsObserved);

		// 3. Operator declarations + local turn ledger lower bounds + provider allowances.
		const declRead = store.readDeclarations();
		const declarations = declRead.ok && declRead.exists ? declRead.value : null;
		const turnLedger = (options.probes?.observeLocalTurnLedger ?? defaultObserveLocalTurnLedger)({
			root: options.root,
			nowMs: observeNowMs,
		});
		const providerResult = buildProviderObservations({
			nowMs: observeNowMs,
			staleAfterMs,
			localEndpoints,
			declarations,
			turnLedger,
		});
		const providers = providerResult.providers;

		// 4. Passive hardware observation seam (S1-F).
		const observeHardware = options.probes?.observeHardware ?? passiveHostOsHardwareObserverV0;
		const hardware = await observeHardware({
			nowMs: observeNowMs,
			staleAfterMs,
			localEndpoints,
			signal: phase2Signal,
		});

		const baseProjectionSummary =
			needsProjection || projection.summary.coordinationSha256 !== null ? projection.summary : null;
		const projectionSummary =
			providerResult.truncated && baseProjectionSummary !== null
				? {
						...baseProjectionSummary,
						gaps: [...new Set([...baseProjectionSummary.gaps, "providers-truncated"])].slice(
							0,
							L.maxProjectionGaps,
						),
					}
				: baseProjectionSummary;

		// Note: `publishedAtMs` is stamped in Phase 3 from the publication clock!
		observationSnapshot = validateEndoDevelopResourceObservationV0({
			schemaVersion: ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
			leaseEpoch: myEpoch,
			holderId,
			observedAtMs: observeNowMs,
			publishedAtMs: observeNowMs,
			staleAfterMs,
			tokensConsumed: 0,
			modelPool: {
				poolSha256,
				poolSource,
				localEndpoints,
			},
			providers,
			sessions: mergedSessions,
			worktrees: projection.worktrees.slice(0, L.maxWorktreesObserved),
			hardware,
			projectionSummary,
		});
	} catch (error) {
		// Adversarial M1: sanitize error text so control chars or empty strings never throw inside Phase 3 outcome validation.
		const raw = error instanceof Error ? error.message : String(error ?? "");
		const cleaned = raw
			.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
			.trim()
			.slice(0, 240);
		phase2FailureDetail = cleaned.length > 0 ? cleaned : "observation phase failed";
	}

	await options.hooks?.afterPhase2Probes?.({ leaseEpoch: myEpoch, holderId });

	// ---- Phase 3: Publish (re-acquire brief `automation.lock.<n>`) ---------------------------------------------------------------

	const phase3 = store.withAutomationLockSync((s) => {
		// Evaluate publication clock & monotonic elapsed FRESH INSIDE the lock (Adversarial H3: eliminates pre-lock wait TOCTOU).
		const publishNowMs = now();
		const monotonicElapsedMs = performance.now() - monotonicStartMs;

		const leaseRead = s.readLease();
		if (!leaseRead.ok) {
			return {
				ok: false as const,
				refusal: (leaseRead.reason === "unsafe-path" ? "unsafe-path" : "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `lease.json unreadable at publication (${leaseRead.reason})`,
			};
		}
		if (!leaseRead.exists) {
			return {
				ok: false as const,
				refusal: "stale-lease-epoch" as const,
				detail: "lease.json missing at publication; refusing publication without writes",
			};
		}
		const currentLease = leaseRead.value;

		// Strict lease & epoch fencing (S1-B, S1-AT05, S1-AT09):
		// - Holder must match.
		// - Epoch must match.
		// - Lease must not be released.
		// - Publication wall clock must not precede acquisition (backward clock jump guard) AND must be strictly < expiresAtMs.
		// - Monotonic elapsed duration must not exceed leaseTtlMs.
		if (
			currentLease.holderId !== holderId ||
			currentLease.epoch !== myEpoch ||
			currentLease.releasedAtMs !== null ||
			publishNowMs < currentLease.acquiredAtMs ||
			publishNowMs >= currentLease.expiresAtMs ||
			monotonicElapsedMs >= leaseTtlMs
		) {
			return {
				ok: false as const,
				refusal: "stale-lease-epoch" as const,
				detail: `lease fence rejected publication (expected holder=${holderId} epoch=${myEpoch}, found holder=${currentLease.holderId} epoch=${currentLease.epoch} released=${currentLease.releasedAtMs} expiresAt=${currentLease.expiresAtMs} publishNow=${publishNowMs})`,
			};
		}

		// Monotonic resource-epoch check: never replace an observation from a newer epoch.
		const existingResources = s.readResources();
		if (!existingResources.ok) {
			return {
				ok: false as const,
				refusal: (existingResources.reason === "unsafe-path"
					? "unsafe-path"
					: "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `resources.json unreadable at publication (${existingResources.reason})`,
			};
		}
		if (existingResources.exists && myEpoch < existingResources.value.leaseEpoch) {
			return {
				ok: false as const,
				refusal: "stale-lease-epoch" as const,
				detail: `resources.json already holds newer epoch ${existingResources.value.leaseEpoch} > ${myEpoch}`,
			};
		}

		// Re-read schedules to detect in-flight disable / remove / revision / remove+readd changes (S1-C, S1-AT08, Adversarial H6).
		const schedulesRead = s.readSchedules();
		if (!schedulesRead.ok) {
			return {
				ok: false as const,
				refusal: (schedulesRead.reason === "unsafe-path"
					? "unsafe-path"
					: "unreadable") as EndoSchedulerTickRefusalV0,
				detail: `schedules.json unreadable at publication (${schedulesRead.reason})`,
			};
		}
		const schedulesFile = schedulesRead.exists ? schedulesRead.value : null;

		const claimDispositions = claimed.map((claim) => {
			const current = schedulesFile?.schedules.find((sc) => sc.scheduleId === claim.scheduleId);
			if (current === undefined) {
				return { claim, valid: false as const, detail: "schedule-removed-in-flight" };
			}
			if (!current.enabled) {
				return { claim, valid: false as const, detail: "schedule-disabled-in-flight" };
			}
			if (current.revision !== claim.scheduleRevision) {
				return {
					claim,
					valid: false as const,
					detail: `schedule-revised-in-flight (claimed rev ${claim.scheduleRevision}, current rev ${current.revision})`,
				};
			}
			// Adversarial H6: guard against removeSchedule + addSchedule recreating the same scheduleId at revision 1.
			if (
				current.cursor.lastFireIdempotencyKey !== claim.idempotencyKey ||
				current.actionKind !== claim.actionKind ||
				endoScheduleTriggerCursorV0(current.trigger) !== claim.triggerCursor
			) {
				return {
					claim,
					valid: false as const,
					detail: "schedule-replaced-in-flight",
				};
			}
			return { claim, valid: true as const, detail: null };
		});

		const anyValidClaim = claimDispositions.some((d) => d.valid);
		const anyValidHealth = claimDispositions.some((d) => d.valid && d.claim.actionKind === "observe-health");
		const anyValidProjection = claimDispositions.some((d) => d.valid && d.claim.actionKind === "refresh-projection");
		let publishedResources = false;
		let observationDigest: string | null = null;

		// Publish `resources.json` ONLY when at least one claimed schedule remains valid at its claimed revision.
		// Adversarial H2: preserve unrefreshed sections from `existingResources` so `observe-health` and `refresh-projection`
		// never clobber each other's modelPool endpoints or statusSha256.
		if (anyValidClaim && observationSnapshot !== null && phase2FailureDetail === null) {
			const prev = existingResources.exists ? existingResources.value : null;
			const mergedModelPool = !anyValidHealth && prev !== null ? prev.modelPool : observationSnapshot.modelPool;
			const mergedProviders = !anyValidHealth && prev !== null ? prev.providers : observationSnapshot.providers;
			const mergedHardware = !anyValidHealth && prev !== null ? prev.hardware : observationSnapshot.hardware;
			const mergedProjectionSummary =
				!anyValidProjection &&
				prev?.projectionSummary !== null &&
				prev?.projectionSummary !== undefined &&
				observationSnapshot.projectionSummary !== null &&
				observationSnapshot.projectionSummary.statusSha256 === null
					? {
							...observationSnapshot.projectionSummary,
							statusSha256: prev.projectionSummary.statusSha256,
						}
					: (observationSnapshot.projectionSummary ?? prev?.projectionSummary ?? null);

			const finalSnapshot = validateEndoDevelopResourceObservationV0({
				...observationSnapshot,
				leaseEpoch: myEpoch,
				holderId,
				publishedAtMs: publishNowMs,
				modelPool: mergedModelPool,
				providers: mergedProviders,
				hardware: mergedHardware,
				projectionSummary: mergedProjectionSummary,
			});
			options.hooks?.beforePublishResources?.();
			const resWrite = s.writeResources(finalSnapshot);
			if (resWrite !== "committed") {
				return {
					ok: false as const,
					refusal: resWrite as EndoSchedulerTickRefusalV0,
					detail: `failed to publish resources.json (${resWrite})`,
				};
			}
			publishedResources = true;
			observationDigest = sha256HexV0(canonicalEndoJsonV0(finalSnapshot as never));
			options.hooks?.afterPublishResources?.();
		}

		// Record immutable write-once `.outcome.json` per claimed fire.
		const outcomes: EndoDevelopScheduleFireOutcomeV0[] = [];
		const statusUpdateByKey = new Map<string, EndoDevelopScheduleFireOutcomeV0["status"]>();

		for (const disp of claimDispositions) {
			const { claim } = disp;
			const outcomeRecord: EndoDevelopScheduleFireOutcomeV0 = {
				schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
				idempotencyKey: claim.idempotencyKey,
				scheduleId: claim.scheduleId,
				scheduleRevision: claim.scheduleRevision,
				actionKind: claim.actionKind,
				windowStartMs: claim.windowStartMs,
				completedAtMs: publishNowMs,
				leaseEpoch: myEpoch,
				holderId,
				status: !disp.valid ? "cancelled-schedule-changed" : phase2FailureDetail !== null ? "failed" : "completed",
				missedWindowCount: claim.missedWindowsBefore,
				observationDigest: disp.valid && phase2FailureDetail === null ? observationDigest : null,
				detail: !disp.valid ? disp.detail : phase2FailureDetail,
				tokensConsumed: 0,
			};
			options.hooks?.beforeWriteOutcome?.(claim.idempotencyKey);
			const outWrite = s.writeFireOutcomeOnce(outcomeRecord);
			if (outWrite === "failed") {
				return {
					ok: false as const,
					refusal: "storage-failed" as const,
					detail: `failed to write outcome for ${claim.idempotencyKey}`,
				};
			}
			outcomes.push(outcomeRecord);
			// Adversarial M6: key status updates by exact `idempotencyKey` so disabled/revised schedules that still point
			// to this fire get `cancelled-schedule-changed` without touching operator fields or replaced schedules.
			statusUpdateByKey.set(claim.idempotencyKey, outcomeRecord.status);
			options.hooks?.afterWriteOutcome?.(claim.idempotencyKey);
		}

		if (schedulesFile !== null && statusUpdateByKey.size > 0) {
			let anyCursorChanged = false;
			const nextSchedules = schedulesFile.schedules.map((sc) => {
				const st =
					sc.cursor.lastFireIdempotencyKey !== null
						? statusUpdateByKey.get(sc.cursor.lastFireIdempotencyKey)
						: undefined;
				if (st === undefined) return sc;
				anyCursorChanged = true;
				return {
					...sc,
					cursor: {
						...sc.cursor,
						lastFireStatus: st,
					},
				};
			});
			if (anyCursorChanged) {
				const schedWrite = s.writeSchedules({
					...schedulesFile,
					updatedAtMs: Math.max(schedulesFile.updatedAtMs, publishNowMs),
					schedules: nextSchedules,
				});
				if (schedWrite !== "committed") {
					return {
						ok: false as const,
						refusal: schedWrite as EndoSchedulerTickRefusalV0,
						detail: `failed to update schedule fire status (${schedWrite})`,
					};
				}
			}
		}

		// Bounded retention pruning (NEVER removes `claimed-incomplete` records).
		const pruneResult = s.pruneRetainedFires(maxFirePairsRetained);

		// Release our verified lease.
		options.hooks?.beforeReleaseLease?.();
		const relWrite = s.writeLease({ ...currentLease, releasedAtMs: publishNowMs });
		if (relWrite !== "committed") {
			return {
				ok: false as const,
				refusal: relWrite as EndoSchedulerTickRefusalV0,
				detail: `failed to release lease.json (${relWrite})`,
			};
		}
		options.hooks?.afterReleaseLease?.();

		return {
			ok: true as const,
			publishNowMs,
			publishedResources,
			observationDigest,
			outcomes,
			prunedFireCount: pruneResult.prunedKeys.length,
		};
	});

	if (!phase3.ok) {
		return refuse(
			phase3.code === "busy" ? "lock-busy" : phase3.code,
			`failed to reacquire automation.lock in Phase 3 (${phase3.code})`,
			myEpoch,
		);
	}
	if (!phase3.result.ok) {
		return refuse(phase3.result.refusal, phase3.result.detail, myEpoch);
	}

	return {
		ok: true,
		schemaVersion: "endo.scheduler-tick-result.v0",
		holderId,
		leaseEpoch: myEpoch,
		claimNowMs,
		publishNowMs: phase3.result.publishNowMs,
		claimed,
		missedSkipped,
		outcomes: phase3.result.outcomes,
		publishedResources: phase3.result.publishedResources,
		observationDigest: phase3.result.observationDigest,
		prunedFireCount: phase3.result.prunedFireCount,
		tokensConsumed: 0,
	};
}
