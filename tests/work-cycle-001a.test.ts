// WORK-CYCLE-001A (research/work-cycle/README.md): one DEVELOP work cycle through the public CLI, reconstructed afterwards from the
// stored records alone.
//
// TEST-SUBSTITUTE APPROVAL. In every tier below the APPROVE ATTEMPT phrase is typed by this test into a real pseudo-terminal that is
// the workbench's controlling terminal. That is the production approval path with a scripted operator; it is NOT the
// operator-governed run, which `node research/work-cycle/driver.ts run` leaves to a person.
//
//   tier 1 (always, Linux with script(1))  the fake Pi. It runs no tools, so the candidate edit is made by this test and says so.
//   tier 2 (ENDO_PI_EXECUTABLE)            an installed Pi and the local fake model endpoint, scripted to call Pi's own read and
//                                          edit tools, including one call Pi must refuse (Pi 1.5.0 argument validation).
//   tier 3 (+ ENDO_WORK_CYCLE_ENDPOINT and ENDO_WORK_CYCLE_MODEL)  the same Pi and a real local model through the recording proxy.
//                                          Nothing is asserted about the model's success; what happened is kept.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	attachArgs,
	capturedChatBodies,
	classifyPonytail,
	doctor,
	endo,
	findPonytail,
	json,
	launchRun,
	type Prepared,
	piEnv,
	ponytailInstructions,
	prepareJourney,
	processesOfRun,
	type RunLayout,
	reconstruct,
	renderReconstruction,
	runEnv,
	runGit,
	TASK,
	writePiAgentDir,
} from "../research/work-cycle/driver.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const hasScript = spawnSync("script", ["--version"]).status === 0;
const linuxPty = hasScript && process.platform === "linux";
const realPi = process.env.ENDO_PI_EXECUTABLE ?? "";
const modelEndpoint = process.env.ENDO_WORK_CYCLE_ENDPOINT ?? "";
const modelId = process.env.ENDO_WORK_CYCLE_MODEL ?? "";
const keep = process.env.ENDO_WORK_CYCLE_EVIDENCE_DIR ?? "";
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];

const FIXED = 'return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");';
const BROKEN = 'return title.toLowerCase().replace(/ /g, "-");';

class Pty {
	output = "";
	private consumed = 0;
	readonly child: ChildProcessWithoutNullStreams;
	readonly exit: Promise<number | null>;
	constructor(argv: readonly string[], env: NodeJS.ProcessEnv) {
		const command = [process.execPath, ...argv].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
		this.child = spawn("script", ["-qefc", `stty cols 250; exec ${command}`, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.child.stdout.on("data", (chunk) => {
			this.output += String(chunk).replace(ansi, "");
		});
		this.exit = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
		cleanup.push(() => {
			if (this.child.exitCode === null) this.child.kill("SIGKILL");
		});
	}
	async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<RegExpExecArray> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const match = pattern.exec(this.output.slice(this.consumed));
			if (match) {
				this.consumed += match.index + match[0].length;
				return match;
			}
			if (Date.now() > deadline || this.child.exitCode !== null)
				throw new Error(`pattern ${pattern} not seen; output so far:\n${this.output.slice(-2500)}`);
			await sleep(25);
		}
	}
	type(line: string) {
		this.child.stdin.write(`${line}\r`);
	}
}

beforeAll(async () => {
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(new URL("../studio-ui/dist", import.meta.url).pathname);
}, 90_000);
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

function freshRun(prefix: string): RunLayout {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
	return launchRun(join(parent, "run"));
}

const S = (l: RunLayout) => ["--root", l.store];

