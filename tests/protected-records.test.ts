// EVAL-ISO-001, application logic (no sandbox; runs everywhere): the evidence records and their independent reader, the strict spec, the
// submission collection policy on the host filesystem, and the unchanged behaviour of the historical runner and its readers.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { identityOfHostV0, preflightPassesV0 } from "../adapters/sandbox/preflight.ts";
import { endoSubmissionDigestV0, exportSubmissionV0 } from "../adapters/sandbox/submission.ts";
import { planEndoExperimentV0 } from "../cli/experiment.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentRunRecordFileV0,
	readEndoExperimentTrialResultFileV0,
} from "../cli/experiment-artifacts.ts";
import {
	type EndoProtectedTrialV0,
	endoProtectedTrialOutcomeV0,
	endoProtectedTrialQualifiesV0,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	checkEndoProtectedRunV0,
	checkEndoProtectedTrialV0,
	readEndoProtectedTrialFileV0,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";
import { writeAllSyncV0 } from "../runtime/contracts/write-all.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-protected-records-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const H = (c: string) => c.repeat(64);
const LIMITS = { maxFileBytes: 1024, maxTotalBytes: 2048 };

/** A complete, consistent trial record (as the controller writes for a passed attempt), unsealed. */
function passedRecord(): Omit<EndoProtectedTrialV0, "recordSha256"> {
	const files = [{ path: "src/a.mjs", bytes: 3, sha256: H("a") }];
	return {
		schemaVersion: "endo.protected-trial.v0",
		run: { id: "endo.experiment.t", specSha256: H("1"), seed: 1 },
		trial: { position: 0, task: "t", condition: "c", trial: 0, attempt: 1, retryOf: null },
		isolation: {
			mechanism: "bubblewrap",
			version: "0.13.1",
			executableSha256: H("2"),
			containment: { mechanism: "systemd-user-scope", version: "262", systemdRunSha256: H("9"), tasksMax: 512 },
			profileSha256: H("3"),
			requested: {
				namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
				network: "none",
				rootReadOnly: true,
				userNamespacesDisabled: true,
				environment: ["HOME", "PATH", "TMPDIR"],
				mounts: [
					{ target: "/usr/bin/node", kind: "ro-file", role: "runtime", sha256: H("4") },
					{ target: "/work", kind: "rw-dir", role: "workspace", sha256: null },
				],
			},
		},
		preflight: {
			status: "established",
			probes: [{ id: "net-external", passed: true, observed: "ENETUNREACH" }],
			reason: null,
		},
		network: { mode: "none", relay: null, status: "established" },
		agent: {
			status: "completed",
			exitCode: 0,
			signal: null,
			durationMs: 10,
			termination: "confirmed",
			outputSha256: H("5"),
			scope: { unit: `endo-sandbox-${"a".repeat(24)}`, established: true, ended: "confirmed" },
		},
		submission: { status: "collected", files, sha256: endoSubmissionDigestV0(files), refusals: [] },
		evaluation: {
			status: "passed",
			definitionSha256: H("6"),
			driverSha256: H("7"),
			cases: { total: 3, passed: 3 },
			reason: null,
			outputSha256: H("8"),
		},
		controller: { finalized: "normally" },
		invalidating: [],
		recordedAt: "2026-11-07T00:00:00.000Z",
	};
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("the protected-trial record and its independent reader", () => {
	it("reads a sealed record back exactly, and qualifies it", () => {
		const sealed = sealEndoProtectedTrialV0(passedRecord());
		const r = checkEndoProtectedTrialV0(clone(sealed));
		expect(r).toEqual({ ok: true, value: sealed });
		if (r.ok) expect(endoProtectedTrialQualifiesV0(r.value)).toBe(true);
	});

	it("refuses a tampered, truncated, unknown-version or extended record", () => {
		const sealed = sealEndoProtectedTrialV0(passedRecord());
		const tampered = clone(sealed);
		tampered.evaluation.cases = { total: 3, passed: 3 };
		tampered.agent.durationMs = 11;
		expect(checkEndoProtectedTrialV0(tampered)).toMatchObject({ ok: false, reason: expect.stringMatching(/digest/) });
		const manifest = clone(sealed);
		manifest.submission.files[0]!.sha256 = H("b");
		expect(checkEndoProtectedTrialV0(manifest).ok).toBe(false);
		const path = join(fresh("rec"), "record.json");
		writeFileSync(path, canonicalEndoJsonV0(sealed as never).slice(0, 200));
		expect(readEndoProtectedTrialFileV0(path)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/not readable JSON/),
		});
		expect(checkEndoProtectedTrialV0({ ...clone(sealed), schemaVersion: "endo.protected-trial.v9" })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/unsupported schemaVersion/),
		});
		expect(checkEndoProtectedTrialV0({ ...clone(sealed), verified: true })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/unknown field/),
		});
	});

	it("refuses a record whose facts contradict each other, even when it is sealed consistently", () => {
		const cases: [string, (r: ReturnType<typeof passedRecord>) => void, RegExp][] = [
			[
				"a result without a collected submission",
				(r) => {
					r.submission = {
						status: "missing",
						files: [],
						sha256: null,
						refusals: [{ path: "src/a.mjs", reason: "missing" }],
					};
				},
				/collected submission/,
			],
			[
				"an agent that ran without an established boundary",
				(r) => {
					r.preflight = {
						status: "failed",
						probes: [{ id: "net-external", passed: false, observed: "connected" }],
						reason: null,
					};
					r.network.status = "failed";
				},
				/without an established boundary/,
			],
			[
				"a pass that did not pass every case",
				(r) => {
					r.evaluation.cases = { total: 3, passed: 2 };
				},
				/every case/,
			],
			[
				"a collection before termination was confirmed",
				(r) => {
					r.agent.termination = "unconfirmed";
				},
				/termination was confirmed/,
			],
			[
				"an omitted invalidating condition",
				(r) => {
					r.evaluation = { ...r.evaluation, status: "could-not-run", cases: null, reason: "x" };
				},
				/invalidating is not what/,
			],
			[
				"an established boundary with a failed probe",
				(r) => {
					r.preflight.probes = [{ id: "net-external", passed: false, observed: "connected" }];
				},
				/every one passed/,
			],
			[
				"a confirmed termination whose scope was not confirmed ended",
				(r) => {
					r.agent.scope = { unit: `endo-sandbox-${"a".repeat(24)}`, established: true, ended: "unconfirmed" };
				},
				/scope confirmed ended/,
			],
			[
				"a confirmed termination with no scope at all (a pid observation alone)",
				(r) => {
					r.agent.scope = null;
				},
				/scope confirmed ended/,
			],
			[
				"a later attempt that names no earlier one",
				(r) => {
					r.trial.attempt = 2;
				},
				/later attempt/,
			],
			[
				"a model relay this version does not support",
				(r) => {
					(r.network as unknown as { relay: unknown }).relay = { socket: "/run/relay" };
				},
				/no relay/,
			],
		];
		for (const [name, change, why] of cases) {
			const r = passedRecord();
			change(r);
			expect(() => sealEndoProtectedTrialV0(r), name).toThrow(why);
		}
	});

	it("counts a missing or unacceptable submission as the agent's failure, and a disturbed collection as attrition", () => {
		const missing = passedRecord();
		missing.submission = {
			status: "missing",
			files: [],
			sha256: null,
			refusals: [{ path: "src/a.mjs", reason: "missing" }],
		};
		missing.evaluation = { ...missing.evaluation, status: "not-run", cases: null, outputSha256: null };
		const m = sealEndoProtectedTrialV0(missing);
		expect(m.invalidating).toEqual([]);
		expect(endoProtectedTrialOutcomeV0(m)).toEqual({ outcome: "failed", reason: "submission-missing" });
		expect(endoProtectedTrialQualifiesV0(m)).toBe(true);
		const linked = clone(missing);
		linked.submission = {
			...linked.submission,
			status: "refused",
			refusals: [{ path: "src/a.mjs", reason: "symbolic-link" }],
		};
		expect(endoProtectedTrialOutcomeV0(sealEndoProtectedTrialV0(linked))).toEqual({
			outcome: "failed",
			reason: "submission-symbolic-link",
		});
		const disturbed = clone(missing);
		disturbed.submission = {
			...disturbed.submission,
			status: "refused",
			refusals: [{ path: "src/a.mjs", reason: "changed-during-collection" }],
		};
		disturbed.invalidating = ["collection-disturbed"];
		expect(endoProtectedTrialOutcomeV0(sealEndoProtectedTrialV0(disturbed)).outcome).toBe("attrition");
	});

	it("never qualifies attrition, and keeps an interrupted record readable", () => {
		const r = passedRecord();
		r.agent = {
			status: "interrupted",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination: "confirmed",
			outputSha256: null,
			scope: { unit: `endo-sandbox-${"b".repeat(24)}`, established: false, ended: "confirmed" },
		};
		r.submission = { status: "not-collected", files: [], sha256: null, refusals: [] };
		r.evaluation = { ...r.evaluation, status: "not-run", cases: null, outputSha256: null };
		r.controller = { finalized: "on-resume" };
		r.invalidating = ["controller-interrupted", "agent-interrupted"];
		const sealed = sealEndoProtectedTrialV0(r);
		expect(endoProtectedTrialQualifiesV0(sealed)).toBe(false);
	});
});

