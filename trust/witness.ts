/**
 * Phase 8 — the witness coverage report (README "## Phase 8 — Trust integrations"): which of a
 * result's trials the Cogitator witness records cover.
 *
 * A report is a derived view over named records — it explains the record, it grants nothing. A
 * trial with no recorded run, and a run with no witness, report an honest absence (null), never a
 * fabricated coverage: a witness root anchors integrity, not occurrence, so a missing anchor is
 * stated, not patched.
 */

import { validateEndoEvaluationResultV0 } from "../protocol/evaluation.ts";
import type { EndoWitnessCoverageTrialV0, EndoWitnessCoverageV0 } from "../protocol/trust.ts";
import { validateEndoWitnessCoverageV0, validateEndoWitnessRecordV0 } from "../protocol/trust.ts";

/**
 * Report which of the result's trials the witnesses cover. Pure: the result and each witness
 * validate at the door (TypeError, never a repair); the trials keep the result's order; the first
 * witness covering a run wins; and the report exits through the protocol validator.
 */
export function witnessCoverageV0(result: unknown, witnesses: readonly unknown[]): EndoWitnessCoverageV0 {
	const r = validateEndoEvaluationResultV0(result);
	if (r === null) {
		throw new TypeError("witnessCoverageV0 requires a valid endo.evaluation-result.v0");
	}
	const covered = witnesses.map((w) => {
		const wv = validateEndoWitnessRecordV0(w);
		if (wv === null) {
			throw new TypeError("witnessCoverageV0 requires valid endo.witness.v0 records");
		}
		return wv;
	});
	const trials: EndoWitnessCoverageTrialV0[] = r.trials.map((t) => {
		const runId = t.coordinates.runId ?? null;
		const witness = runId === null ? null : (covered.find((w) => w.runId === runId) ?? null);
		return {
			schemaVersion: "endo.witness-coverage-trial.v0",
			trial: t.coordinates.trial,
			runId,
			witnessId: witness === null ? null : witness.id,
		};
	});
	const report: EndoWitnessCoverageV0 = {
		schemaVersion: "endo.witness-coverage.v0",
		experimentId: r.profile.experimentId,
		trials,
	};
	const out = validateEndoWitnessCoverageV0(report);
	if (out === null) {
		throw new TypeError("internal error: the witness coverage report failed validation");
	}
	return out;
}
