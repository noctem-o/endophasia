// The Coordinator Model Pool's runtime contract (M1, docs/designs/coordinator-model-pool-m1-implementation.md): what a zero-token health
// observation of one member may say, how a member is selected from those observations, and the provenance a briefing carries.
// Selection is a pure function of the validated pool, the request and the observations it is given; it performs no I/O itself and
// never dispatches inference. A health observation is a controller-observed fact at one instant, never a promise that the next
// inference request will succeed, and never permission to do anything but attempt one advisory briefing.

import {
	type EndoCoordinatorModelPoolAnyV1,
	type EndoCoordinatorModelPoolMemberV0,
	orderedCoordinatorPoolMembersV0,
} from "../../protocol/coordinator-model-pool.ts";
import type { EndoCoordinatorResourceProfileV1 } from "../../protocol/coordinator-resource-policy.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

/**
 * What a zero-token observation established about one local member, most to least available:
 * - `ready`: the model is observed loaded and free capacity was observed passively. M1's local probe never reports it: no llama.cpp
 *   capacity signal is passive (model-pool-probe.ts). It is kept for observers that have one (S1, M2).
 * - `capacity-unknown`: the model is observed loaded and awake; free capacity was not observable without side effects.
 * - `model-unconfirmed`: the endpoint is healthy, but the model's residency was not established: sleeping, a router (whose model
 *   state is not read, since listing can run a reconciliation), a generic catalog entry, or no listing.
 * - `loading`: the server or the model reports it is loading.
 * - `saturated`: the observer reports no free capacity. Like `ready`, never reported by M1's local probe.
 * - `model-unavailable`: the server's listing lacks the exact model, or reports it failed or incomplete.
 * - `unhealthy`: the health endpoint answered with an error.
 * - `unreachable`: no answer within the deadline, or the connection failed.
 * - `probe-refused`: an answer was refused (a redirect, an oversized or malformed body, an unexpected peer).
 */
export const ENDO_COORDINATOR_MEMBER_READINESS_V0 = [
	"ready",
	"capacity-unknown",
	"model-unconfirmed",
	"loading",
	"saturated",
	"model-unavailable",
	"unhealthy",
	"unreachable",
	"probe-refused",
] as const;
export type EndoCoordinatorMemberReadinessV0 = (typeof ENDO_COORDINATOR_MEMBER_READINESS_V0)[number];

/** Why, in one closed word, an observation reached its readiness. */
export const ENDO_COORDINATOR_PROBE_DETAILS_V0 = [
	"slot-idle",
	"slots-not-observable",
	"router-model-state-not-observed",
	"backend-unidentified",
	"model-listed-residency-unknown",
	"model-sleep-state-unknown",
	"model-sleeping",
	"model-listing-unavailable",
	"model-not-listed",
	"server-loading",
	"no-idle-slot",
	"health-error",
	"connect-failed",
	"timeout",
	"cancelled",
	"redirect",
	"response-too-large",
	"malformed-response",
	"destination-mismatch",
] as const;
export type EndoCoordinatorProbeDetailV0 = (typeof ENDO_COORDINATOR_PROBE_DETAILS_V0)[number];

export type EndoCoordinatorBackendV0 = "llama.cpp-router" | "llama.cpp-single" | "openai-compatible" | "unknown";

export interface EndoCoordinatorMemberObservationV0 {
	readonly memberId: string;
	readonly endpoint: string;
	readonly modelId: string;
	readonly basis: "controller-observed";
	readonly observedAtMs: number;
	readonly elapsedMs: number;
	readonly readiness: EndoCoordinatorMemberReadinessV0;
	readonly detail: EndoCoordinatorProbeDetailV0;
	readonly backend: EndoCoordinatorBackendV0;
	/** The server's self-reported build (llama.cpp `build_info`), when it gave one in the expected form. */
	readonly build: string | null;
	/** Every request made, in order, with the HTTP status received (null: none). Never a completion route. */
	readonly requests: readonly { readonly path: string; readonly status: number | null }[];
	/** Always 0: no observation requests inference. */
	readonly inferenceTokens: 0;
}

/** The seam a health observer implements: M1's loopback probe today, S1's recorded observations or M2's hosted signals later. */
export type EndoCoordinatorMemberObserverV0 = (
	member: EndoCoordinatorModelPoolMemberV0,
) => Promise<EndoCoordinatorMemberObservationV0>;

