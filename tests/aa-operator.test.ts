import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import {
	type AaOperatorConfigV0,
	type AaOperatorDepsV0,
	type AaOperatorOutcomeV0,
	renderAaOutcomeV0,
	runAaOperatorV0,
} from "../research/governed-initial-continuation/aa/operator.ts";
import { slotPath } from "../research/governed-initial-continuation/aa/reader.ts";
import {
	provenanceEndPathV0,
	provenancePathV0,
} from "../research/governed-initial-continuation/aa/task-owned-provenance.ts";
import { readinessPathV0 } from "../research/governed-initial-continuation/aa/task-owned-readiness.ts";
import {
	launchTaskOwnedServerV0,
	type TaskOwnedServerV0,
} from "../research/governed-initial-continuation/aa/task-owned-server.ts";
import {
	type AaRig,
	createAaRig,
	HANG,
	portIsFree,
	runningFrom,
	ScriptedTerminal,
	sha256File,
	sleep,
} from "./fixtures/aa-operator-rig.ts";

let rig: AaRig;
// Stands in for the operator's own model server, which no test may touch.
const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
beforeAll(async () => {
	rig = await createAaRig();
}, 240000);
afterAll(async () => {
	expect(sentinel.exitCode).toBeNull();
	expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
	sentinel.kill("SIGKILL");
	await rig?.close();
});
afterEach(() => {
	// Whatever a test did, no task-owned server may outlive it.
	expect(runningFrom(rig.relay)).toEqual([]);
	rig.backend.setHealth([]);
});

const ready = [{ status: 503 }, { status: 503 }, { status: 200, body: '{"status":"ok"}' }];
async function run(
	config: AaOperatorConfigV0,
	terminal: ScriptedTerminal,
	options: { signal?: AbortSignal; deps?: AaOperatorDepsV0 } = {},
): Promise<AaOperatorOutcomeV0> {
	return runAaOperatorV0(
		config,
		rig.fixture.key,
		terminal,
		options.signal ?? new AbortController().signal,
		options.deps,
	);
}
const slotArms = (config: AaOperatorConfigV0) =>
	[1, 2, 3, 4]
		.filter((n) => existsSync(slotPath(config.studyFile, n, "start")))
		.map((n) => JSON.parse(readFileSync(slotPath(config.studyFile, n, "start"), "utf8")).arm as string);

describe.runIf(process.platform === "linux")("terminal-governed A/A operator, fake components only", () => {
	it.each([
		[0, ["baseline", "alternative", "alternative", "baseline"]],
		[1, ["alternative", "baseline", "baseline", "alternative"]],
	])(
		"runs the full fake four-slot study in committed order for seed %i",
		async (seed, order) => {
			const config = await rig.newConfig({ seed });
			rig.backend.setHealth(ready);
			const before = rig.backend.completionRequests().length;
			const terminal = new ScriptedTerminal();
			const outcome = await run(config, terminal);
			expect(outcome.reasons).toEqual([]);
			expect(outcome.verdict).toBe("complete-under-declared-assumptions");
			expect(outcome.stage).toBe("done");
			expect(slotArms(config)).toEqual(order);
			// One approval for the server and one for each of the eight turns, every phrase distinct and used once.
			expect(terminal.asked.map((a) => a.kind)).toEqual(["launch", ...Array(4).fill(["first", "second"]).flat()]);
			expect(new Set(terminal.asked.map((a) => a.phrase)).size).toBe(9);
			expect(rig.backend.completionRequests().length - before).toBe(8);
			expect(
				rig.backend.requests
					.filter((r) => !r.url.endsWith("/chat/completions"))
					.every((r) => r.method === "GET" && r.url === "/health"),
			).toBe(true);
			expect(outcome.readiness).toMatchObject({ status: "ready", loadingResponses: 2 });
			expect(outcome.server.cleanup).toBe("confirmed");
			expect(outcome.independentRead).toMatchObject({
				status: "valid",
				report: {
					studyStatus: "four-receipts",
					records: "valid",
					admissionSidecars: 8,
					observedProcessIdentity: "consistent",
					studyAdmission: "complete",
					lifecycle: "cleaned",
					hostFacts: { ownership: "OWNERSHIP_UNVERIFIED" },
				},
			});
			// Completion is not correctness: the fake model never answers "9", and the study is still complete.
			expect(outcome.independentRead.answers).toMatchObject({ of: 4, firstCorrect: 0 });
			expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
			expect(await portIsFree(config.server.port)).toBe(true);
			const siblings = readVerifiedInitialBranchSetV0(
				config.source,
				config.replay,
				rig.fixture.key,
				config.outputParent,
				config.preparation,
			);
			expect(siblings.status).toBe("verified-pristine");
			const text = renderAaOutcomeV0(outcome);
			expect(text).toContain("COMPLETE-UNDER-DECLARED-ASSUMPTIONS");
			expect(text).toContain("not server attestation");
			// The relay is not the historically accepted llama.cpp digest, and a complete study must still say so,
			// in the headline as well as in the detail line.
			expect(text).toMatch(/outcome: COMPLETE-UNDER-DECLARED-ASSUMPTIONS \(server binary UNSUPPORTED/);
			expect(text).toMatch(
				/server binary\s+UNSUPPORTED \(NOT the historically accepted build; reasons: UNSUPPORTED_BINARY\)/,
			);
			// Only binary reasons are attributed to the binary.
			expect(text).not.toMatch(/reasons:[^)]*OWNERSHIP_UNVERIFIED/);
		},
		300000,
	);
});

