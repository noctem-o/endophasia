/**
 * Phase 12 — explicit versioned model routing policy (README "## Phase 12 — Operational
 * substrate & integration"): the pure, protocol-bound routing service that selects one pool
 * member under an explicit, versioned `endo.model-routing-policy.v0` record. The policy
 * weighs its closed criterion keys in recorded order, gates eligibility on declared
 * capabilities and on the presence of data for every required criterion, and records for
 * each member — eligibility, the missing capabilities, the missing data, and the derived
 * evaluation values — so the decision is explainable on replay. No model is served, called,
 * or contacted: the decision is computed from the presented pool, profile, telemetry, and
 * in-flight records. Load and telemetry are inputs supplied by the caller — the service
 * never observes a runtime itself.
 *
 * Data derivations (never invented): per model, the presented telemetry record with the
 * greatest id (id order is record order; records carry no timestamp) is the latest observed
 * window. Health is recorded as the window's health flag and ranked healthy > degraded >
 * unhealthy. failureRate is failures / calls and latency is durationMs / calls — both
 * defined only when the window's calls > 0. throughput is the window's calls; tokenThroughput
 * is its tokensIn + tokensOut. load is the caller-presented in-flight count (0 when absent).
 * deployment is the profile's deployment, ranked by the policy's recorded preference. modelId
 * is the explicit deterministic tie-break: the lexicographically smaller id is better.
 * Members lacking data for an OPTIONAL criterion survive the pass unranked — absence of data
 * is neither a penalty nor an advantage. Required criteria without data make the member
 * ineligible (recorded in missingData).
 *
 * Selection: a lexicographic pass in policy criterion order — at each criterion the strictly
 * best-value group among surviving eligible members with data survives, unranked members
 * survive alongside it, and the pass is done when one member remains. One survivor selects
 * (decidedBy is the last criterion that narrowed the set); two or more is an honest tie
 * (selectedId null); zero eligible members is no-eligible-model.
 *
 * The doors take `unknown` (the house boundary pattern) and throw TypeError; the service
 * exits through the protocol validator of the returned decision.
 */

import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import type {
	EndoModelProfileV0,
	EndoModelRoutingPolicyDecisionV0,
	EndoModelTelemetryV0,
	EndoRoutingPolicyMemberEvaluationV0,
	EndoRoutingPolicyMemberV0,
} from "../protocol/models.ts";
import {
	validateEndoModelPoolV0,
	validateEndoModelProfileV0,
	validateEndoModelRoutingPolicyDecisionV0,
	validateEndoModelRoutingPolicyV0,
	validateEndoModelTelemetryV0,
} from "../protocol/models.ts";
import { isPlainJsonObjectV0 } from "../protocol/primitives.ts";

/** A declared capability: a non-empty string within the bound. */
function isCapabilityV0(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

/** A recorded non-negative integer: a finite, integral, non-negative number. */
function isNonNegativeIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** The rank of a health flag: higher is better (healthy > degraded > unhealthy). */
function healthRankV0(health: string): number {
	if (health === "healthy") return 3;
	if (health === "degraded") return 2;
	return 1;
}

/** One surviving member of the lexicographic pass, with its per-criterion data. */
interface PassMemberV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** The recorded member standing of the decision. */
	member: EndoRoutingPolicyMemberV0;
}

/**
 * The explicit, versioned routing decision for one pool against one capability request under
 * one routing policy. The doors: a valid policy; a valid pool; a request of unique 1-16
 * 1-512 character capabilities; a presentation of exactly one valid profile per pool member
 * (a member without a profile, a profile without a membership, or a double presentation is
 * not a routing); telemetry records that are all valid with unique ids (records for models
 * outside the pool are ignored — the decision is scoped to the pool); an in-flight
 * presentation, when given, of unique pool members with non-negative integer counts; and a
 * decision id in the endo.evidence.* namespace. Eligibility: a member is eligible exactly
 * when its profile declares every requested capability (the rest, in request order, are
 * recorded in missingCapabilities) and every required criterion has source data (the rest,
 * in policy order, are recorded in missingData). Selection: see the module header. Throws
 * TypeError when a door fails.
 */
