// Pure versioned contract for Coordinator Studio F1 read-only operational visibility
// (`COORDINATOR-STUDIO-F1-002`): strictly project-scoped, redacted S1 recorded resources,
// S1 store observation schedules, and project-scoped S2 advisory schedules, history & proposals.
//
// Invariants:
// - Pure module: zero Node built-ins, zero clock, zero randomness, zero network I/O (imported directly by Studio UI).
// - Closed object schemas: unknown keys and out-of-range values fail closed.
// - Never carries credentials, raw filesystem paths outside loopback origins, foreign project IDs/counts, or mutation tokens.
// - Explicitly attests zero model wakes, zero inference dispatch, and zero schedule execution on read.

import { isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0 = "endo.coordinator-studio-operations.v0" as const;

const PROJECT_ID_RE = /^endo\.project\.[0-9a-f]{32}$/;
const SAFE_SHORT_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/;
const SAFE_DETAIL_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/;
const SAFE_ANSWER_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]{0,4096}$/;
const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/;
const MAX_EPOCH_MS = 8.64e15;

const LOCAL_READINESS_SET = new Set([
	"ready",
	"capacity-unknown",
	"model-unconfirmed",
	"loading",
	"saturated",
	"model-unavailable",
	"unhealthy",
	"unreachable",
	"probe-refused",
]);
const LOCAL_BACKEND_SET = new Set(["llama.cpp-router", "llama.cpp-single", "openai-compatible", "unknown"]);
const ALLOWANCE_STANDING_SET = new Set([
	"available",
	"approaching-limit",
	"exhausted-until-reset",
	"degraded-endpoint",
	"unknown",
]);
const RESOURCE_BASIS_SET = new Set([
	"authoritative-api",
	"controller-observed",
	"passive-response-header",
	"operator-declared",
	"controller-ledger-estimate",
	"unknown",
]);
const RESET_BASIS_SET = new Set(["authoritative-api", "passive-response-header", "operator-declared", "unknown"]);
const S1_ACTION_SET = new Set(["observe-health", "refresh-projection"]);
const S2_ACTION_SET = new Set(["generate-advisory-brief", "emit-operator-proposal"]);
const S2_WAKE_SET = new Set(["on-change", "digest-window"]);
const S2_PROPOSAL_KIND_SET = new Set([
	"inspect-failing-verification",
	"review-awaiting-task",
	"resolve-blocked-task",
	"inspect-contradiction",
	"inspect-stale-evidence",
	"inspect-worktree-conflict",
	"inspect-unverified-liveness",
	"inspect-unsatisfied-dependency",
	"inspect-advisory-review",
	"inspect-candidate-readiness",
]);

export type EndoStudioSourceStateV0 = "ready" | "absent" | "unreadable";
export type EndoStudioFreshnessV0 = "fresh" | "stale" | "unknown";

export interface EndoStudioLocalEndpointViewV0 {
	readonly memberId: string;
	readonly endpoint: string;
	readonly modelId: string;
	readonly readiness: string;
	readonly detail: string;
	readonly backend: string;
	readonly build: string | null;
	readonly observedAtMs: number;
	readonly staleAfterMs: number;
	readonly freshness: "fresh" | "stale";
	/** True only when readiness === "ready" (passive free capacity confirmed). */
	readonly capacityConfirmed: boolean;
	/** Constant reminder: loopback/catalog model names are self-reported, never cryptographically authenticated. */
	readonly modelIdentityAuthenticated: false;
	readonly inferenceTokens: 0;
}

export interface EndoStudioAllowanceWindowViewV0 {
	readonly windowKind: string;
	readonly standing: string;
	readonly resetAtMs: number | null;
	readonly resetBasis: string;
	readonly availabilityConfirmed: boolean;
	readonly remainingEstimate: number | null;
	readonly limitEstimate: number | null;
	readonly unit: string;
}

export interface EndoStudioProviderAllowanceViewV0 {
	readonly providerId: string;
	readonly surfaceKind: string;
	readonly quotaPoolId: string | null;
	readonly standing: string;
	readonly effectiveStanding: string;
	readonly basis: string;
	readonly observedAtMs: number;
	readonly staleAfterMs: number;
	readonly freshness: "fresh" | "stale";
	readonly windows: readonly EndoStudioAllowanceWindowViewV0[];
	readonly localLedgerLowerBound: { readonly recordedTurns: number; readonly recordedAtMs: number } | null;
}

export interface EndoStudioResourceDeclarationViewV0 {
	readonly providerId: string;
	readonly surfaceKind: string;
	readonly quotaPoolId: string | null;
	readonly windowKind: string;
	readonly standing: string;
	readonly resetAtMs: number;
	readonly declaredAtMs: number;
	readonly basis: "operator-declared";
	readonly note: string | null;
}

export interface EndoStudioHardwareDeviceViewV0 {
	readonly deviceId: string;
	readonly kind: string;
	readonly backendFamily: string | null;
	readonly label: string | null;
	readonly memoryTotalBytes: number | null;
	readonly memoryUsedBytes: number | null;
	readonly memoryFreeBytes: number | null;
	readonly memoryBasis: string;
	readonly attributedModelMemberIds: readonly string[];
	readonly sharedDeviceContention: string;
}

export interface EndoStudioResourcesSectionV0 {
	readonly state: EndoStudioSourceStateV0;
	readonly detail: string | null;
	readonly observedAtMs: number | null;
	readonly staleAfterMs: number | null;
	readonly freshness: EndoStudioFreshnessV0;
	readonly liveProbed: false;
	readonly poolSource: "file" | "m0-default" | "none" | null;
	readonly localEndpoints: readonly EndoStudioLocalEndpointViewV0[];
	readonly providers: readonly EndoStudioProviderAllowanceViewV0[];
	readonly declarations: {
		readonly state: EndoStudioSourceStateV0;
		readonly items: readonly EndoStudioResourceDeclarationViewV0[];
	};
	readonly hardware: {
		readonly mode: string;
		readonly observedAtMs: number;
		readonly staleAfterMs: number;
		readonly devices: readonly EndoStudioHardwareDeviceViewV0[];
	} | null;
}

