// COORDINATOR-REASONING-001 acceptance & adversarial test suite (§14).
// Every endpoint here is a deterministic fake on an ephemeral 127.0.0.1 port; zero live model inference is performed.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	pooledCoordinatorV0,
	readCoordinatorModelPoolFileAnyV1,
	readCoordinatorModelPoolFileV0,
	readCoordinatorResourceProfileFileV1,
} from "../adapters/coordinator/model-pool.ts";
import {
	coordinatorInferenceForV0,
	coordinatorRelayPolicyV0,
	coordinatorTargetFromMemberV0,
	type EndoCoordinatorModelTargetV0,
} from "../adapters/coordinator/model-relay.ts";
import { preflightOpenClawCoordinatorV0, runOpenClawCoordinatorV0 } from "../adapters/coordinator/openclaw.ts";
import { COORDINATOR_ENV_V0, coordinatorBwrapV0 } from "../adapters/coordinator/status.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0 } from "../adapters/coordinator/wire.ts";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	revokeEndoAdvisoryAuthorizationV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
	parseEndoCoordinatorModelPoolAnyV1,
	parseEndoCoordinatorModelPoolV0,
	parseEndoCoordinatorModelPoolV1,
} from "../protocol/coordinator-model-pool.ts";
import {
	ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1,
	ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1,
	ENDO_COORDINATOR_RESOURCE_TIER_CEILINGS_V1,
	type EndoCoordinatorResourceProfileV1,
	type EndoCoordinatorResourceTierV1,
	presetEndoCoordinatorResourceProfileV1,
	validateEndoCoordinatorReasoningControlV1,
	validateEndoCoordinatorResourceProfileV1,
} from "../protocol/coordinator-resource-policy.ts";
import {
	ENDO_ADVISORY_LIMITS_V0,
	validateEndoAdvisoryAuthorizationV0,
	validateEndoAdvisoryBudgetV0,
	validateEndoAdvisoryLeaseV0,
	validateEndoAdvisoryTurnAdmissionV0,
	validateEndoAdvisoryTurnDispatchV0,
} from "../protocol/develop-advisory.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	validateEndoDevelopAutomationLeaseV0,
} from "../protocol/develop-automation.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_COORDINATOR_TOOL_V0 } from "../runtime/contracts/coordinator-brief.ts";
import { ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1 } from "../runtime/contracts/coordinator-grounding.ts";
import {
	coordinatorModelPoolSha256V0,
	type EndoCoordinatorMemberObservationV0,
	endoCoordinatorResourceProfileSha256V1,
} from "../runtime/contracts/coordinator-model-pool.ts";
import {
	endoAdvisoryAuthorizationIdV0,
	endoAdvisoryAuthorizationStandingV0,
	endoAdvisoryBudgetStandingV0,
	endoAdvisoryEffectivePoolV0,
} from "../runtime/contracts/develop-advisory.ts";
import { DevelopAdvisoryStoreV0 } from "../storage/develop-advisory.ts";
import { createBriefFixtureV0 } from "./coordinator-brief-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const PROJECT_ID = `endo.project.${"a".repeat(32)}`;
const BASE_TIME = Date.parse("2026-11-27T12:00:00.000Z");

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-r001-"));
	dirs.push(dir);
	return dir;
};

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const close of closers.splice(0)) await close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeMember(
	endpoint: string,
	overrides: Partial<{
		memberId: string;
		modelId: string;
		maxOutputTokens: number;
		timeoutMs: number;
		priority: number;
	}> = {},
) {
	return {
		memberId: overrides.memberId ?? "local-primary",
		kind: "local-openai-compat" as const,
		endpoint,
		modelId: overrides.modelId ?? "Inkling-2-Mini-Uncensored-AD-Q4_K",
		priority: overrides.priority ?? 100,
		maxPromptBytes: 8192,
		maxOutputTokens: overrides.maxOutputTokens ?? 2048,
		timeoutMs: overrides.timeoutMs ?? 135_000,
		advisoryOnly: true as const,
	};
}

function makeV0Pool(endpoint = "http://127.0.0.1:8091", maxOutputTokens = 2048, timeoutMs = 135_000) {
	return parseEndoCoordinatorModelPoolV0({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
		selection: { fallback: "none", unconfirmedModel: "permit" },
		members: [makeMember(endpoint, { maxOutputTokens, timeoutMs })],
	});
}

function makeV1Pool(
	profile: EndoCoordinatorResourceProfileV1,
	endpoint = "http://127.0.0.1:8091",
	overrides: { maxOutputTokens?: number; timeoutMs?: number; modelId?: string } = {},
) {
	return parseEndoCoordinatorModelPoolV1({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
		selection: { fallback: "none", unconfirmedModel: "permit" },
		resourceProfile: profile,
		members: [
			makeMember(endpoint, {
				modelId: overrides.modelId,
				maxOutputTokens: overrides.maxOutputTokens ?? profile.maxOutputTokensPerRequest,
				timeoutMs: overrides.timeoutMs ?? profile.modelExecutionTimeoutMs,
			}),
		],
	});
}

function makePolicy() {
	return {
		permitCapacityUnknown: true,
		permitModelUnconfirmed: true,
		permitPartialObservation: true,
		observationSource: "recorded-or-passive-probe" as const,
		recordedObservationMaxAgeMs: 600_000,
	};
}

function makeBudget(profile?: EndoCoordinatorResourceProfileV1) {
	const maxOut = profile?.maxOutputTokensPerRequest ?? 2048;
	const turnMs = profile?.advisoryTurnDeadlineMs ?? 180_000;
	return validateEndoAdvisoryBudgetV0(
		{
			periodMs: 3_600_000,
			maxTurnsPerPeriod: 4,
			completionRequestsPerTurn: 2,
			maxOutputTokensPerRequest: maxOut,
			maxGeneratedTokensPerPeriod: 4 * 2 * maxOut,
			maxTurnWallClockMs: turnMs,
		},
		"budget",
		profile,
	);
}

function readyObserver(now: () => number) {
	return async (member: {
		memberId: string;
		endpoint: string;
		modelId: string;
	}): Promise<EndoCoordinatorMemberObservationV0> => ({
		memberId: member.memberId,
		endpoint: member.endpoint,
		modelId: member.modelId,
		basis: "controller-observed",
		observedAtMs: now(),
		elapsedMs: 1,
		readiness: "ready",
		detail: "slot-idle",
		backend: "llama.cpp-single",
		build: "b12622-test",
		requests: [{ path: "/health", status: 200 }],
		inferenceTokens: 0,
	});
}

async function startFakeServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
	const requests: { method: string; url: string; body: string; json: Record<string, unknown> | null }[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks).toString("utf8");
		let json: Record<string, unknown> | null = null;
		try {
			const parsed = JSON.parse(body);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
		} catch {
			// non-json
		}
		requests.push({ method: req.method ?? "", url: req.url ?? "", body, json });
		handler(req, res, body);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, port, requests };
}