describe("the protected spec is closed", () => {
	const spec = (): any => ({
		schemaVersion: "endo.protected-experiment-spec.v0",
		id: "endo.experiment.t",
		description: "t",
		seed: 1,
		trials: 1,
		limits: {
			agentTimeoutMs: 1000,
			evaluationTimeoutMs: 1000,
			outputBytes: 4096,
			tmpfsBytes: 1_048_576,
			maxFileBytes: 10,
			maxTotalBytes: 10,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "t",
				workspace: { "a.mjs": "" },
				submission: ["a.mjs"],
				evaluator: { file: "/x/e.json", sha256: H("a") },
			},
		],
		conditions: [
			{ id: "c", description: "c", agent: { directory: "/x/agent", argv: ["/usr/bin/node", "/agent/a.mjs"] } },
		],
	});
	it("accepts the shape and refuses sandbox flags, host paths, traversal and executables it does not declare", () => {
		expect(readEndoProtectedSpecV0(spec()).ok).toBe(true);
		const variants: [string, (s: any) => unknown][] = [
			["an extra field", (s) => ({ ...s, bwrapArgs: ["--share-net"] })],
			[
				"a relative evaluator",
				(s) => {
					s.tasks[0]!.evaluator.file = "e.json";
					return s;
				},
			],
			[
				"traversal in the evaluator path",
				(s) => {
					s.tasks[0]!.evaluator.file = "/x/../etc/e.json";
					return s;
				},
			],
			[
				"traversal in a workspace path",
				(s) => {
					s.tasks[0]!.workspace = { "../escape": "" };
					return s;
				},
			],
			[
				"an undeclared executable",
				(s) => {
					s.conditions[0]!.agent.argv = ["/bin/sh", "-c", "id"];
					return s;
				},
			],
			["a network setting", (s) => ({ ...s, network: "host" })],
			[
				"an unknown limit",
				(s) => {
					s.limits.memoryBytes = 1;
					return s;
				},
			],
		];
		for (const [name, change] of variants) expect(readEndoProtectedSpecV0(change(spec())).ok, name).toBe(false);
	});
});