/** Wraps the real launcher so a test can count and shape `stop()` while the real server is still the one running. */
function wrapLaunch(
	shape: {
		stop?: (real: () => ReturnType<TaskOwnedServerV0["stop"]>) => ReturnType<TaskOwnedServerV0["stop"]>;
		launched?: (server: TaskOwnedServerV0) => void;
	} = {},
) {
	const state = { stops: 0, server: undefined as TaskOwnedServerV0 | undefined };
	const launch: typeof launchTaskOwnedServerV0 = async (...args) => {
		const server = await launchTaskOwnedServerV0(...args);
		state.server = server;
		shape.launched?.(server);
		return {
			provenance: server.provenance,
			stop: () => {
				state.stops++;
				return shape.stop ? shape.stop(() => server.stop()) : server.stop();
			},
		};
	};
	return { launch, state };
}
const untilAsked = async (terminal: ScriptedTerminal, count: number) => {
	for (let i = 0; i < 600 && terminal.asked.length < count; i++) await sleep(25);
	expect(terminal.asked.length).toBeGreaterThanOrEqual(count);
};
const nothingStarted = async (config: AaOperatorConfigV0) => {
	expect(runningFrom(rig.relay)).toEqual([]);
	expect(await portIsFree(config.server.port)).toBe(true);
	expect(existsSync(provenancePathV0(config.studyFile))).toBe(false);
	expect(existsSync(config.studyFile)).toBe(false);
};

