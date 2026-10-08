// The effective harness surface in an experiment: building a trial's `harness` record from its capture log, reading
// the request parameters back out of it, and summarizing a cell's surfaces for the report.
//
// A cell's trials share one task and one condition, so they are expected to show one model-facing surface. The summary
// reports what the trials showed: how many distinct surfaces, which trials differ from the modal set, and which major
// coordinates differ (never the content). A difference is evidence, not a verdict: nothing here marks an experiment
// invalid. Surfaces are comparable only within one digest domain; trials recorded before the surface existed
// (`endo.experiment-trial.v0`) are reported as predating it, never as differing.

import { requestParametersOfEndoHarnessSurfaceV0 } from "../adapters/openai-proxy/harness-surface.ts";
import type {
	EndoExperimentContributionV0,
	EndoExperimentTrialHarnessV0,
	EndoExperimentTrialResultAnyV0,
} from "../protocol/experiment-artifacts.ts";
import { compareEndoHarnessSurfacesV0, type EndoHarnessSurfaceV0 } from "../protocol/harness-surface.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";

/** The identity a recognized surface is deduplicated by; an unrecognized one is never merged with another. */
const dedupeKey = (surface: EndoHarnessSurfaceV0): string =>
	surface.components.status === "reported"
		? `${surface.digestKey.keyId}\u0000${surface.components.value.identity}`
		: `unrecognized\u0000${surface.source.eventId}`;

/** A trial's `harness` from the surfaces of its requests (capture order) and the contributions the runner knows. */
export function buildEndoTrialHarnessV0(
	surfaces: readonly EndoHarnessSurfaceV0[],
	contributions: EndoExperimentTrialHarnessV0["contributions"],
): EndoExperimentTrialHarnessV0 {
	const distinct: EndoHarnessSurfaceV0[] = [];
	const index = new Map<string, number>();
	const requests: EndoExperimentTrialHarnessV0["requests"] = [];
	for (const surface of surfaces) {
		const key = dedupeKey(surface);
		let at = index.get(key);
		if (at === undefined) {
			at = distinct.length;
			index.set(key, at);
			distinct.push(surface);
		}
		requests.push({ exchange: surface.source.exchange, requestDigest: surface.source.requestDigest, surface: at });
	}
	return { surfaces: distinct, requests, contributions };
}

/** A trial's request parameters, per request: the recorded list (v0), or the view of its surfaces (v1). One basis. */
export function requestParametersOfTrialV0(result: EndoExperimentTrialResultAnyV0): JsonValueV0[] {
	if (result.schemaVersion === "endo.experiment-trial.v0") return result.requestParameters;
	return result.harness.requests.map((request) =>
		requestParametersOfEndoHarnessSurfaceV0(result.harness.surfaces[request.surface]!),
	);
}

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** The distinct recognized identities (digest domain + identity) a v1 trial showed, sorted. */
function identitiesOf(harness: EndoExperimentTrialHarnessV0): string[] {
	return sortedUnique(
		harness.surfaces.flatMap((surface) =>
			surface.components.status === "reported"
				? [`${surface.digestKey.keyId}\u0000${surface.components.value.identity}`]
				: [],
		),
	);
}

const label = (result: EndoExperimentTrialResultAnyV0) => `trial #${result.trial}`;

/**
 * What a cell's completed trials showed of the effective harness surface. Pure over the trial records.
 */