export type EndoCoordinatorSkipReasonV0 = EndoCoordinatorMemberReadinessV0 | "hosted-not-permitted";

export const ENDO_COORDINATOR_SELECTION_REFUSALS_V0 = [
	"no-healthy-member",
	"member-not-found",
	"member-unavailable",
	"member-not-permitted",
] as const;
export type EndoCoordinatorSelectionRefusalV0 = (typeof ENDO_COORDINATOR_SELECTION_REFUSALS_V0)[number];

export interface EndoCoordinatorSelectionRequestV0 {
	/** An operator's explicit member (`--member`). It is observed and used or refused; another member is never substituted. */
	readonly memberId?: string;
}

interface SelectionBase {
	readonly mode: "priority" | "explicit";
	readonly requestedMemberId: string | null;
	/** Members considered before the outcome, in order, with why each was not selected. */
	readonly skippedMembers: readonly { readonly memberId: string; readonly reason: EndoCoordinatorSkipReasonV0 }[];
	/** Every observation made for this selection, in order. */
	readonly observations: readonly EndoCoordinatorMemberObservationV0[];
}

export type EndoCoordinatorSelectionV0 = SelectionBase &
	(
		| {
				readonly ok: true;
				readonly member: EndoCoordinatorModelPoolMemberV0;
				readonly observation: EndoCoordinatorMemberObservationV0;
				/** True when a member preferred by the ordering was skipped. Always false for an explicit selection. */
				readonly fallbackOccurred: boolean;
		  }
		| { readonly ok: false; readonly refusal: EndoCoordinatorSelectionRefusalV0 }
	);

/** Whether an observed member may be selected under the pool's policy. */
export function coordinatorMemberEligibleV0(
	pool: EndoCoordinatorModelPoolAnyV1,
	readiness: EndoCoordinatorMemberReadinessV0,
): boolean {
	if (readiness === "ready" || readiness === "capacity-unknown") return true;
	return readiness === "model-unconfirmed" && pool.selection.unconfirmedModel === "permit";
}

/**
 * Select one member (S0 Appendix A, `selectCoordinatorModelV0`). Deterministic for given observations: members are taken in
 * `orderedCoordinatorPoolMembersV0` order and observed lazily, one at a time, so a lower member is observed only when every member
 * above it was skipped. A hosted member is never observed or selected in M1. An explicit member is observed alone: when it is
 * ineligible the selection is refused, never switched.
 */
export async function selectCoordinatorModelV0(
	pool: EndoCoordinatorModelPoolAnyV1,
	request: EndoCoordinatorSelectionRequestV0,
	observe: EndoCoordinatorMemberObserverV0,
): Promise<EndoCoordinatorSelectionV0> {
	const observations: EndoCoordinatorMemberObservationV0[] = [];
	const skippedMembers: { memberId: string; reason: EndoCoordinatorSkipReasonV0 }[] = [];
	const look = async (member: EndoCoordinatorModelPoolMemberV0) => {
		const observation = await observe(member);
		if (
			observation.memberId !== member.memberId ||
			observation.endpoint !== member.endpoint ||
			observation.modelId !== member.modelId
		)
			throw new TypeError("an observation must describe the member it was asked about");
		observations.push(observation);
		return observation;
	};
	if (request.memberId !== undefined) {
		const base = { mode: "explicit" as const, requestedMemberId: request.memberId, skippedMembers, observations };
		const member = pool.members.find((m) => m.memberId === request.memberId);
		if (member === undefined) return { ...base, ok: false, refusal: "member-not-found" };
		if (member.kind !== "local-openai-compat") {
			skippedMembers.push({ memberId: member.memberId, reason: "hosted-not-permitted" });
			return { ...base, ok: false, refusal: "member-not-permitted" };
		}
		const observation = await look(member);
		if (!coordinatorMemberEligibleV0(pool, observation.readiness)) {
			skippedMembers.push({ memberId: member.memberId, reason: observation.readiness });
			return { ...base, ok: false, refusal: "member-unavailable" };
		}
		return { ...base, ok: true, member, observation, fallbackOccurred: false };
	}
	const base = { mode: "priority" as const, requestedMemberId: null, skippedMembers, observations };
	const ordered = orderedCoordinatorPoolMembersV0(pool);
	const considered = pool.selection.fallback === "none" ? ordered.slice(0, 1) : ordered;
	for (const member of considered) {
		if (member.kind !== "local-openai-compat") {
			skippedMembers.push({ memberId: member.memberId, reason: "hosted-not-permitted" });
			continue;
		}
		const observation = await look(member);
		if (coordinatorMemberEligibleV0(pool, observation.readiness))
			return { ...base, ok: true, member, observation, fallbackOccurred: skippedMembers.length > 0 };
		skippedMembers.push({ memberId: member.memberId, reason: observation.readiness });
	}
	return { ...base, ok: false, refusal: "no-healthy-member" };
}