export interface EndoStudioLeaseViewV0 {
	readonly state: EndoStudioSourceStateV0;
	readonly active: boolean;
	readonly epoch: number | null;
	readonly expiresAtMs: number | null;
}

export type EndoStudioNextDueStateV0 = "due" | "not-due" | "disabled" | "completed-once" | "missed";

export interface EndoStudioObservationScheduleViewV0 {
	readonly scheduleId: string;
	readonly label: string | null;
	readonly revision: number;
	readonly enabled: boolean;
	readonly actionKind: string;
	readonly missedRunPolicy: string;
	readonly triggerSummary: string;
	readonly nextDueState: EndoStudioNextDueStateV0;
	readonly nextWindowStartMs: number | null;
	readonly lastEvaluatedAtMs: number | null;
	readonly lastFireStatus: string | null;
}

export interface EndoStudioObservationFireViewV0 {
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly actionKind: string;
	readonly windowStartMs: number;
	readonly state: string;
	readonly claimedAtMs: number | null;
	readonly completedAtMs: number | null;
	readonly missedWindowCount: number;
	readonly tokensConsumed: 0;
	readonly detail: string | null;
}

export interface EndoStudioAdvisoryScheduleViewV0 {
	readonly scheduleId: string;
	readonly label: string | null;
	readonly revision: number;
	readonly enabled: boolean;
	readonly actionKind: string;
	readonly wake: string;
	readonly missedRunPolicy: string;
	readonly triggerSummary: string;
	readonly nextDueState: EndoStudioNextDueStateV0;
	readonly nextWindowStartMs: number | null;
	readonly authorization: {
		readonly ok: boolean;
		readonly status: string;
		readonly expiresAtMs: number | null;
		readonly revocation: string | null;
	};
	readonly budget: {
		readonly admissible: boolean;
		readonly refusal: string | null;
		readonly periodMs: number;
		readonly turnsCharged: number;
		readonly maxTurnsPerPeriod: number;
		readonly generatedTokensCharged: number;
		readonly maxGeneratedTokensPerPeriod: number;
		readonly uncertainTurns: number;
	} | null;
	readonly lastEvaluatedAtMs: number | null;
	readonly lastAttemptedAtMs: number | null;
	readonly lastConsideredAtMs: number | null;
	readonly lastFireStatus: string | null;
}

export interface EndoStudioAdvisoryFireViewV0 {
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly actionKind: string;
	readonly windowStartMs: number;
	readonly state: "claimed-incomplete" | "completed" | "orphan-outcome";
	readonly outcomeStatus: string | null;
	readonly claimedAtMs: number | null;
	readonly completedAtMs: number | null;
	readonly missedWindowCount: number;
	readonly turnId: string | null;
	readonly inferenceDispatched: "yes" | "no" | "unknown";
	readonly detail: string | null;
}

export interface EndoStudioAdvisoryBriefingViewV0 {
	readonly turnId: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly actionKind: string;
	readonly wakeReason: string;
	readonly admittedAtMs: number;
	readonly publishedAtMs: number;
	readonly availability: "available" | "unavailable" | "withheld" | "not-dispatched";
	readonly refusal: string | null;
	readonly currency: "current-at-publication" | "stale-at-publication" | "unknown-at-publication";
	readonly completeness: string;
	readonly gaps: readonly string[];
	readonly model: {
		readonly harness: string;
		readonly provider: string;
		readonly reportedModel: string;
		readonly selectedMemberId: string | null;
		readonly selectedModelId: string | null;
		readonly selectedEndpoint: string | null;
		readonly selectedReadiness: string | null;
		readonly capacityConfirmed: boolean;
		readonly fallbackOccurred: boolean;
	};
	readonly accounting: {
		readonly reservedTokens: number;
		readonly admittedExchanges: number | null;
		readonly reportedPromptTokens: number | null;
		readonly reportedCompletionTokens: number | null;
		readonly usageReportComplete: boolean;
		readonly chargedCompletionRequests: number;
		readonly chargedGeneratedTokens: number;
		readonly inferenceElapsedMs: number | null;
	};
	readonly answer: string | null;
	readonly standing: "untrusted-model-interpretation";
	readonly proposalOutcome: string;
	readonly proposalId: string | null;
	readonly proposalRefusal: string | null;
}

export interface EndoStudioAdvisoryProposalViewV0 {
	readonly proposalId: string;
	readonly kind: string;
	readonly subject: {
		readonly taskId: string | null;
		readonly candidateId: string | null;
		readonly assignmentIds: readonly string[];
	};
	readonly evidenceFacts: readonly string[];
	readonly uncertainties: readonly string[];
	readonly generatedAtMs: number;
	readonly scheduleId: string;
	readonly turnId: string;
	readonly queueState: "pending" | "acknowledged" | "dismissed" | "superseded";
	readonly currency: "current" | "stale" | "unknown";
	readonly decidedAtMs: number | null;
	readonly note: string | null;
	readonly standing: "untrusted-advisory-proposal";
	readonly authorityGrants: "none";
}

