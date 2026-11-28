// Strictly project-scoped, lock-free, bounded read-only operational projection for Coordinator Studio F1
// (`COORDINATOR-STUDIO-F1-002`).
//
// Invariants:
// - Imports ZERO harness/model/provider adapters (preserves `endo workspace open` static import closure).
// - Takes NO locks, writes NO files, probes NO endpoints, wakes NO models, executes NO schedules.
// - Strictly filters ALL S2 records (schedules, authorizations, fires, turns, briefings, proposals, totals, errors) to `projectId`.
// - Never discloses unrelated project IDs, titles, paths, worktree summaries, store-wide project counts, or foreign S2 lease epochs.
// - Enforces explicit directory-entry and total-byte read budgets BEFORE parsing large turn/fire/proposal directories (S1).
// - Strips C0/C1 control characters from untrusted model answers and clamps token totals safely (S2).

import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
	ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0,
	type EndoCoordinatorStudioOperationsV0,
	type EndoStudioAdvisoryBriefingViewV0,
	type EndoStudioAdvisoryFireViewV0,
	type EndoStudioAdvisoryProposalViewV0,
	type EndoStudioAdvisoryScheduleViewV0,
	type EndoStudioNextDueStateV0,
	type EndoStudioObservationFireViewV0,
	type EndoStudioObservationScheduleViewV0,
	type EndoStudioSourceStateV0,
	validateEndoCoordinatorStudioOperationsV0,
} from "../protocol/coordinator-studio-operations.ts";
import { ENDO_ADVISORY_LIMITS_V0, type EndoAdvisoryScheduleV0 } from "../protocol/develop-advisory.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LIMITS_V0,
	type EndoDevelopScheduleV0,
	type EndoScheduleTriggerV0,
} from "../protocol/develop-automation.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../protocol/develop-tasks.ts";
import {
	endoAdvisoryAuthorizationStandingV0,
	endoAdvisoryBudgetStandingV0,
	endoAdvisoryProposalCurrencyV0,
} from "../runtime/contracts/develop-advisory.ts";
import { endoObservationFreshnessV0, evaluateEndoScheduleDueV0 } from "../runtime/contracts/develop-automation.ts";
import { DevelopAdvisoryStoreV0 } from "./develop-advisory.ts";
import { readEndoAutomationProjectionV0 } from "./develop-automation.ts";
import { readDirectoryNamesAtMostV0 } from "./write-once.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const pad2 = (n: number): string => String(n).padStart(2, "0");

export interface EndoCoordinatorStudioOperationsBudgetV0 {
	readonly maxS1FireFiles: number;
	readonly maxS2TurnFiles: number;
	readonly maxS2FireFiles: number;
	readonly maxS2ProposalFiles: number;
	readonly maxDirectoryBytes: number;
}

export const ENDO_STUDIO_OPERATIONS_DEFAULT_BUDGET_V0: EndoCoordinatorStudioOperationsBudgetV0 = Object.freeze({
	maxS1FireFiles: 512,
	maxS2TurnFiles: 1024,
	maxS2FireFiles: 512,
	maxS2ProposalFiles: 512,
	maxDirectoryBytes: 8 * 1024 * 1024,
});

function checkBoundedDir(
	dirPath: string,
	maxFiles: number,
	maxBytes: number,
):
	| { readonly ok: true; readonly exists: boolean }
	| { readonly ok: false; readonly reason: "too-many" | "too-large" | "unsafe-path" | "io" } {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(dirPath, { throwIfNoEntry: false });
	} catch {
		return { ok: false, reason: "io" };
	}
	if (info === undefined) return { ok: true, exists: false };
	if (!info.isDirectory()) return { ok: false, reason: "unsafe-path" };
	let listed: string[] | null;
	try {
		listed = readDirectoryNamesAtMostV0(dirPath, maxFiles);
	} catch {
		return { ok: false, reason: "io" };
	}
	if (listed === null) return { ok: false, reason: "too-many" };
	let totalBytes = 0;
	for (const name of listed) {
		try {
			const st = lstatSync(join(dirPath, name), { throwIfNoEntry: false });
			if (st?.isFile()) {
				totalBytes += st.size;
				if (totalBytes > maxBytes) return { ok: false, reason: "too-large" };
			}
		} catch {
			return { ok: false, reason: "io" };
		}
	}
	return { ok: true, exists: true };
}