/** The digest naming a validated pool in provenance: SHA-256 of its canonical JSON. */
export function coordinatorModelPoolSha256V0(pool: EndoCoordinatorModelPoolAnyV1): string {
	return sha256HexV0(canonicalEndoJsonV0(pool));
}

/** The digest naming a validated governed resource profile: SHA-256 of its canonical JSON. */
export function endoCoordinatorResourceProfileSha256V1(profile: EndoCoordinatorResourceProfileV1): string {
	return sha256HexV0(canonicalEndoJsonV0(profile));
}

/** Bounded measurements of one pooled briefing attempt. Unknown values stay null; nothing here is persisted. */
export interface EndoCoordinatorPoolMeasurementsV0 {
	readonly observationElapsedMs: number;
	/** From dispatching the agent to its end; null when no inference was attempted. */
	readonly inferenceElapsedMs: number | null;
	/** Server-reported usage summed over the exchanges that reported it; null when none did. Self-reported by the model server. */
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
	/** Completion requests the relay admitted to the model server; null when no inference was attempted. */
	readonly exchanges: number | null;
	/** The briefing's closed refusal, when it had one. */
	readonly failureCategory: string | null;
}

/** The provenance extension on `EndoCoordinatorBriefResultV0` when a pool was used (S0 Appendix A). */
export interface EndoCoordinatorModelPoolProvenanceV0 {
	readonly schemaVersion: "endo.coordinator-model-pool-provenance.v0";
	readonly poolSha256: string;
	readonly selectionMode: "priority" | "explicit";
	readonly requestedMemberId: string | null;
	readonly selectedMemberId: string | null;
	readonly selectedModelId: string | null;
	readonly selectedEndpoint: string | null;
	readonly selectedReadiness: EndoCoordinatorMemberReadinessV0 | null;
	/** True only for `ready`: free capacity was observed. A healthy endpoint or a loaded model never confirms capacity. */
	readonly capacityConfirmed: boolean;
	readonly fallbackOccurred: boolean;
	readonly skippedMembers: readonly { readonly memberId: string; readonly reason: EndoCoordinatorSkipReasonV0 }[];
	/** Constant: after inference is dispatched to the selected member, no other member is tried in M1. */
	readonly inferenceFailover: "never";
	readonly measurements: EndoCoordinatorPoolMeasurementsV0;
}

/** `endo coordinator pool check`: the observations and the selection a briefing would make now. Zero inference tokens. */
export interface EndoCoordinatorModelPoolCheckV0 {
	readonly schemaVersion: "endo.coordinator-model-pool-check.v0";
	readonly source: "file" | "m0-default";
	readonly poolSha256: string;
	readonly inferenceTokens: 0;
	readonly members: readonly (
		| {
				readonly memberId: string;
				readonly kind: "local-openai-compat";
				readonly observation: EndoCoordinatorMemberObservationV0;
		  }
		| {
				readonly memberId: string;
				readonly kind: "hosted-relay";
				readonly observation: null;
				readonly reason: "hosted-not-permitted";
		  }
	)[];
	readonly selection:
		| {
				readonly ok: true;
				readonly selectedMemberId: string;
				readonly capacityConfirmed: boolean;
				readonly fallbackOccurred: boolean;
				readonly skippedMembers: SelectionBase["skippedMembers"];
		  }
		| {
				readonly ok: false;
				readonly refusal: EndoCoordinatorSelectionRefusalV0;
				readonly skippedMembers: SelectionBase["skippedMembers"];
		  };
}