/** Drive part 2: ask on the workbench terminal, decline once with the wrong phrase, approve, wait for the run, Ctrl-C. */
async function driveWorkbench(
	layout: RunLayout,
	prepared: Prepared,
	subject: { pi: string; provider?: string; model?: string },
	env: NodeJS.ProcessEnv,
	runTimeoutMs = 120_000,
): Promise<{ output: string; read: any }> {
	const pty = new Pty(attachArgs(layout, prepared, subject), env);
	await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/, 120_000);
	pty.type(`attempt ${prepared.attemptId}`);
	const phrase = (await pty.waitFor(/Type (APPROVE ATTEMPT [0-9a-f]{16}) to send exactly this brief/))[1] as string;
	expect(pty.output).toContain(TASK.objective);
	expect(pty.output).toContain("Terminal approval is not a sandbox");
	pty.type(phrase); // TEST SUBSTITUTE for the operator typing the phrase.
	await pty.waitFor(/was sent and Pi accepted it \(started\)/, 120_000);
	let read: any = null;
	const deadline = Date.now() + runTimeoutMs;
	while (Date.now() < deadline) {
		read = json(
			endo(layout, runEnv(layout), "attempt", "show", ...S(layout), "--attempt", prepared.attemptId),
		).attempt;
		if (read.execution?.run !== "open" && read.execution?.run !== "not-observed") break;
		await sleep(250);
	}
	pty.child.stdin.write("\x03");
	expect(await pty.exit).toBe(0);
	return { output: pty.output, read };
}

/** The evidence steps every tier shares, after the agent has exited: inspect, refuse a dirty check, commit, check, reconstruct. */
function evidenceSteps(layout: RunLayout, prepared: Prepared) {
	const env = runEnv(layout);
	const diff = runGit(layout.project, "diff");
	// A check of an uncommitted candidate is refused and nothing runs: the receipt binds a commit, never a dirty tree.
	const dirty = endo(
		layout,
		env,
		"attempt",
		"check",
		...S(layout),
		"--attempt",
		prepared.attemptId,
		"--",
		...TASK.check,
	);
	runGit(layout.project, "add", "-A");
	runGit(layout.project, "commit", "-q", "-m", "candidate (committed by the operator after review)");
	const candidate = runGit(layout.project, "rev-parse", "HEAD").trim();
	const check = endo(
		layout,
		env,
		"attempt",
		"check",
		...S(layout),
		"--attempt",
		prepared.attemptId,
		"--",
		...TASK.check,
	);
	return { diff, dirty, candidate, check };
}

describe("WORK-CYCLE-001A pieces that need no terminal", () => {
	it("Ponytail's effective mode is read from the system text, and unknown or mismatched modes are said so", () => {
		const instructions = { lite: "LITE RULES", full: "FULL RULES", ultra: "ULTRA RULES", review: "REVIEW MODE" };
		const body = (system: string) => ({
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: "x" },
			],
		});
		const listed = "<skill>ponytail-review</skill>";
		expect(classifyPonytail([body(listed), body(listed)], instructions, "off")).toMatchObject({
			effective: "off",
			matchesDeclared: true,
		});
		expect(classifyPonytail([body(`${listed}\nFULL RULES`)], instructions, "off")).toMatchObject({
			effective: "full",
			matchesDeclared: false,
		});
		expect(classifyPonytail([body(listed), body(`${listed} LITE RULES`)], instructions, "off")).toMatchObject({
			effective: "mixed",
			matchesDeclared: null,
		});
		expect(classifyPonytail([body(`${listed} REVIEW MODE`)], instructions, "review")).toMatchObject({
			effective: "review",
			matchesDeclared: true,
		});
		expect(classifyPonytail([body("no skills here")], instructions, "off").effective).toBe("not-loaded");
		expect(classifyPonytail([], instructions, "off")).toMatchObject({ effective: "unknown", matchesDeclared: null });
		expect(classifyPonytail([body(listed)], null, "off").effective).toBe("unknown");
		expect(classifyPonytail([body(listed)], instructions, null).matchesDeclared).toBeNull();
	});

	it("doctor reports a Pi version other than the one declared as a failure", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const findings = await doctor({ pi: install.bin, expectPiVersion: "1.5.0" });
		expect(findings.find((f) => f.check === "pi --version")).toMatchObject({ status: "fail" });
		expect(
			(await doctor({ pi: install.bin, expectPiVersion: "1.0.0" })).find((f) => f.check === "pi --version")?.status,
		).toBe("ok");
	});

	it("`endo task show` gives a terminal reader the acceptance criteria and the operator's status history", () => {
		const layout = freshRun("endo-wc-show-");
		const env = runEnv(layout);
		const prepared = prepareJourney(layout, env);
		endo(
			layout,
			env,
			"task",
			"status",
			...S(layout),
			"--project",
			prepared.projectId,
			"--task",
			prepared.taskId,
			"--to",
			"in-progress",
		);
		const shown = json(
			endo(layout, env, "task", "show", ...S(layout), "--project", prepared.projectId, "--task", prepared.taskId),
		).task;
		expect(shown.acceptance).toBe(TASK.acceptance);
		expect(shown.description).toBe(TASK.description);
		expect(shown.history.map((h: { from: unknown; to: unknown }) => [h.from, h.to])).toEqual([
			[null, "open"],
			["open", "in-progress"],
		]);
	});
});

