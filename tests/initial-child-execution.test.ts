import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { prepareVerifiedInitialBranchPairV0, readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import {
	approveInitialChildExecutionV0,
	executeInitialChildV0,
	preflightInitialChildExecutionV0,
	recordInitialChildPreflightRefusalV0,
	verifyInitialChildExecutionEvidenceV0,
} from "../cli/initial-child-execution.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { archiveEndoWorkspaceV0 } from "../storage/workspace-snapshot.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
let upstream: FakeOpenAiServer;
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
	upstream = await startFakeOpenAiServer({ chunkMs: 2 });
}, 120_000);
afterAll(async () => {
	await upstream?.close();
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
const conditions = [
	{ id: "baseline", description: "off", settings: { thinkingLevel: "off" } },
	{ id: "alternative", description: "high", settings: { thinkingLevel: "high" } },
] as const;
function setup() {
	const outputParent = mkdtempSync(join(fixture.base, "execution-out-"));
	const preparation = prepareVerifiedInitialBranchPairV0(
		fixture.source,
		fixture.replay,
		fixture.key,
		outputParent,
		conditions[0],
		conditions[1],
	);
	if (preparation.status !== "prepared") throw new Error(`preparation ${preparation.reason}`);
	const options = {
		source: fixture.source,
		replay: fixture.replay,
		outputParent,
		preparation: preparation.preparation,
		childRole: "baseline" as const,
		piExecutable: fixture.pi.bin,
		upstream: new URL(upstream.baseUrl).origin,
		provider: "fake",
		model: "fake-1",
		prompt: "Reply with ready",
		wallTimeoutMs: 10000,
		maxTransferredBytes: 1024 * 1024,
	};
	return { options, preparation };
}
async function ready(options: ReturnType<typeof setup>["options"]) {
	const preflight = await preflightInitialChildExecutionV0(options, fixture.key);
	expect(preflight.status).toBe("ready");
	if (preflight.status !== "ready") throw new Error(preflight.reason);
	return preflight.plan;
}

describe("governed initial child execution", () => {
	it("records one fresh tool-free model exchange and verifies unchanged siblings and provenance", async () => {
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
			expect(fixture.report.comparison.layers[layer].status).toBe("EXACT");
		const { options, preparation } = setup();
		const sourceBefore = canonicalEndoJsonV0(readEndoCaptureEventsV0(fixture.source));
		const replayBefore = canonicalEndoJsonV0(readEndoCaptureEventsV0(fixture.replay));
		const childrenBefore = Object.fromEntries(
			Object.entries(preparation.children).map(([role, child]) => [
				role,
				archiveEndoWorkspaceV0(child.directory).bytes,
			]),
		);
		const plan = await ready(options);
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
		expect(result.status, JSON.stringify(result)).toBe("completed");
		if (result.status !== "completed") return;
		expect(
			verifyInitialChildExecutionEvidenceV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				join(result.area, "receipt.json"),
			),
		).toEqual({ status: "verified", attemptId: plan.attemptId });
		expect(upstream.requests.filter((r) => r.url === "/v1/chat/completions")).toHaveLength(1);
		expect(
			readVerifiedInitialBranchSetV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				options.outputParent,
				options.preparation,
			).status,
		).toBe("verified-pristine");
		for (const [role, child] of Object.entries(preparation.children))
			expect(archiveEndoWorkspaceV0(child.directory).bytes).toEqual(childrenBefore[role]);
		expect(canonicalEndoJsonV0(readEndoCaptureEventsV0(fixture.source))).toBe(sourceBefore);
		expect(canonicalEndoJsonV0(readEndoCaptureEventsV0(fixture.replay))).toBe(replayBefore);
		expect(await executeInitialChildV0(plan, approval, options.prompt, fixture.key)).toMatchObject({
			status: "refused",
		});
	}, 120_000);
	it("refuses missing authority, wrong child, changed plan and unsupported alternative", async () => {
		const { options } = setup();
		const plan = await ready(options);
		expect(await executeInitialChildV0(plan, null, options.prompt, fixture.key)).toMatchObject({ status: "refused" });
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		expect(
			await executeInitialChildV0({ ...plan, childRole: "alternative" }, approval, options.prompt, fixture.key),
		).toMatchObject({ status: "refused" });
		expect(
			await executeInitialChildV0({ ...plan, model: "other" }, approval, options.prompt, fixture.key),
		).toMatchObject({ status: "refused" });
		expect(
			(await preflightInitialChildExecutionV0({ ...options, childRole: "alternative" }, fixture.key)).status,
		).toBe("refused");
	}, 120_000);
	it("refuses changed child and tampered receipt", async () => {
		const { options, preparation } = setup();
		const plan = await ready(options);
		writeFileSync(join(preparation.children.baseline.directory, "work", "endophasia-study.txt"), "modified");
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		expect(await executeInitialChildV0(plan, approval, options.prompt, fixture.key)).toMatchObject({
			status: "refused",
		});
	}, 120_000);
	it.each([
		["ignore-no-tools", "tool exposure"],
		["spurious-tool-event", "tool call"],
		["wrong-request-model", "model mismatch"],
	] as const)(
		"rejects %s despite a completed fake Pi turn",
		async (scenario, _label) => {
			fixture.pi.setScenario(`model-endpoint,${scenario}`);
			try {
				const { options } = setup();
				const plan = await ready(options);
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
				expect(result.status, JSON.stringify(result)).toBe("outcome-unknown");
				if ("area" in result)
					expect(
						verifyInitialChildExecutionEvidenceV0(
							fixture.source,
							fixture.replay,
							fixture.key,
							join(result.area, "receipt.json"),
						).status,
					).toBe("unverified");
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it("retains an ambiguous timeout and will not reuse its approval", async () => {
		const { options } = setup();
		const slow = { ...options, prompt: "Count to forty", wallTimeoutMs: 1000 };
		const plan = await ready(slow);
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		const result = await executeInitialChildV0(plan, approval, slow.prompt, fixture.key);
		expect(result.status, JSON.stringify(result)).toBe("outcome-unknown");
		expect(await executeInitialChildV0(plan, approval, slow.prompt, fixture.key)).toMatchObject({
			status: "refused",
		});
	}, 120_000);
	it("rejects a forged receipt and another digest domain", async () => {
		const { options } = setup();
		const plan = await ready(options);
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
		expect(result.status, JSON.stringify(result)).toBe("completed");
		if (result.status !== "completed") return;
		const file = join(result.area, "receipt.json");
		const original = readFileSync(file, "utf8");
		const changed = JSON.parse(original);
		changed.plan.childId = "endo.prepared-child.00000000-0000-4000-8000-000000000000";
		writeFileSync(file, canonicalEndoJsonV0(changed));
		expect(verifyInitialChildExecutionEvidenceV0(fixture.source, fixture.replay, fixture.key, file).status).toBe(
			"unverified",
		);
		writeFileSync(file, original);
		const otherKey = (await import("../runtime/contracts/keyed-digest.ts")).endoDigestKeyV0(
			Buffer.alloc(32, 7),
			"other",
		);
		expect(verifyInitialChildExecutionEvidenceV0(fixture.source, fixture.replay, otherKey, file).status).toBe(
			"unverified",
		);
	}, 120_000);
	it("records a no-inference preflight refusal without granting execution authority", () => {
		const { options } = setup();
		const count = upstream.requests.length;
		const result = recordInitialChildPreflightRefusalV0(options, fixture.key, "unsupported condition");
		expect(result.status).toBe("recorded");
		if (result.status !== "recorded") return;
		expect(
			verifyInitialChildExecutionEvidenceV0(fixture.source, fixture.replay, fixture.key, result.receipt),
		).toMatchObject({
			status: "unverified",
			outcome: "preflight-refused",
		});
		expect(upstream.requests.length).toBe(count);
	});
	it("refuses inherited nested Pi startup configuration", async () => {
		const { options, preparation } = setup();
		mkdirSync(join(preparation.children.baseline.directory, "work", ".pi"));
		writeFileSync(join(preparation.children.baseline.directory, "work", ".pi", "settings.json"), "{}");
		expect((await preflightInitialChildExecutionV0(options, fixture.key)).status).toBe("refused");
	}, 120_000);
	it("rejects damaged capture evidence and changed post-execution workspace", async () => {
		const { options } = setup();
		const plan = await ready(options);
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
		expect(result.status).toBe("completed");
		if (result.status !== "completed") return;
		const file = join(result.area, "receipt.json");
		writeFileSync(join(result.area, "runtime", "work", "endophasia-study.txt"), "later edit");
		expect(verifyInitialChildExecutionEvidenceV0(fixture.source, fixture.replay, fixture.key, file).status).toBe(
			"unverified",
		);
		appendFileSync(join(result.area, "evidence", "capture", "events", "events.log"), "torn tail");
		expect(verifyInitialChildExecutionEvidenceV0(fixture.source, fixture.replay, fixture.key, file).status).toBe(
			"unverified",
		);
	}, 120_000);
	it("keeps an upstream disconnection as an ambiguous one-attempt outcome", async () => {
		const broken = await startFakeOpenAiServer({ disconnectAfterFirstChunk: true });
		try {
			const { options } = setup();
			const selected = { ...options, upstream: new URL(broken.baseUrl).origin };
			const plan = await ready(selected);
			const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
			const result = await executeInitialChildV0(plan, approval, selected.prompt, fixture.key);
			expect(result.status).toBe("outcome-unknown");
			expect(broken.requests.filter((r) => r.url === "/v1/chat/completions")).toHaveLength(1);
			if ("area" in result)
				expect(
					verifyInitialChildExecutionEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					).status,
				).toBe("unverified");
			expect(await executeInitialChildV0(plan, approval, selected.prompt, fixture.key)).toMatchObject({
				status: "refused",
			});
		} finally {
			await broken.close();
		}
	}, 120_000);
});
