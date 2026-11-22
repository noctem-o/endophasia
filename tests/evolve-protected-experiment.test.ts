// EVOLVE-INSPECT-001: Deterministic report-correctness, parity, and security regression tests
// for the read-only Protected Experiment Inspector (observer, HTTP routes, host containment, CLI args, wire gate).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	ProtectedExperimentObserverV0,
	resolveProtectedRunsRootV0,
} from "../adapters/protected-experiment/observer.ts";
import { reportProtectedExperimentV0 } from "../adapters/sandbox/protected-report.ts";
import { parseEndoStudioArgsV0 } from "../cli/studio.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import {
	ENDO_EVOLVE_EXPERIMENT_LIMITS_V0,
	ENDO_EVOLVE_PROTECTED_EXPERIMENTS_ABSENT_V0,
	validateEndoEvolveProtectedExperimentDetailV0,
	validateEndoEvolveProtectedExperimentsReplyV0,
} from "../protocol/protected-experiment-observation.ts";
import {
	readEvolveExperimentDetail,
	readEvolveExperimentsIndex,
} from "../studio-ui/src/model/protected-experiment-wire.ts";
import { removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import {
	createModelConnectedRunV1,
	createOfflineRichRunV0,
	createStagedRunV2,
	SECRET_HOST_AGENT_DIR,
	SECRET_HOST_EVALUATOR_FILE,
} from "./evolve-protected-fixtures.ts";

const rootBase = mkdtempSync(join(tmpdir(), "endo-evolve-inspect-test-"));
let seq = 0;
const freshDir = (name: string): string => {
	seq += 1;
	const dir = join(rootBase, `${name}-${seq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** Compute deterministic SHA-256 map of every regular file under `dir` to prove read-only immutability. */
function treeHashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (cur: string) => {
		for (const name of readdirSync(cur).sort()) {
			const full = join(cur, name);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (st.isFile()) {
				out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
			}
		}
	};
	walk(dir);
	return out;
}

afterEach(async () => {
	await stopServers();
});

afterAll(() => {
	rmSync(rootBase, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

describe("EVOLVE-INSPECT-001: report correctness & exact parity with reportProtectedExperimentV0", () => {
	it("1, 4, 5, 6: offline v0 run preserves passed, failed, timed-out pass, retries, not-attempted, missing and tampered records", () => {
		const runDir = freshDir("offline-v0");
		createOfflineRichRunV0(runDir);
		const before = treeHashes(runDir);

		const authoritative = reportProtectedExperimentV0(runDir);
		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const index = observer.list();
		expect(validateEndoEvolveProtectedExperimentsReplyV0(index)).not.toBeNull();
		expect(readEvolveExperimentsIndex(index)).not.toBeNull();
		expect(index.available).toBe(true);
		expect(index.runs).toHaveLength(1);

		const summary = index.runs[0]!;
		expect(summary.state).toBe("readable");
		expect(summary.label).toBe(".");
		expect(summary.runId).toBe("endo.experiment.offline-rich");
		expect(summary.experimentType).toBe("offline-fixed");
		expect(summary.evidenceAvailability).toBe("has-refusals");
		expect(summary.counts).toEqual({
			planned: 7,
			attempted: 6,
			notAttempted: 1,
			qualified: 4,
			passed: 3,
			failed: 1,
			attrition: 2,
			retries: 1,
			refusedRecords: 2,
		});

		const detail = observer.detail(summary.selector);
		expect(detail).not.toBeNull();
		expect(validateEndoEvolveProtectedExperimentDetailV0(detail)).not.toBeNull();
		expect(readEvolveExperimentDetail(detail)).not.toBeNull();

		// Exact parity with reportProtectedExperimentV0 cells and refusedRecords
		expect(detail!.cells).toEqual(authoritative.cells);
		expect(detail!.refusedRecords).toEqual(authoritative.refusedRecords);
		expect(detail!.rules).toEqual(authoritative.rules);

		// Per-trial distinctions
		expect(detail!.trials.map((t) => [t.position, t.outcome])).toEqual([
			[0, "passed"],
			[1, "failed"],
			[2, "passed"],
			[3, "passed"],
			[4, "not-attempted"],
			[5, "refused"],
			[6, "refused"],
		]);

		// pos 2 preserves distinction between evaluated candidate passing AND agent timing out afterward
		const timedOutPass = detail!.trials[2]!;
		expect(timedOutPass.finalAttempt?.evaluation?.status).toBe("passed");
		expect(timedOutPass.finalAttempt?.evaluation?.cases).toEqual({ total: 5, passed: 5 });
		expect(timedOutPass.finalAttempt?.agent?.status).toBe("timed-out");
		expect(timedOutPass.finalAttempt?.agent?.termination).toBe("confirmed");

		// pos 3 preserves retry chain (both attempt 1 and attempt 2 visible)
		const retried = detail!.trials[3]!;
		expect(retried.retryCount).toBe(1);
		expect(retried.attempts).toHaveLength(2);
		expect(retried.attempts[0]!.invalidating).toContain("controller-interrupted");
		expect(retried.attempts[1]!.retryOf).toBe(1);

		// pos 5 missing record and pos 6 tampered record stay visible and never look like passes
		expect(detail!.trials[5]!.finalAttempt?.recordStatus).toBe("missing");
		expect(detail!.trials[5]!.finalAttempt?.evaluation).toBeNull();
		expect(detail!.trials[6]!.finalAttempt?.recordStatus).toBe("refused");
		expect(detail!.trials[6]!.finalAttempt?.refusalReason).toContain("digest");

		// Zero mutation of source artifacts
		expect(treeHashes(runDir)).toEqual(before);
	});

	it("2: model-connected v1 run verifies capture logs independently and exposes modelAccess & below-minimum-exchanges", () => {
		const runDir = freshDir("model-v1");
		createModelConnectedRunV1(runDir);
		const before = treeHashes(runDir);

		const authoritative = reportProtectedExperimentV0(runDir);
		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(1);
		expect(index.runs[0]!.experimentType).toBe("model-connected-fixed");
		expect(index.runs[0]!.reportSchemaVersion).toBe("endo.protected-report.v1");

		const detail = observer.detail(index.runs[0]!.selector)!;
		expect(detail.cells).toEqual(authoritative.cells);
		expect(detail.modelAccess).not.toBeNull();
		expect(detail.modelAccess!.model).toBe("synthetic-local-model");
		expect(detail.modelAccess!.minExchanges).toBe(1);

		// Trial 0 passed with 2 verified exchanges; Trial 1 failed below minimum exchanges even though evaluator passed
		expect(detail.trials[0]!.outcome).toBe("passed");
		expect(detail.trials[0]!.finalAttempt?.modelRecording?.answeredVerified).toBe(2);
		expect(detail.trials[1]!.outcome).toBe("failed");
		expect(detail.trials[1]!.outcomeReason).toBe("model-exchanges-below-minimum");
		expect(detail.trials[1]!.finalAttempt?.evaluation?.status).toBe("passed");
		expect(detail.trials[1]!.finalAttempt?.modelRecording?.answeredVerified).toBe(0);

		// Zero secret / host path / digest-key leakage
		const serialized = JSON.stringify({ index, detail });
		expect(serialized).not.toContain(SECRET_HOST_AGENT_DIR);
		expect(serialized).not.toContain(SECRET_HOST_EVALUATOR_FILE);
		expect(serialized).not.toContain(runDir);
		expect(serialized).not.toContain("prompt 1");
		expect(treeHashes(runDir)).toEqual(before);
	});

	it("3 & 8: staged-changeset v2 run verifies valid candidate and refuses tampered changeset evidence", () => {
		const collection = freshDir("staged-collection");
		const validDir = join(collection, "run-valid");
		const tamperedDir = join(collection, "run-tampered");
		createStagedRunV2(validDir, { id: "endo.experiment.staged-ok" });
		createStagedRunV2(tamperedDir, { id: "endo.experiment.staged-tampered", tamperChangeset: true });

		const observer = new ProtectedExperimentObserverV0({ root: collection, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(2);

		const validSummary = index.runs.find((r) => r.label === "run-valid")!;
		const tamperedSummary = index.runs.find((r) => r.label === "run-tampered")!;

		expect(validSummary.counts?.passed).toBe(1);
		expect(validSummary.counts?.refusedRecords).toBe(0);
		const validDetail = observer.detail(validSummary.selector)!;
		expect(validDetail.cells).toEqual(reportProtectedExperimentV0(validDir).cells);
		const validSub = validDetail.trials[0]!.finalAttempt?.submission;
		expect(validSub?.mode).toBe("staged-changeset");
		if (validSub?.mode === "staged-changeset") {
			expect(validSub.verificationStatus).toBe("verified");
			expect(validSub.changedFileCount).toBe(1);
			expect(validSub.candidateSha256).toMatch(/^[0-9a-f]{64}$/);
		}

		// Tampered staged file must be caught on re-verification -> refused record, 0 passes!
		expect(tamperedSummary.counts?.passed).toBe(0);
		expect(tamperedSummary.counts?.refusedRecords).toBe(1);
		expect(tamperedSummary.evidenceAvailability).toBe("has-refusals");
		const tamperedDetail = observer.detail(tamperedSummary.selector)!;
		expect(tamperedDetail.cells).toEqual(reportProtectedExperimentV0(tamperedDir).cells);
		expect(tamperedDetail.trials[0]!.outcome).toBe("refused");
		expect(tamperedDetail.refusedRecords[0]!.reason).toContain("change set does not verify");
	});

	it("7: unsupported schema versions, corrupt JSON, and invalid records fail closed without hiding them", () => {
		const collection = freshDir("mixed-invalid");
		const unsupportedDir = join(collection, "run-v99");
		const corruptDir = join(collection, "run-corrupt");
		mkdirSync(unsupportedDir, { recursive: true });
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(
			join(unsupportedDir, "protected-run.json"),
			JSON.stringify({ schemaVersion: "endo.protected-run.v99" }),
		);
		writeFileSync(join(corruptDir, "protected-run.json"), "{not-json");

		const observer = new ProtectedExperimentObserverV0({ root: collection, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(2);

		const v99 = index.runs.find((r) => r.label === "run-v99")!;
		const corrupt = index.runs.find((r) => r.label === "run-corrupt")!;
		expect(v99.state).toBe("unsupported-version");
		expect(corrupt.state).toBe("invalid");
		expect(observer.detail(v99.selector)).toBeNull();
		expect(observer.detail(corrupt.selector)).toBeNull();
	});
});

describe("EVOLVE-INSPECT-001: security boundaries, symlink rejection, HTTP guards, CLI & host containment", () => {
	it("rejects symlinked run directories, symlinked protected-run.json, and symlinked trial records", () => {
		const outside = freshDir("outside-secret");
		createOfflineRichRunV0(outside, "endo.experiment.outside");
		const collection = freshDir("symlink-tests");

		// 1. Symlinked run directory escaping root -> skipped & counted
		symlinkSync(outside, join(collection, "escaped-run"));

		// 2. Plain run directory whose protected-run.json is a symlink -> unreadable
		const symRunFileDir = join(collection, "sym-run-file");
		mkdirSync(symRunFileDir, { recursive: true });
		symlinkSync(join(outside, "protected-run.json"), join(symRunFileDir, "protected-run.json"));

		// 3. Valid run whose trial record.json is replaced by a symlink -> refused record
		const symTrialDir = join(collection, "sym-trial");
		createStagedRunV2(symTrialDir, { id: "endo.experiment.sym-trial" });
		const recPath = join(symTrialDir, "trials", "staged-calc", "staged-agent", "0", "attempt-1", "record.json");
		rmSync(recPath);
		symlinkSync(join(outside, "protected-run.json"), recPath);

		const observer = new ProtectedExperimentObserverV0({ root: collection, key: OTHER_KEY });
		const index = observer.list();
		expect(index.skipped.links).toBe(1);
		expect(index.runs.find((r) => r.label === "escaped-run")).toBeUndefined();

		const symRunSummary = index.runs.find((r) => r.label === "sym-run-file")!;
		expect(symRunSummary.state).toBe("unreadable");
		expect(observer.detail(symRunSummary.selector)).toBeNull();

		const symTrialSummary = index.runs.find((r) => r.label === "sym-trial")!;
		expect(symTrialSummary.state).toBe("readable");
		expect(symTrialSummary.counts?.passed).toBe(0);
		expect(symTrialSummary.counts?.refusedRecords).toBe(1);
		const detail = observer.detail(symTrialSummary.selector)!;
		expect(detail.refusedRecords[0]!.reason).toContain("plain regular file");
	});

	it("bounds oversized collections safely", () => {
		const big = freshDir("bounded-collection");
		for (let i = 0; i < ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRuns + 4; i += 1) {
			const d = join(big, `run-${String(i).padStart(3, "0")}`);
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, "protected-run.json"), JSON.stringify({ schemaVersion: "endo.protected-run.v99" }));
		}
		const observer = new ProtectedExperimentObserverV0({ root: big, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRuns);
		expect(index.skipped.overLimit).toBe(4);
	});

	it("HTTP routes enforce GET-only, capability prefix, absent sentinel, traversal refusal, and selector invalidation on change", async () => {
		// 1. Unconfigured server returns fixed absent sentinel
		const store = tempRoot("endo-evolve-http-");
		const absentServer = await serve(store);
		const absRes = await get(absentServer, "/api/v0/evolve/experiments");
		expect(absRes.status).toBe(200);
		expect(JSON.parse(absRes.body)).toEqual(ENDO_EVOLVE_PROTECTED_EXPERIMENTS_ABSENT_V0);
		const absDetail = await get(absentServer, `/api/v0/evolve/experiment/e1-${"0".repeat(32)}`);
		expect(absDetail.status).toBe(404);
		await stopServers();

		// 2. Configured server
		const runDir = freshDir("http-run");
		createStagedRunV2(runDir, { id: "endo.experiment.http-ok" });
		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const server = await serve(store, { protectedRuns: observer });
		const cap = capabilityOf(server);

		const listRes = await get(server, "/api/v0/evolve/experiments");
		expect(listRes.status).toBe(200);
		const listed = JSON.parse(listRes.body);
		expect(listed.available).toBe(true);
		const selector = listed.runs[0].selector as string;

		const detailRes = await get(server, `/api/v0/evolve/experiment/${selector}`);
		expect(detailRes.status).toBe(200);
		expect(detailRes.body).not.toContain(runDir);
		expect(detailRes.body).not.toContain(SECRET_HOST_AGENT_DIR);
		expect(detailRes.body).not.toContain(SECRET_HOST_EVALUATOR_FILE);

		// POST/PUT/DELETE refused with 405
		for (const method of ["POST", "PUT", "DELETE"]) {
			const res = await send(server, `${cap}/api/v0/evolve/experiments`, { method });
			expect(res.status, method).toBe(405);
		}
		// Path traversal, query injection, wrong capability, bad Origin all refused
		expect((await get(server, "/api/v0/evolve/experiment/..%2f..%2fetc%2fpasswd")).status).toBe(404);
		expect((await get(server, "/api/v0/evolve/experiments?path=/etc/passwd")).status).toBe(400);
		expect((await send(server, "/wrong-cap/api/v0/evolve/experiments")).status).toBe(404);
		expect(
			(
				await get(server, "/api/v0/evolve/experiments", {
					Origin: "https://evil.example",
				})
			).status,
		).toBe(403);

		// Modifying protected-run.json invalidates the previously issued selector -> 404
		writeFileSync(join(runDir, "protected-run.json"), `${readFileSync(join(runDir, "protected-run.json"), "utf8")} `);
		expect((await get(server, `/api/v0/evolve/experiment/${selector}`)).status).toBe(404);
	});

	it("CLI parses --protected-runs cleanly and host refuses a cockpit key inside --protected-runs", async () => {
		const parsed = parseEndoStudioArgsV0(["/tmp/store", "--protected-runs", "/tmp/runs"]);
		expect(parsed).not.toBe("help");
		if (parsed !== "help") expect(parsed.protectedRuns).toBe("/tmp/runs");
		expect(() => parseEndoStudioArgsV0(["--protected-runs"])).toThrow(/needs a value/);
		expect(() => parseEndoStudioArgsV0(["--protected-runs", "a", "--protected-runs", "b"])).toThrow(/more than once/);
		expect(() => resolveProtectedRunsRootV0(join(rootBase, "does-not-exist"))).toThrow(/existing directory/);

		const runsDir = freshDir("key-inside-runs");
		// Minimal self-contained Studio UI manifest so this test never depends on a pre-built `studio-ui/dist`.
		const uiDir = freshDir("minimal-studio-ui");
		const html = Buffer.from("<!doctype html><html><body></body></html>", "utf8");
		writeFileSync(join(uiDir, "index.html"), html);
		writeFileSync(
			join(uiDir, "studio-ui.manifest.json"),
			JSON.stringify({
				format: "endo.studio-ui-manifest/v0",
				entry: "index.html",
				files: [
					{
						name: "index.html",
						bytes: html.length,
						sha256: createHash("sha256").update(html).digest("hex"),
					},
				],
			}),
		);
		await expect(
			launchEndoCockpitV0({
				root: tempRoot("endo-host-store-"),
				keyFile: join(runsDir, "cockpit-digest-key"),
				uiDirectory: uiDir,
				protectedRuns: {
					root: runsDir,
					open: (key) => new ProtectedExperimentObserverV0({ root: runsDir, key }),
				},
			}),
		).rejects.toThrow(/inside the protected runs directory/);
	});

	it("redacts host paths from verification refusal reasons when a capture store is damaged", () => {
		const runDir = freshDir("damaged-capture-redaction");
		createModelConnectedRunV1(runDir);
		// Remove capture dir so verifyModelEvidenceV0 / loadEndoCassetteV0 raises an error referencing storeRoot.
		rmSync(join(runDir, "trials", "model-task", "effort-low", "0", "attempt-1", "model", "store", "capture"), {
			recursive: true,
			force: true,
		});

		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(1);
		const detail = observer.detail(index.runs[0]!.selector);
		expect(detail).not.toBeNull();
		expect(detail!.refusedRecords.length).toBeGreaterThan(0);

		const wire = JSON.stringify(detail);
		expect(wire).not.toContain(runDir);
		expect(wire).not.toContain(rootBase);
		expect(wire).not.toContain("damaged-capture-redaction");
		expect(validateEndoEvolveProtectedExperimentDetailV0(detail)).not.toBeNull();
	});

	it("skips inaccessible subdirectories without aborting sibling run discovery or detail reads", () => {
		if (process.getuid?.() === 0) return; // root bypasses mode 0o000
		const collection = freshDir("inaccessible-sibling");
		createOfflineRichRunV0(join(collection, "readable-run"));
		const locked = join(collection, "locked-subdir");
		mkdirSync(locked, { recursive: true });
		chmodSync(locked, 0o000);
		try {
			const observer = new ProtectedExperimentObserverV0({ root: collection, key: OTHER_KEY });
			const index = observer.list();
			expect(index.runs).toHaveLength(1);
			expect(index.runs[0]!.label).toBe("readable-run");
			expect(index.skipped.unreadable).toBeGreaterThanOrEqual(1);
			const detail = observer.detail(index.runs[0]!.selector);
			expect(detail).not.toBeNull();
			expect(detail!.label).toBe("readable-run");
		} finally {
			chmodSync(locked, 0o700);
		}
	});

	it("counts only 2xx verified responses toward required model exchanges", () => {
		const runDir = freshDir("model-http-500");
		createModelConnectedRunV1(runDir, "endo.experiment.model-500", { responseStatus: 500 });

		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const index = observer.list();
		const detail = observer.detail(index.runs[0]!.selector);
		expect(detail).not.toBeNull();

		const trial0 = detail!.trials.find((t) => t.position === 0)!;
		expect(trial0.outcome).toBe("failed");
		expect(trial0.outcomeReason).toBe("model-exchanges-below-minimum");
		expect(trial0.finalAttempt?.modelRecording?.required).toBe(1);
		expect(trial0.finalAttempt?.modelRecording?.totalExchanges).toBe(2);
		expect(trial0.finalAttempt?.modelRecording?.answeredVerified).toBe(0);
	});

	it("rejects FIFO special files in nested capture logs without blocking synchronous inspection", () => {
		if (process.platform === "win32") return;
		const runDir = freshDir("fifo-capture-log");
		createModelConnectedRunV1(runDir);
		const logPath = join(
			runDir,
			"trials",
			"model-task",
			"effort-low",
			"0",
			"attempt-1",
			"model",
			"store",
			"capture",
			"events",
			"events.log",
		);
		rmSync(logPath, { force: true });
		const fifo = spawnSync("mkfifo", [logPath]);
		if (fifo.status !== 0) return;

		const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
		const index = observer.list();
		expect(index.runs).toHaveLength(1);
		const detail = observer.detail(index.runs[0]!.selector);
		expect(detail).not.toBeNull();
		expect(detail!.refusedRecords.length).toBeGreaterThan(0);
		expect(detail!.refusedRecords[0]!.reason).toMatch(/not a regular file|unusable/i);
		expect(JSON.stringify(detail)).not.toContain(runDir);
	});

	it("treats an inaccessible attempt directory as a refused record without invalidating sibling trials", () => {
		if (process.getuid?.() === 0) return; // root bypasses mode 0o000
		const runDir = freshDir("inaccessible-attempt-dir");
		createOfflineRichRunV0(runDir);
		const attemptDir = join(runDir, "trials", "calc-fix", "baseline", "0", "attempt-1");
		chmodSync(attemptDir, 0o000);
		try {
			const cliReport = reportProtectedExperimentV0(runDir);
			expect(cliReport.refusedRecords.some((r) => r.path.includes("0/attempt-1/record.json"))).toBe(true);

			const observer = new ProtectedExperimentObserverV0({ root: runDir, key: OTHER_KEY });
			const index = observer.list();
			expect(index.runs).toHaveLength(1);
			expect(index.runs[0]!.state).toBe("readable");

			const detail = observer.detail(index.runs[0]!.selector);
			expect(detail).not.toBeNull();
			const trial0 = detail!.trials.find((t) => t.position === 0)!;
			expect(trial0.outcome).toBe("refused");
			expect(trial0.outcomeReason).toMatch(/not readable/i);
			expect(cliReport.cells[0]!.attrition["record-refused"]).toBeGreaterThanOrEqual(1);
			// Readable sibling trials remain intact.
			const trial1 = detail!.trials.find((t) => t.position === 1)!;
			expect(trial1.outcome).toBe("failed");
			const trial2 = detail!.trials.find((t) => t.position === 2)!;
			expect(trial2.outcome).toBe("passed");
			expect(JSON.stringify(detail)).not.toContain(runDir);
		} finally {
			chmodSync(attemptDir, 0o700);
		}
	});
});
