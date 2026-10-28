import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type AaOperatorConfigV0,
	renderAaOutcomeV0,
	runAaOperatorV0,
} from "../research/governed-initial-continuation/aa/operator.ts";
import { provenanceEndPathV0 } from "../research/governed-initial-continuation/aa/task-owned-provenance.ts";
import { type AaRig, createAaRig, portIsFree, runningFrom, ScriptedTerminal } from "./fixtures/aa-operator-rig.ts";
import type { FakeOpenAiOptions } from "./fixtures/fake-openai-server.ts";

// The fake endpoint reads its options on every request, so one rig serves every fault by mutating this object.
const faults: { -readonly [K in keyof FakeOpenAiOptions]: FakeOpenAiOptions[K] } = { chunkMs: 2 };
let rig: AaRig;
beforeAll(async () => {
	rig = await createAaRig(faults);
}, 240000);
afterAll(async () => {
	await rig?.close();
});
afterEach(() => {
	for (const key of Object.keys(faults) as Array<keyof typeof faults>) if (key !== "chunkMs") delete faults[key];
	rig.backend.setHealth([]);
	expect(runningFrom(rig.relay)).toEqual([]);
});

describe.runIf(process.platform === "linux")("operator under model-endpoint faults", () => {
	const study = async (config: AaOperatorConfigV0) => {
		rig.backend.setHealth([{ status: 200, body: '{"status":"ok"}' }]);
		const before = rig.backend.completionRequests().length;
		const terminal = new ScriptedTerminal();
		const outcome = await runAaOperatorV0(config, rig.fixture.key, terminal, new AbortController().signal);
		return { outcome, terminal, requests: rig.backend.completionRequests().length - before };
	};
	it.each([
		["a response lost after dispatch", { disconnectAfterFirstChunk: true }, "outcome-unknown"],
		["an upstream error", { failWith: { status: 500, body: '{"error":"synthetic"}' } }, undefined],
		["a malformed stream", { malformedStream: true }, undefined],
		["a stream with no answer", { emptyAnswer: true }, undefined],
	] as const)(
		"stops after %s and never retries or continues",
		async (_name, fault, expectedStatus) => {
			Object.assign(faults, fault);
			const config = await rig.newConfig();
			const { outcome, terminal, requests } = await study(config);
			// At most the one authorised request was spent; nothing was resent, and no continuation was offered.
			expect(requests).toBe(1);
			expect(terminal.count("second")).toBe(0);
			expect(outcome.slots).toHaveLength(1);
			expect(outcome.slots[0]!.status).not.toBe("completed");
			if (expectedStatus) expect(outcome.slots[0]!.status).toBe(expectedStatus);
			expect(outcome.verdict).toBe("partial");
			expect(outcome.stage).toBe("study"); // Where the study stopped, not that cleanup ran afterwards.
			expect(outcome.server.cleanup).toBe("confirmed");
			expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
			expect(await portIsFree(config.server.port)).toBe(true);
			const text = renderAaOutcomeV0(outcome);
			expect(text).toContain("PARTIAL");
			expect(text).not.toContain("COMPLETE-UNDER");
			// The spent slot stays spent: the same location cannot be run again, and no request is sent for it.
			delete faults.disconnectAfterFirstChunk;
			delete faults.failWith;
			delete faults.malformedStream;
			delete faults.emptyAnswer;
			const after = rig.backend.completionRequests().length;
			const rerun = await runAaOperatorV0(
				config,
				rig.fixture.key,
				new ScriptedTerminal(),
				new AbortController().signal,
			);
			expect(rerun).toMatchObject({ verdict: "refused", stage: "preparation" });
			expect(rig.backend.completionRequests().length).toBe(after);
		},
		120000,
	);
});