describe.runIf(process.platform === "linux")("operator approvals", () => {
	it.each([
		["a decline", null],
		["a different answer", "approve"],
		["a phrase for another plan", "APPROVE TASK-OWNED SERVER 0000000000000000"],
		["the first-turn phrase", "APPROVE FIRST 0000"],
	])("starts nothing on %s at the server approval", async (_name, answer) => {
		const config = await rig.newConfig();
		const before = rig.backend.requests.length;
		const terminal = new ScriptedTerminal(() => answer);
		const outcome = await run(config, terminal);
		expect(outcome).toMatchObject({
			verdict: "refused",
			stage: "server-launch",
			server: { launched: false, cleanup: "nothing-started" },
		});
		expect(terminal.asked).toHaveLength(1);
		expect(rig.backend.requests.length).toBe(before);
		await nothingStarted(config);
	});
	it("shows the redacted plan before asking, and starts nothing until the exact phrase arrives", async () => {
		const config = await rig.newConfig();
		const controller = new AbortController();
		const terminal = new ScriptedTerminal(() => HANG);
		const pending = run(config, terminal, { signal: controller.signal });
		await untilAsked(terminal, 1);
		await nothingStarted(config); // The question is open and nothing has been started.
		const shown = terminal.transcript;
		expect(shown).toContain("APPROVAL: start a task-owned model server");
		for (const piece of [
			"profile",
			"executable",
			"model ",
			"endpoint",
			"prompt commitments",
			"study order",
			"limits",
			"pending action",
		])
			expect(shown).toContain(piece);
		expect(shown).toContain(String(config.server.port));
		expect(shown).toContain("baseline → alternative → alternative → baseline");
		expect(shown).toContain("authorises no model request");
		// Digests are shown as prefixes only, and neither the key nor the prompt text is displayed.
		expect(shown).not.toContain(config.server.executableSha256);
		expect(shown).not.toContain(config.prompt);
		expect(shown).not.toContain(rig.keyFile);
		controller.abort();
		const outcome = await pending;
		expect(outcome).toMatchObject({ verdict: "refused", interrupted: true, server: { launched: false } });
		await nothingStarted(config);
	});
	it("an approval for the server never authorises a turn, and each turn is asked separately", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const before = rig.backend.completionRequests().length;
		// Approve the server, then decline the very first turn.
		const terminal = new ScriptedTerminal((kind, phrase) => (kind === "launch" ? phrase : null));
		const outcome = await run(config, terminal);
		expect(terminal.asked.map((a) => a.kind)).toEqual(["launch", "first"]);
		expect(rig.backend.completionRequests().length - before).toBe(0);
		expect(outcome.slots).toEqual([{ position: 1, arm: "baseline", status: "no-request-cancelled" }]);
		expect(outcome.verdict).toBe("partial");
		expect(outcome.server.cleanup).toBe("confirmed");
		expect(outcome.independentRead.report?.studyAdmission).not.toBe("complete");
		// The slot is spent: the same location cannot be run again, and no new server is started for it.
		const again = await run(config, new ScriptedTerminal());
		expect(again).toMatchObject({ verdict: "refused", stage: "preparation" });
		expect(runningFrom(rig.relay)).toEqual([]);
	}, 120000);
	it.each([
		["a wrong phrase", (_p: string) => "APPROVE FIRST wrong"],
		["a stale phrase from the server approval", (_p: string) => "APPROVE TASK-OWNED SERVER 0000000000000000"],
	])(
		"%s at the first turn grants no request",
		async (_name, answer) => {
			const config = await rig.newConfig({ seed: 1 });
			rig.backend.setHealth(ready);
			const before = rig.backend.completionRequests().length;
			const terminal = new ScriptedTerminal((kind, phrase) => (kind === "launch" ? phrase : answer(phrase)));
			const outcome = await run(config, terminal);
			expect(rig.backend.completionRequests().length - before).toBe(0);
			expect(terminal.count("first")).toBe(1); // A refusal is not asked again.
			expect(outcome.slots).toEqual([{ position: 1, arm: "alternative", status: "no-request-cancelled" }]);
			expect(outcome.verdict).toBe("partial");
		},
		120000,
	);
	it("a declined, wrong or expired continuation approval stops the study after exactly one request", async () => {
		for (const [answer, config] of [
			[null, await rig.newConfig()],
			["APPROVE CONTINUATION other", await rig.newConfig()],
			[HANG, await rig.newConfig({ maxApprovalIdleMs: 1000 })],
		] as const) {
			rig.backend.setHealth(ready);
			const before = rig.backend.completionRequests().length;
			const terminal = new ScriptedTerminal((kind, phrase) => (kind === "second" ? answer : phrase));
			const outcome = await run(config, terminal);
			expect(rig.backend.completionRequests().length - before).toBe(1);
			expect(terminal.asked.map((a) => a.kind)).toEqual(["launch", "first", "second"]);
			expect(outcome.slots).toHaveLength(1);
			expect(outcome.slots[0]!.status).not.toBe("completed");
			expect(outcome.verdict).toBe("partial");
			expect(outcome.server.cleanup).toBe("confirmed");
			expect(renderAaOutcomeV0(outcome)).not.toContain("COMPLETE-UNDER");
		}
	}, 240000);
});

