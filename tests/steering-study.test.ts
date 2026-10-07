// The steering study's own code (research/steering/1.0.1/), checked before its pilot (DESIGN.md §3-§7): the spec keeps
// E2's tasks, the B+C extension and E3's pinned environment byte for byte and differs between arms only in the
// intervention; the analysis (I1, I2, P1 to P5) on a fake-Pi experiment, where a steered trial's first divergence is
// the request that carries the message and a deliberately broken trial is reported as a violation.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEndoExperimentV0 } from "../cli/experiment.ts";
import { readEndoExperimentPlanFileV0, readEndoExperimentSpecFileV0 } from "../cli/experiment-artifacts.ts";
import { type EndoExperimentSpecV0, endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import { PINNED } from "../research/pinned-environment/1.0.1/make-spec.ts";
import {
	checks,
	complied,
	firstDivergence,
	interventionManipulation,
	judgeSteeredTrial,
} from "../research/steering/1.0.1/analyze.ts";
import { MESSAGES, STEER_POINT, steeringSpec } from "../research/steering/1.0.1/make-spec.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { endoDigestKeyFromEnvironmentV0 } from "../storage/digest-key.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

const E2 = fileURLToPath(new URL("../research/variance/1.0.1/", import.meta.url));
let base: string;
let install: FakePiInstall;
let upstream: FakeOpenAiServer;
beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "endo-steering-study-"));
	install = installFakePi("1.0.0");
	install.setScenario("model-endpoint");
	upstream = await startFakeOpenAiServer({ chunkMs: 1, slowChunkMs: 40 });
});
afterAll(async () => {
	await upstream?.close();
	install?.remove();
	rmSync(base, { recursive: true, force: true });
});

describe("the steering study's spec (DESIGN §3, §4)", () => {
	const spec = steeringSpec("pilot", 3);
	const e2 = readEndoExperimentSpecFileV0(join(E2, "spec.json"));

	it("is valid; keeps E2's tasks, serving inputs and the B+C extension byte for byte; pins every arm", () => {
		expect(endoExperimentSpecProblemV0(spec)).toBeNull();
		expect(spec.tasks.map((task) => task.id)).toEqual(["tool-use", "implement-function"]);
		for (const task of spec.tasks)
			expect(canonicalEndoJsonV0(task)).toBe(canonicalEndoJsonV0(e2.tasks.find((entry) => entry.id === task.id)));
		for (const key of ["pi", "upstream", "provider", "model", "digestDomain", "timeoutMs"] as const)
			expect(spec[key], key).toEqual(e2[key]);
		const bc = e2.conditions.find((condition) => condition.id === "b-c")!.extensions!["endo-arm.ts"];
		expect(spec.conditions.map((condition) => condition.id)).toEqual(["base", "steer", "queue"]);
		for (const condition of spec.conditions) {
			expect(condition.extensions!["endo-arm.ts"], condition.id).toBe(bc);
			expect(condition.environment, condition.id).toEqual(PINNED);
		}
	});

	it("differs between arms only in the intervention: the same message, at the same point", () => {
		const [baseArm, steer, queue] = spec.conditions;
		expect(baseArm!.interventions).toBeUndefined();
		for (const [arm, operation] of [
			[steer!, "steer"],
			[queue!, "queue"],
		] as const)
			for (const task of ["tool-use", "implement-function"])
				expect(arm.interventions![task]).toEqual({
					operation,
					message: MESSAGES[task]!.text,
					after: { exchange: 2, chunks: 1 },
				});
		expect(STEER_POINT).toEqual({ exchange: 2, chunks: 1 });
		const strip = (condition: (typeof spec.conditions)[number]) => {
			const { interventions: _i, id: _id, description: _d, ...rest } = condition;
			return rest;
		};
		expect(canonicalEndoJsonV0(strip(steer!))).toBe(canonicalEndoJsonV0(strip(baseArm!)));
		expect(canonicalEndoJsonV0(strip(queue!))).toBe(canonicalEndoJsonV0(strip(baseArm!)));
		for (const message of Object.values(MESSAGES))
			expect(message.text).toContain(`run exactly this command: ${message.command}`);
	});
});