function formatDurationMs(ms: number): string {
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${Math.round(ms / 1_000)}s`;
}

function summarizeTrigger(trigger: EndoScheduleTriggerV0): string {
	if (trigger.kind === "once") return `Once at ${new Date(trigger.atMs).toISOString()}`;
	if (trigger.kind === "interval") return `Every ${formatDurationMs(trigger.everyMs)}`;
	const s = trigger.schedule;
	if (s.cadence === "hourly") return `Hourly :${pad2(s.minute)} (${trigger.timezone})`;
	if (s.cadence === "daily") return `Daily ${pad2(s.hour)}:${pad2(s.minute)} (${trigger.timezone})`;
	return `Weekly ${WEEKDAYS[s.weekday] ?? "?"} ${pad2(s.hour)}:${pad2(s.minute)} (${trigger.timezone})`;
}

/**
 * Redact any foreign project IDs or filesystem paths (POSIX, home-relative, Windows) from free-form text
 * before returning to the browser. Preserves only safe printable text within the schema bound (S4).
 */
function sanitizeDetail(detail: string | null | undefined, projectId: string, maxLen = 512): string | null {
	if (detail === null || detail === undefined) return null;
	const cleaned = detail
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/endo\.project\.[0-9a-f]{32}/g, (match) => (match === projectId ? match : "[redacted-project]"))
		.replace(/~\/[^\s,;)]+/g, "[redacted-path]")
		.replace(/[A-Za-z]:\\[^\s,;)]+/g, "[redacted-path]")
		.replace(/(?:\/[^\s/\\,;)]+){2,}/g, "[redacted-path]")
		.trim()
		.slice(0, maxLen);
	return cleaned.length === 0 ? null : cleaned;
}

const ANSWER_REFERENCE =
	/(https?:\/\/[^\s<>"'`]+)|file:\/\/[^\s<>"'`]*|endo\.project\.[0-9a-f]{32}|~\/[^\s,;<>"'`()[\]{}*]+|\b[A-Za-z]:[\\/][^\s,;<>"'`()[\]{}*]+|(?<![\w.~-])(?:\/[^\s/\\,;<>"'`()[\]{}*]+){2,}/g;

/**
 * Sanitize untrusted model briefing text (S2): strip disallowed C0/C1 control characters, apply the disclosure boundary
 * `sanitizeDetail` enforces, and cap at 4096 chars. Line breaks, tabs and Markdown survive. The authorized project's own
 * `endo.project.*` id is kept, since this endpoint already discloses it; every other project id becomes `[redacted-project]`.
 * Every absolute filesystem path (POSIX, home-relative, Windows drive, `file://`) becomes `[redacted-path]`, the authorized
 * project's own checkout included, because the contract carries no raw paths. Relative paths and http(s) URLs are prose and
 * are kept, with any foreign project id inside a URL still redacted.
 */
function sanitizeAnswer(answer: string | null, projectId: string): string | null {
	if (answer === null) return null;
	const project = (id: string): string => (id === projectId ? id : "[redacted-project]");
	return answer
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
		.replace(ANSWER_REFERENCE, (match: string, url: string | undefined) => {
			if (url !== undefined) return url.replace(/endo\.project\.[0-9a-f]{32}/g, project);
			if (match.startsWith("endo.project.")) return project(match);
			return `[redacted-path]${/[.,:!?]*$/.exec(match)?.[0] ?? ""}`;
		})
		.slice(0, 4096);
}

const addClamped = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);

function classifyNextDue(
	schedule: EndoDevelopScheduleV0,
	nowMs: number,
	onTimeGraceMs: number,
): {
	readonly nextDueState: EndoStudioNextDueStateV0;
	readonly nextWindowStartMs: number | null;
} {
	if (!schedule.enabled) return { nextDueState: "disabled", nextWindowStartMs: null };
	const ev = evaluateEndoScheduleDueV0(schedule, nowMs, { onTimeGraceMs });
	if (ev.kind === "disabled") return { nextDueState: "disabled", nextWindowStartMs: null };
	if (ev.kind === "completed-once") return { nextDueState: "completed-once", nextWindowStartMs: null };
	if (ev.kind === "due-fire") return { nextDueState: "due", nextWindowStartMs: ev.windowStartMs };
	if (ev.kind === "missed-skip") return { nextDueState: "missed", nextWindowStartMs: ev.latestMissedWindowStartMs };
	if (ev.kind === "clock-behind-cursor") return { nextDueState: "not-due", nextWindowStartMs: null };
	return { nextDueState: "not-due", nextWindowStartMs: ev.nextWindowStartMs };
}