describe.runIf(linuxPty)(
	"WORK-CYCLE-001A tier 1: the fake Pi (test-substitute approval; the candidate edit is the test's)",
	() => {
		it("prepares, fails the baseline, sends once, and is reconstructed after exit; Pi, the check and the operator stay distinct", async () => {
			const layout = freshRun("endo-wc-t1-");
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const env = runEnv(layout, {
				XDG_DATA_HOME: join(layout.home, "xdg"),
				...fakePiEnv({
					FAKE_PI_STEP_MS: "20",
					// The fake reports one edit call and executes nothing; the edit itself is made by this test below.
					FAKE_PI_TOOL_CALLS: JSON.stringify([
						{ toolName: "edit", args: { path: "src/slug.mjs" }, isError: false },
					]),
				}),
			});

			// Drive 1: the baseline check at the fixture commit FAILS, and is recorded as a failure (negative case: verification fails).
			const prepared = prepareJourney(layout, env);
			expect(prepared.baseline).toMatchObject({ exit: 3, outcome: "failed" });

			// Drive 2: the workbench sends the attempt once; Pi's run completes (as the fake reports it).
			const { read } = await driveWorkbench(layout, prepared, { pi: install.bin }, env);
			expect(read.execution).toMatchObject({
				send: "runtime-accepted",
				run: "completed",
				evidence: "complete",
				brief: "matches",
			});
			expect(read.state).toBe("prepared");
			expect(processesOfRun(layout)).toEqual([]);

			// The fake Pi executes no tools: the "agent's" edit is made here, by the test.
			const file = join(layout.project, "src", "slug.mjs");
			writeFileSync(file, readFileSync(file, "utf8").replace(BROKEN, FIXED));

			const { dirty, candidate, check } = evidenceSteps(layout, prepared);
			expect(dirty.status).toBe(2);
			expect(check.status).toBe(0);
			expect(json(check).receipt).toMatchObject({ outcome: "passed", commit: candidate });

			// Evidence: a new reader, no agent, no workbench. Pi completing and the check passing moved no status.
			const r1 = reconstruct(layout, prepared);
			// Paging the event log in small pages reads the same events once each: the store's cursor, not a per-stream sequence.
			const paged = reconstruct(layout, prepared, runEnv(layout), { pageSize: 7 });
			expect(paged.run).toEqual(r1.run);
			expect(r1.run.tools).toEqual({ edit: { started: 1, finished: 1, errors: 0 } });
			expect(r1.liveProcesses).toEqual([]);
			expect(r1.task.status).toBe("open");
			expect(r1.receipts.map((x) => [x.outcome, x.relation])).toEqual([
				["failed", "head-differs"],
				["passed", "at-head"],
			]);
			expect(r1.artifact).toMatchObject({
				head: candidate,
				clean: true,
				changedFiles: ["src/slug.mjs"],
				testsChanged: false,
			});
			expect(r1.artifact.provenance).toContain("declared, not observed");
			expect(r1.receiptLimitations).toContain(
				"The operator linked this check to the attempt; Endophasia does not know which revision the attempt's work produced.",
			);
			expect(r1.verdicts.operatorDecision).toContain("status open");
			expect(r1.run.dispatchSequence).not.toBeNull();
			expect(r1.run.endKind).toBe("lifecycle.run-completed");

			// The decision is the operator's, in its own steps, each against the revision it saw.
			const T = ["--project", prepared.projectId, "--task", prepared.taskId];
			for (const to of ["in-progress", "review"])
				expect(endo(layout, env, "task", "status", ...S(layout), ...T, "--to", to).status).toBe(0);
			expect(
				endo(
					layout,
					env,
					"task",
					"status",
					...S(layout),
					...T,
					"--to",
					"done",
					"--note",
					"read the diff; check passed at the candidate",
				).status,
			).toBe(0);
			const r2 = reconstruct(layout, prepared);
			expect(r2.task.history.map((h) => h.to)).toEqual(["open", "in-progress", "review", "done"]);
			expect(r2.verdicts.operatorDecision).toContain("review → done by `endo task status` or the paired page");

			// Negative: the revision moves after the receipt. The passing receipt is not carried forward: it reads stale.
			writeFileSync(join(layout.project, "NOTES"), "a later commit\n");
			runGit(layout.project, "add", "NOTES");
			runGit(layout.project, "commit", "-q", "-m", "later");
			const r3 = reconstruct(layout, prepared);
			expect(r3.receipts.at(-1)).toMatchObject({ outcome: "passed", relation: "head-differs" });
			expect(r3.verdicts.checkAtHead).toBe("no check at the current HEAD");
			expect(r3.unknowns).toContain(
				"no receipt was recorded at the current HEAD: the current revision is unchecked",
			);
			expect(r3.task.status).toBe("done"); // and nothing reopened the task on its own
			expect(renderReconstruction(r3)).toContain("## Three separate answers");
		}, 240_000);
	},
);

