import { describe, expect, it } from "vitest";
import { buildEndoExperimentBundleV0 } from "../lab/experiment-bundle.ts";
import { type EndoEvaluationProfileV0, validateEndoEvaluationResultV0 } from "../protocol/evaluation.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function profile(): EndoEvaluationProfileV0 {
	return {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: "endo.experiment.exp-1",
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		trialCount: 1,
	};
}

function result(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id: "endo.evidence.res-1",
		profile: profile(),
		trials: [
			{
				schemaVersion: "endo.trial-result.v0",
				coordinates: { schemaVersion: "endo.trial.v0", experimentId: "endo.experiment.exp-1", trial: 0 },
				raw: { ok: true },
			},
		],
		...overrides,
	};
}

describe("buildEndoExperimentBundleV0", () => {
	it("bundles a valid result with its canonical digest", () => {
		const r = result();
		const bundle = buildEndoExperimentBundleV0("endo.evidence.bundle-1", r);
		expect(bundle.schemaVersion).toBe("endo.experiment-bundle.v0");
		expect(bundle.id).toBe("endo.evidence.bundle-1");
		expect(bundle.result).toBeTypeOf("object");
		expect(bundle.digest).toBe(sha256HexV0(canonicalEndoJsonV0(bundle.result)));
		expect(bundle.digest).not.toBe(DIGEST);
	});

	it("is the strict door on id and result", () => {
		expect(() => buildEndoExperimentBundleV0("endo.run.r1", result())).toThrow(TypeError);
		expect(() => buildEndoExperimentBundleV0("bundle-1", result())).toThrow(TypeError);
		expect(() => buildEndoExperimentBundleV0("endo.evidence.bundle-1", { ...result(), id: "res-1" })).toThrow(
			TypeError,
		);
		expect(() => buildEndoExperimentBundleV0("endo.evidence.bundle-1", { ...result(), trials: [] })).toThrow(
			/not a valid endo.evaluation-result/,
		);
	});

	it("keeps the digest stable for the same result and different for a different one", () => {
		const r = result();
		const first = buildEndoExperimentBundleV0("endo.evidence.bundle-1", r);
		const second = buildEndoExperimentBundleV0("endo.evidence.bundle-2", r);
		const third = buildEndoExperimentBundleV0("endo.evidence.bundle-3", { ...r, wallTimeMs: 99 });
		expect(first.digest).toBe(second.digest);
		expect(first.digest).not.toBe(third.digest);
	});

	it("bundles the validated result: the bundle passes its own validator", () => {
		const r = result();
		const bundle = buildEndoExperimentBundleV0("endo.evidence.bundle-1", r);
		expect(validateEndoEvaluationResultV0(bundle.result)).toBeTypeOf("object");
		expect(bundle.result).toBe(r);
	});
});
