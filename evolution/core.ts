/**
 * Phase 6 — the evolution core: add-only registries for mutations, artifacts, candidates, selection
 * decisions, and promotion requests/decisions (README "## Phase 6 — Evolution substrate").
 *
 * The registries are the integrity point for the records they own:
 * - a candidate's mutations must already be registered, and no mutation may be listed twice;
 * - a candidate's parent (when present) must be registered and may not be the candidate itself;
 * - a selection may not name a candidate that is not registered;
 * - a promotion request must rest on a registered selection whose outcome is "selected", naming the
 *   same candidate and the same experiment;
 * - a promotion decision must answer a registered request, naming the same candidate and experiment.
 *
 * The registries are add-only: once registered, a record stays addressable. Supersession is
 * recorded by a descendant candidate and a promotion decision, not by removing or mutating a
 * record. A registered record is stored as a deep-frozen copy (Phase 12): the caller may keep
 * mutating its own reference after `add` returns — the registry holds the frozen copy, and
 * mutating the returned record throws.
 */

import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import {
	validateEndoArtifactV0,
	validateEndoCandidateV0,
	validateEndoMutationV0,
	validateEndoPromotionDecisionV0,
	validateEndoPromotionRequestV0,
	validateEndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import { deepFreezeCopyV0 } from "../runtime/contracts/immutability.ts";

/**
 * The add-only mutation registry. Mutations are registered before any candidate that applies them.
 */
export interface EndoMutationRegistryV0 {
	/** Register a mutation. Throws TypeError when the record is invalid or the id is already registered. */
	add(value: unknown): EndoMutationV0;
	get(id: string): EndoMutationV0 | null;
	has(id: string): boolean;
	/** All registered mutations, in id order. */
	list(): EndoMutationV0[];
}

/**
 * The add-only artifact registry. A second record under an existing id is always rejected, which is
 * how a digest change under a stable id is detected (evolution/artifacts.ts).
 */
export interface EndoArtifactRegistryV0 {
	/** Register an artifact. Throws TypeError when the record is invalid or the id is already registered. */
	add(value: unknown): EndoArtifactV0;
	get(id: string): EndoArtifactV0 | null;
	has(id: string): boolean;
	/** All registered artifacts, in id order. */
	list(): EndoArtifactV0[];
}

/**
 * The add-only candidate registry. Adding a candidate checks its parent and its mutation list
 * against the already-registered records.
 */
export interface EndoCandidateRegistryV0 {
	/**
	 * Register a candidate. Throws TypeError when the record is invalid, the id is already
	 * registered, the parent is missing or is the candidate itself, a listed mutation is not
	 * registered, or a mutation is listed more than once.
	 */
	add(value: unknown): EndoCandidateV0;
	get(id: string): EndoCandidateV0 | null;
	has(id: string): boolean;
	/** All registered candidates, in id order. */
	list(): EndoCandidateV0[];
}

/**
 * The add-only selection-decision registry. A selection may not name a candidate that is not
 * registered.
 */
export interface EndoSelectionRegistryV0 {
	/**
	 * Register a selection decision. Throws TypeError when the record is invalid, the id is already
	 * registered, or the named candidate (outcome "selected") is not registered.
	 */
	add(value: unknown): EndoSelectionDecisionV0;
	get(id: string): EndoSelectionDecisionV0 | null;
	has(id: string): boolean;
	/** All registered selection decisions, in id order. */
	list(): EndoSelectionDecisionV0[];
}

/** The add-only promotion-request registry. */
export interface EndoPromotionRequestRegistryV0 {
	/**
	 * Register a promotion request. Throws TypeError when the record is invalid, the id is already
	 * registered, the candidate is not registered, the selection is not registered, the selection
	 * did not select a candidate, or the request names a different candidate or experiment than its
	 * selection.
	 */
	add(value: unknown): EndoPromotionRequestV0;
	get(id: string): EndoPromotionRequestV0 | null;
	has(id: string): boolean;
	/** All registered promotion requests, in id order. */
	list(): EndoPromotionRequestV0[];
}

/** The add-only promotion-decision registry. */
export interface EndoPromotionDecisionRegistryV0 {
	/**
	 * Register a promotion decision. Throws TypeError when the record is invalid, the id is already
	 * registered, the request is not registered, or the decision names a different candidate or
	 * experiment than its request.
	 */
	add(value: unknown): EndoPromotionDecisionV0;
	get(id: string): EndoPromotionDecisionV0 | null;
	has(id: string): boolean;
	/** All registered promotion decisions, in id order. */
	list(): EndoPromotionDecisionV0[];
}

/**
 * The evolution core: the six add-only registries and the integrity checks between them. It owns no
 * policy, no state machine, and no ledger — those live in evolution/experiment.ts and
 * evolution/evidence.ts.
 */
export interface EndoEvolutionCoreV0 {
	candidates: EndoCandidateRegistryV0;
	mutations: EndoMutationRegistryV0;
	artifacts: EndoArtifactRegistryV0;
	selections: EndoSelectionRegistryV0;
	promotionRequests: EndoPromotionRequestRegistryV0;
	promotionDecisions: EndoPromotionDecisionRegistryV0;
}

/** A deterministic id order for the `list()` methods. */
function byIdV0<T extends { id: string }>(a: T, b: T): number {
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

/** Create the evolution core with its six empty registries. */
export function createEndoEvolutionCoreV0(): EndoEvolutionCoreV0 {
	const mutations = new Map<string, EndoMutationV0>();
	const artifacts = new Map<string, EndoArtifactV0>();
	const candidates = new Map<string, EndoCandidateV0>();
	const selections = new Map<string, EndoSelectionDecisionV0>();
	const promotionRequests = new Map<string, EndoPromotionRequestV0>();
	const promotionDecisions = new Map<string, EndoPromotionDecisionV0>();

	return {
		mutations: {
			add(value: unknown): EndoMutationV0 {
				const validated = validateEndoMutationV0(value);
				if (validated === null) throw new TypeError("not a valid endo.mutation.v0 record");
				if (mutations.has(validated.id)) throw new TypeError(`mutation ${validated.id} is already registered`);
				const stored = deepFreezeCopyV0(validated);
				mutations.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => mutations.get(id) ?? null,
			has: (id: string) => mutations.has(id),
			list: () => [...mutations.values()].sort(byIdV0),
		},
		artifacts: {
			add(value: unknown): EndoArtifactV0 {
				const validated = validateEndoArtifactV0(value);
				if (validated === null) throw new TypeError("not a valid endo.artifact.v0 record");
				if (artifacts.has(validated.id)) throw new TypeError(`artifact ${validated.id} is already registered`);
				const stored = deepFreezeCopyV0(validated);
				artifacts.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => artifacts.get(id) ?? null,
			has: (id: string) => artifacts.has(id),
			list: () => [...artifacts.values()].sort(byIdV0),
		},
		candidates: {
			add(value: unknown): EndoCandidateV0 {
				const validated = validateEndoCandidateV0(value);
				if (validated === null) throw new TypeError("not a valid endo.candidate.v0 record");
				if (candidates.has(validated.id)) throw new TypeError(`candidate ${validated.id} is already registered`);
				if (validated.parentCandidateId !== undefined) {
					if (validated.parentCandidateId === validated.id)
						throw new TypeError("a candidate cannot be its own parent");
					if (!candidates.has(validated.parentCandidateId)) {
						throw new TypeError(`parent candidate ${validated.parentCandidateId} is not registered`);
					}
				}
				const seen = new Set<string>();
				for (const mutationId of validated.mutations) {
					if (seen.has(mutationId)) throw new TypeError(`mutation ${mutationId} is listed more than once`);
					seen.add(mutationId);
					if (!mutations.has(mutationId)) throw new TypeError(`mutation ${mutationId} is not registered`);
				}
				const stored = deepFreezeCopyV0(validated);
				candidates.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => candidates.get(id) ?? null,
			has: (id: string) => candidates.has(id),
			list: () => [...candidates.values()].sort(byIdV0),
		},
		selections: {
			add(value: unknown): EndoSelectionDecisionV0 {
				const validated = validateEndoSelectionDecisionV0(value);
				if (validated === null) throw new TypeError("not a valid endo.selection-decision.v0 record");
				if (selections.has(validated.id)) throw new TypeError(`selection ${validated.id} is already registered`);
				if (validated.candidateId !== undefined && !candidates.has(validated.candidateId)) {
					throw new TypeError(`selection ${validated.id} names unregistered candidate ${validated.candidateId}`);
				}
				const stored = deepFreezeCopyV0(validated);
				selections.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => selections.get(id) ?? null,
			has: (id: string) => selections.has(id),
			list: () => [...selections.values()].sort(byIdV0),
		},
		promotionRequests: {
			add(value: unknown): EndoPromotionRequestV0 {
				const validated = validateEndoPromotionRequestV0(value);
				if (validated === null) throw new TypeError("not a valid endo.promotion-request.v0 record");
				if (promotionRequests.has(validated.id))
					throw new TypeError(`promotion request ${validated.id} is already registered`);
				if (!candidates.has(validated.candidateId)) {
					throw new TypeError(
						`promotion request ${validated.id} names unregistered candidate ${validated.candidateId}`,
					);
				}
				const selection = selections.get(validated.selectionId) ?? null;
				if (selection === null) {
					throw new TypeError(
						`promotion request ${validated.id} names unregistered selection ${validated.selectionId}`,
					);
				}
				if (selection.outcome !== "selected") {
					throw new TypeError(
						`promotion request ${validated.id} rests on a selection that did not select a candidate`,
					);
				}
				if (selection.candidateId !== validated.candidateId) {
					throw new TypeError(`promotion request ${validated.id} names a different candidate than its selection`);
				}
				if (selection.experimentId !== validated.experimentId) {
					throw new TypeError(`promotion request ${validated.id} names a different experiment than its selection`);
				}
				const stored = deepFreezeCopyV0(validated);
				promotionRequests.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => promotionRequests.get(id) ?? null,
			has: (id: string) => promotionRequests.has(id),
			list: () => [...promotionRequests.values()].sort(byIdV0),
		},
		promotionDecisions: {
			add(value: unknown): EndoPromotionDecisionV0 {
				const validated = validateEndoPromotionDecisionV0(value);
				if (validated === null) throw new TypeError("not a valid endo.promotion-decision.v0 record");
				if (promotionDecisions.has(validated.id))
					throw new TypeError(`promotion decision ${validated.id} is already registered`);
				const request = promotionRequests.get(validated.requestId) ?? null;
				if (request === null) {
					throw new TypeError(
						`promotion decision ${validated.id} names unregistered request ${validated.requestId}`,
					);
				}
				if (request.experimentId !== validated.experimentId) {
					throw new TypeError(`promotion decision ${validated.id} names a different experiment than its request`);
				}
				if (request.candidateId !== validated.candidateId) {
					throw new TypeError(`promotion decision ${validated.id} names a different candidate than its request`);
				}
				const stored = deepFreezeCopyV0(validated);
				promotionDecisions.set(validated.id, stored);
				return stored;
			},
			get: (id: string) => promotionDecisions.get(id) ?? null,
			has: (id: string) => promotionDecisions.has(id),
			list: () => [...promotionDecisions.values()].sort(byIdV0),
		},
	};
}
