import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareVerifiedInitialBranchPairV0, readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import {
	approveContinuationTurnV0,
	approveInitialContinuationV0,
	executeInitialContinuationV0,
	preflightInitialContinuationV0,
	verifyInitialContinuationEvidenceV0,
} from "../cli/initial-continuation.ts";
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

describe("matched continuation API feasibility with fake Pi", () => {
	it.each([
		["ABBA", ["baseline", "alternative", "alternative", "baseline"]],
		["BAAB", ["alternative", "baseline", "baseline", "alternative"]],
	] as const)(
		"independently verifies four fresh sessions in %s order",
		async (_label, order) => {
			const outputParent = mkdtempSync(join(fixture.base, "aa-feasibility-"));
			const prep = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				outputParent,
				{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
				{ id: "arm-b", description: "matched", settings: { thinkingLevel: "off" } },
			);
			if (prep.status !== "prepared") throw new Error(prep.reason);
			const attempts = new Set<string>();
			const sessions = new Set<string>();
			const before = upstream.requests.length;
			for (const childRole of order) {
				const options = {
					source: fixture.source,
					replay: fixture.replay,
					outputParent,
					preparation: prep.preparation,
					childRole,
					piExecutable: fixture.pi.bin,
					upstream: new URL(upstream.baseUrl).origin,
					provider: "fake",
					model: "fake-1",
					prompt: "Reply with ready",
					continuationPrompt: "Continue with another answer",
					wallTimeoutMs: 15000,
					maxApprovalIdleMs: 5000,
					maxTransferredBytes: 1024 * 1024,
				};
				const preflight = await preflightInitialContinuationV0(options, fixture.key);
				if (preflight.status !== "ready") throw new Error(preflight.reason);
				const result = await executeInitialContinuationV0(
					preflight.plan,
					approveInitialContinuationV0(preflight.plan, preflight.plan.commitment, "approve first tool-free turn"),
					options.prompt,
					options.continuationPrompt,
					fixture.key,
					async (boundary) =>
						approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn"),
				);
				expect(result.status, JSON.stringify(result)).toBe("completed");
				if (!("area" in result)) throw new Error("missing attempt area");
				const verified = await verifyInitialContinuationEvidenceV0(
					fixture.source,
					fixture.replay,
					fixture.key,
					join(result.area, "receipt.json"),
				);
				expect(verified.status).toBe("verified");
				const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
				attempts.add(receipt.plan.initial.attemptId);
				sessions.add(receipt.runtime.sessionId);
				expect(
					readVerifiedInitialBranchSetV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						outputParent,
						prep.preparation,
					).status,
				).toBe("verified-pristine");
			}
			expect(attempts.size).toBe(4);
			expect(sessions.size).toBe(4);
			expect(upstream.requests.length - before).toBe(8);
		},
		120000,
	);
});