describe.runIf(process.platform === "linux")("operator readiness", () => {
	const refusedAt = async (
		steps: Parameters<AaRig["backend"]["setHealth"]>[0],
		reason: string,
		extra: Partial<AaOperatorConfigV0["server"]> = {},
	) => {
		const config = await rig.newConfig({}, extra);
		rig.backend.setHealth(steps);
		const before = rig.backend.completionRequests().length;
		const terminal = new ScriptedTerminal();
		const outcome = await run(config, terminal);
		expect(outcome.readiness).toMatchObject({ status: "refused", reason });
		expect(outcome).toMatchObject({
			verdict: "refused",
			stage: "readiness",
			server: { launched: true, cleanup: "confirmed" },
		});
		expect(outcome.reasons.join()).toContain("not reported ready");
		// No study exists, no turn was ever offered, and no completion was requested.
		expect(terminal.asked.map((a) => a.kind)).toEqual(["launch"]);
		expect(rig.backend.completionRequests().length - before).toBe(0);
		expect(existsSync(config.studyFile)).toBe(false);
		expect(outcome.independentRead.performed).toBe(false);
		expect(existsSync(readinessPathV0(config.studyFile))).toBe(true);
		expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
		expect(await portIsFree(config.server.port)).toBe(true);
		return outcome;
	};
	it("a listener that answers nothing about health is not ready", async () => {
		// With no /health script the fake backend answers 404, like a build without the route.
		await refusedAt([], "unexpected-status");
	});
	it("refuses a server that stays in the loading state past the deadline", async () => {
		const outcome = await refusedAt(
			[{ status: 503, body: '{"error":{"message":"Loading model"}}' }],
			"deadline-exceeded",
			{ modelReadyTimeoutMs: 1500 },
		);
		expect((outcome.readiness as { loadingResponses: number }).loadingResponses).toBeGreaterThan(1);
	}, 60000);
	it.each([
		["a wrong status field", [{ status: 200, body: '{"status":"loading"}' }], "invalid-body"],
		["extra fields", [{ status: 200, body: '{"status":"ok","extra":1}' }], "invalid-body"],
		["a non-JSON body", [{ status: 200, body: "ok" }], "invalid-body"],
		["a redirect", [{ status: 302, headers: { location: "/v1/models" } }], "redirect"],
		["an error status", [{ status: 500, body: "{}" }], "unexpected-status"],
		["a dropped connection", [{ status: 0, drop: true }], "network-failure"],
		[
			"an oversized body",
			[{ status: 200, body: `{"status":"ok","pad":"${"x".repeat(9000)}"}` }],
			"oversized-response",
		],
	] as const)(
		"refuses %s",
		async (_name, steps, reason) => {
			await refusedAt(steps, reason);
		},
		60000,
	);
	it("never follows a redirect and never sends anything but GET /health while waiting", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth([{ status: 302, headers: { location: "/v1/models" } }]);
		const before = rig.backend.requests.length;
		await run(config, new ScriptedTerminal());
		const seen = rig.backend.requests.slice(before);
		expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /health"]);
	}, 60000);
	it("ends the wait when the owned server dies during loading", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth([{ status: 503 }]);
		const { launch, state } = wrapLaunch({
			launched: (server) => {
				setTimeout(() => process.kill(server.provenance.process.pid, "SIGKILL"), 600);
			},
		});
		const outcome = await run(config, new ScriptedTerminal(), { deps: { launch } });
		expect(outcome.readiness).toMatchObject({ status: "refused" });
		expect((outcome.readiness as { reason: string }).reason).toMatch(/identity-changed|network-failure/);
		expect(outcome.verdict).toBe("refused");
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("confirmed");
	}, 60000);
	it("stops the wait and the server when interrupted while the model is loading", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth([{ status: 503 }]);
		const controller = new AbortController();
		const { launch, state } = wrapLaunch({ launched: () => void setTimeout(() => controller.abort(), 700) });
		const outcome = await run(config, new ScriptedTerminal(), { signal: controller.signal, deps: { launch } });
		expect(outcome).toMatchObject({
			verdict: "refused",
			interrupted: true,
			readiness: { status: "refused", reason: "cancelled" },
		});
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("confirmed");
	}, 60000);
	it("a failure to publish the readiness record refuses the study", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const { launch } = wrapLaunch({
			launched: () => writeFileSync(readinessPathV0(config.studyFile), "occupied", { mode: 0o600 }),
		});
		const outcome = await run(config, new ScriptedTerminal(), { deps: { launch } });
		expect(outcome).toMatchObject({ verdict: "refused", server: { cleanup: "confirmed" } });
		expect(outcome.independentRead.performed).toBe(false);
		expect(existsSync(config.studyFile)).toBe(false);
	}, 60000);
});