describe.runIf(linuxPty && realPi.length > 0)(
	"WORK-CYCLE-001A tier 2: an installed Pi with Pi's own tools, against the scripted fake endpoint (opt-in: ENDO_PI_EXECUTABLE)",
	() => {
		let server: FakeOpenAiServer;
		afterEach(async () => {
			await server?.close();
		});

		it("real Pi edits the fixture, refuses a malformed tool call, and the cycle is reconstructed after it exits", async () => {
			const layout = freshRun("endo-wc-t2-");
			server = await startFakeOpenAiServer({
				toolScript: {
					steps: [
						// Pi 1.5.0 coerces a numeric string for a number parameter.
						{ name: "read", arguments: JSON.stringify({ path: "src/slug.mjs", limit: "20" }) },
						// Missing `path`: Pi must refuse it before running the tool.
						{ name: "edit", arguments: JSON.stringify({ edits: [{ oldText: BROKEN, newText: FIXED }] }) },
						// `edits` as one object, not an array: Pi 1.5.0 documents wrapping a single value into an array.
						{
							name: "edit",
							arguments: JSON.stringify({ path: "src/slug.mjs", edits: { oldText: BROKEN, newText: FIXED } }),
						},
					],
					finalText: "Done: slugify now collapses separators.",
				},
			});
			const ponytail = findPonytail();
			writePiAgentDir(layout, {
				baseUrl: server.baseUrl,
				provider: "endofake",
				model: "fake-1",
				ponytailPackage: ponytail?.dir ?? null,
			});
			const prepared = prepareJourney(layout, runEnv(layout));
			expect(prepared.baseline.outcome).toBe("failed");
			const env = piEnv(layout, "off");
			const { read, output } = await driveWorkbench(
				layout,
				prepared,
				{ pi: realPi, provider: "endofake", model: "fake-1" },
				env,
			);
			expect(output).not.toContain("an internal error occurred");
			expect(read.execution).toMatchObject({ send: "runtime-accepted", run: "completed", evidence: "complete" });

			// What Pi said back to the model for each tool call: the tool messages of the last request, in order.
			const completions = server.completionRequests();
			const last = completions.at(-1)?.body as { messages: { role: string; content: unknown }[] };
			const toolTexts = last.messages
				.filter((m) => m.role === "tool")
				.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
			// Observed with Pi 1.5.0 (research/work-cycle/README.md): the numeric string was coerced and the file read; the call without
			// `path` was refused before running, in pi-schema's format (TypeBox's, before 1.5.0, was "must have required properties path");
			// the single `edits` object was wrapped into an array and applied. Another release may differ: this pins what was observed.
			expect(toolTexts).toHaveLength(3);
			expect(toolTexts[0]).toContain("export function slugify");
			expect(toolTexts[1]).toContain('Validation failed for tool "edit"');
			expect(toolTexts[1]).toContain("- path: missing");
			expect(toolTexts[2]).toMatch(/Successfully replaced 1 block/);

			const { diff, dirty, check } = evidenceSteps(layout, prepared);
			expect(diff).toContain('replace(/[^a-z0-9]+/g, "-")');
			expect(dirty.status).toBe(2);
			expect(check.status).toBe(0);
			const r = reconstruct(layout, prepared);
			expect(r.liveProcesses).toEqual([]);
			expect(r.run.tools.read).toMatchObject({ started: 1, errors: 0 });
			// The refused call is still a tool execution in the event log, flagged as an error; the wrapped one is not.
			expect(r.run.tools.edit).toMatchObject({ started: 2, finished: 2, errors: 1 });
			expect(r.task.status).toBe("open");

			// Ponytail, observed in what this Pi child sent, against what was declared.
			const observed = classifyPonytail(
				completions.map((c) => c.body),
				ponytail === null ? null : await ponytailInstructions(ponytail.dir),
				"off",
			);
			if (ponytail === null) expect(observed.effective).toBe("unknown");
			else expect(observed).toMatchObject({ effective: "off", matchesDeclared: true });

			// Positive control for the detector: the same Pi, agent directory and package, one print-mode prompt with mode "full".
			let control: ReturnType<typeof classifyPonytail> | null = null;
			if (ponytail !== null) {
				const before = server.completionRequests().length;
				// Asynchronous: the fake endpoint runs in this process, so a synchronous spawn would leave it unable to answer.
				const probe = spawn(
					realPi,
					["-p", "--no-session", "--provider", "endofake", "--model", "fake-1", "hello"],
					{
						cwd: layout.project,
						env: piEnv(layout, "full"),
						stdio: ["ignore", "ignore", "ignore"],
					},
				);
				const killer = setTimeout(() => probe.kill("SIGKILL"), 60_000);
				await new Promise((done) => probe.once("exit", done));
				clearTimeout(killer);
				control = classifyPonytail(
					server
						.completionRequests()
						.slice(before)
						.map((c) => c.body),
					await ponytailInstructions(ponytail.dir),
					"full",
				);
				expect(control).toMatchObject({ effective: "full", matchesDeclared: true });
			}
			if (keep.length > 0) {
				mkdirSync(keep, { recursive: true });
				const version = spawnSync(realPi, ["--version"], { encoding: "utf8" }).stdout.trim();
				writeFileSync(
					join(keep, "tier2.json"),
					`${JSON.stringify({ piVersion: version, ponytail, observed: { ...observed }, control, toolTexts, reconstruction: r }, null, 2)}\n`,
				);
				writeFileSync(join(keep, "tier2-reconstruction.md"), renderReconstruction(r));
			}
		}, 300_000);
	},
);