export interface EndoCoordinatorStudioOperationsV0 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0;
	readonly readAtMs: number;
	readonly projectId: string;
	readonly standing: "read-only-recorded-operations";
	readonly authority: {
		readonly grants: "none";
		readonly triggersInference: false;
		readonly executesSchedules: false;
		readonly wakesModels: false;
	};
	readonly resources: EndoStudioResourcesSectionV0;
	readonly schedules: {
		readonly observation: {
			readonly state: EndoStudioSourceStateV0;
			readonly detail: string | null;
			readonly scope: "store-observation";
			readonly lease: EndoStudioLeaseViewV0;
			readonly schedules: readonly EndoStudioObservationScheduleViewV0[];
			readonly recentFires: readonly EndoStudioObservationFireViewV0[];
			readonly incompleteCount: number;
			readonly degraded: boolean;
			readonly truncated: boolean;
		};
		readonly advisory: {
			readonly state: EndoStudioSourceStateV0;
			readonly detail: string | null;
			readonly scope: "project-scoped";
			readonly lease: EndoStudioLeaseViewV0;
			readonly schedules: readonly EndoStudioAdvisoryScheduleViewV0[];
			readonly recentFires: readonly EndoStudioAdvisoryFireViewV0[];
			readonly incompleteCount: number;
			readonly degraded: boolean;
		};
	};
	readonly advisoryHistory: {
		readonly standing: "untrusted-model-interpretation";
		readonly authority: {
			readonly grants: "none";
			readonly executionAuthority: false;
			readonly operatorAcceptanceControlsPresent: false;
		};
		readonly state: EndoStudioSourceStateV0;
		readonly degraded: boolean;
		readonly detail: string | null;
		readonly briefings: readonly EndoStudioAdvisoryBriefingViewV0[];
		readonly proposals: readonly EndoStudioAdvisoryProposalViewV0[];
		readonly totals: {
			readonly briefingsCount: number;
			readonly publishedCount: number;
			readonly refusedCount: number;
			readonly withheldCount: number;
			readonly notDispatchedCount: number;
			readonly uncertainTurnsCount: number;
			readonly pendingProposalsCount: number;
			readonly totalProposalsCount: number;
			readonly recordedChargedTokens: number;
			readonly recordedPromptTokens: number | null;
			readonly recordedCompletionTokens: number | null;
			readonly anyUsageIncomplete: boolean;
		};
	};
}

// ---- Strict Runtime Validators (Closed Schemas, Zero Side Effects) -----------------------------------------------------------------

function fail(message: string): never {
	throw new TypeError(`endo.coordinator-studio-operations.v0: ${message}`);
}

function closedObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${label} must be an object`);
	const obj = value as Record<string, unknown>;
	const allowed = new Set(keys);
	for (const k of Object.keys(obj)) {
		if (!allowed.has(k)) fail(`${label} has unknown key ${k}`);
	}
	for (const k of keys) {
		if (!Object.hasOwn(obj, k)) fail(`${label} missing key ${k}`);
	}
	return obj;
}

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isEpochMs = (v: unknown): v is number => isNonNegInt(v) && v <= MAX_EPOCH_MS;
const isSourceState = (v: unknown): v is EndoStudioSourceStateV0 =>
	v === "ready" || v === "absent" || v === "unreadable";
const isFreshness = (v: unknown): v is EndoStudioFreshnessV0 => v === "fresh" || v === "stale" || v === "unknown";
const isNextDue = (v: unknown): v is EndoStudioNextDueStateV0 =>
	v === "due" || v === "not-due" || v === "disabled" || v === "completed-once" || v === "missed";

function str(v: unknown, label: string, re: RegExp = SAFE_SHORT_TEXT): string {
	if (typeof v !== "string" || !re.test(v)) fail(`${label} invalid string`);
	return v;
}
function optStr(v: unknown, label: string, re: RegExp = SAFE_SHORT_TEXT): string | null {
	return v === null ? null : str(v, label, re);
}
function bool(v: unknown, label: string): boolean {
	if (typeof v !== "boolean") fail(`${label} must be boolean`);
	return v;
}
function nonNeg(v: unknown, label: string): number {
	if (!isNonNegInt(v)) fail(`${label} must be non-negative safe integer`);
	return v;
}
function optNonNeg(v: unknown, label: string): number | null {
	return v === null ? null : nonNeg(v, label);
}
function epoch(v: unknown, label: string): number {
	if (!isEpochMs(v)) fail(`${label} invalid epoch`);
	return v;
}
function optEpoch(v: unknown, label: string): number | null {
	return v === null ? null : epoch(v, label);
}
function strArray(v: unknown, label: string, max: number, re: RegExp = SAFE_DETAIL_TEXT): string[] {
	if (!Array.isArray(v) || v.length > max) fail(`${label} must be array (max ${max})`);
	return v.map((item, i) => str(item, `${label}[${i}]`, re));
}

function loopbackOrigin(v: unknown, label: string): string {
	const s = str(v, label, LOOPBACK_ORIGIN_RE);
	const m = LOOPBACK_ORIGIN_RE.exec(s);
	const port = m === null ? 0 : Number(m[1]);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail(`${label} port out of range`);
	return s;
}
function optLoopbackOrigin(v: unknown, label: string): string | null {
	return v === null ? null : loopbackOrigin(v, label);
}
function enumStr(v: unknown, allowed: ReadonlySet<string>, label: string): string {
	if (typeof v !== "string" || !allowed.has(v)) fail(`${label} not in closed vocabulary`);
	return v;
}

function validateLease(v: unknown, label: string): EndoStudioLeaseViewV0 {
	const o = closedObject(v, ["state", "active", "epoch", "expiresAtMs"], label);
	if (!isSourceState(o.state)) fail(`${label}.state invalid`);
	return {
		state: o.state,
		active: bool(o.active, `${label}.active`),
		epoch: optNonNeg(o.epoch, `${label}.epoch`),
		expiresAtMs: optEpoch(o.expiresAtMs, `${label}.expiresAtMs`),
	};
}

export function validateEndoCoordinatorStudioOperationsV0(value: unknown): EndoCoordinatorStudioOperationsV0 {
	const root = closedObject(
		value,
		["schemaVersion", "readAtMs", "projectId", "standing", "authority", "resources", "schedules", "advisoryHistory"],
		"root",
	);
	if (root.schemaVersion !== ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0) fail("schemaVersion mismatch");
	const readAtMs = epoch(root.readAtMs, "readAtMs");
	const projectId = str(root.projectId, "projectId", PROJECT_ID_RE);
	if (root.standing !== "read-only-recorded-operations") fail("standing mismatch");
	const auth = closedObject(
		root.authority,
		["grants", "triggersInference", "executesSchedules", "wakesModels"],
		"authority",
	);
	if (
		auth.grants !== "none" ||
		auth.triggersInference !== false ||
		auth.executesSchedules !== false ||
		auth.wakesModels !== false
	)
		fail("authority violation");

	// Resources
	const res = closedObject(
		root.resources,
		[
			"state",
			"detail",
			"observedAtMs",
			"staleAfterMs",
			"freshness",
			"liveProbed",
			"poolSource",
			"localEndpoints",
			"providers",
			"declarations",
			"hardware",
		],
		"resources",
	);
	if (!isSourceState(res.state)) fail("resources.state invalid");
	if (!isFreshness(res.freshness)) fail("resources.freshness invalid");
	if (res.liveProbed !== false) fail("resources.liveProbed must be false");
	if (
		res.poolSource !== null &&
		res.poolSource !== "file" &&
		res.poolSource !== "m0-default" &&
		res.poolSource !== "none"
	)
		fail("resources.poolSource invalid");
	if (!Array.isArray(res.localEndpoints) || res.localEndpoints.length > 16) fail("resources.localEndpoints invalid");
	const localEndpoints: EndoStudioLocalEndpointViewV0[] = res.localEndpoints.map((item, i) => {
		const o = closedObject(
			item,
			[
				"memberId",
				"endpoint",
				"modelId",
				"readiness",
				"detail",
				"backend",
				"build",
				"observedAtMs",
				"staleAfterMs",
				"freshness",
				"capacityConfirmed",
				"modelIdentityAuthenticated",
				"inferenceTokens",
			],
			`resources.localEndpoints[${i}]`,
		);
		if (o.freshness !== "fresh" && o.freshness !== "stale") fail("endpoint freshness invalid");
		if (o.modelIdentityAuthenticated !== false) fail("modelIdentityAuthenticated must be false");
		if (o.inferenceTokens !== 0) fail("inferenceTokens must be 0");
		const readiness = enumStr(o.readiness, LOCAL_READINESS_SET, "readiness");
		const capacityConfirmed = bool(o.capacityConfirmed, "capacityConfirmed");
		if (capacityConfirmed !== (readiness === "ready")) fail("capacityConfirmed must equal (readiness === 'ready')");
		return {
			memberId: str(o.memberId, "memberId"),
			endpoint: loopbackOrigin(o.endpoint, "endpoint"),
			modelId: str(o.modelId, "modelId"),
			readiness,
			detail: str(o.detail, "detail"),
			backend: enumStr(o.backend, LOCAL_BACKEND_SET, "backend"),
			build: optStr(o.build, "build"),
			observedAtMs: epoch(o.observedAtMs, "observedAtMs"),
			staleAfterMs: nonNeg(o.staleAfterMs, "staleAfterMs"),
			freshness: o.freshness,
			capacityConfirmed,
			modelIdentityAuthenticated: false,
			inferenceTokens: 0,
		};
	});
	if (!Array.isArray(res.providers) || res.providers.length > 32) fail("resources.providers invalid");
	const providers: EndoStudioProviderAllowanceViewV0[] = res.providers.map((item, i) => {
		const o = closedObject(
			item,
			[
				"providerId",
				"surfaceKind",
				"quotaPoolId",
				"standing",
				"effectiveStanding",
				"basis",
				"observedAtMs",
				"staleAfterMs",
				"freshness",
				"windows",
				"localLedgerLowerBound",
			],
			`resources.providers[${i}]`,
		);
		if (o.freshness !== "fresh" && o.freshness !== "stale") fail("provider freshness invalid");
		if (!Array.isArray(o.windows) || o.windows.length > 8) fail("provider windows invalid");
		const windows: EndoStudioAllowanceWindowViewV0[] = o.windows.map((w, wi) => {
			const wo = closedObject(
				w,
				[
					"windowKind",
					"standing",
					"resetAtMs",
					"resetBasis",
					"availabilityConfirmed",
					"remainingEstimate",
					"limitEstimate",
					"unit",
				],
				`provider[${i}].windows[${wi}]`,
			);
			const resetBasis = enumStr(wo.resetBasis, RESET_BASIS_SET, "resetBasis");
			const availabilityConfirmed = bool(wo.availabilityConfirmed, "availabilityConfirmed");
			if (availabilityConfirmed && resetBasis !== "authoritative-api")
				fail("availabilityConfirmed requires authoritative-api resetBasis");
			return {
				windowKind: str(wo.windowKind, "windowKind"),
				standing: enumStr(wo.standing, ALLOWANCE_STANDING_SET, "window.standing"),
				resetAtMs: optEpoch(wo.resetAtMs, "resetAtMs"),
				resetBasis,
				availabilityConfirmed,
				remainingEstimate: optNonNeg(wo.remainingEstimate, "remainingEstimate"),
				limitEstimate: optNonNeg(wo.limitEstimate, "limitEstimate"),
				unit: str(wo.unit, "unit"),
			};
		});
		let lowerBound: { recordedTurns: number; recordedAtMs: number } | null = null;
		if (o.localLedgerLowerBound !== null) {
			const lb = closedObject(o.localLedgerLowerBound, ["recordedTurns", "recordedAtMs"], "localLedgerLowerBound");
			lowerBound = {
				recordedTurns: nonNeg(lb.recordedTurns, "recordedTurns"),
				recordedAtMs: epoch(lb.recordedAtMs, "recordedAtMs"),
			};
		}
		return {
			providerId: str(o.providerId, "providerId"),
			surfaceKind: str(o.surfaceKind, "surfaceKind"),
			quotaPoolId: optStr(o.quotaPoolId, "quotaPoolId"),
			standing: enumStr(o.standing, ALLOWANCE_STANDING_SET, "standing"),
			effectiveStanding: enumStr(o.effectiveStanding, ALLOWANCE_STANDING_SET, "effectiveStanding"),
			basis: enumStr(o.basis, RESOURCE_BASIS_SET, "basis"),
			observedAtMs: epoch(o.observedAtMs, "observedAtMs"),
			staleAfterMs: nonNeg(o.staleAfterMs, "staleAfterMs"),
			freshness: o.freshness,
			windows,
			localLedgerLowerBound: lowerBound,
		};
	});
	const decl = closedObject(res.declarations, ["state", "items"], "resources.declarations");
	if (!isSourceState(decl.state)) fail("declarations.state invalid");
	if (!Array.isArray(decl.items) || decl.items.length > 64) fail("declarations.items invalid");
	const declItems: EndoStudioResourceDeclarationViewV0[] = decl.items.map((item, i) => {
		const o = closedObject(
			item,
			[
				"providerId",
				"surfaceKind",
				"quotaPoolId",
				"windowKind",
				"standing",
				"resetAtMs",
				"declaredAtMs",
				"basis",
				"note",
			],
			`declarations.items[${i}]`,
		);
		if (o.basis !== "operator-declared") fail("declaration basis invalid");
		return {
			providerId: str(o.providerId, "providerId"),
			surfaceKind: str(o.surfaceKind, "surfaceKind"),
			quotaPoolId: optStr(o.quotaPoolId, "quotaPoolId"),
			windowKind: str(o.windowKind, "windowKind"),
			standing: str(o.standing, "standing"),
			resetAtMs: epoch(o.resetAtMs, "resetAtMs"),
			declaredAtMs: epoch(o.declaredAtMs, "declaredAtMs"),
			basis: "operator-declared",
			note: optStr(o.note, "note", SAFE_DETAIL_TEXT),
		};
	});
	let hardware: EndoStudioResourcesSectionV0["hardware"] = null;
	if (res.hardware !== null) {
		const hw = closedObject(res.hardware, ["mode", "observedAtMs", "staleAfterMs", "devices"], "resources.hardware");
		if (!Array.isArray(hw.devices) || hw.devices.length > 16) fail("hardware.devices invalid");
		hardware = {
			mode: str(hw.mode, "hardware.mode"),
			observedAtMs: epoch(hw.observedAtMs, "hardware.observedAtMs"),
			staleAfterMs: nonNeg(hw.staleAfterMs, "hardware.staleAfterMs"),
			devices: hw.devices.map((d, di) => {
				const do_ = closedObject(
					d,
					[
						"deviceId",
						"kind",
						"backendFamily",
						"label",
						"memoryTotalBytes",
						"memoryUsedBytes",
						"memoryFreeBytes",
						"memoryBasis",
						"attributedModelMemberIds",
						"sharedDeviceContention",
					],
					`hardware.devices[${di}]`,
				);
				return {
					deviceId: str(do_.deviceId, "deviceId"),
					kind: str(do_.kind, "kind"),
					backendFamily: optStr(do_.backendFamily, "backendFamily"),
					label: optStr(do_.label, "label"),
					memoryTotalBytes: optNonNeg(do_.memoryTotalBytes, "memoryTotalBytes"),
					memoryUsedBytes: optNonNeg(do_.memoryUsedBytes, "memoryUsedBytes"),
					memoryFreeBytes: optNonNeg(do_.memoryFreeBytes, "memoryFreeBytes"),
					memoryBasis: str(do_.memoryBasis, "memoryBasis"),
					attributedModelMemberIds: strArray(do_.attributedModelMemberIds, "attributedModelMemberIds", 32),
					sharedDeviceContention: str(do_.sharedDeviceContention, "sharedDeviceContention"),
				};
			}),
		};
	}

	// Schedules
	const schedRoot = closedObject(root.schedules, ["observation", "advisory"], "schedules");
	const obsS = closedObject(
		schedRoot.observation,
		["state", "detail", "scope", "lease", "schedules", "recentFires", "incompleteCount", "degraded", "truncated"],
		"schedules.observation",
	);
	if (!isSourceState(obsS.state) || obsS.scope !== "store-observation") fail("schedules.observation invalid");
	if (!Array.isArray(obsS.schedules) || obsS.schedules.length > 64) fail("observation.schedules invalid");
	const obsSchedules: EndoStudioObservationScheduleViewV0[] = obsS.schedules.map((s, i) => {
		const o = closedObject(
			s,
			[
				"scheduleId",
				"label",
				"revision",
				"enabled",
				"actionKind",
				"missedRunPolicy",
				"triggerSummary",
				"nextDueState",
				"nextWindowStartMs",
				"lastEvaluatedAtMs",
				"lastFireStatus",
			],
			`observation.schedules[${i}]`,
		);
		if (!isNextDue(o.nextDueState)) fail("observation.schedules.nextDueState invalid");
		return {
			scheduleId: str(o.scheduleId, "scheduleId"),
			label: optStr(o.label, "label"),
			revision: nonNeg(o.revision, "revision"),
			enabled: bool(o.enabled, "enabled"),
			actionKind: enumStr(o.actionKind, S1_ACTION_SET, "actionKind"),
			missedRunPolicy: str(o.missedRunPolicy, "missedRunPolicy"),
			triggerSummary: str(o.triggerSummary, "triggerSummary"),
			nextDueState: o.nextDueState,
			nextWindowStartMs: optEpoch(o.nextWindowStartMs, "nextWindowStartMs"),
			lastEvaluatedAtMs: optEpoch(o.lastEvaluatedAtMs, "lastEvaluatedAtMs"),
			lastFireStatus: optStr(o.lastFireStatus, "lastFireStatus"),
		};
	});
	if (!Array.isArray(obsS.recentFires) || obsS.recentFires.length > 32) fail("observation.recentFires invalid");
	const obsFires: EndoStudioObservationFireViewV0[] = obsS.recentFires.map((f, i) => {
		const o = closedObject(
			f,
			[
				"idempotencyKey",
				"scheduleId",
				"scheduleRevision",
				"actionKind",
				"windowStartMs",
				"state",
				"claimedAtMs",
				"completedAtMs",
				"missedWindowCount",
				"tokensConsumed",
				"detail",
			],
			`observation.recentFires[${i}]`,
		);
		if (o.tokensConsumed !== 0) fail("observation fire tokensConsumed must be 0");
		return {
			idempotencyKey: str(o.idempotencyKey, "idempotencyKey"),
			scheduleId: str(o.scheduleId, "scheduleId"),
			scheduleRevision: nonNeg(o.scheduleRevision, "scheduleRevision"),
			actionKind: str(o.actionKind, "actionKind"),
			windowStartMs: epoch(o.windowStartMs, "windowStartMs"),
			state: str(o.state, "state"),
			claimedAtMs: optEpoch(o.claimedAtMs, "claimedAtMs"),
			completedAtMs: optEpoch(o.completedAtMs, "completedAtMs"),
			missedWindowCount: nonNeg(o.missedWindowCount, "missedWindowCount"),
			tokensConsumed: 0,
			detail: optStr(o.detail, "detail", SAFE_DETAIL_TEXT),
		};
	});

	const advS = closedObject(
		schedRoot.advisory,
		["state", "detail", "scope", "lease", "schedules", "recentFires", "incompleteCount", "degraded"],
		"schedules.advisory",
	);
	if (!isSourceState(advS.state) || advS.scope !== "project-scoped") fail("schedules.advisory invalid");
	if (!Array.isArray(advS.schedules) || advS.schedules.length > 64) fail("advisory.schedules invalid");
	const advSchedules: EndoStudioAdvisoryScheduleViewV0[] = advS.schedules.map((s, i) => {
		const o = closedObject(
			s,
			[
				"scheduleId",
				"label",
				"revision",
				"enabled",
				"actionKind",
				"wake",
				"missedRunPolicy",
				"triggerSummary",
				"nextDueState",
				"nextWindowStartMs",
				"authorization",
				"budget",
				"lastEvaluatedAtMs",
				"lastAttemptedAtMs",
				"lastConsideredAtMs",
				"lastFireStatus",
			],
			`advisory.schedules[${i}]`,
		);
		if (!isNextDue(o.nextDueState)) fail("advisory.schedules.nextDueState invalid");
		const ao = closedObject(o.authorization, ["ok", "status", "expiresAtMs", "revocation"], "authorization");
		let budget: EndoStudioAdvisoryScheduleViewV0["budget"] = null;
		if (o.budget !== null) {
			const bo = closedObject(
				o.budget,
				[
					"admissible",
					"refusal",
					"periodMs",
					"turnsCharged",
					"maxTurnsPerPeriod",
					"generatedTokensCharged",
					"maxGeneratedTokensPerPeriod",
					"uncertainTurns",
				],
				"budget",
			);
			budget = {
				admissible: bool(bo.admissible, "budget.admissible"),
				refusal: optStr(bo.refusal, "budget.refusal"),
				periodMs: nonNeg(bo.periodMs, "budget.periodMs"),
				turnsCharged: nonNeg(bo.turnsCharged, "budget.turnsCharged"),
				maxTurnsPerPeriod: nonNeg(bo.maxTurnsPerPeriod, "budget.maxTurnsPerPeriod"),
				generatedTokensCharged: nonNeg(bo.generatedTokensCharged, "budget.generatedTokensCharged"),
				maxGeneratedTokensPerPeriod: nonNeg(bo.maxGeneratedTokensPerPeriod, "budget.maxGeneratedTokensPerPeriod"),
				uncertainTurns: nonNeg(bo.uncertainTurns, "budget.uncertainTurns"),
			};
		}
		return {
			scheduleId: str(o.scheduleId, "scheduleId"),
			label: optStr(o.label, "label"),
			revision: nonNeg(o.revision, "revision"),
			enabled: bool(o.enabled, "enabled"),
			actionKind: enumStr(o.actionKind, S2_ACTION_SET, "actionKind"),
			wake: enumStr(o.wake, S2_WAKE_SET, "wake"),
			missedRunPolicy: str(o.missedRunPolicy, "missedRunPolicy"),
			triggerSummary: str(o.triggerSummary, "triggerSummary"),
			nextDueState: o.nextDueState,
			nextWindowStartMs: optEpoch(o.nextWindowStartMs, "nextWindowStartMs"),
			authorization: {
				ok: bool(ao.ok, "authorization.ok"),
				status: str(ao.status, "authorization.status"),
				expiresAtMs: optEpoch(ao.expiresAtMs, "authorization.expiresAtMs"),
				revocation: optStr(ao.revocation, "authorization.revocation"),
			},
			budget,
			lastEvaluatedAtMs: optEpoch(o.lastEvaluatedAtMs, "lastEvaluatedAtMs"),
			lastAttemptedAtMs: optEpoch(o.lastAttemptedAtMs, "lastAttemptedAtMs"),
			lastConsideredAtMs: optEpoch(o.lastConsideredAtMs, "lastConsideredAtMs"),
			lastFireStatus: optStr(o.lastFireStatus, "lastFireStatus"),
		};
	});
	if (!Array.isArray(advS.recentFires) || advS.recentFires.length > 32) fail("advisory.recentFires invalid");
	const advFires: EndoStudioAdvisoryFireViewV0[] = advS.recentFires.map((f, i) => {
		const o = closedObject(
			f,
			[
				"idempotencyKey",
				"scheduleId",
				"scheduleRevision",
				"actionKind",
				"windowStartMs",
				"state",
				"outcomeStatus",
				"claimedAtMs",
				"completedAtMs",
				"missedWindowCount",
				"turnId",
				"inferenceDispatched",
				"detail",
			],
			`advisory.recentFires[${i}]`,
		);
		if (o.state !== "claimed-incomplete" && o.state !== "completed" && o.state !== "orphan-outcome")
			fail("advisory fire state invalid");
		if (o.inferenceDispatched !== "yes" && o.inferenceDispatched !== "no" && o.inferenceDispatched !== "unknown")
			fail("advisory fire inferenceDispatched invalid");
		return {
			idempotencyKey: str(o.idempotencyKey, "idempotencyKey"),
			scheduleId: str(o.scheduleId, "scheduleId"),
			scheduleRevision: nonNeg(o.scheduleRevision, "scheduleRevision"),
			actionKind: str(o.actionKind, "actionKind"),
			windowStartMs: epoch(o.windowStartMs, "windowStartMs"),
			state: o.state,
			outcomeStatus: optStr(o.outcomeStatus, "outcomeStatus"),
			claimedAtMs: optEpoch(o.claimedAtMs, "claimedAtMs"),
			completedAtMs: optEpoch(o.completedAtMs, "completedAtMs"),
			missedWindowCount: nonNeg(o.missedWindowCount, "missedWindowCount"),
			turnId: optStr(o.turnId, "turnId"),
			inferenceDispatched: o.inferenceDispatched,
			detail: optStr(o.detail, "detail", SAFE_DETAIL_TEXT),
		};
	});

	// Advisory history
	const hist = closedObject(
		root.advisoryHistory,
		["standing", "authority", "state", "degraded", "detail", "briefings", "proposals", "totals"],
		"advisoryHistory",
	);
	if (hist.standing !== "untrusted-model-interpretation") fail("advisoryHistory.standing mismatch");
	const ha = closedObject(
		hist.authority,
		["grants", "executionAuthority", "operatorAcceptanceControlsPresent"],
		"advisoryHistory.authority",
	);
	if (ha.grants !== "none" || ha.executionAuthority !== false || ha.operatorAcceptanceControlsPresent !== false)
		fail("advisoryHistory.authority violation");
	if (!isSourceState(hist.state)) fail("advisoryHistory.state invalid");
	if (!Array.isArray(hist.briefings) || hist.briefings.length > 32) fail("advisoryHistory.briefings invalid");
	const briefings: EndoStudioAdvisoryBriefingViewV0[] = hist.briefings.map((b, i) => {
		const o = closedObject(
			b,
			[
				"turnId",
				"scheduleId",
				"scheduleRevision",
				"actionKind",
				"wakeReason",
				"admittedAtMs",
				"publishedAtMs",
				"availability",
				"refusal",
				"currency",
				"completeness",
				"gaps",
				"model",
				"accounting",
				"answer",
				"standing",
				"proposalOutcome",
				"proposalId",
				"proposalRefusal",
			],
			`briefings[${i}]`,
		);
		if (
			o.availability !== "available" &&
			o.availability !== "unavailable" &&
			o.availability !== "withheld" &&
			o.availability !== "not-dispatched"
		)
			fail("briefing availability invalid");
		if (
			o.currency !== "current-at-publication" &&
			o.currency !== "stale-at-publication" &&
			o.currency !== "unknown-at-publication"
		)
			fail("briefing currency invalid");
		if (o.standing !== "untrusted-model-interpretation") fail("briefing standing invalid");
		const m = closedObject(
			o.model,
			[
				"harness",
				"provider",
				"reportedModel",
				"selectedMemberId",
				"selectedModelId",
				"selectedEndpoint",
				"selectedReadiness",
				"capacityConfirmed",
				"fallbackOccurred",
			],
			`briefings[${i}].model`,
		);
		const ac = closedObject(
			o.accounting,
			[
				"reservedTokens",
				"admittedExchanges",
				"reportedPromptTokens",
				"reportedCompletionTokens",
				"usageReportComplete",
				"chargedCompletionRequests",
				"chargedGeneratedTokens",
				"inferenceElapsedMs",
			],
			`briefings[${i}].accounting`,
		);
		return {
			turnId: str(o.turnId, "turnId"),
			scheduleId: str(o.scheduleId, "scheduleId"),
			scheduleRevision: nonNeg(o.scheduleRevision, "scheduleRevision"),
			actionKind: str(o.actionKind, "actionKind"),
			wakeReason: str(o.wakeReason, "wakeReason"),
			admittedAtMs: epoch(o.admittedAtMs, "admittedAtMs"),
			publishedAtMs: epoch(o.publishedAtMs, "publishedAtMs"),
			availability: o.availability,
			refusal: optStr(o.refusal, "refusal"),
			currency: o.currency,
			completeness: str(o.completeness, "completeness"),
			gaps: strArray(o.gaps, "gaps", 32),
			model: {
				harness: str(m.harness, "harness"),
				provider: str(m.provider, "provider"),
				reportedModel: str(m.reportedModel, "reportedModel"),
				selectedMemberId: optStr(m.selectedMemberId, "selectedMemberId"),
				selectedModelId: optStr(m.selectedModelId, "selectedModelId"),
				selectedEndpoint: optLoopbackOrigin(m.selectedEndpoint, "selectedEndpoint"),
				selectedReadiness: optStr(m.selectedReadiness, "selectedReadiness"),
				capacityConfirmed: bool(m.capacityConfirmed, "capacityConfirmed"),
				fallbackOccurred: bool(m.fallbackOccurred, "fallbackOccurred"),
			},
			accounting: {
				reservedTokens: nonNeg(ac.reservedTokens, "reservedTokens"),
				admittedExchanges: optNonNeg(ac.admittedExchanges, "admittedExchanges"),
				reportedPromptTokens: optNonNeg(ac.reportedPromptTokens, "reportedPromptTokens"),
				reportedCompletionTokens: optNonNeg(ac.reportedCompletionTokens, "reportedCompletionTokens"),
				usageReportComplete: bool(ac.usageReportComplete, "usageReportComplete"),
				chargedCompletionRequests: nonNeg(ac.chargedCompletionRequests, "chargedCompletionRequests"),
				chargedGeneratedTokens: nonNeg(ac.chargedGeneratedTokens, "chargedGeneratedTokens"),
				inferenceElapsedMs: optNonNeg(ac.inferenceElapsedMs, "inferenceElapsedMs"),
			},
			answer: optStr(o.answer, "answer", SAFE_ANSWER_TEXT),
			standing: "untrusted-model-interpretation",
			proposalOutcome: str(o.proposalOutcome, "proposalOutcome"),
			proposalId: optStr(o.proposalId, "proposalId"),
			proposalRefusal: optStr(o.proposalRefusal, "proposalRefusal"),
		};
	});
	if (!Array.isArray(hist.proposals) || hist.proposals.length > 64) fail("advisoryHistory.proposals invalid");
	const proposals: EndoStudioAdvisoryProposalViewV0[] = hist.proposals.map((p, i) => {
		const o = closedObject(
			p,
			[
				"proposalId",
				"kind",
				"subject",
				"evidenceFacts",
				"uncertainties",
				"generatedAtMs",
				"scheduleId",
				"turnId",
				"queueState",
				"currency",
				"decidedAtMs",
				"note",
				"standing",
				"authorityGrants",
			],
			`proposals[${i}]`,
		);
		if (
			o.queueState !== "pending" &&
			o.queueState !== "acknowledged" &&
			o.queueState !== "dismissed" &&
			o.queueState !== "superseded"
		)
			fail("proposal queueState invalid");
		if (o.currency !== "current" && o.currency !== "stale" && o.currency !== "unknown")
			fail("proposal currency invalid");
		if (o.standing !== "untrusted-advisory-proposal" || o.authorityGrants !== "none")
			fail("proposal standing/authority invalid");
		const sub = closedObject(o.subject, ["taskId", "candidateId", "assignmentIds"], `proposals[${i}].subject`);
		return {
			proposalId: str(o.proposalId, "proposalId"),
			kind: enumStr(o.kind, S2_PROPOSAL_KIND_SET, "proposal.kind"),
			subject: {
				taskId: optStr(sub.taskId, "subject.taskId"),
				candidateId: optStr(sub.candidateId, "subject.candidateId"),
				assignmentIds: strArray(sub.assignmentIds, "subject.assignmentIds", 16),
			},
			evidenceFacts: strArray(o.evidenceFacts, "evidenceFacts", 16),
			uncertainties: strArray(o.uncertainties, "uncertainties", 16),
			generatedAtMs: epoch(o.generatedAtMs, "generatedAtMs"),
			scheduleId: str(o.scheduleId, "scheduleId"),
			turnId: str(o.turnId, "turnId"),
			queueState: o.queueState,
			currency: o.currency,
			decidedAtMs: optEpoch(o.decidedAtMs, "decidedAtMs"),
			note: optStr(o.note, "note", SAFE_DETAIL_TEXT),
			standing: "untrusted-advisory-proposal",
			authorityGrants: "none",
		};
	});
	const totalsObj = closedObject(
		hist.totals,
		[
			"briefingsCount",
			"publishedCount",
			"refusedCount",
			"withheldCount",
			"notDispatchedCount",
			"uncertainTurnsCount",
			"pendingProposalsCount",
			"totalProposalsCount",
			"recordedChargedTokens",
			"recordedPromptTokens",
			"recordedCompletionTokens",
			"anyUsageIncomplete",
		],
		"advisoryHistory.totals",
	);
	const briefingsCount = nonNeg(totalsObj.briefingsCount, "briefingsCount");
	const publishedCount = nonNeg(totalsObj.publishedCount, "publishedCount");
	const refusedCount = nonNeg(totalsObj.refusedCount, "refusedCount");
	const withheldCount = nonNeg(totalsObj.withheldCount, "withheldCount");
	const notDispatchedCount = nonNeg(totalsObj.notDispatchedCount, "notDispatchedCount");
	const uncertainTurnsCount = nonNeg(totalsObj.uncertainTurnsCount, "uncertainTurnsCount");
	const pendingProposalsCount = nonNeg(totalsObj.pendingProposalsCount, "pendingProposalsCount");
	const totalProposalsCount = nonNeg(totalsObj.totalProposalsCount, "totalProposalsCount");
	if (publishedCount + refusedCount + withheldCount + notDispatchedCount !== briefingsCount)
		fail("briefing totals breakdown does not sum to briefingsCount");
	if (pendingProposalsCount > totalProposalsCount) fail("pendingProposalsCount exceeds totalProposalsCount");

	return {
		schemaVersion: ENDO_COORDINATOR_STUDIO_OPERATIONS_SCHEMA_V0,
		readAtMs,
		projectId,
		standing: "read-only-recorded-operations",
		authority: {
			grants: "none",
			triggersInference: false,
			executesSchedules: false,
			wakesModels: false,
		},
		resources: {
			state: res.state,
			detail: optStr(res.detail, "resources.detail", SAFE_DETAIL_TEXT),
			observedAtMs: optEpoch(res.observedAtMs, "resources.observedAtMs"),
			staleAfterMs: optNonNeg(res.staleAfterMs, "resources.staleAfterMs"),
			freshness: res.freshness,
			liveProbed: false,
			poolSource: res.poolSource,
			localEndpoints,
			providers,
			declarations: { state: decl.state, items: declItems },
			hardware,
		},
		schedules: {
			observation: {
				state: obsS.state,
				detail: optStr(obsS.detail, "observation.detail", SAFE_DETAIL_TEXT),
				scope: "store-observation",
				lease: validateLease(obsS.lease, "observation.lease"),
				schedules: obsSchedules,
				recentFires: obsFires,
				incompleteCount: nonNeg(obsS.incompleteCount, "observation.incompleteCount"),
				degraded: bool(obsS.degraded, "observation.degraded"),
				truncated: bool(obsS.truncated, "observation.truncated"),
			},
			advisory: {
				state: advS.state,
				detail: optStr(advS.detail, "advisory.detail", SAFE_DETAIL_TEXT),
				scope: "project-scoped",
				lease: validateLease(advS.lease, "advisory.lease"),
				schedules: advSchedules,
				recentFires: advFires,
				incompleteCount: nonNeg(advS.incompleteCount, "advisory.incompleteCount"),
				degraded: bool(advS.degraded, "advisory.degraded"),
			},
		},
		advisoryHistory: {
			standing: "untrusted-model-interpretation",
			authority: {
				grants: "none",
				executionAuthority: false,
				operatorAcceptanceControlsPresent: false,
			},
			state: hist.state,
			degraded: bool(hist.degraded, "advisoryHistory.degraded"),
			detail: optStr(hist.detail, "advisoryHistory.detail", SAFE_DETAIL_TEXT),
			briefings,
			proposals,
			totals: {
				briefingsCount,
				publishedCount,
				refusedCount,
				withheldCount,
				notDispatchedCount,
				uncertainTurnsCount,
				pendingProposalsCount,
				totalProposalsCount,
				recordedChargedTokens: nonNeg(totalsObj.recordedChargedTokens, "recordedChargedTokens"),
				recordedPromptTokens: optNonNeg(totalsObj.recordedPromptTokens, "recordedPromptTokens"),
				recordedCompletionTokens: optNonNeg(totalsObj.recordedCompletionTokens, "recordedCompletionTokens"),
				anyUsageIncomplete: bool(totalsObj.anyUsageIncomplete, "anyUsageIncomplete"),
			},
		},
	};
}