describe("Codex review regressions", () => {
	it("keeps a workspace file named __proto__ (or constructor) as a file", () => {
		const raw = JSON.parse(
			'{"schemaVersion":"endo.protected-experiment-spec.v0","id":"endo.experiment.t","description":"t","seed":1,"trials":1,' +
				'"limits":{"agentTimeoutMs":1000,"evaluationTimeoutMs":1000,"outputBytes":4096,"tmpfsBytes":1048576,"maxFileBytes":10,"maxTotalBytes":10},' +
				'"runtime":{"executables":["/usr/bin/node"]},' +
				'"tasks":[{"id":"t","workspace":{"__proto__":"fixture","constructor":"other","a.mjs":""},"submission":["a.mjs"],"evaluator":{"file":"/x/e.json","sha256":"' +
				"a".repeat(64) +
				'"}}],' +
				'"conditions":[{"id":"c","description":"c","agent":{"directory":"/x/agent","argv":["/usr/bin/node","/agent/a.mjs"]}}]}',
		);
		const read = readEndoProtectedSpecV0(raw);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const ws = read.value.tasks[0]!.workspace;
		expect(Object.keys(ws).sort()).toEqual(["__proto__", "a.mjs", "constructor"]);
		expect(Object.getOwnPropertyDescriptor(ws, "__proto__")?.value).toBe("fixture");
		// And it is part of the digest the run records: removing it changes the canonical spec.
		const without = JSON.parse(JSON.stringify(raw).replace('"__proto__":"fixture",', ""));
		const other = readEndoProtectedSpecV0(without);
		expect(other.ok && canonicalEndoJsonV0(other.value as never) !== canonicalEndoJsonV0(read.value as never)).toBe(
			true,
		);
	});

	it("writes every byte through short writes, and refuses a write that makes no progress", () => {
		const out: number[] = [];
		const short = (_fd: number, b: Uint8Array, offset: number, length: number) => {
			const n = Math.min(3, length);
			out.push(...b.subarray(offset, offset + n));
			return n;
		};
		writeAllSyncV0(0, "a submission of some length", short);
		expect(Buffer.from(out).toString("utf8")).toBe("a submission of some length");
		expect(() => writeAllSyncV0(0, "x", () => 0)).toThrow(/no progress/);
	});

	it("judges the private /proc by PID namespace, not by comparing PID numbers across namespaces", () => {
		// The sandbox has its own PID 1, which may equal the controller's number (a controller running as PID 1 in a container).
		expect(preflightPassesV0("proc-private", "pids:2 pidns:own")).toBe(true);
		expect(preflightPassesV0("proc-private", "pids:2 pidns:controller")).toBe(false);
		expect(preflightPassesV0("proc-private", "pids:9 pidns:own")).toBe(false);
	});

	it("judges a protected path by the host object's identity, not by whether its name exists inside", () => {
		// Codex 4501423401: a controller whose home is /home/agent, or a checkout at /work, shares a name with the sandbox's own paths.
		expect(identityOfHostV0("ok:41:7", "41:7")).toBe("host-object");
		expect(identityOfHostV0("ok:12:7", "41:7")).toBe("other-object");
		expect(identityOfHostV0("ok:41:8", "41:7")).toBe("other-object");
		expect(identityOfHostV0("ok:41:7", null)).toBe("unknown-object");
		expect(identityOfHostV0("ok", "41:7")).toBe("unknown-object");
		expect(identityOfHostV0("ENOENT", "41:7")).toBe("ENOENT");
		expect(preflightPassesV0("fs-hidden-host-home", "ENOENT")).toBe(true);
		expect(preflightPassesV0("fs-hidden-host-home", "other-object")).toBe(true);
		for (const o of ["host-object", "unknown-object", "EACCES", "ok", "ok:41:7"])
			expect(preflightPassesV0("fs-hidden-host-home", o)).toBe(false);
		// The canary and host sockets are still judged by absence alone.
		expect(preflightPassesV0("fs-canary-read", "other-object")).toBe(false);
	});
});