describe.runIf(linuxPty && realPi.length > 0 && modelEndpoint.length > 0 && modelId.length > 0)(
	"WORK-CYCLE-001A tier 3: an installed Pi and a REAL local model (opt-in; test-substitute approval; outcome recorded, not asserted)",
	() => {
		it("runs the cycle against the model through the recording proxy and keeps what happened", async () => {
			const layout = freshRun("endo-wc-t3-");
			const proxy = spawn(
				process.execPath,
				[
					new URL("../cli/index.ts", import.meta.url).pathname,
					"proxy",
					"record",
					"--upstream",
					new URL(modelEndpoint).origin,
					"--store",
					layout.capture,
				],
				{ env: runEnv(layout), stdio: ["ignore", "pipe", "pipe"] },
			);
			let proxyErr = "";
			proxy.stderr.on("data", (c) => {
				proxyErr += String(c);
			});
			const proxyExit = new Promise((r) => proxy.once("exit", r));
			cleanup.push(async () => {
				if (proxy.exitCode === null) proxy.kill("SIGTERM");
				await proxyExit;
			});
			for (let i = 0; i < 200 && !/recording (http:\/\/\S+) ->/.test(proxyErr); i++) await sleep(50);
			const origin = /recording (http:\/\/\S+) ->/.exec(proxyErr)?.[1] as string;
			expect(origin).toBeDefined();
			const ponytail = findPonytail();
			writePiAgentDir(layout, {
				baseUrl: `${origin}/v1`,
				provider: "work-cycle",
				model: modelId,
				ponytailPackage: ponytail?.dir ?? null,
			});
			const findings = await doctor({ pi: realPi, endpoint: modelEndpoint, model: modelId });
			const prepared = prepareJourney(layout, runEnv(layout));
			const started = Date.now();
			const { read } = await driveWorkbench(
				layout,
				prepared,
				{ pi: realPi, provider: "work-cycle", model: modelId },
				piEnv(layout, "off"),
				Number(process.env.ENDO_WORK_CYCLE_RUN_MS ?? 900_000),
			);
			const runMs = Date.now() - started;
			proxy.kill("SIGTERM");
			await proxyExit;
			const changed = runGit(layout.project, "status", "--porcelain=v1", "--untracked-files=all").trim().length > 0;
			const candidateDiff = runGit(layout.project, "diff");
			const evidence = changed ? evidenceSteps(layout, prepared) : null;
			const r = reconstruct(layout, prepared);
			const bodies = await capturedChatBodies(layout.capture, layout.digestKeyFile);
			const observed = classifyPonytail(
				bodies,
				ponytail === null ? null : await ponytailInstructions(ponytail.dir),
				"off",
			);
			const summary = {
				label: "tier 3: real model, TEST-SUBSTITUTE approval (not the operator-governed run)",
				piVersion: spawnSync(realPi, ["--version"], { encoding: "utf8" }).stdout.trim(),
				model: modelId,
				endpoint: modelEndpoint,
				doctor: findings,
				runMs,
				execution: read.execution,
				modelRequests: bodies.length,
				ponytail: { package: ponytail, ...observed },
				candidateChanged: changed,
				checkExit: evidence?.check.status ?? null,
				reconstruction: r,
			};
			if (keep.length > 0) {
				mkdirSync(keep, { recursive: true });
				writeFileSync(join(keep, "tier3.json"), `${JSON.stringify(summary, null, 2)}\n`);
				writeFileSync(join(keep, "tier3-candidate.diff"), candidateDiff);
				writeFileSync(join(keep, "tier3-reconstruction.md"), renderReconstruction(r));
				// The whole run (store, Pi session, capture, project) stays with the evidence, outside the repository.
				cpSync(layout.run, join(keep, "run"), { recursive: true, verbatimSymlinks: true });
			}
			process.stderr.write(
				`tier 3: send=${read.execution?.send} run=${read.execution?.run} changed=${changed} check=${evidence?.check.status ?? "-"} ponytail=${observed.effective}\n`,
			);
			// Only the governance is asserted: one send, a reading after exit, no status moved, nothing left running.
			expect(read.execution?.send).toBe("runtime-accepted");
			expect(r.task.status).toBe("open");
			expect(r.liveProcesses).toEqual([]);
		}, 1_200_000);
	},
);