export function summarizeEndoCellHarnessSurfacesV0(trials: readonly EndoExperimentTrialResultAnyV0[]): JsonValueV0 {
	const v1 = trials.flatMap((result) => (result.schemaVersion === "endo.experiment-trial.v1" ? [result] : []));
	const predating = trials.length - v1.length;
	// A trial with no recognized request has no surface to compare: it is counted, never matched or mismatched.
	const withSurface = v1.filter((result) => identitiesOf(result.harness).length > 0);
	const noRecognized = v1.length - withSurface.length;
	if (withSurface.length === 0)
		return JSON.parse(
			JSON.stringify({
				status: "UNAVAILABLE",
				reason:
					trials.length === 0
						? "no trial of this cell completed"
						: v1.length === 0
							? "every trial of this cell predates the harness surface (endo.experiment-trial.v0)"
							: "no trial of this cell showed a recognized chat-completions request",
				trials: { withSurface: 0, predatingSurface: predating, noRecognizedSurface: noRecognized },
			}),
		);

	const surfaces = withSurface.flatMap((result) => result.harness.surfaces);
	const keyIds = sortedUnique(surfaces.map((surface) => surface.digestKey.keyId));
	const requestsObserved = v1.reduce((n, result) => n + result.harness.requests.length, 0);
	const unrecognizedRequests = v1.reduce(
		(n, result) =>
			n +
			result.harness.requests.filter((r) => result.harness.surfaces[r.surface]!.components.status !== "reported")
				.length,
		0,
	);

	// Per identity: requests and trials that showed it, and one surface that carries it.
	const byIdentity = new Map<string, { surface: EndoHarnessSurfaceV0; requests: number; trials: number }>();
	for (const result of withSurface) {
		const seen = new Set<string>();
		for (const request of result.harness.requests) {
			const surface = result.harness.surfaces[request.surface]!;
			if (surface.components.status !== "reported") continue;
			const id = `${surface.digestKey.keyId}\u0000${surface.components.value.identity}`;
			const entry = byIdentity.get(id) ?? { surface, requests: 0, trials: 0 };
			entry.requests += 1;
			if (!seen.has(id)) entry.trials += 1;
			seen.add(id);
			byIdentity.set(id, entry);
		}
	}
	const identities = [...byIdentity.entries()]
		.map(([id, entry]) => ({ id, ...entry }))
		.sort((a, b) => b.trials - a.trials || (a.id < b.id ? -1 : 1));

	// The modal set: the identity set most trials showed (ties: the first by identity order).
	const signatures = new Map<string, { trials: typeof withSurface; set: string[] }>();
	for (const result of withSurface) {
		const set = identitiesOf(result.harness);
		const signature = set.join("\u0001");
		const entry = signatures.get(signature) ?? { trials: [], set };
		entry.trials.push(result);
		signatures.set(signature, entry);
	}
	const modal = [...signatures.entries()].sort(
		(a, b) => b[1].trials.length - a[1].trials.length || (a[0] < b[0] ? -1 : 1),
	)[0]![1];
	const modalIds = new Set(modal.set);
	const comparable = keyIds.length <= 1;
	const differing = withSurface.filter(
		(result) => identitiesOf(result.harness).join("\u0001") !== modal.set.join("\u0001"),
	);

	const differences = comparable
		? identities
				.filter((entry) => !modalIds.has(entry.id))
				.map((entry) => {
					const against = modal.set
						.map((id) => byIdentity.get(id))
						.flatMap((other) =>
							other === undefined
								? []
								: [{ other, comparison: compareEndoHarnessSurfacesV0(other.surface, entry.surface) }],
						)
						.sort(
							(a, b) =>
								(a.comparison.comparable ? a.comparison.differs.length : 99) -
								(b.comparison.comparable ? b.comparison.differs.length : 99),
						)[0];
					return {
						identity:
							entry.surface.components.status === "reported" ? entry.surface.components.value.identity : null,
						trials: entry.trials,
						comparedWith:
							against?.other.surface.components.status === "reported"
								? against.other.surface.components.value.identity
								: null,
						...(against?.comparison.comparable
							? { differs: against.comparison.differs, parameterNames: against.comparison.parameterNames }
							: { differs: [], parameterNames: [] }),
					};
				})
		: [];

	const contribution = (pick: (c: EndoExperimentTrialHarnessV0["contributions"]) => EndoExperimentContributionV0) => {
		const values = sortedUnique(
			withSurface.map((result) => {
				const c = pick(result.harness.contributions);
				return c.status === "reported" ? c.value : "UNAVAILABLE";
			}),
		);
		return { distinct: values.length, values };
	};

	return JSON.parse(
		JSON.stringify({
			status: "reported",
			expectation: "one surface per cell: its trials share a task and a condition",
			trials: { withSurface: withSurface.length, predatingSurface: predating, noRecognizedSurface: noRecognized },
			digestKeyIds: keyIds,
			comparable,
			requests: {
				observed: requestsObserved,
				recognized: requestsObserved - unrecognizedRequests,
				unrecognized: unrecognizedRequests,
			},
			distinctSurfaces: identities.length,
			surfaces: identities.map((entry) => ({
				identity: entry.surface.components.status === "reported" ? entry.surface.components.value.identity : null,
				keyId: entry.surface.digestKey.keyId,
				requests: entry.requests,
				trials: entry.trials,
			})),
			matched: comparable ? differing.length === 0 : null,
			...(comparable
				? {}
				: {
						notComparable:
							"the trials were digested under different keys (different digest domains); no equality follows",
					}),
			trialsDifferingFromModalSet: comparable ? differing.map(label) : [],
			withinTrialVariation: withSurface.filter((result) => identitiesOf(result.harness).length > 1).map(label),
			differences,
			contributions: {
				workingDirectory: contribution((c) => c.workingDirectory),
				invocationMode: contribution((c) => c.invocationMode),
				configuredModel: contribution((c) => c.configuredModel),
			},
			unrecognized: {
				requests: unrecognizedRequests,
				note: "requests that were not recognized chat-completions requests have no components and are never counted as differing",
			},
		}),
	);
}
