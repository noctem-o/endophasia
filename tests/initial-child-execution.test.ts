import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
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
	it.each([
		["startup-lock", "completed", 1],
		["startup-auth-change", "failed", 0],
	] as const)("handles Pi %s before dispatch", async (scenario, expected, requestCount) => {
		const before = upstream.requests.length;
		const { options } = setup();
		try {
			fixture.pi.setScenario(`model-endpoint,${scenario}`);
			const plan = await ready(options);
			const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
			const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
			expect(result.status).toBe(expected);
			expect(upstream.requests.length - before).toBe(requestCount);
			if (result.status === "completed")
				expect(
					verifyInitialChildExecutionEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					).status,
				).toBe("verified");
			else expect(result).toMatchObject({ reason: "adapted runtime changed before dispatch" });
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	});
	it("preflights aliased help but refuses missing --no-mcp without requests, approval or receipts", async () => {
		const { options } = setup();
		const before = readdirSync(options.outputParent).sort();
		const requests = upstream.requests.length;
		const pidFile = join(dirname(fixture.pi.packageJson), "rpc-pid");
		rmSync(pidFile, { force: true });
		try {
			fixture.pi.setScenario("model-endpoint,record-rpc-pid,help-aliases");
			const checked = await preflightInitialChildExecutionV0(options, fixture.key);
			expect(checked.status).toBe("ready");
			// A successful preflight grants no approval and writes no attempt area either.
			expect(checked).not.toHaveProperty("approval");
			fixture.pi.setScenario("model-endpoint,record-rpc-pid,help-aliases,help-missing:--no-mcp");
			const refused = await preflightInitialChildExecutionV0(options, fixture.key);
			expect(refused).toEqual({
				status: "refused",
				reason: "Pi executable or required resource-disabling flags unverified",
			});
			expect(refused).not.toHaveProperty("plan");
			expect(refused).not.toHaveProperty("approval");
			expect(refused).not.toHaveProperty("receipt");
			expect(readdirSync(options.outputParent).sort()).toEqual(before);
			expect(upstream.requests.length).toBe(requests);
			expect(existsSync(pidFile)).toBe(false);
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120_000);
	it("uses the remaining startup deadline instead of restarting the RPC timeout after a slow state read", async () => {
		fixture.pi.setScenario("model-endpoint,record-rpc-pid,delay-startup-state,hang-on:get_entries");
		const pidFile = join(dirname(fixture.pi.packageJson), "rpc-pid");
		rmSync(pidFile, { force: true });
		try {
			const { options } = setup();
			const plan = await ready({ ...options, wallTimeoutMs: 3000 });
			const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
			const count = upstream.requests.length;
			const running = executeInitialChildV0(plan, approval, options.prompt, fixture.key);
			await expect.poll(() => existsSync(pidFile), { timeout: 3000 }).toBe(true);
			const spawnedAt = Date.now();
			const result = await running;
			expect(result).toMatchObject({ status: "failed", reason: "timeout" });
			expect(Date.now() - spawnedAt).toBeLessThan(4000);
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
			expect(upstream.requests.length).toBe(count);
			if ("area" in result)
				expect(existsSync(join(result.area, "evidence", "events", "session-attachment.lock"))).toBe(false);
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120_000);
	it.each(["get_state", "get_entries"])(
		"interrupts startup %s on cancellation",
		async (command) => {
			fixture.pi.setScenario(`model-endpoint,record-rpc-pid,hang-on:${command}`);
			const marker = join(dirname(fixture.pi.packageJson), "rpc-hung");
			rmSync(marker, { force: true });
			const abort = new AbortController();
			let running: ReturnType<typeof executeInitialChildV0> | undefined;
			try {
				const { options } = setup();
				const plan = await ready({ ...options, wallTimeoutMs: 5000 });
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const count = upstream.requests.length;
				running = executeInitialChildV0(plan, approval, options.prompt, fixture.key, abort.signal);
				await expect
					.poll(() => (existsSync(marker) ? readFileSync(marker, "utf8") : null), { timeout: 3000 })
					.toBe(command);
				const cancelledAt = Date.now();
				abort.abort();
				const result = await running;
				expect(Date.now() - cancelledAt).toBeLessThan(2000);
				expect(result.status).toBe("cancelled");
				const pid = Number(readFileSync(join(dirname(fixture.pi.packageJson), "rpc-pid"), "utf8"));
				expect(() => process.kill(pid, 0)).toThrow();
				if ("area" in result)
					expect(existsSync(join(result.area, "evidence", "events", "session-attachment.lock"))).toBe(false);
				expect(upstream.requests.length).toBe(count);
			} finally {
				abort.abort();
				await running;
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it("observes settlement batched with the prompt acknowledgement", async () => {
		fixture.pi.setScenario("model-endpoint,batch-output-100ms");
		try {
			const { options } = setup();
			const plan = await ready({ ...options, wallTimeoutMs: 3000 });
			const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
			const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
			expect(result.status, JSON.stringify(result)).toBe("completed");
			if (result.status === "completed")
				expect(
					verifyInitialChildExecutionEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					).status,
				).toBe("verified");
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120_000);
	it.each(["cancel", "timeout"])(
		"stops promptly on %s while a post-dispatch entry read hangs",
		async (mode) => {
			fixture.pi.setScenario("model-endpoint,record-rpc-pid,hang-entries-after-prompt,ignore-eof");
			const abort = new AbortController();
			try {
				const { options } = setup();
				const plan = await ready({
					...options,
					prompt: "Count to forty",
					wallTimeoutMs: mode === "timeout" ? 1000 : 10000,
				});
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const count = upstream.requests.length;
				const startedAt = Date.now();
				const running = executeInitialChildV0(plan, approval, "Count to forty", fixture.key, abort.signal);
				await expect.poll(() => upstream.requests.length, { timeout: 5000 }).toBeGreaterThan(count);
				if (mode === "cancel") abort.abort();
				const result = await running;
				expect(result.status).toBe(mode === "cancel" ? "cancelled" : "outcome-unknown");
				expect(Date.now() - startedAt).toBeLessThan(4000);
				const pid = Number(readFileSync(join(dirname(fixture.pi.packageJson), "rpc-pid"), "utf8"));
				expect(() => process.kill(pid, 0)).toThrow();
				if ("area" in result) {
					expect(existsSync(join(result.area, "evidence", "events", "session-attachment.lock"))).toBe(false);
					expect(
						verifyInitialChildExecutionEvidenceV0(
							fixture.source,
							fixture.replay,
							fixture.key,
							join(result.area, "receipt.json"),
						).status,
					).toBe("unverified");
				}
			} finally {
				abort.abort();
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it("records one fresh tool-free model exchange and verifies unchanged siblings and provenance", async () => {
		const requestsBefore = upstream.requests.filter((r) => r.url === "/v1/chat/completions").length;
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
		expect(upstream.requests.filter((r) => r.url === "/v1/chat/completions")).toHaveLength(requestsBefore + 1);
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
	it.each(["get_state", "get_entries"])(
		"stops owned Pi and releases its store when startup %s times out",
		async (command) => {
			fixture.pi.setScenario(`model-endpoint,record-rpc-pid,hang-on:${command}`);
			let pid: number | undefined;
			try {
				const count = upstream.requests.length;
				const { options } = setup();
				const plan = await ready({ ...options, wallTimeoutMs: 1000 });
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
				expect(result.status).toBe("failed");
				pid = Number(readFileSync(join(dirname(fixture.pi.packageJson), "rpc-pid"), "utf8"));
				expect(() => process.kill(pid!, 0)).toThrow();
				if ("area" in result)
					expect(existsSync(join(result.area, "evidence", "events", "session-attachment.lock"))).toBe(false);
				expect(upstream.requests.length).toBe(count);
			} finally {
				if (pid !== undefined) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* Already reaped by the attachment. */
					}
				}
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it.each(["stdout-overflow-after-settled", "stdout-overflow-after-exit"])(
		"rejects %s",
		async (scenario) => {
			fixture.pi.setScenario(`model-endpoint,${scenario}`);
			try {
				const { options } = setup();
				const plan = await ready(options);
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
				expect(result.status, JSON.stringify(result)).toBe("outcome-unknown");
				if ("area" in result) {
					const violations = readEndoStoreEventsV0(join(result.area, "evidence")).filter(
						(event) => event.kind === "harness.output-limit-exceeded",
					);
					expect(violations).toHaveLength(1);
					expect((violations[0]!.payload as { bytes: number }).bytes).toBeGreaterThan(2 * 1024 * 1024);
					expect(
						verifyInitialChildExecutionEvidenceV0(
							fixture.source,
							fixture.replay,
							fixture.key,
							join(result.area, "receipt.json"),
						).status,
					).toBe("unverified");
				}
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it.each(["", ",split-text-parts"])(
		"verifies Pi text-part array%s against the exact approved prompt",
		async (extra) => {
			fixture.pi.setScenario(`model-endpoint,prompt-text-parts${extra}`);
			try {
				const { options } = setup();
				const plan = await ready(options);
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
				expect(result.status, JSON.stringify(result)).toBe("completed");
				if (result.status === "completed")
					expect(
						verifyInitialChildExecutionEvidenceV0(
							fixture.source,
							fixture.replay,
							fixture.key,
							join(result.area, "receipt.json"),
						),
					).toEqual({ status: "verified", attemptId: plan.attemptId });
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it.each(["altered-text-part", "image-prompt-part", "unknown-prompt-part-field"])(
		"refuses unapproved prompt content in text arrays: %s",
		async (scenario) => {
			fixture.pi.setScenario(`model-endpoint,prompt-text-parts,${scenario}`);
			try {
				const { options } = setup();
				const plan = await ready(options);
				const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
				const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
				expect(result.status).toBe("outcome-unknown");
				expect(result).toMatchObject({
					reason: "final evidence single approved prompt not observed in model request",
				});
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120_000,
	);
	it("independently refuses a durable stdout violation despite a completed receipt", async () => {
		const { options } = setup();
		const plan = await ready(options);
		const approval = approveInitialChildExecutionV0(plan, plan.commitment, "approve one tool-free turn");
		const result = await executeInitialChildV0(plan, approval, options.prompt, fixture.key);
		expect(result.status).toBe("completed");
		if (result.status !== "completed") return;
		const root = join(result.area, "evidence");
		const events = readEndoStoreEventsV0(root);
		const last = events.at(-1)!;
		const store = createEndoDurableEventStoreV0(root);
		try {
			store.ingest({
				...last,
				id: "endo.event.test.stdout-limit",
				sequence: last.sequence + 1,
				kind: "harness.output-limit-exceeded",
				payload: { bytes: 3 * 1024 * 1024 },
			});
		} finally {
			store.close();
		}
		expect(
			verifyInitialChildExecutionEvidenceV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				join(result.area, "receipt.json"),
			),
		).toMatchObject({ status: "unverified", reason: "runtime stdout limit exceeded" });
	}, 120_000);
});