function sseChunk(
	delta: Record<string, unknown>,
	finishReason: string | null,
	model: string,
	usage?: Record<string, unknown>,
): string {
	const lines: string[] = [];
	lines.push(
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta, finish_reason: null }],
		})}\n\n`,
	);
	lines.push(
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			model,
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			...(usage === undefined ? {} : { usage }),
		})}\n\n`,
	);
	lines.push("data: [DONE]\n\n");
	return lines.join("");
}

describe("COORDINATOR-REASONING-001 governed resource policy (§14)", () => {
	it("1. V0 pools without explicit V1 resource profile keep exact V0 ceilings (<= 2048 tokens, <= 135 s)", () => {
		const validV0 = makeV0Pool();
		expect(validV0.members[0]?.maxOutputTokens).toBe(2048);
		expect(validV0.members[0]?.timeoutMs).toBe(135_000);

		expect(() => makeV0Pool("http://127.0.0.1:8091", 2049, 135_000)).toThrow(/2048/);
		expect(() => makeV0Pool("http://127.0.0.1:8091", 4096, 135_000)).toThrow(/2048/);
		expect(() => makeV0Pool("http://127.0.0.1:8091", 2048, 135_001)).toThrow(/135000/);
		expect(() =>
			parseEndoCoordinatorModelPoolAnyV1({
				schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
				selection: { fallback: "none", unconfirmedModel: "permit" },
				members: [makeMember("http://127.0.0.1:8091", { maxOutputTokens: 16_384, timeoutMs: 720_000 })],
			}),
		).toThrow(/2048/);
	});

	it("2. V0 S2 authorizations and S1 leases keep exact V0 limits and digest compatibility", () => {
		const pool = makeV0Pool();
		const policy = makePolicy();
		const budget = makeBudget();
		const baseGrant = {
			scheduleId: "sched-v0",
			scheduleIncarnation: "1".repeat(64),
			scheduleRevision: 2,
			projectId: PROJECT_ID,
			actionKind: "generate-advisory-brief" as const,
			poolSha256: coordinatorModelPoolSha256V0(pool),
			policy,
			budget,
			grantedAtMs: BASE_TIME,
			expiresAtMs: BASE_TIME + 3_600_000,
		};
		const id = endoAdvisoryAuthorizationIdV0(baseGrant);
		const auth = validateEndoAdvisoryAuthorizationV0({
			authorizationId: id,
			...baseGrant,
			pool,
			revokedAtMs: null,
			revocation: null,
		});
		expect(auth.resourceProfile).toBeUndefined();
		expect(auth.resourceProfileSha256).toBeUndefined();

		// V0 budget without resourceProfile still rejects > 2048 tokens or > 240 s turn timeout
		expect(() =>
			validateEndoAdvisoryBudgetV0({
				periodMs: 3_600_000,
				maxTurnsPerPeriod: 1,
				completionRequestsPerTurn: 2,
				maxOutputTokensPerRequest: 4096,
				maxGeneratedTokensPerPeriod: 8192,
				maxTurnWallClockMs: 180_000,
			}),
		).toThrow(/2048/);
		expect(() =>
			validateEndoAdvisoryBudgetV0({
				periodMs: 3_600_000,
				maxTurnsPerPeriod: 1,
				completionRequestsPerTurn: 2,
				maxOutputTokensPerRequest: 2048,
				maxGeneratedTokensPerPeriod: 4096,
				maxTurnWallClockMs: 240_001,
			}),
		).toThrow(/240000/);

		// S1 lease validator remains strictly capped at 300,000 ms while S2 advisory lease accepts up to 1,200,000 ms
		const extendedLease = {
			schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
			holderId: "holder-1",
			epoch: 1,
			acquiredAtMs: BASE_TIME,
			expiresAtMs: BASE_TIME + 840_000,
			releasedAtMs: null,
		};
		expect(() => validateEndoDevelopAutomationLeaseV0(extendedLease)).toThrow(/300000/);
		expect(validateEndoAdvisoryLeaseV0(extendedLease).expiresAtMs).toBe(BASE_TIME + 840_000);
		expect(() => validateEndoAdvisoryLeaseV0({ ...extendedLease, expiresAtMs: BASE_TIME + 1_200_001 })).toThrow(
			/1200000/,
		);
	});

	it("3. All five cognitive tiers validate strictly and enforce deadline/lease/context/answer-byte invariants", () => {
		for (const tier of ["reflex", "light", "deliberate", "deep", "extended"] as const) {
			const profile = presetEndoCoordinatorResourceProfileV1(tier);
			expect(profile.schemaVersion).toBe(ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1);
			expect(profile.tier).toBe(tier);
			expect(profile.maxAnswerBytes).toBe(4096);
			expect(profile.desiredVisibleAnswerTokensAdvisoryOnly).toBe(true);
			const ceiling = ENDO_COORDINATOR_RESOURCE_TIER_CEILINGS_V1[tier];
			expect(profile.maxOutputTokensPerRequest).toBe(ceiling.maxOutputTokensPerRequest);
			if (tier === "reflex") {
				expect(profile.completionRequestsPerTurn).toBe(0);
				expect(profile.maxAggregateGeneratedTokensPerTurn).toBe(0);
			} else {
				expect(profile.completionRequestsPerTurn).toBe(2);
				expect(profile.advisoryLeaseTtlMs).toBeGreaterThanOrEqual(
					profile.advisoryTurnDeadlineMs + profile.publicationReserveMs,
				);
				expect(profile.advisoryTurnDeadlineMs).toBeGreaterThanOrEqual(profile.modelExecutionTimeoutMs);
				expect(profile.contextWindowTokens).toBeGreaterThanOrEqual(profile.maxOutputTokensPerRequest + 8192);
			}
		}

		// Invalid profile mutations must fail closed
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		expect(() => validateEndoCoordinatorResourceProfileV1({ ...deep, maxOutputTokensPerRequest: 16_385 })).toThrow();
		expect(() => validateEndoCoordinatorResourceProfileV1({ ...deep, maxAnswerBytes: 8192 })).toThrow();
		expect(() =>
			validateEndoCoordinatorResourceProfileV1({ ...deep, desiredVisibleAnswerTokensAdvisoryOnly: false }),
		).toThrow();
		expect(() =>
			validateEndoCoordinatorResourceProfileV1({
				...deep,
				advisoryLeaseTtlMs: deep.advisoryTurnDeadlineMs + 10_000,
			}),
		).toThrow();
		expect(() => validateEndoCoordinatorResourceProfileV1({ ...deep, publicationReserveMs: 19_999 })).toThrow();
		expect(() =>
			validateEndoCoordinatorResourceProfileV1({
				...deep,
				modelExecutionTimeoutMs: 720_000,
				advisoryTurnDeadlineMs: 700_000,
			}),
		).toThrow();
		expect(() => validateEndoCoordinatorResourceProfileV1({ ...deep, unknownField: 1 })).toThrow(/unknown field/);
	});

	it("4. Reflex tier authorizes zero inference and is refused for pools, grants, and targets", () => {
		const reflex = presetEndoCoordinatorResourceProfileV1("reflex");
		expect(() =>
			parseEndoCoordinatorModelPoolV1({
				schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
				selection: { fallback: "none", unconfirmedModel: "permit" },
				resourceProfile: reflex,
				members: [makeMember("http://127.0.0.1:8091")],
			}),
		).toThrow(/reflex/);
		expect(() => coordinatorTargetFromMemberV0(makeMember("http://127.0.0.1:8091"), reflex)).toThrow(/reflex/);
		expect(() => validateEndoAdvisoryBudgetV0(makeBudget(), "budget", reflex)).toThrow(/reflex/);
	});

	it("5. Reasoning control validation rejects unsafe llama.cpp/Inkling modes ('none' and 0) and accepts verified ones", () => {
		expect(() =>
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-effort", effort: "none" }, 16_384, true),
		).toThrow();
		expect(() =>
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-budget-tokens", tokens: 0 }, 16_384, true),
		).toThrow();
		expect(() =>
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-budget-tokens", tokens: -1 }, 16_384, true),
		).toThrow();
		expect(() =>
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-budget-tokens", tokens: 16_384 }, 16_384, true),
		).toThrow();
		expect(() =>
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-budget-tokens", tokens: 16_129 }, 16_384, true),
		).toThrow();

		expect(
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-effort", effort: "low" }, 16_384, true),
		).toEqual({ mode: "reasoning-effort", effort: "low" });
		expect(
			validateEndoCoordinatorReasoningControlV1({ mode: "reasoning-budget-tokens", tokens: 8_192 }, 16_384, true),
		).toEqual({ mode: "reasoning-budget-tokens", tokens: 8_192 });
	});

	it("6. V1 pool & authorization bind resourceProfile digest, refuse tampering, and enforce member ceilings", () => {
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const pool = makeV1Pool(deep);
		const profileSha = endoCoordinatorResourceProfileSha256V1(deep);
		const budget = makeBudget(deep);
		const policy = makePolicy();
		const grant = {
			scheduleId: "sched-deep",
			scheduleIncarnation: "2".repeat(64),
			scheduleRevision: 2,
			projectId: PROJECT_ID,
			actionKind: "emit-operator-proposal" as const,
			poolSha256: coordinatorModelPoolSha256V0(pool),
			resourceProfile: deep,
			resourceProfileSha256: profileSha,
			policy,
			budget,
			grantedAtMs: BASE_TIME,
			expiresAtMs: BASE_TIME + 3_600_000,
		};
		const auth = validateEndoAdvisoryAuthorizationV0({
			authorizationId: endoAdvisoryAuthorizationIdV0(grant),
			...grant,
			pool,
			revokedAtMs: null,
			revocation: null,
		});
		const schedule = {
			scheduleId: "sched-deep",
			incarnation: "2".repeat(64),
			revision: 2,
			projectId: PROJECT_ID,
			actionKind: "emit-operator-proposal" as const,
		};
		const standingOk = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: {
				schemaVersion: "endo.develop-advisory-authorizations.v0",
				revision: 1,
				updatedAtMs: BASE_TIME,
				authorizations: [auth],
			},
			nowMs: BASE_TIME + 1000,
		});
		expect(standingOk.ok).toBe(true);

		// Tampering resourceProfileSha256 fails standing even if authorizationId were recomputed
		const tamperedGrant = { ...grant, resourceProfileSha256: "f".repeat(64) };
		const tamperedAuth = validateEndoAdvisoryAuthorizationV0({
			authorizationId: endoAdvisoryAuthorizationIdV0(tamperedGrant),
			...tamperedGrant,
			pool,
			revokedAtMs: null,
			revocation: null,
		});
		const standingTampered = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: {
				schemaVersion: "endo.develop-advisory-authorizations.v0",
				revision: 1,
				updatedAtMs: BASE_TIME,
				authorizations: [tamperedAuth],
			},
			nowMs: BASE_TIME + 1000,
		});
		expect(standingTampered).toEqual({ ok: false, refusal: "resource-profile-digest-mismatch" });

		// Mismatched pool.resourceProfile vs authorization.resourceProfile is refused
		const extended = presetEndoCoordinatorResourceProfileV1("extended");
		expect(() =>
			validateEndoAdvisoryAuthorizationV0({
				authorizationId: endoAdvisoryAuthorizationIdV0(grant),
				...grant,
				pool: makeV1Pool(extended),
				revokedAtMs: null,
				revocation: null,
			}),
		).toThrow(/must exactly match/);

		// Effective pool narrowing preserves V1 schema & filters out members above budget
		const effective = endoAdvisoryEffectivePoolV0(auth);
		expect(effective?.schemaVersion).toBe(ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1);
		expect(effective?.members).toHaveLength(1);
	});

	it("7. Turn admission/dispatch validators enforce strict V0 bounds without resourceProfileSha256 and V1 bounds with it", () => {
		const baseAdmission = {
			schemaVersion: "endo.develop-advisory-turn-admission.v0" as const,
			turnId: "a".repeat(64),
			fireIdempotencyKey: "b".repeat(64),
			scheduleId: "sched-1",
			scheduleRevision: 2,
			projectId: PROJECT_ID,
			actionKind: "generate-advisory-brief" as const,
			authorizationId: "c".repeat(64),
			poolSha256: "d".repeat(64),
			policySha256: "e".repeat(64),
			budgetSha256: "f".repeat(64),
			leaseEpoch: 1,
			holderId: "holder-1",
			admittedAtMs: BASE_TIME,
			turnDeadlineMs: BASE_TIME + 780_000,
			wakeReason: "first-observation" as const,
			semanticDigest: "1".repeat(64),
			completeness: "complete" as const,
			observedAtMs: BASE_TIME,
			gaps: [],
			reservation: { completionRequests: 2, generatedTokens: 32_768, wallClockMs: 780_000 },
			budgetBefore: {
				periodStartMs: BASE_TIME - 3_600_000,
				turnsCharged: 0,
				generatedTokensCharged: 0,
				uncertainTurns: 0,
			},
		};
		// Without resourceProfileSha256: V0 rejects 780 s deadline and 32,768 reservation
		expect(() => validateEndoAdvisoryTurnAdmissionV0(baseAdmission)).toThrow();
		// With resourceProfileSha256: governed V1 accepts it (and still rejects > 49,152)
		const admittedV1 = validateEndoAdvisoryTurnAdmissionV0({
			...baseAdmission,
			resourceProfileSha256: "9".repeat(64),
		});
		expect(admittedV1.reservation.generatedTokens).toBe(32_768);
		expect(() =>
			validateEndoAdvisoryTurnAdmissionV0({
				...baseAdmission,
				resourceProfileSha256: "9".repeat(64),
				reservation: { completionRequests: 2, generatedTokens: 49_153, wallClockMs: 780_000 },
			}),
		).toThrow();

		const baseDispatch = {
			schemaVersion: "endo.develop-advisory-turn-dispatch.v0" as const,
			turnId: "a".repeat(64),
			leaseEpoch: 1,
			holderId: "holder-1",
			dispatchedAtMs: BASE_TIME + 100,
			authorizationId: "c".repeat(64),
			scheduleRevision: 2,
			effectivePoolSha256: "d".repeat(64),
			selectedMemberId: "local-primary",
			selectedModelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
			selectedEndpoint: "http://127.0.0.1:8091",
			selectedReadiness: "ready",
			observationBasis: "live-probe" as const,
			capacityConfirmed: true,
			fallbackOccurred: false,
			skippedMembers: [],
			inferenceDeadlineMs: BASE_TIME + 720_100,
			effectiveTimeoutMs: 720_000,
		};
		expect(() => validateEndoAdvisoryTurnDispatchV0(baseDispatch)).toThrow(/240000/);
		expect(
			validateEndoAdvisoryTurnDispatchV0({ ...baseDispatch, resourceProfileSha256: "9".repeat(64) })
				.effectiveTimeoutMs,
		).toBe(720_000);
	});

	it("8. Wire request gate blocks smuggled reasoning/budget fields and enforces exact authorized parameters", () => {
		const bearer = "test-bearer-token";
		const toolText = JSON.stringify({ availability: "available", status: {} });
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const target = coordinatorTargetFromMemberV0(
			makeMember("http://127.0.0.1:8091", { maxOutputTokens: 16_384, timeoutMs: 720_000 }),
			deep,
		);
		const inference = coordinatorInferenceForV0(target);
		expect(inference).toEqual({ ...COORDINATOR_INFERENCE_V0, max_tokens: 16_384 });
		expect(coordinatorRelayPolicyV0(target).maxTransferredBytes).toBe(32 * 1024 * 1024);

		const makeReq = (extra: Record<string, unknown> = {}) => {
			const payload = {
				model: target.model,
				stream: true,
				...inference,
				tools: [
					{
						type: "function",
						function: {
							name: ENDO_COORDINATOR_TOOL_V0,
							description:
								"Read the evidence-qualified status of the one Endophasia project in scope. It cannot make changes.",
							parameters: {
								type: "object",
								properties: { project: { type: "string", pattern: "^endo\\.project\\.[0-9a-f]{32}$" } },
								additionalProperties: false,
							},
						},
					},
				],
				messages: [{ role: "user", content: "brief" }],
				...extra,
			};
			return {
				body: Buffer.from(JSON.stringify(payload)),
				headers: [["authorization", `Bearer ${bearer}`]] as readonly [string, string][],
			};
		};

		// Authorized request passes
		const wireOk = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, { inference, model: target.model });
		expect(wireOk.request(makeReq())).toBe(true);

		// Smuggled fields are all refused
		for (const smuggled of [
			{ reasoning_effort: "high" },
			{ reasoning_budget_tokens: 99999 },
			{ thinking_budget_tokens: 99999 },
			{ reasoning_budget: 99999 },
			{ chat_template_kwargs: { reasoning_effort: 0.99 } },
			{ enable_thinking: true },
			{ max_tokens: 24_576 },
			{ n_predict: -1 },
			{ max_completion_tokens: 32_768 },
			{ temperature: 0.7 },
		]) {
			const wire = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, { inference, model: target.model });
			expect(wire.request(makeReq(smuggled))).toBe(false);
			expect(wire.trace.refusal).toBe("model-unavailable");
		}
	});

	it("9. Wire response diagnostics count reasoning without storing raw reasoning text and detect unsupported reasoning controls", () => {
		const bearer = "test-bearer-token";
		const secretThought = "SECRET_INTERNAL_MONOLOGUE_SHOULD_NEVER_BE_PERSISTED_99421";
		const toolText = JSON.stringify({ availability: "available", status: {} });
		const deep = presetEndoCoordinatorResourceProfileV1("deep", {
			reasoningControl: { mode: "reasoning-effort", effort: "low" },
		});
		const target = coordinatorTargetFromMemberV0(
			makeMember("http://127.0.0.1:8091", { maxOutputTokens: 16_384, timeoutMs: 720_000 }),
			deep,
		);
		const inference = coordinatorInferenceForV0(target);
		expect(inference.reasoning_effort).toBe("low");

		// 1) Reasoning-only length exhaustion: captures counts, never stores raw text
		const wireExhaust = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, {
			inference,
			model: target.model,
		});
		const sseBody = sseChunk({ reasoning_content: secretThought }, "length", target.model, {
			prompt_tokens: 1000,
			completion_tokens: 16_384,
			completion_tokens_details: { reasoning_tokens: 16_384 },
		});
		const rawHttp = Buffer.from(
			`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(sseBody)}\r\n\r\n${sseBody}`,
		);
		expect(wireExhaust.response({ status: 200, wire: rawHttp })).toBe(true);
		expect(wireExhaust.trace.responses[0]?.finish).toBe("length");
		expect(wireExhaust.trace.responses[0]?.sawReasoning).toBe(true);
		expect(wireExhaust.trace.responses[0]?.reasoningChars).toBe(secretThought.length);
		expect(wireExhaust.trace.responses[0]?.sawVisibleContent).toBe(false);
		expect(wireExhaust.trace.responses[0]?.reasoningTokens).toBe(16_384);
		expect(JSON.stringify(wireExhaust.trace)).not.toContain(secretThought);

		// 2) Server rejects reasoning_effort with HTTP 400 -> unsupported-reasoning-control
		const wireUnsupported = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, {
			inference,
			model: target.model,
		});
		const errBody = JSON.stringify({ error: { message: "unknown field reasoning_effort" } });
		expect(
			wireUnsupported.response({
				status: 400,
				wire: Buffer.from(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${errBody.length}\r\n\r\n${errBody}`),
			}),
		).toBe(false);
		expect(wireUnsupported.trace.refusal).toBe("unsupported-reasoning-control");
	});

	it("10. S2 tick with deep V1 profile acquires 840 s lease, reserves 32,768 tokens, enforces revocation & crash-uncertain accounting", async () => {
		const dir = scratch();
		const fixture = createBriefFixtureV0(dir, "review");
		const root = fixture.root;
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const pool = makeV1Pool(deep);
		let nowMs = BASE_TIME;
		const clock = () => nowMs;

		const added = addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-deep",
				label: "Deep test",
				projectId: fixture.projectId,
				actionKind: "generate-advisory-brief",
				wake: "digest-window",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 600_000, anchorMs: BASE_TIME },
			},
			clock,
		);
		expect(added.ok).toBe(true);
		const enabled = setEndoAdvisoryScheduleEnabledV0(root, "sched-deep", true, 1, clock);
		expect(enabled.ok).toBe(true);
		const auth = authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-deep",
				scheduleRevision: 2,
				pool,
				resourceProfile: deep,
				policy: makePolicy(),
				budget: makeBudget(deep),
				lifetimeMs: 86_400_000,
			},
			clock,
		);
		expect(auth.ok).toBe(true);

		// 1) Normal run under deep profile: verify lease TTL = 840 s, target.maxOutputTokens = 16,384, target.contextWindowTokens = 65,536
		let observedTarget: EndoCoordinatorModelTargetV0 | undefined;
		let observedLeaseTtl = 0;
		const store = new DevelopAdvisoryStoreV0(root, { now: clock });
		const tick1 = await runEndoAdvisoryTickV0({
			root,
			now: clock,
			observeMember: readyObserver(clock),
			hooks: {
				afterAdmission: () => {
					const l = store.readLease();
					if (l.ok && l.exists) observedLeaseTtl = l.value.expiresAtMs - l.value.acquiredAtMs;
				},
			},
			run: async (_root, req, opts) => {
				observedTarget = opts?.target;
				opts?.trial?.({
					promptSha256: "a".repeat(64),
					inference: coordinatorInferenceForV0(opts.target!),
					wire: {
						toolDefinitions: [],
						statusDelivered: true,
						statusMessage: null,
						inference: [],
						responses: [
							{
								finish: "tool_calls",
								usage: { prompt_tokens: 1000, completion_tokens: 50 },
								text: "",
								toolCalled: true,
							},
							{
								finish: "stop",
								usage: { prompt_tokens: 4000, completion_tokens: 4500 },
								text: "Review pending.",
								toolCalled: false,
							},
						],
						refusal: null,
					},
					dispatched: true,
					toolOutcome: null,
					evidence: {
						readAtMs: nowMs,
						projectionSha256: "1".repeat(64),
						modelViewSha256: "2".repeat(64),
					},
					latencyMs: 500,
					inferenceElapsedMs: 400,
					admittedExchanges: 2,
					recorderClean: true,
					stderr: "",
				});
				return {
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: req.projectId,
					runtime: { harness: "OpenClaw 2026.11.10", provider: "llama.cpp (fake)", model: opts!.target!.model },
					availability: "available",
					answer: "Review pending.",
					evidence: {
						readAtMs: nowMs,
						projectionSha256: "1".repeat(64),
						modelViewSha256: "2".repeat(64),
					},
					toolSurface: [ENDO_COORDINATOR_TOOL_V0],
				};
			},
		});
		expect(tick1.ok).toBe(true);
		expect(observedLeaseTtl).toBe(840_000);
		expect(observedTarget?.maxOutputTokens).toBe(16_384);
		expect(observedTarget?.contextWindowTokens).toBe(65_536);
		expect(observedTarget?.relayMaxTransferredBytes).toBe(32 * 1024 * 1024);

		const turns1 = store.listTurns(nowMs);
		expect(turns1.ok).toBe(true);
		if (turns1.ok) {
			expect(turns1.entries).toHaveLength(1);
			expect(turns1.entries[0]?.admission.reservation.generatedTokens).toBe(32_768);
			expect(turns1.entries[0]?.admission.resourceProfileSha256).toBe(endoCoordinatorResourceProfileSha256V1(deep));
			expect(turns1.entries[0]?.briefing?.accounting.chargedGeneratedTokens).toBe(4_550);
		}

		// 2) Concurrent tick while an extended lease is live is refused as lease-held
		nowMs += 600_000;
		let concurrentResult: Awaited<ReturnType<typeof runEndoAdvisoryTickV0>> | undefined;
		const tick2 = await runEndoAdvisoryTickV0({
			root,
			now: clock,
			observeMember: readyObserver(clock),
			hooks: {
				afterDispatchRecord: async () => {
					concurrentResult = await runEndoAdvisoryTickV0({
						root,
						now: () => nowMs + 400_000, // 400 s into 840 s lease -> still held!
						observeMember: readyObserver(clock),
					});
					// Also revoke authorization in flight to verify late/revoked withholding!
					revokeEndoAdvisoryAuthorizationV0(root, "sched-deep", clock);
				},
			},
			run: async (_root, req, opts) => ({
				schemaVersion: "endo.coordinator-brief.v0",
				projectId: req.projectId,
				runtime: { harness: "OpenClaw 2026.11.10", provider: "llama.cpp (fake)", model: opts!.target!.model },
				availability: "available",
				answer: "Should be withheld.",
				evidence: { readAtMs: nowMs, projectionSha256: "1".repeat(64), modelViewSha256: "2".repeat(64) },
				toolSurface: [ENDO_COORDINATOR_TOOL_V0],
			}),
		});
		expect(concurrentResult?.ok).toBe(false);
		if (concurrentResult && !concurrentResult.ok) expect(concurrentResult.refusal).toBe("lease-held");
		expect(tick2.ok).toBe(true);
		if (tick2.ok) {
			expect(tick2.outcomes[0]?.status).toBe("result-withheld");
		}
		// Withheld turn with missing usage charges full 32,768 reservation (never 0!)
		const turns2 = store.listTurns(nowMs);
		expect(turns2.ok).toBe(true);
		if (turns2.ok) {
			const standing = endoAdvisoryBudgetStandingV0({
				turns: turns2.entries,
				budget: makeBudget(deep),
				nowMs,
				currentLease: null,
			});
			expect(standing.turnsCharged).toBe(2);
			expect(standing.generatedTokensCharged).toBe(4_550 + 32_768);
		}
	});

	it("11. Pre-dispatch runtime preflight refuses with not-dispatched and 0 token charge", async () => {
		const dir = scratch();
		const fixture = createBriefFixtureV0(dir, "review");
		const root = fixture.root;
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const pool = makeV1Pool(deep);
		const nowMs = BASE_TIME;
		const clock = () => nowMs;
		addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-pf",
				label: null,
				projectId: fixture.projectId,
				actionKind: "generate-advisory-brief",
				wake: "digest-window",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "once", atMs: BASE_TIME },
			},
			clock,
		);
		setEndoAdvisoryScheduleEnabledV0(root, "sched-pf", true, 1, clock);
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-pf",
				scheduleRevision: 2,
				pool,
				resourceProfile: deep,
				policy: makePolicy(),
				budget: makeBudget(deep),
				lifetimeMs: 86_400_000,
			},
			clock,
		);
		const res = await runEndoAdvisoryTickV0({
			root,
			now: clock,
			observeMember: readyObserver(clock),
			preflight: () => ({ ok: false, detail: "simulated local runtime mismatch" }),
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.inferenceDispatched).toBe(false);
			const store = new DevelopAdvisoryStoreV0(root, { now: clock });
			const turns = store.listTurns(nowMs);
			expect(turns.ok).toBe(true);
			if (turns.ok) {
				expect(turns.entries[0]?.briefing?.availability).toBe("not-dispatched");
				expect(turns.entries[0]?.briefing?.accounting.chargedGeneratedTokens).toBe(0);
			}
		}
	});

	it("12. CLI --resource-profile accepts valid V1 profile, refuses reflex/symlink/duplicate-key files, and preserves V0 ceiling when omitted", () => {
		const root = scratch();
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const profilePath = join(root, "deep.profile.json");
		const v1PoolPath = join(root, "deep.pool.json");
		const v0PoolPath = join(root, "v0.pool.json");
		const linkPath = join(root, "link.profile.json");
		const dupPath = join(root, "dup.profile.json");
		writeFileSync(profilePath, canonicalEndoJsonV0(deep));
		writeFileSync(v1PoolPath, canonicalEndoJsonV0(makeV1Pool(deep)));
		writeFileSync(v0PoolPath, canonicalEndoJsonV0(makeV0Pool()));
		symlinkSync(profilePath, linkPath);
		writeFileSync(dupPath, '{"tier":"deep","tier":"deep"}');

		// File readers enforce O_NOFOLLOW, duplicate-key rejection, and V0 isolation
		expect(() => readCoordinatorResourceProfileFileV1(linkPath)).toThrow(/cannot be opened/);
		expect(() => readCoordinatorResourceProfileFileV1(dupPath)).toThrow(/repeats a key/);
		expect(readCoordinatorResourceProfileFileV1(profilePath).tier).toBe("deep");
		expect(() => readCoordinatorModelPoolFileV0(v1PoolPath)).toThrow(/unknown field|schemaVersion/);
		expect(readCoordinatorModelPoolFileAnyV1(v1PoolPath).schemaVersion).toBe(ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1);

		// CLI authorize with --resource-profile succeeds for 16,384 tokens
		const runCli = (args: string[]) =>
			spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env } });
		expect(
			runCli([
				"advisory",
				"add",
				root,
				"--id",
				"cli-deep",
				"--project",
				PROJECT_ID,
				"--action",
				"generate-advisory-brief",
				"--wake",
				"on-change",
				"--every",
				"1h",
				"--quiet",
			]).status,
		).toBe(0);
		expect(runCli(["advisory", "enable", root, "--id", "cli-deep", "--revision", "1", "--quiet"]).status).toBe(0);

		// Omitting V1 profile with V0 pool refuses > 2048 tokens
		const badV0 = runCli([
			"advisory",
			"authorize",
			root,
			"--id",
			"cli-deep",
			"--revision",
			"2",
			"--pool",
			v0PoolPath,
			"--period",
			"1h",
			"--max-turns",
			"2",
			"--max-output-tokens",
			"16384",
			"--max-generated-tokens",
			"65536",
			"--turn-timeout",
			"780",
			"--expires-in",
			"24h",
			"--quiet",
		]);
		expect(badV0.status).not.toBe(0);

		// Providing --resource-profile + V1 pool succeeds
		const okV1 = runCli([
			"advisory",
			"authorize",
			root,
			"--id",
			"cli-deep",
			"--revision",
			"2",
			"--pool",
			v1PoolPath,
			"--resource-profile",
			profilePath,
			"--period",
			"1h",
			"--max-turns",
			"2",
			"--max-output-tokens",
			"16384",
			"--max-generated-tokens",
			"65536",
			"--turn-timeout",
			"780",
			"--expires-in",
			"24h",
			"--quiet",
		]);
		expect(okV1.status).toBe(0);
		const parsed = JSON.parse(okV1.stdout);
		expect(parsed.authorization.resourceProfile.tier).toBe("deep");
		expect(parsed.authorization.budget.maxOutputTokensPerRequest).toBe(16_384);
	});

	it("13. Grounded-v1 prompt freeze and sampling constants remain completely unchanged (§9)", () => {
		expect(ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1).toBe(
			"c50ada62528e0fe0b96c18cefa9bf2bddd7ed0da5db54e575508bd9cb23b6ecc",
		);
		expect(COORDINATOR_INFERENCE_V0).toEqual({
			temperature: 0,
			top_k: 1,
			top_p: 1,
			min_p: 0,
			seed: 101,
			max_tokens: 2048,
		});
		expect(ENDO_ADVISORY_LIMITS_V0.maxAnswerBytes).toBe(4096);
		expect(ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.maxAnswerBytes).toBe(4096);
	});

	it("14. Adversarial regressions (F1, F3, F4, F6, F7, F9, F10): TOCTOU lease fence, closed wire allowlist, publication reserve, diagnostics hygiene & headroom", async () => {
		// F3: Closed wire request allowlist blocks reasoning_format, ignore_eos, min_tokens, samplers, mirostat, logprobs, etc.
		const bearer = "test-bearer-f3";
		const toolText = JSON.stringify({ availability: "available", status: {} });
		const deep = presetEndoCoordinatorResourceProfileV1("deep");
		const target = coordinatorTargetFromMemberV0(
			makeMember("http://127.0.0.1:8091", { maxOutputTokens: 16_384, timeoutMs: 720_000 }),
			deep,
		);
		const inference = coordinatorInferenceForV0(target);
		const basePayload = {
			model: target.model,
			stream: true,
			stream_options: { include_usage: true },
			...inference,
			tools: [
				{
					type: "function",
					function: {
						name: ENDO_COORDINATOR_TOOL_V0,
						description:
							"Read the evidence-qualified status of the one Endophasia project in scope. It cannot make changes.",
						parameters: {
							type: "object",
							properties: { project: { type: "string", pattern: "^endo\\.project\\.[0-9a-f]{32}$" } },
							additionalProperties: false,
						},
					},
				},
			],
			messages: [{ role: "user", content: "brief" }],
		};
		for (const smuggled of [
			{ reasoning_format: "none" },
			{ reasoning: { effort: "high" } },
			{ thinking: { type: "enabled" } },
			{ ignore_eos: true },
			{ min_tokens: 16_384 },
			{ samplers: ["top_k"] },
			{ mirostat: 2 },
			{ logit_bias: { "1": 100 } },
			{ logprobs: true },
			{ timings_per_token: true },
			{ stream_options: { include_usage: true, extra: 1 } },
			{ store: true },
			{ tool_choice: "none" },
		]) {
			const w = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, { inference, model: target.model });
			expect(
				w.request({
					body: Buffer.from(JSON.stringify({ ...basePayload, ...smuggled })),
					headers: [["authorization", `Bearer ${bearer}`]],
				}),
			).toBe(false);
			expect(w.trace.refusal).toBe("model-unavailable");
		}

		// F6: Unrelated HTTP 400 (e.g., "unsupported model") is NOT misclassified as unsupported-reasoning-control,
		// and malformed/oversized finish_reason is sanitized to "other".
		const lowProfile = presetEndoCoordinatorResourceProfileV1("light", {
			reasoningControl: { mode: "reasoning-effort", effort: "low" },
		});
		const lowInf = coordinatorInferenceForV0(
			coordinatorTargetFromMemberV0(
				makeMember("http://127.0.0.1:8091", { maxOutputTokens: 4096, timeoutMs: 360_000 }),
				lowProfile,
			),
		);
		const wUnrelated400 = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, {
			inference: lowInf,
			model: target.model,
		});
		const unrelatedBody = JSON.stringify({ error: { message: "unsupported model: foo" } });
		expect(
			wUnrelated400.response({
				status: 400,
				wire: Buffer.from(
					`HTTP/1.1 400 Bad Request\r\nContent-Length: ${unrelatedBody.length}\r\n\r\n${unrelatedBody}`,
				),
			}),
		).toBe(false);
		expect(wUnrelated400.trace.refusal).toBe("model-unavailable");

		const wDirtyFinish = coordinatorWireV0(PROJECT_ID, toolText, bearer, undefined, {
			inference,
			model: target.model,
		});
		const dirtySse = sseChunk(
			{ content: "ok" },
			"LEAKED_SECRET\u001b[31m_HUGE_FINISH_REASON_OVER_32_CHARS",
			target.model,
		);
		wDirtyFinish.response({
			status: 200,
			wire: Buffer.from(
				`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(dirtySse)}\r\n\r\n${dirtySse}`,
			),
		});
		expect(wDirtyFinish.trace.responses[0]?.finish).toBe("other");

		// F7: reasoning-budget-tokens headroom enforced on V1 pool members, budgets, and targets;
		// coordinatorTargetFromMemberV0 without resourceProfile refuses > 2048 tokens or > 135 s timeout.
		const budgetedProfile = presetEndoCoordinatorResourceProfileV1("deep", {
			reasoningControl: { mode: "reasoning-budget-tokens", tokens: 8_000 },
		});
		expect(() => makeV1Pool(budgetedProfile, "http://127.0.0.1:8091", { maxOutputTokens: 8_100 })).toThrow();
		expect(() =>
			validateEndoAdvisoryBudgetV0(
				{
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 1,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 8_100,
					maxGeneratedTokensPerPeriod: 16_200,
					maxTurnWallClockMs: 780_000,
				},
				"budget",
				budgetedProfile,
			),
		).toThrow();
		expect(() =>
			coordinatorTargetFromMemberV0(
				makeMember("http://127.0.0.1:8091", { maxOutputTokens: 4096, timeoutMs: 135_000 }),
			),
		).toThrow(/V0 ceiling/);
		expect(() =>
			coordinatorTargetFromMemberV0(
				makeMember("http://127.0.0.1:8091", { maxOutputTokens: 2048, timeoutMs: 200_000 }),
			),
		).toThrow(/V0 ceiling/);

		// F1: Phase A -> Phase C authorization downgrade (deep 840 s lease -> V0 300 s grant) is refused as refused-insufficient-lease
		const dir = scratch();
		const fixture = createBriefFixtureV0(dir, "review");
		const root = fixture.root;
		let nowMs = BASE_TIME;
		const clock = () => nowMs;
		addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-f1",
				label: null,
				projectId: fixture.projectId,
				actionKind: "generate-advisory-brief",
				wake: "digest-window",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 600_000, anchorMs: BASE_TIME },
			},
			clock,
		);
		setEndoAdvisoryScheduleEnabledV0(root, "sched-f1", true, 1, clock);
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-f1",
				scheduleRevision: 2,
				pool: makeV1Pool(deep),
				resourceProfile: deep,
				policy: makePolicy(),
				budget: makeBudget(deep),
				lifetimeMs: 86_400_000,
			},
			clock,
		);
		const f1Tick = await runEndoAdvisoryTickV0({
			root,
			now: clock,
			observeMember: readyObserver(clock),
			hooks: {
				afterClaim: () => {
					// Re-authorize at same revision with V0 grant (300 s lease ceiling) after Phase A acquired 840 s lease!
					authorizeEndoAdvisoryScheduleV0(
						root,
						{
							scheduleId: "sched-f1",
							scheduleRevision: 2,
							pool: makeV0Pool(),
							policy: makePolicy(),
							budget: makeBudget(),
							lifetimeMs: 86_400_000,
						},
						clock,
					);
				},
			},
		});
		expect(f1Tick.ok).toBe(true);
		if (f1Tick.ok) {
			expect(f1Tick.inferenceDispatched).toBe(false);
			expect(f1Tick.outcomes[0]?.status).toBe("refused-insufficient-lease");
		}

		// F4: Inference completing 2 s before turnDeadlineMs while Phase G uses 5 s of publicationReserveMs publishes cleanly!
		nowMs += 600_000;
		const tightDeep = presetEndoCoordinatorResourceProfileV1("deep", {
			modelExecutionTimeoutMs: 720_000,
			advisoryTurnDeadlineMs: 720_000,
			publicationReserveMs: 60_000,
			advisoryLeaseTtlMs: 780_000,
		});
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-f1",
				scheduleRevision: 2,
				pool: makeV1Pool(tightDeep),
				resourceProfile: tightDeep,
				policy: makePolicy(),
				budget: makeBudget(tightDeep),
				lifetimeMs: 86_400_000,
			},
			clock,
		);
		let monoMs = 1_000;
		const f4Tick = await runEndoAdvisoryTickV0({
			root,
			now: clock,
			monotonicNow: () => monoMs,
			observeMember: readyObserver(clock),
			hooks: {
				afterInference: () => {
					// Phase G takes 5 s, crossing turnDeadlineMs (720 s) into the 60 s publicationReserveMs (lease expires at 780 s)
					nowMs += 5_000;
					monoMs += 5_000;
				},
			},
			run: async (_r, req, opts) => {
				// Inference finishes at 718 s (2 s before 720 s inference & turn deadline)
				nowMs += 718_000;
				monoMs += 718_000;
				return {
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: req.projectId,
					runtime: { harness: "OpenClaw 2026.11.10", provider: "llama.cpp (fake)", model: opts!.target!.model },
					availability: "available",
					answer: "Published inside publicationReserveMs.",
					evidence: { readAtMs: nowMs, projectionSha256: "1".repeat(64), modelViewSha256: "2".repeat(64) },
					toolSurface: [ENDO_COORDINATOR_TOOL_V0],
				};
			},
		});
		expect(f4Tick.ok).toBe(true);
		if (f4Tick.ok) {
			expect(f4Tick.outcomes[0]?.status).toBe("briefing-published");
		}
	});
});

const sandboxAvailable = (() => {
	try {
		return (
			process.platform === "linux" &&
			spawnSync("/usr/bin/bwrap", coordinatorBwrapV0([], ["-e", ""]), { env: COORDINATOR_ENV_V0 }).status === 0
		);
	} catch {
		return false;
	}
})();
const openclaw = process.env.ENDO_COORDINATOR_OPENCLAW;

describe.skipIf(!sandboxAvailable || !openclaw)(
	"COORDINATOR-REASONING-001 installed OpenClaw + bwrap + protected relay fake-provider verification",
	() => {
		function groundedAnswerJson(_projectId: string, taskId: string) {
			return JSON.stringify({
				schemaVersion: "endo.coordinator-grounded-brief.v1",
				claims: [
					{
						subjectKind: "task",
						subjectId: taskId,
						predicate: "task-phase",
						value: "awaiting-review",
						evidenceRef: `ev:task:${taskId}`,
					},
				],
				uncertainties: [],
				recommendations: [
					{
						kind: "review-awaiting-review",
						subjectKind: "task",
						subjectId: taskId,
						supportingRefs: [`ev:task:${taskId}`],
						priority: "high",
						rationaleCode: "review-lacks-passing-check",
					},
				],
				proposal: null,
			});
		}

		it.each([
			["light", 4_096],
			["deliberate", 8_192],
			["deep", 16_384],
			["extended", 24_576],
		] as readonly [Exclude<EndoCoordinatorResourceTierV1, "reflex">, number][])(
			"passes governed %s budget (%d max_tokens) through installed OpenClaw and protected relay cleanly",
			async (tier, expectedMaxTokens) => {
				vi.stubEnv("XDG_RUNTIME_DIR", scratch());
				const dir = scratch();
				mkdirSync(join(dir, "control"));
				const fixture = createBriefFixtureV0(dir, "review");
				const modelId = "Inkling-2-Mini-Uncensored-AD-Q4_K";
				const seenMaxTokens: number[] = [];

				const fake = await startFakeServer((req, res, body) => {
					if (req.method !== "POST") {
						res.statusCode = 404;
						res.end();
						return;
					}
					const parsed = JSON.parse(body) as Record<string, unknown>;
					seenMaxTokens.push(Number(parsed.max_tokens));
					const isFirst = !body.includes('"role":"tool"');
					res.setHeader("content-type", "text/event-stream");
					if (isFirst) {
						res.end(
							sseChunk(
								{
									tool_calls: [
										{
											index: 0,
											id: `call_${randomBytes(4).toString("hex")}`,
											type: "function",
											function: {
												name: ENDO_COORDINATOR_TOOL_V0,
												arguments: JSON.stringify({ project: fixture.projectId }),
											},
										},
									],
								},
								"tool_calls",
								modelId,
								{ prompt_tokens: 1200, completion_tokens: 45 },
							),
						);
						return;
					}
					res.end(
						sseChunk(
							{
								reasoning_content: "Thinking through the task status evidence.",
								content: groundedAnswerJson(fixture.projectId, fixture.taskId),
							},
							"stop",
							modelId,
							{ prompt_tokens: 3400, completion_tokens: 320 },
						),
					);
				});

				const profile = presetEndoCoordinatorResourceProfileV1(tier);
				const pool = makeV1Pool(profile, fake.origin, { modelId });
				const preflight = preflightOpenClawCoordinatorV0(
					fixture.root,
					{ projectId: fixture.projectId },
					{
						openclaw,
						target: coordinatorTargetFromMemberV0(pool.members[0]!, profile),
						briefingMode: "grounded-v1",
						visibilityMode: "status-and-coordination-v1",
					},
				);
				expect(preflight.ok).toBe(true);

				const substrate = pooledCoordinatorV0(fixture.root, pool, {
					observe: readyObserver(Date.now),
					briefingMode: "grounded-v1",
					visibilityMode: "status-and-coordination-v1",
					run: (r, req, opts) => runOpenClawCoordinatorV0(r, req, { ...opts, openclaw }),
				});
				const result = await substrate.brief({ projectId: fixture.projectId });
				expect(result.availability === "available" ? "available" : result.reason).toBe("available");
				expect(seenMaxTokens).toEqual([expectedMaxTokens, expectedMaxTokens]);
				expect(result.diagnostics?.terminationClass).toBe("published");
				expect(result.diagnostics?.effectiveMaxOutputTokens).toBe(expectedMaxTokens);
				expect(result.diagnostics?.rawReasoningStored).toBe(false);
				expect(result.diagnostics?.exchanges).toHaveLength(2);
				expect(result.diagnostics?.exchanges[1]?.sawReasoning).toBe(true);
				expect(result.diagnostics?.exchanges[1]?.reasoningTokens).toBeNull();
				expect(JSON.stringify(result)).not.toContain("Thinking through the task status evidence.");
			},
			60_000,
		);

		it("classifies reasoning-budget-exhausted through installed OpenClaw without leaking raw reasoning text", async () => {
			vi.stubEnv("XDG_RUNTIME_DIR", scratch());
			const dir = scratch();
			mkdirSync(join(dir, "control"));
			const fixture = createBriefFixtureV0(dir, "review");
			const modelId = "Inkling-2-Mini-Uncensored-AD-Q4_K";
			const secretReasoning = "SENSITIVE_CHAIN_OF_THOUGHT_TOKEN_77319";

			const fake = await startFakeServer((req, res, body) => {
				if (req.method !== "POST") {
					res.statusCode = 404;
					res.end();
					return;
				}
				const isFirst = !body.includes('"role":"tool"');
				res.setHeader("content-type", "text/event-stream");
				if (isFirst) {
					res.end(
						sseChunk(
							{
								tool_calls: [
									{
										index: 0,
										id: "call_rbe_1",
										type: "function",
										function: {
											name: ENDO_COORDINATOR_TOOL_V0,
											arguments: JSON.stringify({ project: fixture.projectId }),
										},
									},
								],
							},
							"tool_calls",
							modelId,
							{ prompt_tokens: 1200, completion_tokens: 45 },
						),
					);
					return;
				}
				res.end(
					sseChunk({ reasoning_content: secretReasoning }, "length", modelId, {
						prompt_tokens: 3400,
						completion_tokens: 4096,
					}),
				);
			});

			const profile = presetEndoCoordinatorResourceProfileV1("light");
			const pool = makeV1Pool(profile, fake.origin, { modelId });
			const substrate = pooledCoordinatorV0(fixture.root, pool, {
				observe: readyObserver(Date.now),
				briefingMode: "grounded-v1",
				visibilityMode: "status-and-coordination-v1",
				run: (r, req, opts) => runOpenClawCoordinatorV0(r, req, { ...opts, openclaw }),
			});
			const result = await substrate.brief({ projectId: fixture.projectId });
			expect(result.availability).toBe("unavailable");
			if (result.availability === "unavailable") {
				expect(result.reason).toBe("reasoning-budget-exhausted");
			}
			expect(result.diagnostics?.terminationClass).toBe("reasoning-budget-exhausted");
			expect(result.diagnostics?.rawReasoningStored).toBe(false);
			expect(result.diagnostics?.exchanges[1]?.finishReason).toBe("length");
			expect(result.diagnostics?.exchanges[1]?.sawReasoning).toBe(true);
			expect(result.diagnostics?.exchanges[1]?.sawVisibleContent).toBe(false);
			expect(JSON.stringify(result)).not.toContain(secretReasoning);
		}, 60_000);

		it("forwards authorized reasoning_effort and reports unsupported-reasoning-control when server rejects it", async () => {
			vi.stubEnv("XDG_RUNTIME_DIR", scratch());
			const dir = scratch();
			mkdirSync(join(dir, "control"));
			const fixture = createBriefFixtureV0(dir, "review");
			const modelId = "Inkling-2-Mini-Uncensored-AD-Q4_K";
			const seenEfforts: unknown[] = [];

			const fake = await startFakeServer((req, res, body) => {
				if (req.method !== "POST") {
					res.statusCode = 404;
					res.end();
					return;
				}
				const parsed = JSON.parse(body) as Record<string, unknown>;
				seenEfforts.push(parsed.reasoning_effort);
				res.statusCode = 400;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: { message: "unsupported parameter: reasoning_effort" } }));
			});

			const profile = presetEndoCoordinatorResourceProfileV1("light", {
				reasoningControl: { mode: "reasoning-effort", effort: "low" },
			});
			const pool = makeV1Pool(profile, fake.origin, { modelId });
			const substrate = pooledCoordinatorV0(fixture.root, pool, {
				observe: readyObserver(Date.now),
				briefingMode: "grounded-v1",
				visibilityMode: "status-and-coordination-v1",
				run: (r, req, opts) => runOpenClawCoordinatorV0(r, req, { ...opts, openclaw }),
			});
			const result = await substrate.brief({ projectId: fixture.projectId });
			expect(seenEfforts).toEqual(["low"]);
			expect(result.availability).toBe("unavailable");
			if (result.availability === "unavailable") {
				expect(result.reason).toBe("unsupported-reasoning-control");
			}
			expect(result.diagnostics?.terminationClass).toBe("unsupported-reasoning-control");
		}, 60_000);
	},
);
