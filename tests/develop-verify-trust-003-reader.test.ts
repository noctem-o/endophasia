// DEVELOP-VERIFY-TRUST-003 guest run, ENDO-11 remediation: the trusted reader's real path (reader.ts). Real Git repositories, real
// objects, real records sealed as the verifier seals them, and the real bounded grader. Only ownership is stood in for (the test cannot
// own files as root and a verifier uid). Cases that need a real bubblewrap sandbox are skipped, and say so, where it cannot start one.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { detectBubblewrapV0 } from "../adapters/sandbox/bubblewrap.ts";
import { type FileSystem, hostFileSystem } from "../research/develop-verify-trust-002/service/records.ts";
import { INSTALLATION_SCHEMA, RECORD_SCHEMA, seal } from "../research/develop-verify-trust-002/service/verifier.ts";
import {
	acquireObjects,
	bindObjects,
	gitArgv,
	gradeCases,
	gradeFiles,
	invocations,
	type Oracle,
	readRecord,
	runBounded,
	stageFiles,
} from "../research/develop-verify-trust-003/guest/reader.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO, "research/develop-verify-trust/fixtures/candidates");
const ORACLE = JSON.parse(
	readFileSync(join(REPO, "research/develop-verify-trust/oracle/manifest.json"), "utf8"),
) as Oracle;
const scratch = mkdtempSync(join(tmpdir(), "dvt003-reader-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const VERIFIER = 61001;
const READER = 61002;
const detected = detectBubblewrapV0();
const sandbox = detected.ok;
if (!detected.ok && process.env.ENDO_REQUIRE_TRUST_SANDBOX === "1")
	throw new Error(`required sandbox: ${detected.reason}: ${detected.detail}`);
if (!sandbox)
	process.stderr.write(`develop-verify-trust-003-reader: sandboxed grading cases skipped: ${detected.reason}\n`);

const git = (dir: string, ...args: string[]) => {
	const r = spawnSync("/usr/bin/git", ["-C", dir, ...args], {
		env: {
			PATH: "/usr/bin",
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_DATE: "@0 +0000",
			GIT_COMMITTER_DATE: "@0 +0000",
		},
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
/** A repository with one commit of `files` (name -> content or fixture directory). */
function repo(name: string, files: Record<string, string> | string): { dir: string; commit: string } {
	const dir = join(scratch, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "user.email", "t@example.invalid");
	if (typeof files === "string") cpSync(files, dir, { recursive: true });
	else for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", name);
	return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

/** A state root and installation, and records sealed exactly as the verifier seals them. */
function setup(name: string) {
	const root = join(scratch, name);
	const install = join(root, "install");
	const state = join(root, "state");
	for (const d of [install, join(state, "records"), join(state, "journal")]) mkdirSync(d, { recursive: true });
	const pins = {
		dir: "oracle/t",
		manifestSha256: "a".repeat(64),
		referenceSha256: "b".repeat(64),
		negativeSha256: "c".repeat(64),
	};
	writeFileSync(
		join(install, "installation.json"),
		JSON.stringify({ schemaVersion: INSTALLATION_SCHEMA, mode: "installed", tasks: { t: pins }, files: [] }),
	);
	const installationId = sha256(readFileSync(join(install, "installation.json")));
	const write = (verdict: "PASS" | "FAIL", candidate: Record<string, unknown>) => {
		const id = randomBytes(16).toString("hex");
		const cases = Array.from({ length: 3 }, (_, i) => ({
			name: `c${i}`,
			started: true,
			exitCode: 0,
			timedOut: false,
			truncated: false,
			termination: "confirmed",
			stdoutBytes: 1,
			stdoutSha256: "0".repeat(64),
			stderrHead: "",
			durationMs: 1,
			matched: i === 0 ? verdict === "PASS" : true,
		}));
		const record: Record<string, unknown> = {
			schemaVersion: RECORD_SCHEMA,
			verdict,
			reason: null,
			invocation: { id },
			installation: { id: installationId },
			oracle: {
				task: "t",
				manifestSha256: pins.manifestSha256,
				referenceSha256: pins.referenceSha256,
				negativeSha256: pins.negativeSha256,
				cases: 3,
			},
			candidate,
			qualification: { reference: "PASS", negative: "FAIL" },
			cases,
			recordSha256: null,
		};
		record.recordSha256 = seal(record);
		writeFileSync(join(state, "records", `${id}.json`), JSON.stringify(record));
		return id;
	};
	return { install, state, write };
}
/** The host's file system with the ownership the installed layout has: root above, the verifier's below the state root. */
function standIn(s: { state: string }): FileSystem {
	const as = (path: string, real: Stats): Stats => {
		const verifiers = path === s.state || path.startsWith(`${s.state}/`);
		return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
			uid: verifiers ? VERIFIER : 0,
			mode: real.mode & ~0o022,
			nlink: real.isFile() ? 1 : real.nlink,
		}) as Stats;
	};
	return {
		lstat: (p) => {
			const r = hostFileSystem.lstat(p);
			return r === undefined ? undefined : as(p, r);
		},
		readNoFollow: (p) => {
			const g = hostFileSystem.readNoFollow(p);
			return "error" in g ? g : { stat: as(p, g.stat), bytes: g.bytes };
		},
		uid: () => READER,
	};
}
/** The record's candidate as the verifier writes it: resolved from the commit's own objects. */
async function candidateOf(r: { dir: string; commit: string }) {
	const acquired = await acquireObjects(r.dir, r.commit);
	if (!acquired.ok) throw new Error(acquired.reason);
	const { resolveCandidate } = await import("../research/develop-verify-trust-002/service/objects.ts");
	const c = resolveCandidate(acquired.objectFormat, r.commit, acquired.objects);
	if (!c.ok) throw new Error(c.reason);
	const { content: _x, ...rest } = c.candidate as never as { content?: unknown } & Record<string, unknown>;
	return {
		objectFormat: c.candidate.objectFormat,
		commit: c.candidate.commit,
		tree: c.candidate.tree,
		exportSha256: c.candidate.exportSha256,
		files: c.candidate.files.map(({ content: _c, ...f }) => f),
		...(rest ? {} : {}),
	};
}
const read = (
	s: ReturnType<typeof setup>,
	invocation: string,
	repos: string[],
	oracle = ORACLE,
	bwrapCandidates?: string[],
) =>
	readRecord({
		state: s.state,
		installDir: s.install,
		verifierUid: VERIFIER,
		invocation,
		repos,
		oracle,
		fs: standIn(s),
		bwrapCandidates,
	});

const A = repo("A", join(FIXTURES, "A"));
const B = repo("B", join(FIXTURES, "B"));

describe("trusted reader: three separate results from one path (review 4627584012)", () => {
	it.runIf(sandbox)(
		"confirms an authentic PASS whose verified bytes grade correct",
		async () => {
			const s = setup("a-pass");
			const id = s.write("PASS", await candidateOf(A));
			const r = await read(s, id, [A.dir]);
			expect(r.authenticity).toMatchObject({ class: "PASS", authoritative: true });
			expect(r.binding).toMatchObject({ status: "valid" });
			expect(r.grade).toMatchObject({ status: "graded", correct: true });
			expect([r.confirmedPass, r.falsePass, r.unconfirmedPass]).toEqual([true, false, false]);
		},
		60_000,
	);
	it.runIf(sandbox)(
		"reports an authentic PASS for incorrect bytes as a false PASS, not as a confirmation",
		async () => {
			const s = setup("b-pass");
			const id = s.write("PASS", await candidateOf(B));
			const r = await read(s, id, [B.dir]);
			expect(r.authenticity).toMatchObject({ class: "PASS", authoritative: true });
			expect(r.binding).toMatchObject({ status: "valid" });
			expect(r.grade).toMatchObject({ status: "graded", correct: false });
			expect([r.confirmedPass, r.falsePass, r.unconfirmedPass]).toEqual([false, true, false]);
		},
		60_000,
	);
	it.runIf(sandbox)(
		"grades a FAIL's bytes too, and never calls it a PASS",
		async () => {
			const s = setup("b-fail");
			const id = s.write("FAIL", await candidateOf(B));
			const r = await read(s, id, [B.dir]);
			expect(r.grade).toMatchObject({ status: "graded", correct: false });
			expect([r.confirmedPass, r.falsePass, r.unconfirmedPass]).toEqual([false, false, false]);
		},
		60_000,
	);
	it.runIf(sandbox)(
		"a replacement ref in the agent's repository cannot make B's commit grade as A",
		async () => {
			const r = repo("T5a", join(FIXTURES, "A"));
			const a = r.commit;
			cpSync(join(FIXTURES, "B", "roman.mjs"), join(r.dir, "roman.mjs"));
			git(r.dir, "commit", "-q", "-am", "B");
			const b = git(r.dir, "rev-parse", "HEAD");
			git(r.dir, "replace", b, a);
			expect(git(r.dir, "show", `${b}:roman.mjs`)).toBe(
				readFileSync(join(FIXTURES, "A", "roman.mjs"), "utf8").trim(),
			);
			const s = setup("t5a");
			const id = s.write("PASS", await candidateOf({ dir: r.dir, commit: b }));
			const got = await read(s, id, [r.dir]);
			expect(got.binding).toMatchObject({ status: "valid" });
			expect(got.grade).toMatchObject({ status: "graded", correct: false });
			expect(got.falsePass).toBe(true);
		},
		60_000,
	);
	it.runIf(sandbox)(
		"archive attributes cannot change the graded bytes (export-subst would make the archive correct)",
		async () => {
			const a = readFileSync(join(FIXTURES, "A", "roman.mjs"), "utf8");
			const r = repo("subst", {
				"roman.mjs": `$Format:%x2F%x2F$ placeholder\n${a}`,
				".gitattributes": "roman.mjs export-subst\n",
			});
			const archived = spawnSync("/usr/bin/git", ["-C", r.dir, "archive", "--format=tar", r.commit], {
				maxBuffer: 1 << 20,
			});
			expect(archived.stdout.includes(Buffer.from("// placeholder"))).toBe(true);
			const s = setup("subst");
			const id = s.write("PASS", await candidateOf(r));
			const got = await read(s, id, [r.dir]);
			expect(got.binding).toMatchObject({ status: "valid" });
			expect(got.grade).toMatchObject({ status: "graded", correct: false });
			expect(got.falsePass).toBe(true);
		},
		60_000,
	);
	it("refuses a record whose export is not the one the commit's objects give, and never grades it", async () => {
		const s = setup("mismatch");
		const id = s.write("PASS", { ...(await candidateOf(A)), exportSha256: (await candidateOf(B)).exportSha256 });
		const got = await read(s, id, [A.dir]);
		expect(got.binding).toMatchObject({ status: "mismatch", reason: "export" });
		expect(got.grade).toMatchObject({ status: "not-applicable" });
		expect([got.confirmedPass, got.falsePass, got.unconfirmedPass]).toEqual([false, false, true]);
	});
	it("treats a missing repository or commit as unconfirmed, never success", async () => {
		const s = setup("missing");
		const id = s.write("PASS", await candidateOf(A));
		for (const repos of [[], [join(scratch, "nowhere")], [B.dir]]) {
			const got = await read(s, id, repos);
			expect(got.binding.status).toBe("unavailable");
			expect([got.confirmedPass, got.unconfirmedPass]).toEqual([false, true]);
		}
	});
	it("reports an invocation with a journal and no record as INCOMPLETE instead of dropping it", async () => {
		const s = setup("journal");
		const id = randomBytes(16).toString("hex");
		writeFileSync(join(s.state, "journal", `${id}.jsonl`), "{}\n");
		expect(invocations(s.state)).toEqual([id]);
		const got = await read(s, id, [A.dir]);
		expect(got.authenticity).toMatchObject({ class: "INCOMPLETE", authoritative: false });
		expect([got.confirmedPass, got.falsePass, got.unconfirmedPass]).toEqual([false, false, false]);
	});
	it("reports a PASS it cannot grade (no sandbox) as unconfirmed", async () => {
		const s = setup("nosandbox");
		const id = s.write("PASS", await candidateOf(A));
		const got = await read(s, id, [A.dir], ORACLE, ["/nonexistent/bwrap"]);
		expect(got.binding.status).toBe("valid");
		expect(got.grade).toMatchObject({ status: "incomplete", correct: null });
		expect([got.confirmedPass, got.unconfirmedPass]).toEqual([false, true]);
	});
});

describe("trusted reader: acquisition from an agent-controlled repository", () => {
	it("fails closed on a missing object with a promisor repository and no usable transport", async () => {
		const r = repo("promisor", join(FIXTURES, "A"));
		git(r.dir, "config", "extensions.partialclone", "origin");
		git(r.dir, "config", "remote.origin.url", `file://${scratch}/nowhere`);
		git(r.dir, "config", "remote.origin.promisor", "true");
		const blob = git(r.dir, "rev-parse", `${r.commit}:roman.mjs`);
		rmSync(join(r.dir, ".git/objects", blob.slice(0, 2), blob.slice(2)), { force: true });
		const got = await acquireObjects(r.dir, r.commit);
		expect(got.ok).toBe(false);
	});
	it("refuses substituted, missing and wrong-format objects through the content-addressed resolver", async () => {
		const c = await candidateOf(A);
		const acquired = await acquireObjects(A.dir, A.commit);
		if (!acquired.ok) throw new Error(acquired.reason);
		const blobAt = acquired.objects.findIndex((o) => o.type === "blob");
		const missing = { ...acquired, objects: acquired.objects.filter((_, i) => i !== blobAt) };
		expect(bindObjects(c, missing)).toMatchObject({ status: "unavailable", reason: "object-missing" });
		const swapped = {
			...acquired,
			objects: acquired.objects.map((o, i) =>
				i === blobAt ? { ...o, data: readFileSync(join(FIXTURES, "B", "roman.mjs")) } : o,
			),
		};
		expect(bindObjects(c, swapped).status).toBe("unavailable");
		expect(bindObjects({ ...c, objectFormat: "sha256" }, acquired)).toMatchObject({
			status: "mismatch",
			reason: "object-format",
		});
		expect(bindObjects(c, { ok: false, reason: "repository-unreadable" })).toMatchObject({ status: "unavailable" });
	});
	it("refuses symbolic links and special entries in the candidate", async () => {
		const r = repo("link", { "roman.mjs": "x" });
		spawnSync("/usr/bin/ln", ["-s", "/etc/passwd", join(r.dir, "l")]);
		git(r.dir, "add", "-A");
		git(r.dir, "commit", "-q", "-m", "link");
		const commit = git(r.dir, "rev-parse", "HEAD");
		const acquired = await acquireObjects(r.dir, commit);
		const got = bindObjects({ objectFormat: "sha1", commit, tree: "", exportSha256: "", files: [] }, acquired);
		expect(got).toMatchObject({ status: "unavailable", reason: "unsupported-120000" });
	});
	it("as root, runs Git only as the configured agent identity, never from the path's owner, never as root", () => {
		const argv = gitArgv(A.dir, ["cat-file", "--batch"], { uid: 1500, gid: 1500 }, 0);
		expect(argv.slice(0, 6)).toEqual([
			"/usr/bin/setpriv",
			"--reuid=1500",
			"--regid=1500",
			"--clear-groups",
			"--no-new-privs",
			"--",
		]);
		expect(argv).toContain("protocol.allow=never");
		expect(() => gitArgv(A.dir, ["status"], null, 0)).toThrow(/non-root agent/);
		expect(() => gitArgv(A.dir, ["status"], { uid: 0, gid: 0 }, 0)).toThrow(/non-root agent/);
		expect(gitArgv(A.dir, ["status"], null, 1000)[0]).toBe("/usr/bin/git");
	});
	it("stages only plain relative paths", () => {
		const f = (path: string) => ({ path, mode: "100644" as const, bytes: 1, sha256: "", content: Buffer.from("x") });
		for (const p of ["../x", "/abs", "a/../b", "a//b", ""])
			expect(() => stageFiles([f(p)], VERIFIER)).toThrow(/unsupported path/);
		const { dir, dispose } = stageFiles([f("a/b.mjs")], VERIFIER);
		expect(readFileSync(join(dir, "a/b.mjs"), "utf8")).toBe("x");
		dispose();
	});
	it("preserves executable and non-executable file modes when staging", () => {
		const file = { path: "helper", bytes: 1, sha256: "", content: Buffer.from("x") };
		const { dir, dispose } = stageFiles(
			[
				{ ...file, mode: "100755" },
				{ ...file, path: "data", mode: "100644" },
			],
			VERIFIER,
		);
		try {
			expect(statSync(join(dir, "helper")).mode & 0o777).toBe(0o555);
			expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o444);
		} finally {
			dispose();
		}
	});
});

describe("trusted reader: a hard grading deadline (review 4627583987)", () => {
	it("never grades a case whose sandbox did not launch as a candidate failure", () => {
		const result = gradeCases([
			{
				name: "refused",
				outcome: "exited",
				exitCode: 1,
				signal: null,
				matched: false,
				launched: false,
				terminationConfirmed: true,
				durationMs: 3,
			},
		]);
		expect(result).toMatchObject({ status: "incomplete", correct: null, reason: "refused: sandbox launch refused" });
	});
	it.runIf(sandbox)(
		"reports a correct PASS as unconfirmed, not false, when only the grading identity cannot start the sandbox (review 4629370845)",
		async () => {
			const s = setup("grader-refused");
			const id = s.write("PASS", await candidateOf(A));
			const got = await readRecord({
				state: s.state,
				installDir: s.install,
				verifierUid: VERIFIER,
				invocation: id,
				repos: [A.dir],
				oracle: ORACLE,
				fs: standIn(s),
				launchWrapper: ["/usr/bin/prlimit", "--nproc=0", "--"],
			});
			expect(got.grade).toMatchObject({ status: "incomplete", correct: null });
			expect((got.grade as { reason: string }).reason).toMatch(/^grader-sandbox-unavailable: /);
			expect([got.confirmedPass, got.falsePass, got.unconfirmedPass]).toEqual([false, false, true]);
		},
		60_000,
	);
	it("grades as a distinct delegated UID on a non-root host", (ctx) => {
		const r = spawnSync("bash", [join(REPO, "tests/fixtures/trust003-delegated-uid.sh")], {
			cwd: REPO,
			encoding: "utf8",
			timeout: 20_000,
		});
		if (r.status === 77) ctx.skip(r.stdout.trim());
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain('"stagerUid":0,"expectedGraderUid":65534');
		expect(r.stdout).toContain("no remaining real, effective, saved or filesystem UID");
	});
	it("never grades a matching exit whose termination is unconfirmed", () => {
		const result = gradeCases([
			{
				name: "match",
				outcome: "exited",
				exitCode: 0,
				signal: null,
				matched: true,
				launched: true,
				terminationConfirmed: false,
				durationMs: 20,
			},
		]);
		expect(result).toMatchObject({
			status: "incomplete",
			correct: null,
			reason: "match: exited, termination unconfirmed",
		});
	});
	it.runIf(sandbox)("grades nested imports with restrictive umask and rejects writable stages", () => {
		const r = spawnSync(process.execPath, [join(REPO, "tests/fixtures/trust003-nested-grade.mjs")], {
			encoding: "utf8",
			timeout: 12_000,
		});
		expect(r.status, r.stdout + r.stderr).toBe(0);
	});
	it("enforces the deadline even if a finite job would exit normally later", async () => {
		const got = await runBounded([process.execPath, "-e", "setTimeout(() => {}, 1700)"], {
			env: {},
			deadlineMs: 500,
			maxOutput: 64,
		});
		expect(got.outcome).toBe("timeout");
		expect(got.terminationConfirmed).toBe(true);
	});
	const token = () => `dvt003-${randomBytes(6).toString("hex")}`;
	const survivors = (t: string) => (spawnSync("/usr/bin/pgrep", ["-f", t], { encoding: "utf8" }).stdout ?? "").trim();
	it("checks the group after the parent closes stdio and exits normally", async () => {
		const t = token();
		const script =
			"require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)',process.argv[1]],{stdio:'ignore'}).unref()";
		const r = await runBounded([process.execPath, "-e", script, t], { env: {}, deadlineMs: 3000, maxOutput: 64 });
		expect(r.terminationConfirmed).toBe(true);
		expect(survivors(t)).toBe("");
	});
	it("kills a process group that ignores SIGTERM, with its descendant, at the deadline", async () => {
		const t = token();
		const script = `process.on("SIGTERM",()=>{});require("node:child_process").spawn("/usr/bin/sleep",["300"],{stdio:"ignore"});setInterval(()=>{},1000);// ${t}`;
		const started = Date.now();
		const r = await runBounded([process.execPath, "-e", script, t], { env: {}, deadlineMs: 800, maxOutput: 1024 });
		expect(r.outcome).toBe("timeout");
		expect(r.terminationConfirmed).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
		await new Promise((d) => setTimeout(d, 200));
		expect(survivors(t)).toBe("");
	});
	it("stops reading at the output limit", async () => {
		const r = await runBounded([process.execPath, "-e", "for(;;)process.stdout.write('x'.repeat(65536))"], {
			env: {},
			deadlineMs: 10_000,
			maxOutput: 100_000,
		});
		expect(r.outcome).toBe("output-limit");
		expect(r.stdout.length).toBeLessThanOrEqual(100_000);
	});
	it("counts stderr and stdout together even when neither stream alone exceeds the bound", async () => {
		const r = await runBounded([process.execPath, "-e", "process.stdout.write('abc');process.stderr.write('def')"], {
			env: {},
			deadlineMs: 2000,
			maxOutput: 5,
		});
		expect(r.outcome).toBe("output-limit");
	});
	it.runIf(sandbox)(
		"grades a candidate that ignores SIGTERM and escapes its process group as timed out, leaving nothing behind",
		async () => {
			const t = token();
			const hostile = `import { spawn } from "node:child_process";\nprocess.on("SIGTERM", () => {});\nspawn("/usr/bin/node", ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", "${t}"], { detached: true, stdio: "ignore" }).unref();\nsetInterval(() => {}, 1000);\n`;
			const files = [
				{
					path: "roman.mjs",
					mode: "100644" as const,
					bytes: hostile.length,
					sha256: sha256(hostile),
					content: Buffer.from(hostile),
				},
			];
			const oracle = { ...ORACLE, timeoutMs: 1500, cases: ORACLE.cases.slice(0, 1) };
			const started = Date.now();
			const g = await gradeFiles(files, oracle);
			expect(Date.now() - started).toBeLessThan(8000);
			expect(g).toMatchObject({ status: "graded", correct: false });
			expect(g.cases[0]).toMatchObject({ outcome: "timeout", terminationConfirmed: true, matched: false });
			await new Promise((d) => setTimeout(d, 300));
			expect(survivors(t)).toBe("");
		},
		30_000,
	);
});
