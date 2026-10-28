import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
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
import {
	admissionPath,
	type SyntheticAdmissionRecord,
	sealAdmission,
} from "../research/governed-initial-continuation/aa/synthetic-admission.ts";
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
	it.each([
		"first",
		"second",
		"environment-cancel",
		"environment-hang",
		"environment-expired",
		"admission-first",
		"admission-second",
		"admission-cancel",
		"identity-drift-first",
		"identity-drift-second",
		"duplicate-observation",
		"publication-failure",
		"late-preparation",
		"timeout-preparation",
		"preparation-throws",
	] as const)(
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
				maxApprovalIdleMs: denied === "timeout-preparation" ? 1000 : 5000,
				maxTransferredBytes: 1048576,
			};
			const file = join(outputParent, "study.json");
			await createStudyPlan(file, options, 0, "9", "synthetic endpoint", fixture.key, "synthetic-server");
			const before = upstream.requests.length;
			const controller = new AbortController();
			const sentinel = ["admission-first", "preparation-throws"].includes(denied)
				? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
				: undefined;
			let ownedPid = 0;
			let proxyOrigin = "";
			const repeatedId = randomBytes(16).toString("hex");
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
				second: async (boundary: { pid: number; attemptId: string }, phrase: string) => {
					ownedPid = boundary.pid;
					proxyOrigin = JSON.parse(readFileSync(join(outputParent, boundary.attemptId, "receipt.json"), "utf8"))
						.runtime.proxyOrigin;
					return denied === "second" ? null : phrase;
				},
			};
			try {
				let result: string;
				try {
					result = await runNextSlot(file, fixture.key, hooks, controller.signal, {
						prepare: async (turn) => {
							if (denied === "late-preparation") {
								setTimeout(() => controller.abort(), 10);
								await new Promise((resolve) => setTimeout(resolve, 100));
							}
							if (denied === "timeout-preparation" && turn === 2)
								await new Promise((resolve) => setTimeout(resolve, 1500));
							if (denied === "preparation-throws" && turn === 2) throw null;
							return {
								identity:
									(denied === "identity-drift-first" && turn === 1) ||
									(denied === "identity-drift-second" && turn === 2)
										? "changed"
										: "synthetic-server",
								observationId:
									denied === "duplicate-observation" ? repeatedId : randomBytes(16).toString("hex"),
							};
						},
						recheck: (_identity, turn) => {
							if (denied === "admission-cancel") controller.abort();
							if (denied === "publication-failure" && turn === 1) {
								const start = JSON.parse(readFileSync(slotPath(file, 1, "start"), "utf8"));
								writeFileSync(admissionPath(join(outputParent, start.plan.initial.attemptId), 1), "occupied", {
									mode: 0o600,
								});
							}
							return !(
								(denied === "admission-first" && turn === 1) ||
								(denied === "admission-second" && turn === 2)
							);
						},
					});
				} finally {
					clock?.mockRestore();
				}
				if (["first", "second", "environment-cancel", "environment-hang", "environment-expired"].includes(denied)) {
					expect(result).toBe(denied === "second" ? "first-turn-verified" : "no-request-cancelled");
					expect(await inspectStoppedSlot(file, fixture.key, 1)).toBe(result);
				}
				expect(upstream.requests.length - before).toBe(
					[
						"second",
						"admission-second",
						"identity-drift-second",
						"duplicate-observation",
						"timeout-preparation",
						"preparation-throws",
					].includes(denied)
						? 1
						: 0,
				);
				if (sentinel?.pid) expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
				if (denied === "preparation-throws") {
					expect(ownedPid).toBeGreaterThan(0);
					expect(() => process.kill(ownedPid, 0)).toThrow();
					await expect(fetch(`${proxyOrigin}/v1/chat/completions`, { method: "POST" })).rejects.toThrow();
				}
			} finally {
				if (sentinel && sentinel.exitCode === null && sentinel.signalCode === null) {
					const exited = once(sentinel, "exit");
					sentinel.kill("SIGTERM");
					await exited;
				}
			}
			if (denied === "late-preparation") {
				await new Promise((resolve) => setTimeout(resolve, 150));
				const start = JSON.parse(readFileSync(slotPath(file, 1, "start"), "utf8"));
				expect(() => readFileSync(admissionPath(join(outputParent, start.plan.initial.attemptId), 1))).toThrow();
			}
			await expect(
				runNextSlot(file, fixture.key, hooks, undefined, {
					prepare: async () => ({ identity: "synthetic-server", observationId: randomBytes(16).toString("hex") }),
					recheck: () => true,
				}),
			).rejects.toThrow();
			expect(upstream.requests.length - before).toBe(
				[
					"second",
					"admission-second",
					"identity-drift-second",
					"duplicate-observation",
					"timeout-preparation",
					"preparation-throws",
				].includes(denied)
					? 1
					: 0,
			);
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
			const study = await createStudyPlan(
				file,
				options,
				seed,
				"9",
				"synthetic endpoint",
				fixture.key,
				"synthetic-server",
			);
			for (let index = 0; index < 4; index++) {
				const status = await runNextSlot(
					file,
					fixture.key,
					{
						checkEnvironment: async () => true, // Fake fixture only; no real observer is supplied here.
						first: async (_plan, phrase) => phrase,
						second: async (_boundary, phrase) => phrase,
					},
					undefined,
					{
						prepare: async () => ({
							identity: "synthetic-server",
							observationId: randomBytes(16).toString("hex"),
						}),
						recheck: (identity) => identity === "synthetic-server",
					},
				);
				expect(status).toBe("completed");
			}

			const comparison = await readStudy(file, fixture.key);
			expect(comparison.status).toBe("four-receipts");
			expect(comparison.syntheticAdmission).toBe("verified");
			expect(comparison.serverIdentity).toBe("unverified");
			const fresh = () =>
				spawnSync(process.execPath, ["tests/fixtures/read-aa-synthetic.ts", file], { encoding: "utf8" });
			expect(fresh().status).toBe(0);
			expect(comparison.effectiveParametersEqual).toBe(true);
			expect(comparison.trials).toHaveLength(4);
			expect(
				comparison.trials.every((t) => t.receiptStatus === "verified" && !t.firstCorrect && !t.referenceCorrect),
			).toBe(true);
			expect(comparison.comparisons).toHaveLength(6);
			expect(comparison.trials.every((t) => t.turns.every((turn) => turn.cwdAdjusted))).toBe(true);
			const admission = admissionPath(join(outputParent, comparison.trials[0]!.attemptId), 1);
			const originalAdmission = readFileSync(admission);
			const secondRecord = JSON.parse(
				readFileSync(admissionPath(join(outputParent, comparison.trials[0]!.attemptId), 2), "utf8"),
			) as SyntheticAdmissionRecord;
			const altered = JSON.parse(originalAdmission.toString()) as SyntheticAdmissionRecord;
			const { commitment: _commitment, ...body } = altered;
			for (const change of [
				{ turn: 2 as const },
				{ position: 2 },
				{ attemptId: "wrong" },
				{ requestDigest: secondRecord.requestDigest },
				{ studyCommitment: body.startCommitment },
				{ observationId: secondRecord.observationId },
			]) {
				writeFileSync(admission, canonicalEndoJsonV0(sealAdmission(fixture.key, { ...body, ...change })), {
					mode: 0o600,
				});
				await expect(readStudy(file, fixture.key)).rejects.toThrow();
			}
			expect(fresh().status).not.toBe(0);
			rmSync(admission);
			expect(fresh().status).not.toBe(0);
			writeFileSync(admission, "{}", { mode: 0o600 });
			await expect(readStudy(file, fixture.key)).rejects.toThrow();
			writeFileSync(admission, originalAdmission, { mode: 0o600 });
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
	it("refuses an observation replayed from an earlier slot before forwarding", async () => {
		const outputParent = mkdtempSync(join(fixture.base, "aa-replay-"));
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
		await createStudyPlan(file, options, 0, "9", "synthetic", fixture.key, "synthetic-server");
		const ids = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
		let count = 0;
		const hooks = {
			checkEnvironment: async () => true,
			first: async (_p: unknown, phrase: string) => phrase,
			second: async (_b: unknown, phrase: string) => phrase,
		};
		const provider = {
			prepare: async () => ({ identity: "synthetic-server", observationId: ids[count++ < 2 ? count - 1 : 0]! }),
			recheck: () => true,
		};
		const before = upstream.requests.length;
		expect(await runNextSlot(file, fixture.key, hooks, undefined, provider)).toBe("completed");
		expect(upstream.requests.length - before).toBe(2);
		expect(await runNextSlot(file, fixture.key, hooks, undefined, provider)).not.toBe("completed");
		expect(upstream.requests.length - before).toBe(2);
	}, 120000);
	it("does not retry a request whose upstream disconnects after forwarding", async () => {
		const server = await startFakeOpenAiServer({ disconnectAfterFirstChunk: true });
		try {
			const outputParent = mkdtempSync(join(fixture.base, "aa-unknown-"));
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
				upstream: new URL(server.baseUrl).origin,
				provider: "fake",
				model: "fake-1",
				prompt: "Compute 4 plus 5. Return only the decimal result.",
				continuationPrompt: "Repeat only the token in your immediately preceding answer.",
				wallTimeoutMs: 15000,
				maxApprovalIdleMs: 5000,
				maxTransferredBytes: 1048576,
			};
			const file = join(outputParent, "study.json");
			await createStudyPlan(file, options, 0, "9", "synthetic", fixture.key, "synthetic-server");
			const hooks = {
				checkEnvironment: async () => true,
				first: async (_p: unknown, phrase: string) => phrase,
				second: async (_b: unknown, phrase: string) => phrase,
			};
			const provider = {
				prepare: async () => ({ identity: "synthetic-server", observationId: randomBytes(16).toString("hex") }),
				recheck: () => true,
			};
			expect(await runNextSlot(file, fixture.key, hooks, undefined, provider)).toBe("outcome-unknown");
			expect(server.requests.length).toBe(1);
			await expect(runNextSlot(file, fixture.key, hooks, undefined, provider)).rejects.toThrow();
			expect(server.requests.length).toBe(1);
		} finally {
			await server.close();
		}
	}, 120000);
});
