#!/usr/bin/env node
/**
 * S2-LIVE-001 Phase C — Controlled Real-Time Observation Experiment
 *
 * Runs a bounded ~12-minute live experiment against an isolated real Git repository
 * and disjoint Endophasia store using the pinned local Inkling model on 127.0.0.1:8091.
 * Tests:
 *   - On-change wake gating vs unchanged idle windows (0 unnecessary inference)
 *   - Digest window on unchanged state + co-due scheduling fairness
 *   - Task state change (blocked -> grounded resolve-blocked-task proposal -> staleness on unblock)
 *   - Verification evidence changes (controller-observed FAIL at HEAD, HEAD advance -> historical not-current, fresh PASS at HEAD)
 *   - Coordination state change (active assignment)
 *   - Operator proposal disposition (ack) with store-isolation verification
 *   - Non-disruptive inference unavailability via isolated closed loopback port (127.0.0.1:18099)
 *     without touching or stopping the operator's 127.0.0.1:8091 llama-server.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const WORKTREE = "/home/noctem/.gemini/antigravity/worktrees/endophasia/live_coordinator_experiment_s2";
const CLI = join(WORKTREE, "cli/index.ts");
const PKG_DIR = join(WORKTREE, "research/coordinator/s2-live-001");
const EV_DIR = join(PKG_DIR, "evidence/phase-c-controlled");
const OBS_JSONL = join(PKG_DIR, "observations/phase-c-controlled.jsonl");
const POOL_LIVE = join(PKG_DIR, "config/pool-local-inkling.json");

const EXP_ROOT = "/tmp/endo-s2-live-001/controlled";
const PROJECT_DIR = join(EXP_ROOT, "project");
const STORE_DIR = join(EXP_ROOT, "store");
const POOL_OUTAGE = join(EXP_ROOT, "pool-outage.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const isoSec = (ms) => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;

function run(cmd, args, opts = {}) {
	const started = Date.now();
	try {
		const stdout = execFileSync(cmd, args, {
			encoding: "utf8",
			cwd: opts.cwd ?? WORKTREE,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: opts.timeout ?? 240_000,
		});
		return { ok: true, exitCode: 0, stdout, stderr: "", elapsedMs: Date.now() - started };
	} catch (err) {
		return {
			ok: false,
			exitCode: typeof err.status === "number" ? err.status : 1,
			stdout: err.stdout?.toString?.("utf8") ?? "",
			stderr: err.stderr?.toString?.("utf8") ?? String(err.message ?? err),
			elapsedMs: Date.now() - started,
		};
	}
}

function endo(args, opts = {}) {
	const res = run(process.execPath, [CLI, ...args], opts);
	if (!opts.allowNonZero && !res.ok) {
		throw new Error(`endo ${args.join(" ")} failed (exit ${res.exitCode}):\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
	}
	let json = null;
	if (res.stdout.trim().startsWith("{")) {
		try {
			json = JSON.parse(res.stdout);
		} catch {
			// leave null
		}
	}
	return { ...res, json };
}

function git(args) {
	const res = run("/usr/bin/git", ["-C", PROJECT_DIR, ...args]);
	if (!res.ok) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
	return res.stdout.trim();
}

function walkFiles(dir, excludeFn) {
	const out = [];
	if (!existsSync(dir)) return out;
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop();
		for (const ent of readdirSync(cur, { withFileTypes: true })) {
			const full = join(cur, ent.name);
			if (excludeFn(full)) continue;
			if (ent.isDirectory()) stack.push(full);
			else if (ent.isFile()) out.push(full);
		}
	}
	return out.sort();
}

function fingerprintDir(dir, excludeFn) {
	const manifest = {};
	for (const f of walkFiles(dir, excludeFn)) {
		manifest[f] = createHash("sha256").update(readFileSync(f)).digest("hex");
	}
	return manifest;
}

function saveEv(name, content) {
	writeFileSync(join(EV_DIR, name), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function logObs(row) {
	appendFileSync(OBS_JSONL, `${JSON.stringify(row)}\n`);
	console.log(
		`[${row.timestampUtc}] ${row.window} ${row.event}: ${row.summary ?? ""}`,
	);
}

async function waitUntil(targetMs, label) {
	const delta = targetMs - Date.now();
	if (delta > 0) {
		console.log(`[${iso()}] Waiting ${Math.ceil(delta / 1000)}s until ${label} (${iso(targetMs)})...`);
		await sleep(delta);
	}
}

function gatewayInfo() {
	const r = run("systemctl", ["--user", "show", "openclaw-gateway.service", "-p", "MainPID,InvocationID,ActiveState"]);
	return r.stdout.trim();
}

function llamaWorkers() {
	const r = run("pgrep", ["-a", "-P", "1426952"], { allowNonZero: true });
	return r.ok ? r.stdout.trim().split("\n").filter(Boolean) : [];
}

async function main() {
	rmSync(EXP_ROOT, { recursive: true, force: true });
	rmSync(EV_DIR, { recursive: true, force: true });
	mkdirSync(EV_DIR, { recursive: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
	mkdirSync(join(STORE_DIR, "events"), { recursive: true });
	mkdirSync(join(STORE_DIR, "develop/attempts"), { recursive: true });
	chmodSync(EXP_ROOT, 0o700);
	chmodSync(STORE_DIR, 0o700);
	writeFileSync(join(STORE_DIR, "events/events.log"), "");
	writeFileSync(OBS_JSONL, "");

	// Outage pool targeting closed loopback port 18099 (NEVER touches 8091)
	writeFileSync(
		POOL_OUTAGE,
		`${JSON.stringify(
			{
				schemaVersion: "endo.coordinator-model-pool.v0",
				selection: { fallback: "none", unconfirmedModel: "permit" },
				members: [
					{
						memberId: "isolated-closed-port",
						kind: "local-openai-compat",
						endpoint: "http://127.0.0.1:18099",
						modelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
						priority: 100,
						maxPromptBytes: 8192,
						maxOutputTokens: 2048,
						timeoutMs: 30000,
						advisoryOnly: true,
					},
				],
			},
			null,
			2,
		)}\n`,
	);

	const gwBefore = gatewayInfo();
	saveEv("gateway-before.txt", `${gwBefore}\n`);

	// 1. Initialize isolated real Git repo with an intentional bug in sub()
	git(["init", "-b", "main"]);
	git(["config", "user.name", "S2-LIVE-001 Controlled"]);
	git(["config", "user.email", "s2-live-001@localhost"]);
	writeFileSync(
		join(PROJECT_DIR, "calc.mjs"),
		"export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b; // bug: adds instead of subtracts\n",
	);
	writeFileSync(
		join(PROJECT_DIR, "test.mjs"),
		'import assert from "node:assert/strict";\nimport { add, sub } from "./calc.mjs";\nassert.equal(add(2, 3), 5);\nassert.equal(sub(5, 3), 2);\nconsole.log("all tests passed");\n',
	);
	git(["add", "calc.mjs", "test.mjs"]);
	git(["commit", "-m", "feat: add calc module with test suite"]);
	const initialHead = git(["rev-parse", "HEAD"]);

	// 2. Register project & add initial task T1
	const proj = endo(["project", "add", "--root", STORE_DIR, "--name", "s2-live-controlled", "--path", PROJECT_DIR]);
	const projectId = proj.json.project.id;
	const t1Add = endo(["task", "add", "--root", STORE_DIR, "--project", projectId, "--title", "Verify arithmetic module API"]);
	const task1Id = t1Add.json.task.id;

	// Anchor window 0 cleanly ~6 seconds in the future (on exact second)
	const anchor0Ms = Math.ceil((Date.now() + 6000) / 1000) * 1000;
	const anchor0Iso = isoSec(anchor0Ms);
	// Offset digest by +35s relative to 1m on-change so both fire cleanly within 1m's 15s grace
	const digestAnchorIso = isoSec(anchor0Ms + 4 * 60_000 + 35_000);

	// 3. Add, enable, and authorize ctrl-on-change (1m) and ctrl-digest (5m)
	endo([
		"advisory", "add", "--root", STORE_DIR,
		"--id", "ctrl-on-change", "--project", projectId,
		"--action", "emit-operator-proposal", "--wake", "on-change",
		"--every", "1m", "--anchor", anchor0Iso, "--missed-run", "skip-and-report",
		"--label", "Phase C controlled on-change",
	]);
	endo(["advisory", "enable", "--root", STORE_DIR, "--id", "ctrl-on-change", "--revision", "1"]);
	endo([
		"advisory", "authorize", "--root", STORE_DIR,
		"--id", "ctrl-on-change", "--revision", "2",
		"--pool", POOL_LIVE,
		"--period", "2h", "--max-turns", "10", "--max-output-tokens", "2048",
		"--max-generated-tokens", "40960", "--turn-timeout", "180", "--expires-in", "2h",
		"--observation", "recorded-or-passive-probe",
		"--permit-capacity-unknown", "--permit-model-unconfirmed",
	]);

	endo([
		"advisory", "add", "--root", STORE_DIR,
		"--id", "ctrl-digest", "--project", projectId,
		"--action", "generate-advisory-brief", "--wake", "digest-window",
		"--every", "5m", "--anchor", digestAnchorIso, "--missed-run", "skip-and-report",
		"--label", "Phase C controlled 5m digest",
	]);
	endo(["advisory", "enable", "--root", STORE_DIR, "--id", "ctrl-digest", "--revision", "1"]);
	endo([
		"advisory", "authorize", "--root", STORE_DIR,
		"--id", "ctrl-digest", "--revision", "2",
		"--pool", POOL_LIVE,
		"--period", "2h", "--max-turns", "3", "--max-output-tokens", "2048",
		"--max-generated-tokens", "12288", "--turn-timeout", "180", "--expires-in", "2h",
		"--observation", "recorded-or-passive-probe",
		"--permit-capacity-unknown", "--permit-model-unconfirmed",
	]);

	saveEv("setup-meta.json", {
		projectId,
		task1Id,
		initialHead,
		anchor0Ms,
		anchor0Iso,
		digestAnchorIso,
		storeDir: STORE_DIR,
		projectDir: PROJECT_DIR,
		llamaWorkersAtStart: llamaWorkers(),
	});

	let tickSeq = 0;
	const seenBriefings = new Set();

	function captureDeterministicBaseline(tag) {
		const st = endo(["coordinator", "status", "--root", STORE_DIR, "--project", projectId]);
		const co = endo(["coordinator", "coordination", "--root", STORE_DIR, "--project", projectId]);
		saveEv(`baseline-${tag}-status.json`, st.json);
		saveEv(`baseline-${tag}-status.stderr.txt`, st.stderr);
		saveEv(`baseline-${tag}-coordination.json`, co.json);
		return { status: st.json, coordination: co.json };
	}

	function runTick(windowLabel, note) {
		tickSeq += 1;
		const nonAdvBefore = fingerprintDir(STORE_DIR, (p) => p.includes("/develop/automation/"));
		const projBefore = fingerprintDir(PROJECT_DIR, (p) => p.includes("/.git/"));
		const tRes = endo(["advisory", "tick", "--root", STORE_DIR]);
		const nonAdvAfter = fingerprintDir(STORE_DIR, (p) => p.includes("/develop/automation/"));
		const projAfter = fingerprintDir(PROJECT_DIR, (p) => p.includes("/.git/"));
		const nonAdvUnchanged = JSON.stringify(nonAdvBefore) === JSON.stringify(nonAdvAfter);
		const projUnchanged = JSON.stringify(projBefore) === JSON.stringify(projAfter);

		const bRes = endo(["advisory", "briefings", "--root", STORE_DIR, "--limit", "50"]);
		const pRes = endo(["advisory", "proposals", "--root", STORE_DIR, "--all", "--limit", "50"]);
		const newBriefings = (bRes.json?.briefings ?? []).filter((b) => !seenBriefings.has(b.turnId));
		for (const b of newBriefings) seenBriefings.add(b.turnId);

		const tag = `tick-${String(tickSeq).padStart(2, "0")}-${windowLabel}`;
		saveEv(`${tag}.json`, { tick: tRes.json, elapsedMs: tRes.elapsedMs, newBriefings, proposals: pRes.json });

		const outcomes = tRes.json?.tick?.outcomes ?? [];
		const outcomeSummary = outcomes.map((o) => `${o.scheduleId}:${o.status}${o.detail ? `(${o.detail})` : ""}`).join(", ") || "nothing-due";
		const b = newBriefings[0] ?? null;

		logObs({
			timestampUtc: iso(),
			window: windowLabel,
			event: "advisory-tick",
			tickSeq,
			note,
			endToEndLatencyMs: tRes.elapsedMs,
			inferenceDispatched: tRes.json?.tick?.inferenceDispatched ?? false,
			leaseEpoch: tRes.json?.tick?.leaseEpoch ?? null,
			outcomes,
			briefing: b
				? {
						turnId: b.turnId,
						scheduleId: b.scheduleId,
						wakeReason: b.wakeReason,
						availability: b.availability,
						refusal: b.refusal,
						currency: b.source?.currency ?? null,
						completeness: b.source?.completeness ?? null,
						gaps: b.source?.gaps ?? [],
						accounting: b.accounting,
						model: b.model,
						proposal: b.proposal,
						answer: b.answer,
					}
				: null,
			pendingProposalsCount: (pRes.json?.proposals ?? []).filter((p) => p.queueState === "pending").length,
			nonAdvisoryStoreUnchanged: nonAdvUnchanged,
			projectFilesUnchanged: projUnchanged,
			summary: `${outcomeSummary} | dispatched=${tRes.json?.tick?.inferenceDispatched} | ${tRes.elapsedMs}ms${b ? ` | avail=${b.availability}${b.refusal ? `(${b.refusal})` : ""} | tok=${b.accounting.chargedGeneratedTokens} | prop=${b.proposal.outcome}${b.proposal.refusal ? `(${b.proposal.refusal})` : ""}` : ""}`,
		});
		return { tick: tRes.json, newBriefings, proposals: pRes.json };
	}

	const winTime = (k) => anchor0Ms + k * 60_000 + 2000;

	// ---- W0 (T+0m): Initial state ----
	await waitUntil(winTime(0), "W0 initial observation");
	captureDeterministicBaseline("W0-initial");
	runTick("W0-initial", "First observation: 1 open task, no checks, clean HEAD");

	// ---- W1 (T+1m): Unchanged idle #1 ----
	await waitUntil(winTime(1), "W1 idle #1");
	runTick("W1-idle-1", "Unchanged state — expect skipped-unchanged, 0 inference");

	// ---- W2 (T+2m): Unchanged idle #2 ----
	await waitUntil(winTime(2), "W2 idle #2");
	runTick("W2-idle-2", "Unchanged state — expect skipped-unchanged, 0 inference");

	// ---- W3 (T+3m): Task state change (T1 -> blocked) ----
	await waitUntil(winTime(3) - 3000, "W3 mutation T1->blocked");
	const t1Block = endo([
		"task", "status", "--root", STORE_DIR, "--project", projectId,
		"--task", task1Id, "--to", "blocked", "--note", "Blocked awaiting upstream API spec confirmation",
	]);
	logObs({ timestampUtc: iso(), window: "W3-task-blocked", event: "mutation", summary: `T1 -> blocked (rev ${t1Block.json?.task?.revision})` });
	captureDeterministicBaseline("W3-task-blocked");
	await waitUntil(winTime(3), "W3 tick");
	const w3 = runTick("W3-task-blocked", "Task moved to blocked — expect state-changed + resolve-blocked-task proposal");

	// ---- W4 (T+4m): Unchanged idle #3 ----
	await waitUntil(winTime(4), "W4 idle #3");
	runTick("W4-idle-3", "Unchanged state after blocked — expect skipped-unchanged, 0 inference");

	// ---- W5 (T+4m35s digest, T+5m02s on-change): Digest window on unchanged state ----
	await waitUntil(anchor0Ms + 4 * 60_000 + 37_000, "W5 digest window (unchanged state)");
	runTick("W5-digest-1", "Digest window on unchanged state — expect ctrl-digest briefing-published");
	await waitUntil(winTime(5), "W5 on-change tick (unchanged state)");
	runTick("W5-idle-after-digest", "Unchanged state after digest — expect ctrl-on-change skipped-unchanged");

	// ---- W6 (T+6m): Verification FAIL at HEAD + T2 review + T1 unblocked (stale proposal test) ----
	await waitUntil(winTime(6) - 6000, "W6 mutations");
	const t1Unblock = endo([
		"task", "status", "--root", STORE_DIR, "--project", projectId,
		"--task", task1Id, "--to", "in-progress", "--note", "Spec confirmed; implementation resumed",
	]);
	const t2Add = endo(["task", "add", "--root", STORE_DIR, "--project", projectId, "--title", "Fix subtraction bug in calc.mjs"]);
	const task2Id = t2Add.json.task.id;
	endo(["task", "status", "--root", STORE_DIR, "--project", projectId, "--task", task2Id, "--to", "in-progress", "--note", "Started investigation"]);
	endo(["task", "status", "--root", STORE_DIR, "--project", projectId, "--task", task2Id, "--to", "review", "--note", "Ready for check review"]);
	const att1 = endo([
		"attempt", "prepare", "--root", STORE_DIR, "--project", projectId, "--task", task2Id,
		"--objective", "Verify calc.mjs unit test suite against current HEAD",
	]);
	const attempt1Id = att1.json.attempt.id;
	const failCheck = endo(
		["attempt", "check", "--root", STORE_DIR, "--attempt", attempt1Id, "--cwd", PROJECT_DIR, "--", "/usr/bin/node", "test.mjs"],
		{ allowNonZero: true },
	);
	saveEv("w6-failing-check.json", { exitCode: failCheck.exitCode, stdout: failCheck.stdout, stderr: failCheck.stderr });
	logObs({
		timestampUtc: iso(),
		window: "W6-verify-fail",
		event: "mutation",
		summary: `T1->in-progress (rev ${t1Unblock.json?.task?.revision}); T2(${task2Id})->review + attempt ${attempt1Id} FAIL receipt (exit ${failCheck.exitCode})`,
	});
	captureDeterministicBaseline("W6-verify-fail");
	await waitUntil(winTime(6), "W6 tick");
	const w6 = runTick("W6-verify-fail", "Failing receipt at HEAD + T2 in review + T1 unblocked");

	// ---- W7 (T+7m): Idle #4 + Operator ack of pending proposal ----
	await waitUntil(winTime(7), "W7 idle #4");
	runTick("W7-idle-4", "Unchanged state after W6 — expect skipped-unchanged, 0 inference");
	const propsBeforeAck = endo(["advisory", "proposals", "--root", STORE_DIR, "--all"]);
	const pendingProp = (propsBeforeAck.json?.proposals ?? []).find((p) => p.queueState === "pending" && p.currency === "current")
		?? (propsBeforeAck.json?.proposals ?? []).find((p) => p.queueState === "pending");
	if (pendingProp) {
		const nonAdvBeforeAck = fingerprintDir(STORE_DIR, (p) => p.includes("/develop/automation/"));
		const ackRes = endo([
			"advisory", "ack", "--root", STORE_DIR,
			"--proposal", pendingProp.proposal.proposalId,
			"--note", "Operator acknowledged during Phase C controlled validation",
		]);
		const nonAdvAfterAck = fingerprintDir(STORE_DIR, (p) => p.includes("/develop/automation/"));
		saveEv("w7-proposal-ack.json", {
			proposalId: pendingProp.proposal.proposalId,
			kind: pendingProp.proposal.kind,
			ack: ackRes.json,
			nonAdvisoryUnchanged: JSON.stringify(nonAdvBeforeAck) === JSON.stringify(nonAdvAfterAck),
		});
		logObs({
			timestampUtc: iso(),
			window: "W7-idle-4",
			event: "operator-ack",
			summary: `Acknowledged ${pendingProp.proposal.kind} (${pendingProp.proposal.proposalId.slice(0, 12)}…); nonAdvisoryUnchanged=${JSON.stringify(nonAdvBeforeAck) === JSON.stringify(nonAdvAfterAck)}`,
		});
	}

	// ---- W8 (T+8m): Coordination assignment + Git HEAD advance (prior FAIL becomes historical not-current) ----
	await waitUntil(winTime(8) - 6000, "W8 mutations");
	const t1Show = endo(["task", "show", "--root", STORE_DIR, "--project", projectId, "--task", task1Id]);
	const t1Rev = t1Show.json.task.revision;
	const assignRes = endo([
		"assign", "create", "--root", STORE_DIR,
		"--project", projectId, "--task", task1Id,
		"--participant", "worker-1", "--role", "builder", "--harness", "pi",
		"--worktree", PROJECT_DIR, "--access", "rw",
		"--revision", "0", "--task-revision", String(t1Rev),
	]);
	// Fix calc.mjs and commit -> advances HEAD so T2's prior failing receipt is now historical (not-current)
	writeFileSync(
		join(PROJECT_DIR, "calc.mjs"),
		"export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n",
	);
	git(["add", "calc.mjs"]);
	git(["commit", "-m", "fix: correct sub() implementation in calc.mjs"]);
	const fixedHead = git(["rev-parse", "HEAD"]);
	saveEv("w8-assign-and-commit.json", { assignment: assignRes.json, fixedHead });
	logObs({
		timestampUtc: iso(),
		window: "W8-coord-and-head",
		event: "mutation",
		summary: `Created assignment on T1 (rev ${t1Rev}) + fixed calc.mjs at HEAD ${fixedHead.slice(0, 12)} (prior FAIL receipt now not-current)`,
	});
	captureDeterministicBaseline("W8-coord-and-head");
	await waitUntil(winTime(8), "W8 tick");
	runTick("W8-coord-and-head", "Active coordination assignment + HEAD advanced (historical failure)");

	// ---- W9 (T+9m): Fresh controller-observed PASS receipt at new HEAD ----
	await waitUntil(winTime(9) - 5000, "W9 passing check");
	const passCheck = endo([
		"attempt", "check", "--root", STORE_DIR, "--attempt", attempt1Id, "--cwd", PROJECT_DIR, "--", "/usr/bin/node", "test.mjs",
	]);
	saveEv("w9-passing-check.json", { exitCode: passCheck.exitCode, stdout: passCheck.stdout, stderr: passCheck.stderr });
	logObs({
		timestampUtc: iso(),
		window: "W9-verify-pass",
		event: "mutation",
		summary: `Recorded PASS verification receipt on T2 at HEAD ${fixedHead.slice(0, 12)}`,
	});
	captureDeterministicBaseline("W9-verify-pass");
	await waitUntil(winTime(9), "W9 tick");
	runTick("W9-verify-pass", "Fresh controller-observed PASS at current HEAD");

	// ---- W10 (T+9m35s digest #2 + T+10m02s isolated non-disruptive outage test) ----
	await waitUntil(anchor0Ms + 9 * 60_000 + 37_000, "W10 digest window #2");
	runTick("W10-digest-2", "Digest window #2 on current verified state");
	await waitUntil(winTime(10) - 5000, "W10 add isolated outage schedule");
	const outageAnchorIso = isoSec(anchor0Ms + 10 * 60_000);
	endo([
		"advisory", "add", "--root", STORE_DIR,
		"--id", "ctrl-outage", "--project", projectId,
		"--action", "generate-advisory-brief", "--wake", "on-change",
		"--every", "1m", "--anchor", outageAnchorIso, "--missed-run", "skip-and-report",
		"--label", "Phase C isolated outage probe (127.0.0.1:18099)",
	]);
	endo(["advisory", "enable", "--root", STORE_DIR, "--id", "ctrl-outage", "--revision", "1"]);
	endo([
		"advisory", "authorize", "--root", STORE_DIR,
		"--id", "ctrl-outage", "--revision", "2",
		"--pool", POOL_OUTAGE,
		"--period", "2h", "--max-turns", "2", "--max-output-tokens", "2048",
		"--max-generated-tokens", "8192", "--turn-timeout", "60", "--expires-in", "2h",
		"--observation", "recorded-or-passive-probe",
		"--permit-capacity-unknown", "--permit-model-unconfirmed",
	]);
	await waitUntil(winTime(10), "W10 on-change + isolated outage ticks");
	runTick("W10-codue-1", "Tick 1 of 2 at T+10m (on-change + isolated outage)");
	runTick("W10-codue-2", "Tick 2 of 2 at T+10m (on-change + isolated outage)");

	// ---- W11 (T+11m): Post-outage repeat (verify skipped-already-attempted + skipped-unchanged) ----
	await waitUntil(winTime(11), "W11 post-outage repeat");
	runTick("W11-post-outage-1", "Post-outage tick 1 of 2 (expect skipped-unchanged / skipped-already-attempted)");
	runTick("W11-post-outage-2", "Post-outage tick 2 of 2 (expect skipped-unchanged / skipped-already-attempted)");

	// ---- Final audit, export, and revoke ----
	const finalList = endo(["advisory", "list", "--root", STORE_DIR]);
	const finalFires = endo(["advisory", "fires", "--root", STORE_DIR, "--limit", "100"]);
	const finalBriefings = endo(["advisory", "briefings", "--root", STORE_DIR, "--limit", "100"]);
	const finalProposals = endo(["advisory", "proposals", "--root", STORE_DIR, "--all", "--limit", "100"]);
	const routeFiles = walkFiles(STORE_DIR, () => false).filter((f) => f.endsWith(".route.json"));
	const gwAfter = gatewayInfo();

	saveEv("final-list.json", finalList.json);
	saveEv("final-fires.json", finalFires.json);
	saveEv("final-briefings.json", finalBriefings.json);
	saveEv("final-proposals.json", finalProposals.json);
	saveEv("gateway-after.txt", `${gwAfter}\n`);
	saveEv("final-audit.json", {
		routeFilesFound: routeFiles,
		gatewayUnchanged: gwBefore === gwAfter,
		llamaWorkersAtEnd: llamaWorkers(),
		totalBriefings: finalBriefings.json?.briefings?.length ?? 0,
		totalFires: finalFires.json?.fires?.length ?? 0,
		totalProposals: finalProposals.json?.proposals?.length ?? 0,
	});

	mkdirSync(join(EV_DIR, "raw-advisory"), { recursive: true });
	cpSync(join(STORE_DIR, "develop/automation/advisory"), join(EV_DIR, "raw-advisory"), { recursive: true });

	// Revoke all three schedules cleanly
	for (const id of ["ctrl-on-change", "ctrl-digest", "ctrl-outage"]) {
		endo(["advisory", "revoke", "--root", STORE_DIR, "--id", id]);
		endo(["advisory", "disable", "--root", STORE_DIR, "--id", id]);
	}

	logObs({
		timestampUtc: iso(),
		window: "COMPLETE",
		event: "phase-c-finished",
		summary: `Briefings=${finalBriefings.json?.briefings?.length}, Fires=${finalFires.json?.fires?.length}, Proposals=${finalProposals.json?.proposals?.length}, RouteFiles=${routeFiles.length}, GatewayUnchanged=${gwBefore === gwAfter}`,
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
