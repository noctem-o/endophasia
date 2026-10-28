import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareVerifiedInitialBranchPairV0 } from "../cli/initial-branch-set.ts";
import { createStudyPlan, readStudyPlan } from "../research/governed-initial-continuation/aa/study-plan.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
let upstream: FakeOpenAiServer;
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
	upstream = await startFakeOpenAiServer();
}, 120000);
afterAll(async () => {
	await upstream?.close();
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
function setup(matched = true) {
	const outputParent = mkdtempSync(join(fixture.base, "aa-plan-"));
	const prep = prepareVerifiedInitialBranchPairV0(
		fixture.source,
		fixture.replay,
		fixture.key,
		outputParent,
		{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
		{ id: "arm-b", description: "matched", settings: { thinkingLevel: matched ? "off" : "high" } },
	);
	if (prep.status !== "prepared") throw new Error(prep.reason);
	return {
		outputParent,
		preparation: prep.preparation,
		source: fixture.source,
		replay: fixture.replay,
		piExecutable: fixture.pi.bin,
		upstream: new URL(upstream.baseUrl).origin,
		provider: "fake",
		model: "fake-1",
		prompt: "Compute 4 plus 5. Return only the decimal result.",
		continuationPrompt: "Repeat only the token in your immediately preceding answer.",
		wallTimeoutMs: 15000,
		maxApprovalIdleMs: 5000,
		maxTransferredBytes: 1048576,
	};
}
describe("private A/A plan", () => {
	it.each([
		[0, ["baseline", "alternative", "alternative", "baseline"]],
		[1, ["alternative", "baseline", "baseline", "alternative"]],
	] as const)(
		"publishes and verifies seed %s without dispatch",
		async (seed, order) => {
			const options = setup();
			const file = join(options.outputParent, "study.json");
			const before = upstream.requests.length;
			const plan = await createStudyPlan(file, options, seed, "9", "fake endpoint declaration", fixture.key);
			expect(plan.order).toEqual(order);
			expect(await readStudyPlan(file, fixture.key)).toEqual(plan);
			expect(upstream.requests.length).toBe(before);
			await expect(
				createStudyPlan(file, options, seed, "9", "fake endpoint declaration", fixture.key),
			).rejects.toThrow();
			const changed = JSON.parse(readFileSync(file, "utf8"));
			changed.order.reverse();
			writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
			await expect(readStudyPlan(file, fixture.key)).rejects.toThrow();
		},
		120000,
	);
	it("refuses unequal conditions, wrong expected answers and excessive budgets", async () => {
		const options = setup(false);
		await expect(
			createStudyPlan(join(options.outputParent, "study.json"), options, 0, "9", "fake", fixture.key),
		).rejects.toThrow("conditions");
		const matched = setup();
		await expect(
			createStudyPlan(join(matched.outputParent, "study.json"), matched, 0, "8", "fake", fixture.key),
		).rejects.toThrow();
		await expect(
			createStudyPlan(
				join(matched.outputParent, "study.json"),
				{ ...matched, wallTimeoutMs: 120001 },
				0,
				"9",
				"fake",
				fixture.key,
			),
		).rejects.toThrow();
	}, 120000);
});