function advisoryAsS1Schedule(s: EndoAdvisoryScheduleV0): EndoDevelopScheduleV0 {
	return {
		scheduleId: s.scheduleId,
		label: s.label,
		revision: s.revision,
		enabled: s.enabled,
		actionKind: "observe-health",
		missedRunPolicy: s.missedRunPolicy,
		trigger: s.trigger,
		createdAtMs: s.createdAtMs,
		updatedAtMs: s.updatedAtMs,
		cursor: {
			lastEvaluatedAtMs: s.cursor.lastEvaluatedAtMs,
			lastConsumedWindowStartMs: s.cursor.lastConsumedWindowStartMs,
			completedOnce: s.cursor.completedOnce,
			lastFireIdempotencyKey: null,
			lastFireStatus: null,
		},
	};
}

export function readEndoCoordinatorStudioOperationsV0(options: {
	readonly root: string;
	readonly projectId: string;
	readonly now?: () => number;
	readonly budget?: Partial<EndoCoordinatorStudioOperationsBudgetV0>;
}): EndoCoordinatorStudioOperationsV0 {
	const { root, projectId } = options;
	if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) {
		throw new TypeError("invalid projectId for Studio operations projection");
	}
	const nowMs = (options.now ?? Date.now)();
	const budget: EndoCoordinatorStudioOperationsBudgetV0 = {
		...ENDO_STUDIO_OPERATIONS_DEFAULT_BUDGET_V0,
		...options.budget,
	};

	// ---- S1 Automation (Resources + Store-Level Observation Schedules) ------------------------------------------------------------
	const s1FiresBudget = checkBoundedDir(
		join(root, "develop", "automation", "fires"),
		budget.maxS1FireFiles,
		budget.maxDirectoryBytes,
	);
	const s1 = readEndoAutomationProjectionV0(root, {
		now: () => nowMs,
		includeFires: s1FiresBudget.ok && s1FiresBudget.exists,
	});

	const declarationsSection =
		s1.declarations.state === "ready"
			? {
					state: "ready" as const,
					items: s1.declarations.file.declarations.slice(0, 64).map((d) => ({
						providerId: d.providerId,
						surfaceKind: d.surfaceKind,
						quotaPoolId: d.quotaPoolId,
						windowKind: d.windowKind,
						standing: d.standing,
						resetAtMs: d.resetAtMs,
						declaredAtMs: d.declaredAtMs,
						basis: "operator-declared" as const,
						note: sanitizeDetail(d.note, projectId),
					})),
				}
			: { state: s1.declarations.state, items: [] };

	const resourcesSection: EndoCoordinatorStudioOperationsV0["resources"] =
		s1.resources.state === "ready"
			? {
					state: "ready",
					detail: null,
					observedAtMs: s1.resources.observation.observedAtMs,
					staleAfterMs: s1.resources.observation.staleAfterMs,
					freshness: s1.resources.freshness === "fresh" ? "fresh" : "stale",
					liveProbed: false,
					poolSource: s1.resources.observation.modelPool.poolSource,
					localEndpoints: s1.resources.observation.modelPool.localEndpoints.slice(0, 16).map((ep) => ({
						memberId: ep.memberId,
						endpoint: ep.endpoint,
						modelId: ep.modelId,
						readiness: ep.readiness,
						detail: ep.detail,
						backend: ep.backend,
						build: sanitizeDetail(ep.build, projectId, 256),
						observedAtMs: ep.observedAtMs,
						staleAfterMs: ep.staleAfterMs,
						freshness:
							endoObservationFreshnessV0(ep.observedAtMs, ep.staleAfterMs, nowMs) === "fresh"
								? "fresh"
								: "stale",
						capacityConfirmed: ep.readiness === "ready",
						modelIdentityAuthenticated: false,
						inferenceTokens: 0,
					})),
					providers: s1.resources.observation.providers.slice(0, 32).map((obs, idx) => {
						const eff = s1.resources.state === "ready" ? s1.resources.effectiveProviders[idx] : undefined;
						return {
							providerId: obs.providerId,
							surfaceKind: obs.surfaceKind,
							quotaPoolId: obs.quotaPoolId,
							standing: obs.standing,
							effectiveStanding: eff?.effectiveStanding ?? "unknown",
							basis: obs.basis,
							observedAtMs: obs.observedAtMs,
							staleAfterMs: obs.staleAfterMs,
							freshness:
								(eff?.freshness ?? endoObservationFreshnessV0(obs.observedAtMs, obs.staleAfterMs, nowMs)) ===
								"fresh"
									? "fresh"
									: "stale",
							windows: obs.windows.slice(0, 8).map((w) => ({
								windowKind: w.windowKind,
								standing: w.standing,
								resetAtMs: w.resetAtMs,
								resetBasis: w.resetBasis,
								availabilityConfirmed: w.availabilityConfirmed && w.resetBasis === "authoritative-api",
								remainingEstimate: w.remainingEstimate,
								limitEstimate: w.limitEstimate,
								unit: w.unit,
							})),
							localLedgerLowerBound:
								obs.localLedgerLowerBound === null
									? null
									: {
											recordedTurns: obs.localLedgerLowerBound.recordedTurns,
											recordedAtMs: obs.localLedgerLowerBound.recordedAtMs,
										},
						};
					}),
					declarations: declarationsSection,
					hardware: {
						mode: s1.resources.observation.hardware.mode,
						observedAtMs: s1.resources.observation.hardware.observedAtMs,
						staleAfterMs: s1.resources.observation.hardware.staleAfterMs,
						devices: s1.resources.observation.hardware.devices.slice(0, 16).map((d) => ({
							deviceId: d.deviceId,
							kind: d.kind,
							backendFamily: d.backendFamily,
							label: sanitizeDetail(d.label, projectId, 256),
							memoryTotalBytes: d.memoryTotalBytes,
							memoryUsedBytes: d.memoryUsedBytes,
							memoryFreeBytes: d.memoryFreeBytes,
							memoryBasis: d.memoryBasis,
							attributedModelMemberIds: d.attributedModelMemberIds.slice(0, 32),
							sharedDeviceContention: d.sharedDeviceContention,
						})),
					},
				}
			: {
					state: s1.resources.state,
					detail: s1.resources.state === "unreadable" ? s1.resources.reason : null,
					observedAtMs: null,
					staleAfterMs: null,
					freshness: "unknown",
					liveProbed: false,
					poolSource: null,
					localEndpoints: [],
					providers: [],
					declarations: declarationsSection,
					hardware: null,
				};

	const s1Schedules: EndoStudioObservationScheduleViewV0[] =
		s1.schedules.state === "ready"
			? s1.schedules.file.schedules.slice(0, 64).map((s) => {
					const due = classifyNextDue(s, nowMs, ENDO_DEVELOP_AUTOMATION_LIMITS_V0.defaultOnTimeGraceMs);
					return {
						scheduleId: s.scheduleId,
						label: sanitizeDetail(s.label, projectId, 256),
						revision: s.revision,
						enabled: s.enabled,
						actionKind: s.actionKind,
						missedRunPolicy: s.missedRunPolicy,
						triggerSummary: summarizeTrigger(s.trigger),
						nextDueState: due.nextDueState,
						nextWindowStartMs: due.nextWindowStartMs,
						lastEvaluatedAtMs: s.cursor.lastEvaluatedAtMs,
						lastFireStatus: s.cursor.lastFireStatus,
					};
				})
			: [];

	const s1Fires: EndoStudioObservationFireViewV0[] =
		s1FiresBudget.ok && s1.fires.state === "ready"
			? [...s1.fires.entries]
					.sort((a, b) => {
						const ta = a.outcome?.completedAtMs ?? a.claim?.claimedAtMs ?? 0;
						const tb = b.outcome?.completedAtMs ?? b.claim?.claimedAtMs ?? 0;
						return tb - ta;
					})
					.slice(0, 16)
					.map((e) => ({
						idempotencyKey: e.idempotencyKey,
						scheduleId: e.outcome?.scheduleId ?? e.claim?.scheduleId ?? "unknown",
						scheduleRevision: e.outcome?.scheduleRevision ?? e.claim?.scheduleRevision ?? 0,
						actionKind: e.outcome?.actionKind ?? e.claim?.actionKind ?? "observe-health",
						windowStartMs: e.outcome?.windowStartMs ?? e.claim?.windowStartMs ?? 0,
						state: e.state,
						claimedAtMs: e.claim?.claimedAtMs ?? null,
						completedAtMs: e.outcome?.completedAtMs ?? null,
						missedWindowCount: e.outcome?.missedWindowCount ?? e.claim?.missedWindowsBefore ?? 0,
						tokensConsumed: 0,
						detail: sanitizeDetail(e.outcome?.detail, projectId),
					}))
			: [];

	const s1Lease: EndoCoordinatorStudioOperationsV0["schedules"]["observation"]["lease"] =
		s1.lease.state === "ready"
			? {
					state: "ready",
					active: s1.lease.active,
					epoch: s1.lease.lease.epoch,
					expiresAtMs: s1.lease.lease.expiresAtMs,
				}
			: { state: s1.lease.state, active: false, epoch: null, expiresAtMs: null };

	// ---- S2 Advisory (Strictly Project-Scoped to `projectId` — Bounded Reads & Zero Foreign Project Disclosure) -------------------
	const advStore = new DevelopAdvisoryStoreV0(root, { now: () => nowMs });
	const advSchedRead = advStore.readSchedules();
	const advAuthRead = advStore.readAuthorizations();
	const advLeaseRead = advStore.readLease();
	const advObsRead = advStore.readObservations();

	const turnsBudget = checkBoundedDir(advStore.turnsDir, budget.maxS2TurnFiles, budget.maxDirectoryBytes);
	const firesBudget = checkBoundedDir(advStore.firesDir, budget.maxS2FireFiles, budget.maxDirectoryBytes);
	const proposalsBudget = checkBoundedDir(advStore.proposalsDir, budget.maxS2ProposalFiles, budget.maxDirectoryBytes);

	const advTurnsRead = turnsBudget.ok
		? advStore.listTurns(nowMs)
		: ({ ok: false as const, reason: turnsBudget.reason } as const);
	const advFiresRead = firesBudget.ok
		? advStore.listFires()
		: ({ ok: false as const, reason: firesBudget.reason } as const);
	const advProposalsRead = proposalsBudget.ok
		? advStore.listProposals()
		: ({ ok: false as const, reason: proposalsBudget.reason } as const);

	const advLeaseVal = advLeaseRead.ok && advLeaseRead.exists ? advLeaseRead.value : null;
	const advLeaseActive = advLeaseVal !== null && advLeaseVal.releasedAtMs === null && nowMs < advLeaseVal.expiresAtMs;
	const currentAdvLease = advLeaseVal === null ? null : { epoch: advLeaseVal.epoch, active: advLeaseActive };

	// Strictly filter schedules, authorizations, turns, and fires to authorized `projectId` (S4).
	const projectSchedules =
		advSchedRead.ok && advSchedRead.exists
			? advSchedRead.value.schedules.filter((s) => s.projectId === projectId)
			: [];
	const projectAuthorizationsFile =
		advAuthRead.ok && advAuthRead.exists
			? {
					...advAuthRead.value,
					authorizations: advAuthRead.value.authorizations.filter((a) => a.projectId === projectId),
				}
			: null;
	const projectTurns = advTurnsRead.ok ? advTurnsRead.entries.filter((t) => t.admission.projectId === projectId) : [];

	// Strict both-sides projectId matching on S2 fires (S4): never merge foreign claim/outcome pairs.
	let fireProjectMismatch = false;
	const projectFiresAll = advFiresRead.ok
		? advFiresRead.entries.filter((e) => {
				const cProj = e.claim?.projectId ?? null;
				const oProj = e.outcome?.projectId ?? null;
				if (cProj !== null && oProj !== null && cProj !== oProj) {
					if (cProj === projectId || oProj === projectId) fireProjectMismatch = true;
					return false;
				}
				return (cProj ?? oProj) === projectId;
			})
		: [];

	const advFiresProblems = advFiresRead.ok ? advFiresRead.problems.length > 0 : true;
	const advTurnsProblems = advTurnsRead.ok ? advTurnsRead.problems.length > 0 : true;
	const advProposalsProblems = advProposalsRead.ok ? advProposalsRead.problems.length > 0 : true;

	const advStorageDegraded =
		!advSchedRead.ok ||
		!advAuthRead.ok ||
		!advLeaseRead.ok ||
		!advObsRead.ok ||
		advTurnsProblems ||
		advFiresProblems ||
		advProposalsProblems ||
		fireProjectMismatch;

	// S3: NEVER disclose store-wide S2 lease epoch or foreign projects' real-time tick expiry under `scope: "project-scoped"`.
	// Only reflect whether an active lease corresponds to a currently open in-flight turn owned by THIS project.
	const hasProjectAdvisoryState = projectSchedules.length > 0 || projectFiresAll.length > 0 || projectTurns.length > 0;
	const projectOwnsActiveLease =
		advLeaseActive &&
		advLeaseVal !== null &&
		projectTurns.some((t) => t.briefing === null && t.admission.leaseEpoch === advLeaseVal.epoch);
	const advLeaseView: EndoCoordinatorStudioOperationsV0["schedules"]["advisory"]["lease"] = !advLeaseRead.ok
		? { state: "unreadable", active: false, epoch: null, expiresAtMs: null }
		: !hasProjectAdvisoryState
			? { state: "absent", active: false, epoch: null, expiresAtMs: null }
			: {
					state: "ready",
					active: projectOwnsActiveLease,
					epoch: null,
					expiresAtMs: projectOwnsActiveLease && advLeaseVal !== null ? advLeaseVal.expiresAtMs : null,
				};

	const advScheduleViews: EndoStudioAdvisoryScheduleViewV0[] = projectSchedules.slice(0, 64).map((schedule) => {
		const due = classifyNextDue(advisoryAsS1Schedule(schedule), nowMs, ENDO_ADVISORY_LIMITS_V0.defaultOnTimeGraceMs);
		const standing = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: projectAuthorizationsFile,
			nowMs,
		});
		const latestGrant =
			projectAuthorizationsFile !== null
				? ([...projectAuthorizationsFile.authorizations]
						.filter((a) => a.scheduleId === schedule.scheduleId)
						.sort((a, b) => b.grantedAtMs - a.grantedAtMs)[0] ?? null)
				: null;
		const budgetStanding =
			standing.ok && !advTurnsProblems
				? endoAdvisoryBudgetStandingV0({
						turns: projectTurns.filter((t) => t.admission.scheduleId === schedule.scheduleId),
						budget: standing.authorization.budget,
						nowMs,
						currentLease: currentAdvLease,
					})
				: null;
		return {
			scheduleId: schedule.scheduleId,
			label: sanitizeDetail(schedule.label, projectId, 256),
			revision: schedule.revision,
			enabled: schedule.enabled,
			actionKind: schedule.actionKind,
			wake: schedule.wake,
			missedRunPolicy: schedule.missedRunPolicy,
			triggerSummary: summarizeTrigger(schedule.trigger),
			nextDueState: due.nextDueState,
			nextWindowStartMs: due.nextWindowStartMs,
			authorization: {
				ok: standing.ok,
				status: !advAuthRead.ok ? "unreadable" : standing.ok ? "authorized" : standing.refusal,
				expiresAtMs: standing.ok ? standing.authorization.expiresAtMs : (latestGrant?.expiresAtMs ?? null),
				revocation: standing.ok ? null : (latestGrant?.revocation ?? null),
			},
			budget:
				budgetStanding === null || !standing.ok
					? null
					: {
							admissible: budgetStanding.admissible,
							refusal: budgetStanding.admissible ? null : budgetStanding.refusal,
							periodMs: standing.authorization.budget.periodMs,
							turnsCharged: budgetStanding.turnsCharged,
							maxTurnsPerPeriod: standing.authorization.budget.maxTurnsPerPeriod,
							generatedTokensCharged: budgetStanding.generatedTokensCharged,
							maxGeneratedTokensPerPeriod: standing.authorization.budget.maxGeneratedTokensPerPeriod,
							uncertainTurns: budgetStanding.uncertainTurns,
						},
			lastEvaluatedAtMs: schedule.cursor.lastEvaluatedAtMs,
			lastAttemptedAtMs: schedule.cursor.lastAttemptedAtMs,
			lastConsideredAtMs: schedule.cursor.lastConsideredAtMs,
			lastFireStatus: schedule.cursor.lastFireStatus,
		};
	});

	const projectIncompleteFires = projectFiresAll.filter((e) => e.claim !== null && e.outcome === null).length;
	const advFireViews: EndoStudioAdvisoryFireViewV0[] = [...projectFiresAll]
		.sort((a, b) => {
			const ta = a.outcome?.completedAtMs ?? a.claim?.claimedAtMs ?? 0;
			const tb = b.outcome?.completedAtMs ?? b.claim?.claimedAtMs ?? 0;
			return tb - ta;
		})
		.slice(0, 16)
		.map((e) => ({
			idempotencyKey: e.idempotencyKey,
			scheduleId: e.outcome?.scheduleId ?? e.claim?.scheduleId ?? "unknown",
			scheduleRevision: e.outcome?.scheduleRevision ?? e.claim?.scheduleRevision ?? 0,
			actionKind: e.outcome?.actionKind ?? e.claim?.actionKind ?? "generate-advisory-brief",
			windowStartMs: e.outcome?.windowStartMs ?? e.claim?.windowStartMs ?? 0,
			state:
				e.claim !== null && e.outcome === null
					? "claimed-incomplete"
					: e.claim === null
						? "orphan-outcome"
						: "completed",
			outcomeStatus: e.outcome?.status ?? null,
			claimedAtMs: e.claim?.claimedAtMs ?? null,
			completedAtMs: e.outcome?.completedAtMs ?? null,
			missedWindowCount: e.outcome?.missedWindowCount ?? e.claim?.missedWindowsBefore ?? 0,
			turnId: e.outcome?.turnId ?? null,
			inferenceDispatched: e.outcome?.inferenceDispatched ?? "unknown",
			detail: sanitizeDetail(e.outcome?.detail, projectId),
		}));

	// Strictly project-scoped S2 briefings & unsettled dispatched turns (S2, S5).
	const projectBriefingsAll = projectTurns
		.flatMap((t) => (t.briefing === null ? [] : [t.briefing]))
		.filter((b) => b.projectId === projectId)
		.sort((a, b) => b.publishedAtMs - a.publishedAtMs);
	const unsettledDispatchedTurns = projectTurns.filter((t) => t.briefing === null && t.dispatch !== null);

	const briefingViews: EndoStudioAdvisoryBriefingViewV0[] = projectBriefingsAll.slice(0, 16).map((b) => ({
		turnId: b.turnId,
		scheduleId: b.scheduleId,
		scheduleRevision: b.scheduleRevision,
		actionKind: b.actionKind,
		wakeReason: b.wakeReason,
		admittedAtMs: b.admittedAtMs,
		publishedAtMs: b.publishedAtMs,
		availability: b.availability,
		refusal: b.refusal,
		currency: b.source.currency,
		completeness: b.source.completeness,
		gaps: b.source.gaps.slice(0, 32),
		model: {
			harness: b.model.harness,
			provider: b.model.provider,
			reportedModel: b.model.reportedModel,
			selectedMemberId: b.model.selectedMemberId,
			selectedModelId: b.model.selectedModelId,
			selectedEndpoint: b.model.selectedEndpoint,
			selectedReadiness: b.model.selectedReadiness,
			capacityConfirmed: b.model.capacityConfirmed,
			fallbackOccurred: b.model.fallbackOccurred,
		},
		accounting: {
			reservedTokens: b.accounting.reserved.generatedTokens,
			admittedExchanges: b.accounting.admittedExchanges,
			reportedPromptTokens: b.accounting.reportedPromptTokens,
			reportedCompletionTokens: b.accounting.reportedCompletionTokens,
			usageReportComplete: b.accounting.usageReportComplete,
			chargedCompletionRequests: b.accounting.chargedCompletionRequests,
			chargedGeneratedTokens: b.accounting.chargedGeneratedTokens,
			inferenceElapsedMs: b.accounting.inferenceElapsedMs,
		},
		answer: sanitizeAnswer(b.answer, projectId),
		standing: "untrusted-model-interpretation",
		proposalOutcome: b.proposal.outcome,
		proposalId: b.proposal.proposalId,
		proposalRefusal: b.proposal.refusal,
	}));

	// Strictly project-scoped S2 proposals (deduped strictly within `projectId`).
	const projectObservation =
		advObsRead.ok && advObsRead.exists
			? (advObsRead.value.projects.find((p) => p.projectId === projectId) ?? null)
			: null;
	const projectProposalsAll = advProposalsRead.ok
		? advProposalsRead.entries.filter((e) => e.proposal.projectId === projectId)
		: [];
	const newestPerDedup = new Map<string, string>();
	const proposalViewsAll: EndoStudioAdvisoryProposalViewV0[] = [];
	for (const e of projectProposalsAll) {
		if (!newestPerDedup.has(e.proposal.dedupKey)) newestPerDedup.set(e.proposal.dedupKey, e.proposal.proposalId);
		const decision = [...e.dispositions].sort((a, b) => a.decidedAtMs - b.decidedAtMs)[0];
		const queueState: EndoStudioAdvisoryProposalViewV0["queueState"] =
			decision !== undefined
				? decision.disposition
				: newestPerDedup.get(e.proposal.dedupKey) === e.proposal.proposalId
					? "pending"
					: "superseded";
		proposalViewsAll.push({
			proposalId: e.proposal.proposalId,
			kind: e.proposal.kind,
			subject: {
				taskId: e.proposal.subject.taskId,
				candidateId: e.proposal.subject.candidateId,
				assignmentIds: e.proposal.subject.assignmentId === null ? [] : [e.proposal.subject.assignmentId],
			},
			evidenceFacts: e.proposal.evidence.facts.slice(0, 16).map((f) => `${f.fact} (${f.subject})`),
			uncertainties: e.proposal.uncertainties.slice(0, 16),
			generatedAtMs: e.proposal.generatedAtMs,
			scheduleId: e.proposal.scheduleId,
			turnId: e.proposal.turnId,
			queueState,
			currency: endoAdvisoryProposalCurrencyV0(e.proposal.evidence.semanticDigest, projectObservation),
			decidedAtMs: decision?.decidedAtMs ?? null,
			note: sanitizeDetail(decision?.note, projectId),
			standing: "untrusted-advisory-proposal",
			authorityGrants: "none",
		});
	}
	const pendingProposals = proposalViewsAll.filter((p) => p.queueState === "pending");
	const nonPendingProposals = proposalViewsAll.filter((p) => p.queueState !== "pending").slice(0, 32);
	const listedProposals = [...pendingProposals, ...nonPendingProposals].slice(0, 64);

	let recordedChargedTokens = 0;
	let recordedPromptTokens: number | null = null;
	let recordedCompletionTokens: number | null = null;
	let anyUsageIncomplete = unsettledDispatchedTurns.length > 0 || advTurnsProblems;
	for (const b of projectBriefingsAll) {
		recordedChargedTokens = addClamped(recordedChargedTokens, b.accounting.chargedGeneratedTokens);
		if (b.accounting.reportedPromptTokens !== null)
			recordedPromptTokens = addClamped(recordedPromptTokens ?? 0, b.accounting.reportedPromptTokens);
		if (b.accounting.reportedCompletionTokens !== null)
			recordedCompletionTokens = addClamped(recordedCompletionTokens ?? 0, b.accounting.reportedCompletionTokens);
		if (b.availability !== "not-dispatched" && !b.accounting.usageReportComplete) anyUsageIncomplete = true;
	}
	for (const t of unsettledDispatchedTurns) {
		recordedChargedTokens = addClamped(recordedChargedTokens, t.admission.reservation.generatedTokens);
	}

	const advSchedState: EndoStudioSourceStateV0 = !advSchedRead.ok
		? "unreadable"
		: projectSchedules.length > 0 || projectFiresAll.length > 0
			? "ready"
			: "absent";
	const advHistDegraded = advTurnsProblems || advProposalsProblems;
	const advHistState: EndoStudioSourceStateV0 =
		!advTurnsRead.ok || !advProposalsRead.ok
			? "unreadable"
			: projectBriefingsAll.length > 0 || proposalViewsAll.length > 0 || unsettledDispatchedTurns.length > 0
				? "ready"
				: "absent";

	return validateEndoCoordinatorStudioOperationsV0({
		schemaVersion: ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0,
		readAtMs: nowMs,
		projectId,
		standing: "read-only-recorded-operations",
		authority: {
			grants: "none",
			triggersInference: false,
			executesSchedules: false,
			wakesModels: false,
		},
		resources: resourcesSection,
		schedules: {
			observation: {
				state: s1.schedules.state,
				detail:
					s1.schedules.state === "unreadable"
						? s1.schedules.reason
						: !s1FiresBudget.ok
							? s1FiresBudget.reason
							: null,
				scope: "store-observation",
				lease: s1Lease,
				schedules: s1Schedules,
				recentFires: s1Fires,
				incompleteCount: s1FiresBudget.ok && s1.fires.state === "ready" ? s1.fires.incompleteCount : 0,
				degraded:
					!s1FiresBudget.ok ||
					s1.schedules.state === "unreadable" ||
					s1.lease.state === "unreadable" ||
					s1.fires.state === "unreadable" ||
					(s1.fires.state === "ready" && s1.fires.problemCount > 0),
				truncated: !s1FiresBudget.ok || (s1.fires.state === "ready" ? s1.fires.truncated : false),
			},
			advisory: {
				state: advSchedState,
				detail: !advSchedRead.ok ? advSchedRead.reason : !advFiresRead.ok ? advFiresRead.reason : null,
				scope: "project-scoped",
				lease: advLeaseView,
				schedules: advScheduleViews,
				recentFires: advFireViews,
				incompleteCount: projectIncompleteFires,
				degraded: advStorageDegraded,
			},
		},
		advisoryHistory: {
			standing: "untrusted-model-interpretation",
			authority: {
				grants: "none",
				executionAuthority: false,
				operatorAcceptanceControlsPresent: false,
			},
			state: advHistState,
			degraded: advHistDegraded,
			detail: !advTurnsRead.ok ? advTurnsRead.reason : !advProposalsRead.ok ? advProposalsRead.reason : null,
			briefings: briefingViews,
			proposals: listedProposals,
			totals: {
				briefingsCount: projectBriefingsAll.length,
				publishedCount: projectBriefingsAll.filter((b) => b.availability === "available").length,
				refusedCount: projectBriefingsAll.filter((b) => b.availability === "unavailable").length,
				withheldCount: projectBriefingsAll.filter((b) => b.availability === "withheld").length,
				notDispatchedCount: projectBriefingsAll.filter((b) => b.availability === "not-dispatched").length,
				uncertainTurnsCount: unsettledDispatchedTurns.length,
				pendingProposalsCount: pendingProposals.length,
				totalProposalsCount: proposalViewsAll.length,
				recordedChargedTokens,
				recordedPromptTokens,
				recordedCompletionTokens,
				anyUsageIncomplete,
			},
		},
	});
}