describe("submission collection on the host filesystem", () => {
	const ws = () => {
		const w = fresh("ws");
		mkdirSync(join(w, "src"));
		writeFileSync(join(w, "src", "a.mjs"), "aaa");
		writeFileSync(join(w, "README.md"), "r");
		return w;
	};
	it("copies exactly the declared regular files into a new staging directory, with their digests", () => {
		const w = ws();
		writeFileSync(join(w, "src", "extra.mjs"), "not declared");
		const staging = join(fresh("st"), "copy");
		const got = exportSubmissionV0(w, ["src/a.mjs"], LIMITS, staging);
		expect(got).toMatchObject({ status: "collected", files: [{ path: "src/a.mjs", bytes: 3 }] });
		expect(readFileSync(join(staging, "src", "a.mjs"), "utf8")).toBe("aaa");
		expect(existsSync(join(staging, "src", "extra.mjs"))).toBe(false);
		expect(got.files[0]?.sha256).toBe(createHash("sha256").update("aaa").digest("hex"));
		expect(got.sha256).toBe(endoSubmissionDigestV0(got.files));
		// The staging directory is the collector's own: an existing one is never reused.
		expect(() => exportSubmissionV0(w, ["src/a.mjs"], LIMITS, staging)).toThrow();
	});
	it("refuses links, special files, traversal, oversize and a file changed while it is read", () => {
		const cases: [string, (w: string) => void, string, string?][] = [
			[
				"a symbolic link",
				(w) => {
					rmSync(join(w, "src", "a.mjs"));
					symlinkSync("/etc/passwd", join(w, "src", "a.mjs"));
				},
				"symbolic-link",
			],
			[
				"a linked directory",
				(w) => {
					rmSync(join(w, "src"), { recursive: true });
					symlinkSync("/etc", join(w, "src"));
				},
				"symbolic-link",
			],
			[
				"a hard link",
				(w) => {
					rmSync(join(w, "src", "a.mjs"));
					linkSync(join(w, "README.md"), join(w, "src", "a.mjs"));
				},
				"hard-link",
			],
			[
				"a directory",
				(w) => {
					rmSync(join(w, "src", "a.mjs"));
					mkdirSync(join(w, "src", "a.mjs"));
				},
				"not-a-regular-file",
			],
			["an oversized file", (w) => writeFileSync(join(w, "src", "a.mjs"), Buffer.alloc(2000)), "too-large"],
			["a missing file", (w) => rmSync(join(w, "src", "a.mjs")), "missing"],
		];
		for (const [name, attack, reason] of cases) {
			const w = ws();
			attack(w);
			const staging = join(fresh("st"), "copy");
			const got = exportSubmissionV0(w, ["src/a.mjs"], LIMITS, staging);
			expect(got.refusals, name).toEqual([{ path: "src/a.mjs", reason }]);
			expect(got.sha256, name).toBeNull();
			expect(existsSync(staging), name).toBe(false);
		}
		for (const path of ["../escape", "/etc/passwd", "src/../../x", "./src/a.mjs"])
			expect(exportSubmissionV0(ws(), [path], LIMITS, join(fresh("st"), "c")).refusals, path).toEqual([
				{ path, reason: "unsafe-path" },
			]);
		const w = ws();
		const changed = exportSubmissionV0(w, ["src/a.mjs"], LIMITS, join(fresh("st"), "c"), {
			afterOpen: () => writeFileSync(join(w, "src", "a.mjs"), "changed while reading"),
		});
		expect(changed.refusals).toEqual([{ path: "src/a.mjs", reason: "changed-during-collection" }]);
		// Each file within its bound, together over the total.
		const two = ws();
		for (const name of ["a", "b", "c"]) writeFileSync(join(two, "src", `${name}.mjs`), Buffer.alloc(1000));
		expect(
			exportSubmissionV0(two, ["src/a.mjs", "src/b.mjs", "src/c.mjs"], LIMITS, join(fresh("st"), "c")).refusals,
		).toEqual([{ path: "src/c.mjs", reason: "total-too-large" }]);
	});
	it("refuses what the agent can cause while reading, and propagates what the host causes (EIO, EMFILE)", () => {
		const fail = (code: string) => () => {
			throw Object.assign(new Error(code), { code });
		};
		const w = ws();
		expect(
			exportSubmissionV0(w, ["src/a.mjs"], LIMITS, join(fresh("st"), "c"), { afterOpen: fail("EACCES") }).refusals,
		).toEqual([{ path: "src/a.mjs", reason: "unreadable" }]);
		for (const code of ["EIO", "EMFILE"])
			expect(
				() => exportSubmissionV0(ws(), ["src/a.mjs"], LIMITS, join(fresh("st"), "c"), { afterOpen: fail(code) }),
				code,
			).toThrow(code);
	});

	it.runIf(spawnSync("/usr/bin/mkfifo", ["--version"]).status === 0)("refuses a FIFO without blocking on it", () => {
		const w = ws();
		rmSync(join(w, "src", "a.mjs"));
		spawnSync("/usr/bin/mkfifo", [join(w, "src", "a.mjs")]);
		expect(exportSubmissionV0(w, ["src/a.mjs"], LIMITS, join(fresh("st"), "c")).refusals).toEqual([
			{ path: "src/a.mjs", reason: "not-a-regular-file" },
		]);
	});
});

describe("the historical runner and its records are unchanged", () => {
	const RUN = fileURLToPath(new URL("../research/path-sensitivity/1.0.1/pilot/pilot-1", import.meta.url));
	it("plans a committed run's spec and seed to exactly its committed plan (the protected runner uses the same planner)", () => {
		const run = readEndoExperimentRunRecordFileV0(RUN);
		const plan = readEndoExperimentPlanFileV0(RUN).plan;
		expect(planEndoExperimentV0(run.spec, run.seed)).toEqual(plan.order);
	});
	it("still reads committed v0 trial records as they are, and the protected readers refuse them", () => {
		const trial = readEndoExperimentTrialResultFileV0(join(RUN, "trials", "tool-use", "base", "0", "result.json"));
		expect(trial.schemaVersion).toBe("endo.experiment-trial.v0");
		expect(checkEndoProtectedTrialV0(trial).ok).toBe(false);
		expect(checkEndoProtectedRunV0(readEndoExperimentRunRecordFileV0(RUN)).ok).toBe(false);
	});
});