describe.runIf(process.platform === "linux")("operator launch boundary", () => {
	it("terminates and reports a server that exits or never listens, without retrying it", async () => {
		const crashing = await rig.newConfig({}, { executablePath: rig.crash, executableSha256: sha256File(rig.crash) });
		const terminal = new ScriptedTerminal();
		const outcome = await run(crashing, terminal);
		expect(outcome).toMatchObject({
			verdict: "refused",
			stage: "server-launch",
			server: { launched: false, cleanup: "nothing-started" },
		});
		expect(outcome.reasons.join()).toContain("exited");
		expect(terminal.count("launch")).toBe(1);
		expect(runningFrom(rig.crash)).toEqual([]);
		expect(await portIsFree(crashing.server.port)).toBe(true);
		const hanging = await rig.newConfig(
			{},
			{ executablePath: rig.hang, executableSha256: sha256File(rig.hang), startupTimeoutMs: 1000 },
		);
		expect((await run(hanging, new ScriptedTerminal())).reasons.join()).toContain("timed out");
		expect(runningFrom(rig.hang)).toEqual([]);
	}, 60000);
	it("an interruption while the server is starting leaves no process or listener", async () => {
		const config = await rig.newConfig({}, { executablePath: rig.hang, executableSha256: sha256File(rig.hang) });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		const outcome = await run(config, new ScriptedTerminal(), { signal: controller.signal });
		expect(outcome).toMatchObject({ verdict: "refused", stage: "server-launch", interrupted: true });
		expect(outcome.reasons.join()).toContain("cancelled");
		expect(runningFrom(rig.hang)).toEqual([]);
		expect(await portIsFree(config.server.port)).toBe(true);
	}, 60000);
	it("refuses before any launch when the port is taken, evidence exists, or the study is out of range", async () => {
		const taken = await rig.newConfig();
		const listener = createServer();
		await new Promise<void>((resolve) => listener.listen(taken.server.port, "127.0.0.1", resolve));
		try {
			const terminal = new ScriptedTerminal();
			const outcome = await run(taken, terminal);
			expect(outcome).toMatchObject({ verdict: "refused" });
			expect(terminal.asked.map((a) => a.kind)).toEqual([]);
			// The occupied port belongs to someone else; the operator neither signalled nor reported it as its own.
			expect(outcome.server.cleanup).toBe("nothing-started");
		} finally {
			await new Promise((resolve) => listener.close(resolve));
		}
		for (const bad of [
			{ seed: -1 },
			{ seed: 1.5 },
			{ expectedAnswer: "10" },
			{ wallTimeoutMs: 999 },
			{ prompt: "Say hi" },
		]) {
			const terminal = new ScriptedTerminal();
			const outcome = await run(await rig.newConfig(bad), terminal);
			expect(outcome).toMatchObject({ verdict: "refused", stage: "preparation" });
			expect(terminal.asked).toEqual([]);
		}
		expect(runningFrom(rig.relay)).toEqual([]);
	}, 60000);
});