describe("the analysis's pure parts", () => {
	it("firstDivergence is the 1-based index of the first differing request, or the shorter length plus one", () => {
		expect(firstDivergence([1, 2, 3], [1, 2, 3])).toBeNull();
		expect(firstDivergence([1, 2, 3], [1, 2, 9])).toBe(3);
		expect(firstDivergence([1, 2, 3, 4], [1, 2, 3])).toBe(4);
		expect(firstDivergence([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBeNull();
	});

	it("complied needs the exact command in a bash call after the message, never before it, never another command", () => {
		const message = MESSAGES["tool-use"]!;
		const call = (command: string, name = "bash") => ({
			role: "assistant",
			tool_calls: [{ function: { name, arguments: JSON.stringify({ command }) } }],
		});
		const user = { role: "user", content: message.text };
		const request = (...messages: unknown[]) => [{ messages: [{ role: "system", content: "s" }, ...messages] }];
		expect(complied(request(call("wc -l notes.txt"), user, call(" cat notes.txt ")), "tool-use")).toBe(true);
		expect(complied(request(call("cat notes.txt"), user, call("wc -l notes.txt")), "tool-use")).toBe(false);
		expect(complied(request(user, call("cat notes.txt", "read")), "tool-use")).toBe(false);
		expect(complied(request(user, call("cat notes.txt && rm notes.txt")), "tool-use")).toBe(false);
		expect(complied(request(call("cat notes.txt")), "tool-use")).toBe(false);
		expect(complied([], "tool-use")).toBe(false);
		expect(
			complied(
				request({ role: "user", content: [{ type: "text", text: message.text }] }, call("cat notes.txt")),
				"tool-use",
			),
		).toBe(true);
	});
});

describe("the analysis on a fake-Pi experiment", () => {
	const message = MESSAGES["tool-use"]!.text;
	const after = { exchange: 1, chunks: 5 };
	const fakeSpec = (): EndoExperimentSpecV0 => ({
		schemaVersion: "endo.experiment-spec.v0",
		id: "endo.experiment.test-steering-analysis",
		description: "analysis test",
		trials: 2,
		seed: 3,
		pi: install.bin,
		upstream: new URL(upstream.baseUrl).origin,
		provider: "fake",
		model: "fake-1",
		digestDomain: "installation",
		timeoutMs: 30_000,
		tasks: [{ id: "tool-use", prompts: ["Count to forty"], workspace: { "notes.txt": "a synthetic file\n" } }],
		conditions: [
			{ id: "base", description: "no intervention" },
			{ id: "steer", description: "steer", interventions: { "tool-use": { operation: "steer", message, after } } },
			{ id: "queue", description: "queue", interventions: { "tool-use": { operation: "queue", message, after } } },
		],
	});
	let dir: string;
	beforeAll(async () => {
		dir = join(base, "run");
		await runEndoExperimentV0({ spec: fakeSpec(), dir, log: () => {}, scratchParent: base });
	}, 240_000);

	it("I1 and I2 pass, and P1 to P4 hold: the steer diverges at the request that carries it, the queue after the baseline", () => {
		const m = interventionManipulation(dir, endoDigestKeyFromEnvironmentV0());
		expect(m.I1.byCondition, JSON.stringify(m.I1.byCondition)).toBeDefined();
		expect(m.I1.status, JSON.stringify(m.I1.byCondition)).toBe("PASS");
		expect(m.I1.byCondition).toMatchObject({ base: { trials: 2 }, steer: { trials: 2 }, queue: { trials: 2 } });
		expect(m.I2).toMatchObject({ status: "PASS" });
		const result = checks(dir, { kind: "installation" });
		expect(result.study).toMatch(/^HOLDS/);
		const task = result.tasks["tool-use"] as Record<string, any>;
		expect(task.P1).toMatchObject({ status: "PASS", trials: 2, n: 1 });
		expect(task.steer.perTrial.map((entry: any) => [entry.firstDivergence, entry.consumedExchange])).toEqual([
			[2, 2],
			[2, 2],
		]);
		expect(task.queue.perTrial.map((entry: any) => [entry.firstDivergence, entry.consumedExchange])).toEqual([
			[2, 2],
			[2, 2],
		]);
		for (const arm of ["steer", "queue"]) {
			expect(task[arm].P2).toEqual({ passed: 2, of: 2 });
			expect(task[arm].P3).toEqual({ passed: 2, of: 2 });
			expect(task[arm].P4).toEqual({ passed: 2, of: 2 });
			// The fake Pi runs no bash: the message is consumed, and not complied with. Compliance is read, not assumed.
			expect(task[arm].P5.compliance).toMatchObject({ successes: 0, n: 2 });
		}
	});
	/** Copy trial `from` over trial `to`, rewriting its result so it claims to be that cell and trial. */
	const transplant = (root: string, from: [string, number], to: [string, number]) => {
		const [fromDir, toDir] = [from, to].map(([condition, trial]) =>
			join(root, "trials", "tool-use", condition, String(trial)),
		);
		rmSync(toDir!, { recursive: true, force: true });
		cpSync(fromDir!, toDir!, { recursive: true });
		const result = JSON.parse(readFileSync(join(toDir!, "result.json"), "utf8"));
		// A fabricated result must still be the plan entry's: its own position as well as its coordinates.
		const position = readEndoExperimentPlanFileV0(root).plan.order.find(
			(entry) => entry.task === "tool-use" && entry.condition === to[0] && entry.trial === to[1],
		)!.position;
		writeFileSync(
			join(toDir!, "result.json"),
			JSON.stringify({
				...result,
				position,
				condition: to[0],
				trial: to[1],
				store: `trials/tool-use/${to[0]}/${to[1]}/store`,
			}),
		);
	};

	it("I1 compares the message's keyed digest, as DESIGN §6 says: another key fails it", () => {
		const other = endoDigestKeyV0(Buffer.alloc(32, 1), "not-the-recording-key");
		const result = interventionManipulation(dir, other);
		expect(result.I1.status).toBe("FAIL");
		expect(result.I1.byCondition.steer!.failures[0]).toMatch(
			/message digest is not the keyed digest of the spec's message/,
		);
		expect(result.I1.byCondition.base!.failures).toEqual([]);
	});

	it("a steered trial among the baseline breaks the noise floor (P1) and the study no longer holds", () => {
		const broken = join(base, "run-p1");
		cpSync(dir, broken, { recursive: true });
		transplant(broken, ["steer", 0], ["base", 1]);
		const result = checks(broken, { kind: "installation" });
		expect((result.tasks["tool-use"] as any).P1).toMatchObject({ status: "FAIL", requestsEqual: false });
		expect(result.study).toMatch(/^DOES NOT HOLD/);
		expect(interventionManipulation(broken, endoDigestKeyFromEnvironmentV0()).I1.status).toBe("FAIL");
	});

	it("a baseline trial in the steer arm (the message never consumed) is a reported manipulation failure, not an effect", () => {
		const broken = join(base, "run-p4");
		cpSync(dir, broken, { recursive: true });
		transplant(broken, ["base", 0], ["steer", 1]);
		const result = checks(broken, { kind: "installation" });
		const steer = (result.tasks["tool-use"] as any).steer;
		expect(steer.P2).toEqual({ passed: 2, of: 2 });
		expect(steer.P3).toEqual({ passed: 1, of: 2 });
		expect(steer.P4).toEqual({ passed: 1, of: 2 });
		expect(steer.perTrial[1]).toMatchObject({ firstDivergence: null, P4: "FAIL (manipulation failure)" });
		expect(result.study).toMatch(/^DOES NOT HOLD: 1 violation/);
		expect(interventionManipulation(broken, endoDigestKeyFromEnvironmentV0()).I1.status).toBe("FAIL");
	});
});

describe("P2 to P4 on synthetic request sequences", () => {
	const b = ["r1", "r2", "r3", "r4"];
	const judge = (arm: "steer" | "queue", requests: string[], consumedExchange: number | null, observed = true) =>
		judgeSteeredTrial({ arm, point: 2, baseRequests: b, requests, consumedExchange, consumptionObserved: observed });

	it("a steer that diverges at the next request, consumed there, passes P2 to P4", () => {
		expect(judge("steer", ["r1", "r2", "s3", "s4", "s5"], 3)).toEqual({
			first: 3,
			expectedFirst: 3,
			p2: true,
			p3: true,
			p4: true,
		});
	});

	it("a queue whose requests equal the baseline's and then one more passes; consumed at n + 1", () => {
		expect(judge("queue", [...b, "q5", "q6"], 5)).toEqual({
			first: 5,
			expectedFirst: 5,
			p2: true,
			p3: true,
			p4: true,
		});
	});

	it("a divergence before the point is a bug: P2 fails, however the rest looks", () => {
		const early = judge("steer", ["r1", "x2", "s3"], 3);
		expect(early.p2).toBe(false);
		expect(early.first).toBe(2);
		expect(early.p3).toBe(false);
	});

	it("a steer that diverges late, or a queue that diverges within the baseline's requests, fails P3", () => {
		expect(judge("steer", ["r1", "r2", "r3", "s4"], 4).p3).toBe(false);
		expect(judge("queue", ["r1", "r2", "r3", "q4", "q5"], 4).p3).toBe(false);
	});

	it("consumption elsewhere, or not shown by the proxy, fails P4 (a manipulation failure, not an effect)", () => {
		expect(judge("steer", ["r1", "r2", "s3", "s4"], 4).p4).toBe(false);
		expect(judge("steer", ["r1", "r2", "s3", "s4"], null).p4).toBe(false);
		expect(judge("steer", ["r1", "r2", "s3", "s4"], 3, false).p4).toBe(false);
		// Identical to the baseline: no divergence, so nothing was consumed anywhere.
		expect(judge("steer", b, 3).first).toBeNull();
	});
});
