// The experiment-bundle half of the lab: the evaluation result plus the bundle's own digest over it in
// canonical form. The bundle is the artifact a consumer persists or compares across processes — the digest
// makes the bundle checkable after transport, and the result it carries names the inputs that produced it.

import { type EndoExperimentBundleV0, validateEndoEvaluationResultV0 } from "../protocol/evaluation.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

/**
 * Build the experiment bundle: the evaluation result and the bundle's own digest over it in canonical form.
 * The strict door: the id must be an endo.evidence.* identifier and the result a valid
 * endo.evaluation-result.v0. The digest is deterministic — the same result always bundles to the same digest
 * — which is what makes "produced result bundle X" checkable. Throws TypeError when the id or the result is
 * invalid.
 */
export function buildEndoExperimentBundleV0(id: unknown, result: unknown): EndoExperimentBundleV0 {
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("bundle id must be an endo.evidence.* identifier");
	}
	const validated = validateEndoEvaluationResultV0(result);
	if (validated === null) throw new TypeError("not a valid endo.evaluation-result.v0 result");
	return {
		schemaVersion: "endo.experiment-bundle.v0",
		id,
		result: validated,
		digest: sha256HexV0(canonicalEndoJsonV0(validated)),
	};
}
