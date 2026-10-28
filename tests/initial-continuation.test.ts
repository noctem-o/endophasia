import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareVerifiedInitialBranchPairV0 } from "../cli/initial-branch-set.ts";
import {
	approveContinuationTurnV0,
	approveInitialContinuationV0,
	executeInitialContinuationV0,
	preflightInitialContinuationV0,
	verifyInitialContinuationEvidenceV0,
} from "../cli/initial-continuation.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
let upstream: FakeOpenAiServer;
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
	upstream = await startFakeOpenAiServer({ chunkMs: 2, splitWrites: true });
}, 120000);
afterAll(async () => {
	await upstream?.close();
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
function setup() {
	const outputParent = mkdtempSync(join(fixture.base, "continuation-out-"));
	const prep = prepareVerifiedInitialBranchPairV0(
		fixture.source,
		fixture.replay,
		fixture.key,
		outputParent,
		{ id: "baseline", description: "off", settings: { thinkingLevel: "off" } },
		{ id: "alternative", description: "high", settings: { thinkingLevel: "high" } },
	);
	if (prep.status !== "prepared") throw new Error(prep.reason);
	return {
		source: fixture.source,
		replay: fixture.replay,
		outputParent,
		preparation: prep.preparation,
		childRole: "baseline" as const,
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
}
async function planFor(options: ReturnType<typeof setup>) {
	const result = await preflightInitialContinuationV0(options, fixture.key);
	if (result.status !== "ready") throw new Error(result.reason);
	return result.plan;
}

describe("governed initial continuation", () => {
	it("accepts the Pi 1.0.1 startup prefix for two turns in one process", async () => {
		const recording = readFileSync(
			new URL("../research/pi-conformance/1.0.1/cassettes/completes/session.events.jsonl", import.meta.url),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; payload: { entryType?: string; details?: unknown } })
			.filter((event) => event.kind === "session.entry-observed");
		expect(recording.slice(0, 2).map((event) => event.payload)).toMatchObject([
			{ entryType: "model_change", details: { provider: "endolocal", modelId: "qwen3.8-27b" } },
			{ entryType: "thinking_level_change", details: { thinkingLevel: "off" } },
		]);
		fixture.pi.setScenario("model-endpoint,pi-1-startup");
		try {
			const options = setup(),
				plan = await planFor(options),
				before = upstream.requests.length;
			let pid = 0;
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async (boundary) => {
					pid = boundary.pid;
					expect(() => process.kill(pid, 0)).not.toThrow();
					return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
				},
			);
			expect(result.status, JSON.stringify(result)).toBe("completed");
			expect(upstream.requests.length - before).toBe(2);
			expect(() => process.kill(pid, 0)).toThrow();
			if (!("area" in result)) throw new Error("no receipt");
			const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
			const entries = readEndoStoreEventsV0(receipt.runtime.store)
				.filter((event) => event.kind === "session.entry-observed")
				.map((event) => event.payload as { entryType: string; details: Record<string, unknown> });
			expect(entries.map((entry) => entry.entryType)).toEqual([
				"model_change",
				"thinking_level_change",
				"message",
				"message",
				"message",
				"message",
			]);
			expect(entries[0]!.details).toEqual({ provider: "fake", modelId: "fake-1" });
			expect(entries[1]!.details).toEqual({ thinkingLevel: "off" });
			expect(
				(
					await verifyInitialContinuationEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					)
				).status,
			).toBe("verified");
			// Reframe modified events so the independent reader must examine the
			// session semantics, rather than merely detect a broken frame checksum.
			const logPath = join(receipt.runtime.store, "events", "events.log");
			const originalLog = readFileSync(logPath);
			const originalEvents = readEndoStoreEventsV0(receipt.runtime.store);
			type Entry = {
				entryType: string;
				details: Record<string, unknown>;
				parentId: string | null;
				recognized: boolean;
			};
			const mutations: Array<{ expected: string; apply: (entries: Entry[]) => void }> = [
				{
					expected: "unexpected session model selection",
					apply: (e) => {
						e[0]!.details.modelId = "other";
					},
				},
				{
					expected: "unexpected session model selection",
					apply: (e) => {
						e[0]!.details.provider = "other";
					},
				},
				{
					expected: "unexpected session model selection",
					apply: (e) => {
						delete e[0]!.details.modelId;
					},
				},
				{
					expected: "unexpected session model selection",
					apply: (e) => {
						e[1]!.entryType = "model_change";
						e[1]!.details = { provider: "fake", modelId: "fake-1" };
					},
				},
				{
					expected: "unexpected session setting",
					apply: (e) => {
						e[0]!.entryType = "thinking_level_change";
						e[0]!.details = { thinkingLevel: "off" };
					},
				},
				{
					expected: "session entry lineage mismatch",
					apply: (e) => {
						e[1]!.parentId = "wrong";
					},
				},
				{
					expected: "unexpected session entry",
					apply: (e) => {
						e[1]!.entryType = "unknown";
						e[1]!.recognized = false;
					},
				},
				{
					expected: "unexpected session model selection",
					apply: (e) => {
						e[3]!.entryType = "model_change";
						e[3]!.details = { provider: "fake", modelId: "fake-1" };
					},
				},
			];
			try {
				for (const mutation of mutations) {
					const events = structuredClone(originalEvents);
					const sessionEntries = events
						.filter((event) => event.kind === "session.entry-observed")
						.map((event) => event.payload as unknown as Entry);
					mutation.apply(sessionEntries);
					writeFileSync(
						logPath,
						Buffer.concat(events.map((event) => endoFrameBytesV0(Buffer.from(canonicalEndoJsonV0(event))))),
					);
					const checked = await verifyInitialContinuationEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					);
					expect(checked).toMatchObject({ status: "unverified", reason: mutation.expected });
				}
			} finally {
				writeFileSync(logPath, originalLog);
			}
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120000);
	it.each([
		"startup-wrong-model",
		"startup-wrong-provider",
		"startup-missing-model",
		"startup-duplicate-model",
		"startup-repeat-thinking",
		"startup-wrong-parent",
		"startup-unknown-entry",
		"post-turn-model-change",
	])(
		"rejects invalid startup or first-turn session entry: %s",
		async (fault) => {
			fixture.pi.setScenario(`model-endpoint,pi-1-startup,${fault}`);
			try {
				const options = setup(),
					plan = await planFor(options);
				let approved = false;
				const result = await executeInitialContinuationV0(
					plan,
					approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
					options.prompt,
					options.continuationPrompt,
					fixture.key,
					async () => {
						approved = true;
						return null;
					},
				);
				expect(result.status).not.toBe("completed");
				expect(approved).toBe(false);
				if ("area" in result)
					expect(
						(
							await verifyInitialContinuationEvidenceV0(
								fixture.source,
								fixture.replay,
								fixture.key,
								join(result.area, "receipt.json"),
							)
						).status,
					).toBe("unverified");
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120000,
	);
	it("rejects a model change after the approved second turn in final evidence", async () => {
		fixture.pi.setScenario("model-endpoint,pi-1-startup,second-turn-model-change");
		try {
			const options = setup(),
				plan = await planFor(options),
				before = upstream.requests.length;
			let approved = false;
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async (boundary) => {
					approved = true;
					return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
				},
			);
			expect(approved).toBe(true);
			expect(upstream.requests.length - before).toBe(2);
			expect(result.status).not.toBe("completed");
			if (!("area" in result)) throw new Error("no receipt");
			expect(
				(
					await verifyInitialContinuationEvidenceV0(
						fixture.source,
						fixture.replay,
						fixture.key,
						join(result.area, "receipt.json"),
					)
				).status,
			).toBe("unverified");
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120000);
	it("keeps the same live session, requires a second approval, and verifies both turns", async () => {
		const options = setup();
		const plan = await planFor(options);
		const firstApproval = approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn");
		const before = upstream.requests.length;
		let boundaryPid = 0;
		const result = await executeInitialContinuationV0(
			plan,
			firstApproval,
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => {
				expect(upstream.requests.length - before).toBe(1);
				boundaryPid = boundary.pid;
				expect(() => process.kill(boundary.pid, 0)).not.toThrow();
				return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
			},
		);
		expect(result.status, JSON.stringify(result)).toBe("completed");
		expect(upstream.requests.length - before).toBe(2);
		expect(() => process.kill(boundaryPid, 0)).toThrow();
		if (result.status !== "completed") throw new Error(JSON.stringify(result));
		const verification = await verifyInitialContinuationEvidenceV0(
			fixture.source,
			fixture.replay,
			fixture.key,
			join(result.area, "receipt.json"),
		);
		expect(verification.status, JSON.stringify(verification)).toBe("verified");
		const requests = upstream.requests.slice(before);
		const second = requests[1]!.body as { messages: { role: string; content: string }[] };
		expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(second.messages[2]!.content).toBe("Fake reply.");
		expect(second.messages[3]!.content).toBe(options.continuationPrompt);
		const receipt = readFileSync(join(result.area, "receipt.json"), "utf8");
		expect(receipt).not.toContain(options.prompt);
		expect(receipt).not.toContain(options.continuationPrompt);
		expect(receipt).not.toContain("Fake reply.");
	}, 120000);
	it("closes after the first turn when second approval is absent", async () => {
		const options = setup(),
			plan = await planFor(options);
		const before = upstream.requests.length;
		const result = await executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async () => null,
		);
		expect(result.status, JSON.stringify(result)).toBe("first-completed-not-approved");
		expect(upstream.requests.length - before).toBe(1);
		if (!("area" in result)) throw new Error("no receipt");
		const checked = await verifyInitialContinuationEvidenceV0(
			fixture.source,
			fixture.replay,
			fixture.key,
			join(result.area, "receipt.json"),
		);
		expect(checked.status, JSON.stringify(checked)).toBe("first-turn-verified");
	}, 120000);
	it("refuses missing first approval and changed continuation text before any upstream request", async () => {
		const options = setup(),
			plan = await planFor(options);
		const before = upstream.requests.length;
		const noApproval = await executeInitialContinuationV0(
			plan,
			null,
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async () => null,
		);
		expect(noApproval.status).toBe("refused");
		const approval = approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn");
		const changed = await executeInitialContinuationV0(
			plan,
			approval,
			options.prompt,
			`${options.continuationPrompt}!`,
			fixture.key,
			async () => null,
		);
		expect(changed.status).toBe("refused");
		expect(upstream.requests.length - before).toBe(0);
	}, 120000);
	it("rejects stale and reused continuation approvals", async () => {
		const options = setup(),
			plan = await planFor(options);
		const before = upstream.requests.length;
		let oldApproval: ReturnType<typeof approveContinuationTurnV0> | undefined;
		const first = await executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => {
				oldApproval = approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
				return { ...oldApproval, confirmedAt: new Date(Date.parse(boundary.observedAt) - 1).toISOString() };
			},
		);
		expect(first.status).toBe("first-completed-not-approved");
		const other = setup(),
			otherPlan = await planFor(other);
		const reused = await executeInitialContinuationV0(
			otherPlan,
			approveInitialContinuationV0(otherPlan, otherPlan.commitment, "approve first tool-free turn"),
			other.prompt,
			other.continuationPrompt,
			fixture.key,
			async () => oldApproval!,
		);
		expect(reused.status).toBe("first-completed-not-approved");
		expect(upstream.requests.length - before).toBe(2);
	}, 120000);
	it("refuses a changed prepared child at the continuation boundary", async () => {
		const options = setup(),
			plan = await planFor(options);
		const before = upstream.requests.length;
		const result = await executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => {
				const m = JSON.parse(
					readFileSync(join(options.outputParent, options.preparation, "branch-set.json"), "utf8"),
				);
				writeFileSync(
					join(options.outputParent, options.preparation, m.children.baseline.directory, "work", "unexpected"),
					"changed",
				);
				return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
			},
		);
		expect(result.status).toBe("failed");
		expect(upstream.requests.length - before).toBe(1);
		if (!("area" in result)) throw new Error("no receipt");
		const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
		expect(receipt.secondApproval.method).toBe("local-explicit");
		expect(receipt.dispatch2).toBeNull();
	}, 120000);
	it("refuses a changed parent or Pi binary before the second request", async () => {
		for (const change of ["parent", "binary"] as const) {
			const options = setup(),
				plan = await planFor(options);
			const before = upstream.requests.length;
			const parentFile = join(fixture.replay, "replay-artifacts", "checkpoint-candidate.json");
			const parentBytes = readFileSync(parentFile),
				binaryBytes = readFileSync(fixture.pi.entrypoint);
			try {
				const result = await executeInitialContinuationV0(
					plan,
					approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
					options.prompt,
					options.continuationPrompt,
					fixture.key,
					async (boundary) => {
						if (change === "parent") writeFileSync(parentFile, "{}");
						else fixture.pi.rebuild("continuation adversary");
						return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
					},
				);
				expect(result.status, JSON.stringify(result)).toBe("failed");
				expect(upstream.requests.length - before).toBe(1);
			} finally {
				writeFileSync(parentFile, parentBytes);
				writeFileSync(fixture.pi.entrypoint, binaryBytes);
			}
		}
	}, 120000);
	it("does not restart a process that exits between turns", async () => {
		const options = setup(),
			plan = await planFor(options);
		const before = upstream.requests.length;
		const result = await executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => {
				process.kill(boundary.pid, "SIGKILL");
				await expect
					.poll(() => {
						try {
							process.kill(boundary.pid, 0);
							return true;
						} catch {
							return false;
						}
					})
					.toBe(false);
				return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
			},
		);
		expect(result.status).toBe("failed");
		expect(upstream.requests.length - before).toBe(1);
	}, 120000);
	it.each([
		["model-endpoint,ignore-no-tools", 0],
		["model-endpoint,wrong-request-model", 0],
		["model-endpoint,spurious-tool-event", 1],
		["model-endpoint,wrong-session-after-settlement", 1],
	] as const)(
		"fails closed for %s",
		async (scenario, expected) => {
			fixture.pi.setScenario(scenario);
			try {
				const options = setup(),
					plan = await planFor(options),
					before = upstream.requests.length;
				let asked = false;
				const result = await executeInitialContinuationV0(
					plan,
					approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
					options.prompt,
					options.continuationPrompt,
					fixture.key,
					async () => {
						asked = true;
						return null;
					},
				);
				expect(result.status).not.toBe("completed");
				expect(asked).toBe(false);
				expect(upstream.requests.length - before).toBe(expected);
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120000,
	);
	it.each(["wrong-session-after-boundary", "wrong-model-after-boundary"])(
		"refuses %s after approval",
		async (scenario) => {
			fixture.pi.setScenario(`model-endpoint,${scenario}`);
			try {
				const options = setup(),
					plan = await planFor(options),
					before = upstream.requests.length;
				let approved = false;
				const result = await executeInitialContinuationV0(
					plan,
					approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
					options.prompt,
					options.continuationPrompt,
					fixture.key,
					async (boundary) => {
						approved = true;
						return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
					},
				);
				expect(approved).toBe(true);
				expect(result.status).toBe("failed");
				expect(upstream.requests.length - before).toBe(1);
			} finally {
				fixture.pi.setScenario("model-endpoint");
			}
		},
		120000,
	);
	it("refuses a second request that arrives after its approval window", async () => {
		fixture.pi.setScenario("model-endpoint,delay-second-model-request");
		try {
			const options = { ...setup(), maxApprovalIdleMs: 1000 },
				plan = await planFor(options),
				before = upstream.requests.length;
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async (boundary) => approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn"),
			);
			expect(result.status).toBe("outcome-unknown");
			expect(upstream.requests.length - before).toBe(1);
			if (!("area" in result)) throw new Error("no receipt");
			const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
			expect(receipt.dispatch2.turn).toBe(2);
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120000);
	it("refuses an unoffered tool call without a follow-on upstream request", async () => {
		const toolServer = await startFakeOpenAiServer({ forceToolCall: true, chunkMs: 2 });
		try {
			const options = { ...setup(), upstream: new URL(toolServer.baseUrl).origin },
				plan = await planFor(options);
			let asked = false;
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async () => {
					asked = true;
					return null;
				},
			);
			expect(result.status).not.toBe("completed");
			expect(asked).toBe(false);
			expect(toolServer.requests).toHaveLength(1);
			if (!("area" in result)) throw new Error("no receipt");
			expect(
				readEndoStoreEventsV0(join(result.area, "evidence")).some((event) => event.kind === "tool.started"),
			).toBe(false);
		} finally {
			await toolServer.close();
		}
	}, 120000);
	it("does not copy a malformed private response into a failure receipt", async () => {
		const sentinel = "PRIVATE_RESPONSE_TEXT_DO_NOT_PUBLISH";
		const server = await startFakeOpenAiServer({ malformedStream: true, malformedStreamPayload: sentinel });
		try {
			const options = { ...setup(), upstream: new URL(server.baseUrl).origin },
				plan = await planFor(options);
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async () => null,
			);
			expect(result.status).not.toBe("completed");
			expect(server.requests).toHaveLength(1);
			if (!("area" in result)) throw new Error("no receipt");
			expect(readFileSync(join(result.area, "receipt.json"), "utf8")).not.toContain(sentinel);
		} finally {
			await server.close();
		}
	}, 120000);
	it("blocks an unexpected request before approval and never sends the second prompt", async () => {
		const options = setup(),
			plan = await planFor(options),
			before = upstream.requests.length;
		const result = await executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => {
				const receipt = JSON.parse(
					readFileSync(join(options.outputParent, plan.initial.attemptId, "receipt.json"), "utf8"),
				);
				await expect(
					fetch(`${receipt.runtime.proxyOrigin}/v1/chat/completions`, {
						method: "POST",
						body: JSON.stringify({ model: "fake-1", stream: true, messages: [] }),
					}),
				).rejects.toThrow();
				return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
			},
		);
		expect(result.status).not.toBe("completed");
		expect(upstream.requests.length - before).toBe(1);
	}, 120000);
	it("stops on an idle approval timeout and cancellation before the second dispatch", async () => {
		for (const mode of ["timeout", "cancel"] as const) {
			const options = { ...setup(), maxApprovalIdleMs: 1000 },
				plan = await planFor(options),
				before = upstream.requests.length;
			const controller = new AbortController();
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async () => {
					if (mode === "cancel") controller.abort();
					return new Promise(() => {});
				},
				controller.signal,
			);
			expect(result.status).toBe(mode === "cancel" ? "cancelled" : "first-completed-not-approved");
			expect(upstream.requests.length - before).toBe(1);
		}
	}, 120000);
	it("uses one overall deadline across the first turn and approval wait", async () => {
		const server = await startFakeOpenAiServer({ slowChunkMs: 30 });
		try {
			const options = {
				...setup(),
				upstream: new URL(server.baseUrl).origin,
				prompt: "forty words please",
				wallTimeoutMs: 4500,
				maxApprovalIdleMs: 4000,
			};
			const plan = await planFor(options);
			let asked = false;
			const start = performance.now();
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async (boundary) => {
					asked = true;
					await new Promise((resolve) => setTimeout(resolve, 3800));
					return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
				},
			);
			expect(asked).toBe(true);
			expect(result.status).toBe("first-completed-not-approved");
			expect(server.requests).toHaveLength(1);
			expect(performance.now() - start).toBeLessThan(6000);
		} finally {
			await server.close();
		}
	}, 120000);
	it("retains an uncertain result on cancellation after the second dispatch", async () => {
		const options = { ...setup(), continuationPrompt: "forty words please" },
			plan = await planFor(options),
			before = upstream.requests.length;
		const controller = new AbortController();
		const running = executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async (boundary) => approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn"),
			controller.signal,
		);
		await expect.poll(() => upstream.requests.length - before, { timeout: 10000 }).toBe(2);
		controller.abort();
		const result = await running;
		expect(result.status).toBe("cancelled");
		if (!("area" in result)) throw new Error("no receipt");
		const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
		expect(receipt.dispatch2.turn).toBe(2);
		expect(
			(
				await verifyInitialContinuationEvidenceV0(
					fixture.source,
					fixture.replay,
					fixture.key,
					join(result.area, "receipt.json"),
				)
			).status,
		).toBe("unverified");
	}, 120000);
	it("terminates the owned session on cancellation during the first turn", async () => {
		const options = { ...setup(), prompt: "forty words please" },
			plan = await planFor(options),
			before = upstream.requests.length;
		const controller = new AbortController();
		let asked = false;
		const running = executeInitialContinuationV0(
			plan,
			approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
			options.prompt,
			options.continuationPrompt,
			fixture.key,
			async () => {
				asked = true;
				return null;
			},
			controller.signal,
		);
		await expect.poll(() => upstream.requests.length - before, { timeout: 10000 }).toBe(1);
		controller.abort();
		const result = await running;
		expect(result.status).toBe("cancelled");
		expect(asked).toBe(false);
		expect(upstream.requests.length - before).toBe(1);
		if (!("area" in result)) throw new Error("no receipt");
		const receipt = JSON.parse(readFileSync(join(result.area, "receipt.json"), "utf8"));
		expect(receipt.dispatch1.turn).toBe(1);
		expect(receipt.dispatch2).toBeNull();
	}, 120000);
	it("refuses incomplete first-turn evidence before asking for approval", async () => {
		fixture.pi.setScenario("model-endpoint,hang-entries-after-prompt");
		try {
			const options = { ...setup(), wallTimeoutMs: 3000, maxApprovalIdleMs: 1000 },
				plan = await planFor(options),
				before = upstream.requests.length;
			let asked = false;
			const result = await executeInitialContinuationV0(
				plan,
				approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn"),
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async () => {
					asked = true;
					return null;
				},
			);
			expect(result.status).toBe("outcome-unknown");
			expect(asked).toBe(false);
			expect(upstream.requests.length - before).toBe(1);
		} finally {
			fixture.pi.setScenario("model-endpoint");
		}
	}, 120000);
	it("rejects reused attempts and tampered or partial final evidence", async () => {
		const options = setup(),
			plan = await planFor(options),
			before = upstream.requests.length;
		const approval = approveInitialContinuationV0(plan, plan.commitment, "approve first tool-free turn");
		const run = () =>
			executeInitialContinuationV0(
				plan,
				approval,
				options.prompt,
				options.continuationPrompt,
				fixture.key,
				async (boundary) => approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn"),
			);
		const result = await run();
		expect(result.status, JSON.stringify(result)).toBe("completed");
		if (!("area" in result)) throw new Error("no receipt");
		expect((await run()).status).toBe("refused");
		expect(upstream.requests.length - before).toBe(2);
		const receiptPath = join(result.area, "receipt.json"),
			markerPath = join(result.area, "dispatch-2.json");
		const receipt = readFileSync(receiptPath),
			marker = readFileSync(markerPath);
		const stale = JSON.parse(receipt.toString());
		stale.status = "approved-not-dispatched";
		stale.dispatch1 = null;
		stale.boundary = null;
		stale.secondApproval = null;
		stale.dispatch2 = null;
		stale.observed = null;
		const { commitment: _commitment, ...staleBody } = stale;
		stale.commitment = fixture.key.digest({ purpose: "endo.initial-continuation.receipt.v0", value: staleBody });
		writeFileSync(receiptPath, canonicalEndoJsonV0(stale));
		const interrupted = await verifyInitialContinuationEvidenceV0(
			fixture.source,
			fixture.replay,
			fixture.key,
			receiptPath,
		);
		expect(interrupted).toMatchObject({ status: "unverified", outcome: "outcome-unknown" });
		writeFileSync(receiptPath, receipt);
		const binary = readFileSync(fixture.pi.entrypoint);
		try {
			fixture.pi.rebuild("changed after completion");
			expect(
				(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath))
					.status,
			).toBe("unverified");
		} finally {
			writeFileSync(fixture.pi.entrypoint, binary);
		}
		writeFileSync(markerPath, marker.subarray(0, 20));
		expect(
			(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath)).status,
		).toBe("unverified");
		writeFileSync(markerPath, marker);
		writeFileSync(receiptPath, receipt.subarray(0, 30));
		expect(
			(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath)).status,
		).toBe("unverified");
		writeFileSync(receiptPath, receipt);
		const r = JSON.parse(receipt.toString());
		const runtimeFile = join(result.area, "runtime", "work", "endophasia-study.txt");
		const runtimeBytes = readFileSync(runtimeFile),
			runtimeStat = statSync(runtimeFile);
		writeFileSync(runtimeFile, "substituted runtime");
		expect(
			(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath)).status,
		).toBe("unverified");
		writeFileSync(runtimeFile, runtimeBytes);
		utimesSync(runtimeFile, runtimeStat.atimeMs / 1000, (Math.floor(runtimeStat.mtimeMs) + 0.5) / 1000);
		const restored = await verifyInitialContinuationEvidenceV0(
			fixture.source,
			fixture.replay,
			fixture.key,
			receiptPath,
		);
		expect(restored.status, JSON.stringify(restored)).toBe("verified");
		const blob = join(
			result.area,
			"evidence",
			"capture",
			"blobs",
			r.observed.responseDigests[1].keyId,
			r.observed.responseDigests[1].value,
		);
		const bytes = readFileSync(blob);
		appendFileSync(blob, "tampered");
		expect(
			(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath)).status,
		).toBe("unverified");
		writeFileSync(blob, bytes);
		appendFileSync(join(result.area, "evidence", "events", "events.log"), "partial");
		expect(
			(await verifyInitialContinuationEvidenceV0(fixture.source, fixture.replay, fixture.key, receiptPath)).status,
		).toBe("unverified");
	}, 120000);
});