describe.runIf(process.platform === "linux")("operator interruptions and cleanup", () => {
	it("an interruption at the first-turn approval spends the slot, sends no request and stops the server once", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const before = rig.backend.completionRequests().length;
		const controller = new AbortController();
		const { launch, state } = wrapLaunch();
		const terminal = new ScriptedTerminal((kind, phrase) => (kind === "launch" ? phrase : HANG));
		const pending = run(config, terminal, { signal: controller.signal, deps: { launch } });
		await untilAsked(terminal, 2);
		controller.abort();
		const outcome = await pending;
		expect(outcome).toMatchObject({ verdict: "partial", interrupted: true, server: { cleanup: "confirmed" } });
		expect(outcome.slots).toEqual([{ position: 1, arm: "baseline", status: "no-request-cancelled" }]);
		expect(rig.backend.completionRequests().length - before).toBe(0);
		expect(state.stops).toBe(1);
		expect(terminal.asked).toHaveLength(2);
	}, 120000);
	it("an interruption during dispatch grants nothing further and the slot stays spent", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const before = rig.backend.completionRequests().length;
		const controller = new AbortController();
		const watcher = setInterval(() => {
			if (rig.backend.completionRequests().length > before) controller.abort();
		}, 1);
		const { launch, state } = wrapLaunch();
		const terminal = new ScriptedTerminal();
		let outcome: AaOperatorOutcomeV0;
		try {
			outcome = await run(config, terminal, { signal: controller.signal, deps: { launch } });
		} finally {
			clearInterval(watcher);
		}
		expect(rig.backend.completionRequests().length - before).toBe(1);
		expect(outcome.verdict).toBe("partial");
		expect(outcome.slots).toHaveLength(1);
		expect(outcome.slots[0]!.status).not.toBe("completed");
		expect(outcome.interrupted).toBe(true);
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("confirmed");
		expect(terminal.count("first")).toBe(1);
		expect(terminal.asked.filter((a) => a.kind === "second").length).toBeLessThanOrEqual(1);
	}, 120000);
	it("a server that dies between the turns is not asked for the continuation request", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const before = rig.backend.completionRequests().length;
		const { launch, state } = wrapLaunch();
		const terminal = new ScriptedTerminal((kind, phrase) => {
			if (kind === "second") process.kill(state.server!.provenance.process.pid, "SIGKILL");
			return phrase;
		});
		const outcome = await run(config, terminal, { deps: { launch } });
		expect(rig.backend.completionRequests().length - before).toBe(1);
		expect(outcome.verdict).toBe("partial");
		expect(outcome.slots.map((s) => s.status)).not.toContain("completed");
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("confirmed");
	}, 120000);
	it("a failed stop is reported as cleanup-unconfirmed even after four completed slots", async () => {
		const config = await rig.newConfig({ seed: 1 });
		rig.backend.setHealth(ready);
		const { launch, state } = wrapLaunch({
			stop: async () => {
				throw new Error("stop failed");
			},
		});
		let outcome: AaOperatorOutcomeV0;
		try {
			outcome = await run(config, new ScriptedTerminal(), { deps: { launch } });
		} finally {
			await state.server?.stop().catch(() => {}); // Only the test cleans up what the operator could not confirm.
		}
		expect(state.stops).toBe(1);
		expect(outcome.slots.map((s) => s.status)).toEqual(Array(4).fill("completed"));
		expect(outcome.verdict).toBe("cleanup-unconfirmed");
		expect(outcome.server.cleanup).toBe("cleanup-unconfirmed");
		expect(outcome.reasons.join()).toContain("stop failed");
		expect(renderAaOutcomeV0(outcome)).toContain("CLEANUP-UNCONFIRMED");
		expect(renderAaOutcomeV0(outcome)).not.toContain("COMPLETE-UNDER");
		expect(outcome.independentRead.report?.lifecycle).toBe("open");
	}, 300000);
	it("an unconfirmed process or listener in the end record is never reported as clean", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const { launch, state } = wrapLaunch({
			stop: async (real) => {
				const end = await real();
				return { ...end, listenerGone: false };
			},
		});
		const outcome = await run(config, new ScriptedTerminal((kind, phrase) => (kind === "launch" ? phrase : null)), {
			deps: { launch },
		});
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("cleanup-unconfirmed");
		expect(outcome.verdict).toBe("cleanup-unconfirmed");
	}, 120000);
	it("a signal that arrives while the server is being stopped does not stop it twice or skip the end record", async () => {
		const config = await rig.newConfig();
		rig.backend.setHealth(ready);
		const controller = new AbortController();
		const { launch, state } = wrapLaunch({
			stop: async (real) => {
				controller.abort();
				await sleep(300);
				return real();
			},
		});
		const outcome = await run(config, new ScriptedTerminal((kind, phrase) => (kind === "launch" ? phrase : null)), {
			signal: controller.signal,
			deps: { launch },
		});
		expect(state.stops).toBe(1);
		expect(outcome.server.cleanup).toBe("confirmed");
		expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
		expect(outcome.interrupted).toBe(true);
	}, 120000);
});

