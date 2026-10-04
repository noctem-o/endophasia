// The experiment manipulation checks (cli/experiment-checks.ts) on synthetic trials: each check passes on a correct
// arm and fails, with the trial named, on each kind of breach; a failing arm is invalid.

import { describe, expect, it } from "vitest";
import { type EndoTrialRequestsV0, endoManipulationChecksV0 } from "../cli/experiment-checks.ts";
import type { EndoExperimentManipulationV0 } from "../protocol/experiment-spec.ts";

const SYSTEM = { role: "system", content: "pi system prompt <cwd>/tmp/x</cwd>" };
const TOOLS = [{ type: "function", function: { name: "read" } }];
const base = (messages: unknown[] = []) => ({
	model: "m",
	stream: true,
	store: false,
	max_completion_tokens: 16384,
	messages: [SYSTEM, { role: "user", content: "do it" }, ...messages],
	tools: TOOLS,
});

const MANIPULATION: EndoExperimentManipulationV0 = {
	baseline: "a",
	conditions: {
		a: { injected: {} },
		b: { injected: { temperature: 0, seed: 1234 } },
		"b-c": { injected: { temperature: 0, seed: 1234, cache_prompt: false }, zeroCacheReads: true },
	},
	identical: [["a", "none"]],
};

function trial(
	condition: string,
	n: number,
	requests: Record<string, unknown>[],
	cache = { pi: [0], server: [0] },
): EndoTrialRequestsV0 {
	return {
		task: "t",
		condition,
		trial: n,
		requests: requests as EndoTrialRequestsV0["requests"],
		piCacheReads: cache.pi,
		responseCacheCounters: cache.server,
	};
}

function goodTrials(): EndoTrialRequestsV0[] {
	return [
		trial("a", 0, [base(), base([{ role: "assistant", content: "x" }])], { pi: [0, 900], server: [0, 900] }),
		trial("a", 1, [base()], { pi: [800], server: [800] }),
		trial("none", 0, [base()], { pi: [0], server: [0] }),
		trial("b", 0, [
			{ ...base(), temperature: 0, seed: 1234 },
			{ ...base([{ role: "assistant", content: "y" }]), temperature: 0, seed: 1234 },
		]),
		trial("b-c", 0, [{ ...base(), temperature: 0, seed: 1234, cache_prompt: false }], { pi: [0], server: [0] }),
	];
}

describe("manipulation checks M1-M4", () => {
	it("pass on arms that change exactly what they declare; every condition with trials is valid", () => {
		const checks = endoManipulationChecksV0(MANIPULATION, goodTrials());
		for (const check of ["M1", "M2a", "M2b", "M3", "M4"] as const) expect(checks[check].status, check).toBe("PASS");
		expect(checks.validity).toEqual({ a: "valid", b: "valid", "b-c": "valid", none: "valid" });
	});

	it("M1 fails when an injected field is missing or wrong, or a baseline request carries a watched field", () => {
		const trials = goodTrials();
		trials[3]!.requests[1] = { ...trials[3]!.requests[1]!, seed: 7 };
		trials[1]!.requests[0] = { ...trials[1]!.requests[0]!, top_p: 0.9 };
		const checks = endoManipulationChecksV0(MANIPULATION, trials);
		expect(checks.M1.status).toBe("FAIL");
		expect(checks.M1.failures).toEqual([
			"t/a/#1 request 1: carries top_p = 0.9",
			"t/b/#0 request 2: seed is 7, expected 1234",
		]);
		expect(checks.validity).toMatchObject({ a: "invalid", b: "invalid", "b-c": "valid" });
	});

	it("M2 fails when the system prompt, tools or other fields change beyond the injected ones", () => {
		const trials = goodTrials();
		trials[3]!.requests[0] = {
			...trials[3]!.requests[0]!,
			messages: [
				{ role: "system", content: "other" },
				{ role: "user", content: "do it" },
			],
		};
		trials[4]!.requests[0] = { ...trials[4]!.requests[0]!, n_probs: 3 };
		const checks = endoManipulationChecksV0(MANIPULATION, trials);
		expect(checks.M2a.status).toBe("FAIL");
		expect(checks.M2a.invalidates).toEqual(["b", "b-c"]);
		expect(checks.M2b.failures).toContain(
			"t/b-c/#0 request 1: system message, tools or top-level fields differ from the baseline's",
		);
	});

	it("M3 fails on any cache read in a cache-off arm, Pi-reported or server-reported", () => {
		const trials = goodTrials();
		trials[4] = trial("b-c", 0, [{ ...base(), temperature: 0, seed: 1234, cache_prompt: false }], {
			pi: [0, 12],
			server: [0, 0, 5],
		});
		const checks = endoManipulationChecksV0(MANIPULATION, trials);
		expect(checks.M3.status).toBe("FAIL");
		expect(checks.M3.failures).toEqual([
			"t/b-c/#0: Pi reported cacheRead 12",
			"t/b-c/#0: the server reported cached tokens 5",
		]);
		expect(checks.validity["b-c"]).toBe("invalid");
	});

	it("M4 fails when the no-op extension's requests differ from no extension, invalidating both; it does not apply without both", () => {
		const trials = goodTrials();
		trials[2]!.requests[0] = { ...trials[2]!.requests[0]!, max_completion_tokens: 8192 };
		const checks = endoManipulationChecksV0(MANIPULATION, trials);
		expect(checks.M4.status).toBe("FAIL");
		expect(checks.validity).toMatchObject({ a: "invalid", none: "invalid" });
		const main = endoManipulationChecksV0(
			MANIPULATION,
			goodTrials().filter((t) => t.condition !== "none"),
		);
		expect(main.M4.status).toBe("NOT-APPLICABLE");
		expect(main.validity.none).toBe("no trials");
	});
});
