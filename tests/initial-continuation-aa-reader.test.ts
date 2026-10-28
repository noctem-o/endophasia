import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareVerifiedInitialBranchPairV0 } from "../cli/initial-branch-set.ts";
import { runNextSlot } from "../research/governed-initial-continuation/aa/coordinator.ts";
import {
	cwdAdjustedContext,
	inspectStoppedSlot,
	readStudy,
	sealSlot,
	slotPath,
} from "../research/governed-initial-continuation/aa/reader.ts";
import { createStudyPlan } from "../research/governed-initial-continuation/aa/study-plan.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
let upstream: FakeOpenAiServer;
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
	upstream = await startFakeOpenAiServer({ chunkMs: 2 });
}, 120000);
afterAll(async () => {
	await upstream?.close();
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
describe("independent A/A reader", () => {
	it("refuses a preexisting cwd substitution marker and repeated cwd", () => {
		const marker = "<cwd>\n[verified-runtime-working-directory]\n</cwd>";
		expect(() => cwdAdjustedContext([{ role: "system", content: marker }], "/private/work")).toThrow("collision");
		expect(() =>
			cwdAdjustedContext(
				[{ role: "system", content: "<cwd>\n/private/work\n</cwd> /private/work" }],
				"/private/work",
			),
		).toThrow("uniquely");
	});
	it.each(["first", "second", "environment-cancel", "environment-hang", "environment-expired"] as const)(
		"stops permanently on denied %s approval",
		async (denied) => {
			const outputParent = mkdtempSync(join(fixture.base, "aa-denial-"));
			const prep = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				outputParent,
				{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
				{ id: "arm-b", description: "matched", settings: { thinkingLevel: "off" } },
			);
			if (prep.status !== "prepared") throw new Error(prep.reason);
			const options = {
				source: fixture.source,
				replay: fixture.replay,
				outputParent,
				preparation: prep.preparation,
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
			const file = join(outputParent, "study.json");
			await createStudyPlan(file, options, 0, "9", "synthetic endpoint", fixture.key);
			const before = upstream.requests.length;
			const controller = new AbortController();
			let checks = 0;
			let clock: ReturnType<typeof vi.spyOn> | undefined;
			const hooks = {
				checkEnvironment: async () => {
					if (++checks === 2 && denied === "environment-cancel") controller.abort();
					if (checks === 2 && denied === "environment-hang") {
						setTimeout(() => controller.abort(), 10);
						return new Promise<boolean>(() => {});
					}
					if (checks === 2 && denied === "environment-expired")
						clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 300001);
					return true;
				},
				first: async (_p: unknown, phrase: string) => (denied === "first" ? null : phrase),
				second: async (_b: unknown, phrase: string) => (denied === "second" ? null : phrase),
			};
			let result: string;
			try {
				result = await runNextSlot(file, fixture.key, hooks, controller.signal);
			} finally {
				clock?.mockRestore();
			}
			expect(result).toBe(denied === "second" ? "first-turn-verified" : "no-request-cancelled");
			expect(await inspectStoppedSlot(file, fixture.key, 1)).toBe(result);
			expect(upstream.requests.length - before).toBe(denied === "second" ? 1 : 0);
			await expect(runNextSlot(file, fixture.key, hooks)).rejects.toThrow();
		},
		120000,
	);
	it.each([0, 1])(
		"verifies four governed fake sessions in seed %s order and scores wrong answers separately",
		async (seed) => {
			const outputParent = mkdtempSync(join(fixture.base, "aa-reader-"));
			const prep = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				outputParent,
				{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
				{ id: "arm-b", description: "matched", settings: { thinkingLevel: "off" } },
			);
			if (prep.status !== "prepared") throw new Error(prep.reason);
			const options = {
				source: fixture.source,
				replay: fixture.replay,
				outputParent,
				preparation: prep.preparation,
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
			const file = join(outputParent, "study.json");
			const study = await createStudyPlan(file, options, seed, "9", "synthetic endpoint", fixture.key);
			for (let index = 0; index < 4; index++) {
				const status = await runNextSlot(file, fixture.key, {
					checkEnvironment: async () => true, // Fake fixture only; no real observer is supplied here.
					first: async (_plan, phrase) => phrase,
					second: async (_boundary, phrase) => phrase,
				});
				expect(status).toBe("completed");
			}

			const comparison = await readStudy(file, fixture.key);
			expect(comparison.status).toBe("four-receipts");
			expect(comparison.effectiveParametersEqual).toBe(true);
			expect(comparison.trials).toHaveLength(4);
			expect(
				comparison.trials.every((t) => t.receiptStatus === "verified" && !t.firstCorrect && !t.referenceCorrect),
			).toBe(true);
			expect(comparison.comparisons).toHaveLength(6);
			expect(comparison.trials.every((t) => t.turns.every((turn) => turn.cwdAdjusted))).toBe(true);
			const extra = `${file}.slot-5.start.json`;
			writeFileSync(extra, "{}", { mode: 0o600 });
			await expect(readStudy(file, fixture.key)).rejects.toThrow("unplanned slot");
			rmSync(extra);
			const start2 = slotPath(file, 2, "start");
			const originalStart = readFileSync(start2);
			const changed = JSON.parse(originalStart.toString());
			const { commitment: _saved, ...changedBody } = changed;
			changedBody.arm = study.order[0];
			writeFileSync(start2, canonicalEndoJsonV0(sealSlot(fixture.key, "start", changedBody)), { mode: 0o600 });
			await expect(readStudy(file, fixture.key)).rejects.toThrow();
			writeFileSync(start2, originalStart, { mode: 0o600 });
			const end1 = slotPath(file, 1, "end");
			writeFileSync(end1, "{}", { mode: 0o600 });
			await expect(readStudy(file, fixture.key)).rejects.toThrow();
		},
		120000,
	);
});