describe.runIf(process.platform === "linux")("operator pre-launch pair check and binary rendering", () => {
	it("refuses a sibling pair whose conditions differ before any launch prompt", async () => {
		// Verified-pristine, but the alternative differs from the baseline. Pre-launch preflight must already refuse it.
		const config = await rig.newConfig(
			{},
			{},
			{ id: "arm-b", description: "differs", settings: { thinkingLevel: "high" } as never },
		);
		const terminal = new ScriptedTerminal();
		const outcome = await run(config, terminal);
		expect(outcome).toMatchObject({ verdict: "refused", stage: "preparation", server: { launched: false } });
		expect(outcome.reasons.join()).toMatch(/preflight refused|not matched/);
		expect(terminal.asked).toEqual([]);
		await nothingStarted(config);
	}, 60000);
	const base = (report: AaOperatorOutcomeV0["independentRead"]["report"]): AaOperatorOutcomeV0 => ({
		verdict: "partial",
		stage: "done",
		interrupted: false,
		reasons: [],
		server: { launched: true, cleanup: "confirmed", stop: null },
		readiness: { status: "not-attempted" },
		slots: [],
		independentRead: { performed: true, status: report ? "valid" : "reader-refused", report, answers: null },
	});
	const report = (supportedBinary: string, blockingReasons: string[]) =>
		({
			studyStatus: "four-receipts",
			records: "valid",
			admissionSidecars: 8,
			observedProcessIdentity: "consistent",
			identityDifferences: [],
			declaredTrustAssumptions: ["a"],
			hostFacts: {
				ownership: "OWNERSHIP_UNVERIFIED",
				checks: {},
				supportedBinary,
				unavailable: [],
				blockingReasons,
			},
			lifecycle: "cleaned",
			studyAdmission: "complete",
			observationIds: [],
		}) as unknown as NonNullable<AaOperatorOutcomeV0["independentRead"]["report"]>;
	it("states the binary as matching, unsupported, or unavailable, and never blames unrelated reasons", () => {
		const matched = renderAaOutcomeV0(base(report("MATCH", ["OWNERSHIP_UNVERIFIED"])));
		expect(matched).toMatch(/server binary\s+MATCH \(digest equals the historically accepted build/);
		expect(matched).not.toContain("server binary UNSUPPORTED");
		expect(matched).not.toContain("not the accepted build");
		const unsupported = renderAaOutcomeV0(
			base(report("UNSUPPORTED", ["OWNERSHIP_UNVERIFIED", "REUSEPORT_UNVERIFIED", "UNSUPPORTED_BINARY"])),
		);
		expect(unsupported).toContain("(server binary UNSUPPORTED, not the accepted build)");
		expect(unsupported).toContain("reasons: UNSUPPORTED_BINARY)");
		expect(unsupported).not.toMatch(/reasons:[^)]*(OWNERSHIP|REUSEPORT)/);
		const odd = renderAaOutcomeV0(base(report("UNAVAILABLE", [])));
		expect(odd).toMatch(/server binary\s+UNAVAILABLE \(NOT the historically accepted build\)/);
		expect(renderAaOutcomeV0(base(null))).toMatch(/server binary\s+unavailable/);
	});
});