export function routeModelByPolicyV0(
	policy: unknown,
	pool: unknown,
	profiles: unknown[],
	telemetry: unknown[],
	requestedCapabilities: unknown[],
	inFlight: unknown[] | undefined,
	id: unknown,
): EndoModelRoutingPolicyDecisionV0 {
	const validatedPolicy = validateEndoModelRoutingPolicyV0(policy);
	if (validatedPolicy === null) throw new TypeError("not a valid endo.model-routing-policy.v0 policy");
	const validatedPool = validateEndoModelPoolV0(pool);
	if (validatedPool === null) throw new TypeError("not a valid endo.model-pool.v0 pool");
	if (
		!Array.isArray(requestedCapabilities) ||
		requestedCapabilities.length > 16 ||
		!requestedCapabilities.every((entry) => isCapabilityV0(entry))
	) {
		throw new TypeError("requestedCapabilities must be an array of at most 16 unique 1-512 character strings");
	}
	if (new Set(requestedCapabilities).size !== requestedCapabilities.length) {
		throw new TypeError("requestedCapabilities must be unique");
	}
	const byId = new Map<string, EndoModelProfileV0>();
	for (const entry of profiles) {
		const validatedProfile = validateEndoModelProfileV0(entry);
		if (validatedProfile === null) throw new TypeError("not a valid endo.model-profile.v0 profile");
		if (byId.has(validatedProfile.id)) throw new TypeError(`profile ${validatedProfile.id} is presented twice`);
		byId.set(validatedProfile.id, validatedProfile);
	}
	for (const member of validatedPool.members) {
		if (!byId.has(member.modelId)) throw new TypeError(`pool member ${member.modelId} has no profile presented`);
	}
	for (const profileId of byId.keys()) {
		if (!validatedPool.members.some((member) => member.modelId === profileId)) {
			throw new TypeError(`profile ${profileId} is not a member of the pool`);
		}
	}
	const telemetryByModel = new Map<string, EndoModelTelemetryV0>();
	for (const entry of telemetry) {
		const validatedRecord = validateEndoModelTelemetryV0(entry);
		if (validatedRecord === null) throw new TypeError("not a valid endo.model-telemetry.v0 record");
		if (telemetryByModel.size > 0 && [...telemetryByModel.values()].some((row) => row.id === validatedRecord.id)) {
			throw new TypeError(`telemetry record ${validatedRecord.id} is presented twice`);
		}
		const existing = telemetryByModel.get(validatedRecord.modelId);
		if (existing === undefined || validatedRecord.id > existing.id) {
			telemetryByModel.set(validatedRecord.modelId, validatedRecord);
		}
	}
	const loadByModel = new Map<string, number>();
	if (inFlight !== undefined) {
		if (!Array.isArray(inFlight)) throw new TypeError("inFlight must be an array of {modelId, count} rows");
		for (const entry of inFlight) {
			if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) {
				throw new TypeError("inFlight rows must be plain objects");
			}
			const row = entry as Record<string, unknown>;
			for (const key of Object.keys(row)) {
				if (key !== "modelId" && key !== "count") throw new TypeError(`unknown inFlight row key ${key}`);
			}
			if (typeof row.modelId !== "string" || !isEndoIdentifierV0(row.modelId, "model")) {
				throw new TypeError("inFlight modelId must be an endo.model.* identifier");
			}
			if (!isNonNegativeIntV0(row.count)) throw new TypeError("inFlight count must be a non-negative integer");
			if (!validatedPool.members.some((member) => member.modelId === row.modelId)) {
				throw new TypeError(`inFlight names model ${row.modelId}, which is not a member of the pool`);
			}
			if (loadByModel.has(row.modelId)) throw new TypeError(`inFlight names model ${row.modelId} twice`);
			loadByModel.set(row.modelId, row.count);
		}
	}
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("decision id must be an endo.evidence.* identifier");
	}

	const evaluated: PassMemberV0[] = validatedPool.members.map((member) => {
		const profile = byId.get(member.modelId);
		const window = telemetryByModel.get(member.modelId);
		const evaluations: EndoRoutingPolicyMemberEvaluationV0[] = validatedPolicy.criteria.map((criterion) => {
			const key = criterion.key;
			let value: number | string | null = null;
			if (key === "health") value = window === undefined ? null : window.health;
			else if (key === "failureRate")
				value = window !== undefined && window.calls > 0 ? window.failures / window.calls : null;
			else if (key === "latency")
				value = window !== undefined && window.calls > 0 ? window.durationMs / window.calls : null;
			else if (key === "throughput") value = window === undefined ? null : window.calls;
			else if (key === "tokenThroughput") value = window === undefined ? null : window.tokensIn + window.tokensOut;
			else if (key === "load") value = loadByModel.get(member.modelId) ?? 0;
			else if (key === "deployment") value = profile?.deployment ?? null;
			else value = member.modelId;
			return { criterion: key, value };
		});
		const missingCapabilities = (requestedCapabilities as string[]).filter(
			(capability) => profile?.capabilities.includes(capability) !== true,
		);
		const missingData = validatedPolicy.criteria
			.filter(
				(criterion) =>
					criterion.required && evaluations.find((entry) => entry.criterion === criterion.key)?.value === null,
			)
			.map((criterion) => criterion.key);
		const eligible = missingCapabilities.length === 0 && missingData.length === 0;
		const memberStanding: EndoRoutingPolicyMemberV0 = {
			modelId: member.modelId,
			eligible,
			missingCapabilities,
			missingData,
			evaluations,
		};
		return { modelId: member.modelId, member: memberStanding };
	});

	let survivors = evaluated.filter((entry) => entry.member.eligible);
	let decidedBy: EndoRoutingPolicyMemberV0["evaluations"][number]["criterion"] | null = null;
	for (const criterion of validatedPolicy.criteria) {
		const key = criterion.key;
		const ranked: { modelId: string; rank: number }[] = [];
		const unranked: string[] = [];
		for (const entry of survivors) {
			const value = entry.member.evaluations.find((row) => row.criterion === key)?.value ?? null;
			if (value === null) {
				unranked.push(entry.modelId);
				continue;
			}
			if (key === "modelId") ranked.push({ modelId: entry.modelId, rank: 0 });
			else if (key === "health") ranked.push({ modelId: entry.modelId, rank: healthRankV0(value as string) });
			else if (key === "deployment")
				ranked.push({ modelId: entry.modelId, rank: value === validatedPolicy.deploymentPreference ? 1 : 0 });
			else if (key === "failureRate" || key === "latency" || key === "load")
				ranked.push({ modelId: entry.modelId, rank: -(value as number) });
			else ranked.push({ modelId: entry.modelId, rank: value as number });
		}
		if (ranked.length === 0) continue;
		const best =
			key === "modelId"
				? [...ranked.map((row) => row.modelId)].sort()[0]
				: ranked.reduce((top, row) => (row.rank > top.rank ? row : top), ranked[0]).rank;
		const kept = new Set(
			ranked
				.filter((row) => (key === "modelId" ? row.modelId === best : row.rank === best))
				.map((row) => row.modelId),
		);
		const next = survivors.filter((entry) => kept.has(entry.modelId) || unranked.includes(entry.modelId));
		if (next.length < survivors.length) decidedBy = key;
		survivors = next;
	}

	const selectedId = survivors.length === 1 ? survivors[0].modelId : null;
	const reason = survivors.length === 0 ? "no-eligible-model" : survivors.length === 1 ? "policy-selection" : "tie";
	const decision: EndoModelRoutingPolicyDecisionV0 = {
		schemaVersion: "endo.model-routing-policy-decision.v0",
		id,
		policyId: validatedPolicy.id,
		policyRevision: validatedPolicy.revision,
		poolId: validatedPool.id,
		requestedCapabilities: [...requestedCapabilities],
		members: evaluated.map((entry) => entry.member),
		selectedId,
		decidedBy: selectedId === null ? null : decidedBy,
		reason,
	};
	const validatedDecision = validateEndoModelRoutingPolicyDecisionV0(decision);
	if (validatedDecision === null) throw new TypeError("the routing policy decision failed the protocol door");
	return validatedDecision;
}
