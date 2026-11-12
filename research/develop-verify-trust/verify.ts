// DEVELOP-VERIFY-TRUST-001: the controlled verifier (research only; PROTOCOL.md §2, §4, §7). Not a product path, and not imported by one.
//
// It verifies one committed Node.js command-line program against a frozen, digest-pinned oracle of argv cases (exact exit code and
// standard output), by one of two mechanisms that share everything else:
//   sandbox   (option C) each case in its own Bubblewrap sandbox in a systemd user scope, through the protected-evaluation parts as they
//             are: detectBubblewrapV0, detectContainmentV0, resolveRuntimeV0, buildSandboxProfileV0, runSandboxV0, preflightV0.
//   filtered  (option B) each case through the ordinary check runner (runCheckV0) on the host, with a rebuilt environment and the pinned
//             runtime, in a fresh copy of the export. No isolation.
// The candidate is read from Git objects at the named commit, never from a working tree. Expected results stay in this process. The
// verdict needs qualification first: the oracle's reference must PASS and its negative must FAIL, by the same mechanism.
//
//   node verify.ts run --mechanism sandbox|filtered --oracle <manifest.json> --oracle-sha256 <hex> --repo <dir> --commit <sha>
//                      --out <record.json> [--bwrap <path>] [--systemd-run <path>] [--node <path>]
//   node verify.ts read <record.json> --oracle <manifest.json> --oracle-sha256 <hex> [--commit <sha>]
//
// The three path options exist only to exercise refusals (case 7): they can make a run BLOCKED, never weaker. Run it through run.sh,
// which gives it an environment it builds rather than the caller's.
//
// Addendum 1 (addendum-1/ADDENDUM.md), after the recorded runs, which used this file as frozen at 9c8b6ff79:
//   C1  Git reads the candidate's objects with replace objects and lazy fetches off. A candidate repository's `refs/replace` made
//       "commit X" export another commit's tree, and its partial-clone configuration made `cat-file` run a command of its choosing in
//       this process. Neither occurred in the recorded runs (their repositories had no replace refs and no promisor remote).
//   C2  `read --commit <sha>` binds a record to the commit it is read for. Without it, a genuine PASS for one commit reads PASS when
//       presented for another.
// Addendum 1, version 1.1 (the independent review of the draft PR):
//   C3  A new run removes any earlier record at --out before it writes its journal, so an interrupted retry reads INCOMPLETE, never the
//       earlier verdict.
//   C4  The sandbox applies F's output budget: standard output and standard error together, at most maxOutputBytes.
//   C5  The reader classifies a record that parses to anything but an object as UNKNOWN instead of throwing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runCheckV0 } from "../../adapters/develop/check-runner.ts";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	type EndoBubblewrapV0,
	type EndoRuntimeFileV0,
	type EndoSandboxProfileV0,
	endoTreeDigestV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, type EndoContainmentV0 } from "../../adapters/sandbox/containment.ts";
import { type EndoPreflightV0, preflightV0 } from "../../adapters/sandbox/preflight.ts";
import { endoSubmissionDigestV0, exportSubmissionV0 } from "../../adapters/sandbox/submission.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

export const RECORD_SCHEMA = "endo.research.trust-verification.v0";
const ORACLE_SCHEMA = "endo.research.trust-oracle.v0";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, "../..");
/** Variables that load code into this process or change how its runtime links. Seen here, they refuse the run (defence in depth). */
const HOSTILE = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"] as const;
const GIT = "/usr/bin/git";
const BOUNDS = { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 4 << 20 };
const TMPFS_BYTES = 16 << 20;
const PLAIN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,200}$/;

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";
export type ReadClass = Verdict | "UNKNOWN";
type Mechanism = "sandbox" | "filtered";

export interface OracleCase {
	name: string;
	visible: boolean;
	argv: string[];
	expect: { exitCode: number; stdout: string };
}
export interface Oracle {
	schemaVersion: string;
	task: string;
	timeoutMs: number;
	maxOutputBytes: number;
	reference: string;
	negative: string;
	cases: OracleCase[];
}

/** What was observed of one case. `matched` is the controller's comparison; the reader recomputes it. */
export interface Observation {
	name: string;
	started: boolean;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	termination: "confirmed" | "unconfirmed";
	stdoutBytes: number;
	stdoutSha256: string | null;
	/** The first bytes of standard error, at most 256, for the reader's orientation only. Never compared. */
	stderrHead: string;
	durationMs: number;
	matched: boolean;
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** The controller's byte comparison: one place, so that case 4c can show what code in this process decides. */
const sameBytes = (a: Buffer, b: Buffer): boolean => a.equals(b);

// ---- the oracle -----------------------------------------------------------------------------------------------------------------------

export function loadOracle(
	file: string,
	pinned: string,
): { ok: true; oracle: Oracle; sha256: string } | { ok: false; reason: string } {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return { ok: false, reason: "oracle-unreadable" };
	}
	const digest = sha256(bytes);
	if (!/^[0-9a-f]{64}$/.test(pinned) || digest !== pinned) return { ok: false, reason: "oracle-not-pinned" };
	let o: Oracle;
	try {
		o = JSON.parse(bytes.toString("utf8")) as Oracle;
	} catch {
		return { ok: false, reason: "oracle-unreadable" };
	}
	const good =
		o.schemaVersion === ORACLE_SCHEMA &&
		Number.isSafeInteger(o.timeoutMs) &&
		o.timeoutMs >= 100 &&
		o.timeoutMs <= 60_000 &&
		Number.isSafeInteger(o.maxOutputBytes) &&
		o.maxOutputBytes > 0 &&
		o.maxOutputBytes <= 1 << 20 &&
		PLAIN.test(o.reference) &&
		PLAIN.test(o.negative) &&
		Array.isArray(o.cases) &&
		o.cases.length > 0 &&
		o.cases.length <= 64 &&
		new Set(o.cases.map((c) => c.name)).size === o.cases.length &&
		o.cases.every(
			(c) =>
				typeof c.name === "string" &&
				typeof c.visible === "boolean" &&
				Array.isArray(c.argv) &&
				c.argv[0] === "node" &&
				c.argv.length >= 2 &&
				c.argv.every((a) => typeof a === "string" && !a.includes("\0")) &&
				Number.isSafeInteger(c.expect?.exitCode) &&
				c.expect.exitCode >= 0 &&
				c.expect.exitCode <= 255 &&
				typeof c.expect.stdout === "string" &&
				Buffer.byteLength(c.expect.stdout) < o.maxOutputBytes,
		);
	return good ? { ok: true, oracle: o, sha256: digest } : { ok: false, reason: "oracle-invalid" };
}

// ---- the candidate, from Git objects -------------------------------------------------------------------------------------------------

/** A root-owned regular file that no one else can write, in root-owned directories (the rule bubblewrap.ts applies to its runtime). */
function trustedTool(path: string): boolean {
	const s = lstatSync(path, { throwIfNoEntry: false });
	if (s === undefined || !s.isFile() || s.uid !== 0 || (s.mode & 0o022) !== 0) return false;
	for (let d = dirname(path); ; d = dirname(d)) {
		const ds = lstatSync(d);
		if (ds.uid !== 0 || (ds.mode & 0o022) !== 0) return false;
		if (d === "/") return true;
	}
}

const gitEnv = (): Record<string, string> => ({
	PATH: "/usr/bin",
	HOME: "/nonexistent",
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	// Addendum 1, C1: as adapters/git/readonly-git.ts does. The repository is the candidate's, so its configuration is untrusted.
	GIT_NO_REPLACE_OBJECTS: "1",
	GIT_NO_LAZY_FETCH: "1",
	GIT_OPTIONAL_LOCKS: "0",
});
const git = (repo: string, args: string[], maxBuffer = 1 << 20) =>
	spawnSync(GIT, ["-C", repo, ...args], { env: gitEnv(), maxBuffer, timeout: 20_000 });

export interface CandidateExport {
	commit: string;
	tree: string;
	files: { path: string; bytes: number; sha256: string; mode: string }[];
	sha256: string;
}

/** Every file of `commit`, written read-only into `staging` (which must not exist). Refuses anything but regular files within bounds. */
export function exportCommit(
	repo: string,
	commit: string,
	staging: string,
): { ok: true; candidate: CandidateExport } | { ok: false; reason: string } {
	if (!trustedTool(GIT)) return { ok: false, reason: "git-untrusted" };
	if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return { ok: false, reason: "commit-invalid" };
	const resolved = git(repo, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]);
	if (resolved.status !== 0 || resolved.stdout.toString().trim() !== commit)
		return { ok: false, reason: "commit-unreadable" };
	const tree = git(repo, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
	if (tree.status !== 0) return { ok: false, reason: "commit-unreadable" };
	const list = git(repo, ["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", commit]);
	if (list.status !== 0) return { ok: false, reason: "commit-unreadable" };
	const entries = list.stdout
		.toString("utf8")
		.split("\0")
		.filter((e) => e !== "");
	if (entries.length === 0 || entries.length > BOUNDS.maxFiles) return { ok: false, reason: "unsupported-tree-size" };
	const files: CandidateExport["files"] = [];
	const content: Buffer[] = [];
	let total = 0;
	for (const entry of entries) {
		const m = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(entry);
		if (m === null) return { ok: false, reason: "unsupported-tree-entry" };
		const [, mode, type, oid, path] = m as unknown as [string, string, string, string, string];
		if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
			return { ok: false, reason: `unsupported-${mode}` };
		if (!PLAIN.test(path)) return { ok: false, reason: "unsupported-path" };
		const blob = git(repo, ["cat-file", "blob", oid], BOUNDS.maxFileBytes + 1);
		if (blob.status !== 0) return { ok: false, reason: "object-unreadable" };
		if (blob.stdout.length > BOUNDS.maxFileBytes) return { ok: false, reason: "unsupported-file-size" };
		// The object id, recomputed from the bytes: what is exported is what the commit names.
		const algorithm = oid.length === 40 ? "sha1" : "sha256";
		const id = createHash(algorithm)
			.update(Buffer.concat([Buffer.from(`blob ${blob.stdout.length}\0`), blob.stdout]))
			.digest("hex");
		if (id !== oid) return { ok: false, reason: "object-mismatch" };
		total += blob.stdout.length;
		if (total > BOUNDS.maxTotalBytes) return { ok: false, reason: "unsupported-tree-size" };
		files.push({ path, bytes: blob.stdout.length, sha256: sha256(blob.stdout), mode });
		content.push(blob.stdout);
	}
	mkdirSync(staging, { mode: 0o700 });
	files.forEach((f, i) => {
		const target = join(staging, f.path);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, content[i] as Buffer, { flag: "wx", mode: 0o600 });
		chmodSync(target, f.mode === "100755" ? 0o555 : 0o444);
	});
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
	return {
		ok: true,
		candidate: { commit, tree: tree.stdout.toString().trim(), files: sorted, sha256: endoSubmissionDigestV0(sorted) },
	};
}

// ---- running the cases -----------------------------------------------------------------------------------------------------------------

interface Context {
	mechanism: Mechanism;
	oracle: Oracle;
	node: string;
	runtime: readonly EndoRuntimeFileV0[];
	bwrap: EndoBubblewrapV0 | null;
	containment: EndoContainmentV0 | null;
	work: string;
	journal: (event: Record<string, unknown>) => void;
}

const SANDBOX_ENV = { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" };
const FILTERED_ENV_NAMES = ["HOME", "LANG", "PATH", "TMPDIR"];

function sandboxProfile(ctx: Context, tree: string): EndoSandboxProfileV0 {
	return buildSandboxProfileV0({
		runtime: ctx.runtime,
		mounts: [
			{
				target: "/submission",
				kind: "ro-dir",
				role: "candidate-export",
				source: tree,
				sha256: endoTreeDigestV0(tree),
			},
		],
		env: SANDBOX_ENV,
		cwd: "/submission",
		tmpfsBytes: TMPFS_BYTES,
	});
}

const discard = () =>
	new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});

async function runCase(ctx: Context, tree: string, c: OracleCase, phase: string, index: number): Promise<Observation> {
	const expected = Buffer.from(c.expect.stdout, "utf8");
	const args = c.argv.slice(1);
	let o: Omit<Observation, "matched" | "name">;
	let stdout: Buffer;
	if (ctx.mechanism === "sandbox") {
		const run = await runSandboxV0(ctx.bwrap as EndoBubblewrapV0, sandboxProfile(ctx, tree), [ctx.node, ...args], {
			timeoutMs: ctx.oracle.timeoutMs,
			outputBytes: ctx.oracle.maxOutputBytes,
			containment: ctx.containment as EndoContainmentV0,
			onScope: (unit) => ctx.journal({ event: "scope", phase, case: c.name, unit }),
		});
		stdout = run.stdout;
		// Addendum 1, C4: one budget for both streams, as runCheckV0 enforces it under F.
		const total = run.stdout.length + run.truncated.stdout + run.stderr.length + run.truncated.stderr;
		const truncated = run.truncated.stdout > 0 || run.truncated.stderr > 0 || total > ctx.oracle.maxOutputBytes;
		o = {
			started: run.started,
			exitCode: run.timedOut ? null : run.exitCode,
			timedOut: run.timedOut,
			truncated,
			termination: run.termination,
			stdoutBytes: run.stdout.length + run.truncated.stdout,
			stdoutSha256: truncated ? null : sha256(run.stdout),
			stderrHead: run.stderr.subarray(0, 256).toString("utf8"),
			durationMs: run.durationMs,
		};
	} else {
		// A fresh copy of the export, home and temporary directory per case: the candidate runs as this user and could change its own copy.
		const base = join(ctx.work, `${phase}-${index}`);
		const copy = join(base, "tree");
		mkdirSync(base, { recursive: true, mode: 0o700 });
		cpSync(tree, copy, { recursive: true });
		for (const d of ["home", "tmp"]) mkdirSync(join(base, d), { mode: 0o700 });
		const stderr: Buffer[] = [];
		const run = await runCheckV0({
			executable: ctx.node,
			args,
			cwd: copy,
			env: { PATH: "/usr/bin", HOME: join(base, "home"), TMPDIR: join(base, "tmp"), LANG: "C.UTF-8" },
			timeoutMs: ctx.oracle.timeoutMs,
			maxOutputBytes: ctx.oracle.maxOutputBytes,
			keepStdoutBytes: ctx.oracle.maxOutputBytes,
			stdout: discard(),
			stderr: new Writable({
				write(chunk, _encoding, callback) {
					if (Buffer.concat(stderr).length < 256) stderr.push(chunk as Buffer);
					callback();
				},
			}),
			graceMs: 1_000,
			pipeWaitMs: 1_000,
		});
		const kind = run.execution.kind;
		const truncated = kind === "output-limit" || run.stdout.sha256 === null;
		stdout = run.stdout.kept ?? Buffer.alloc(0);
		o = {
			started: kind !== "spawn-failed",
			exitCode: run.execution.kind === "exited" ? run.execution.code : null,
			timedOut: kind === "timed-out",
			truncated,
			termination: run.escapedProcess ? "unconfirmed" : "confirmed",
			stdoutBytes: run.output.stdoutBytes,
			stdoutSha256: truncated ? null : run.stdout.sha256,
			stderrHead: Buffer.concat(stderr).subarray(0, 256).toString("utf8"),
			durationMs: run.durationMs,
		};
		rmSync(base, { recursive: true, force: true });
	}
	const matched =
		o.started &&
		o.termination === "confirmed" &&
		!o.timedOut &&
		!o.truncated &&
		o.exitCode === c.expect.exitCode &&
		sameBytes(stdout, expected);
	return { name: c.name, ...o, matched };
}

/** The verdict from a complete list of observations (PROTOCOL.md §7, after any BLOCKED reason). */
export function verdictOf(observations: readonly Observation[], total: number): Verdict {
	if (observations.length !== total || observations.some((o) => !o.started || o.termination !== "confirmed"))
		return "INCOMPLETE";
	return observations.every((o) => o.matched) ? "PASS" : "FAIL";
}

async function runAll(
	ctx: Context,
	tree: string,
	phase: string,
): Promise<{ verdict: Verdict; observations: Observation[] }> {
	const observations: Observation[] = [];
	for (const [i, c] of ctx.oracle.cases.entries()) {
		const o = await runCase(ctx, tree, c, phase, i);
		observations.push(o);
		ctx.journal({ event: "case", phase, observation: o });
	}
	return { verdict: verdictOf(observations, ctx.oracle.cases.length), observations };
}

// ---- the record ------------------------------------------------------------------------------------------------------------------------

export const seal = (record: Record<string, unknown>): string => {
	const { recordSha256: _omit, ...rest } = record;
	return sha256HexV0(canonicalEndoJsonV0(rest as never));
};

/** The verifier's own sources, by digest: verify.ts, run.sh, and every repository module it imports, transitively. */
function sources(): { path: string; sha256: string }[] {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file) || !existsSync(file)) return;
		seen.add(file);
		for (const m of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+\.ts)"/g))
			walk(resolve(dirname(file), m[1] as string));
	};
	walk(fileURLToPath(import.meta.url));
	seen.add(join(HERE, "run.sh"));
	return [...seen]
		.filter((f) => existsSync(f))
		.map((f) => ({ path: relative(REPOSITORY, f), sha256: sha256(readFileSync(f)) }))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function arg(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

// ---- run -------------------------------------------------------------------------------------------------------------------------------

async function run(argv: readonly string[]): Promise<number> {
	const mechanism = arg(argv, "--mechanism") as Mechanism | undefined;
	const oracleFile = arg(argv, "--oracle");
	const pin = arg(argv, "--oracle-sha256") ?? "";
	const repo = arg(argv, "--repo");
	const commit = arg(argv, "--commit") ?? "";
	const out = arg(argv, "--out");
	if ((mechanism !== "sandbox" && mechanism !== "filtered") || !oracleFile || !repo || !out) {
		process.stderr.write(
			"usage: verify.ts run --mechanism sandbox|filtered --oracle f --oracle-sha256 h --repo d --commit c --out f\n",
		);
		return 64;
	}
	const node = arg(argv, "--node") ?? "/usr/bin/node";
	const work = `${out}.work`;
	const journalFile = `${out}.journal`;
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { mode: 0o700 });
	// Addendum 1, C3: an earlier record at this path must not outlive the start of this run.
	rmSync(out, { force: true });
	rmSync(`${out}.tmp`, { force: true });
	writeFileSync(journalFile, "");
	const journal = (event: Record<string, unknown>) =>
		appendFileSync(journalFile, `${JSON.stringify({ atMs: Date.now(), ...event })}\n`);
	const startedAtMs = Date.now();
	const hostile = HOSTILE.filter((k) => process.env[k] !== undefined);
	const record: Record<string, unknown> = {
		schemaVersion: RECORD_SCHEMA,
		mechanism,
		verdict: "BLOCKED",
		reason: null,
		oracle: { pinned: pin, sha256: null, task: null, cases: null },
		candidate: null,
		runtime: null,
		isolation: null,
		preflight: null,
		qualification: null,
		cases: [],
		controller: {
			launch: { hostileVariables: hostile, execArgv: process.execArgv.length },
			environmentNames: Object.keys(process.env).sort(),
			sources: sources(),
			git: existsSync(GIT) ? { path: GIT, sha256: sha256(readFileSync(GIT)) } : null,
		},
		startedAtMs,
		endedAtMs: null,
		recordSha256: null,
	};
	journal({ event: "start", mechanism, commit });
	const finish = (verdict: Verdict, reason: string | null): number => {
		record.verdict = verdict;
		record.reason = reason;
		record.endedAtMs = Date.now();
		record.recordSha256 = seal(record);
		writeFileSync(`${out}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { flag: "w" });
		renameSync(`${out}.tmp`, out);
		journal({ event: "end", verdict, reason });
		rmSync(work, { recursive: true, force: true });
		process.stdout.write(`${JSON.stringify({ verdict, reason })}\n`);
		return { PASS: 0, FAIL: 1, BLOCKED: 3, INCOMPLETE: 4 }[verdict];
	};
	let casesStarted = false;
	try {
		// 1. The launch: nothing may have been loaded into this process by its environment.
		if (hostile.length > 0 || process.execArgv.length > 0) return finish("BLOCKED", "controller-environment");
		// 2. The oracle, by its pin.
		const loaded = loadOracle(oracleFile, pin);
		if (!loaded.ok) return finish("BLOCKED", loaded.reason);
		const oracle = loaded.oracle;
		record.oracle = { pinned: pin, sha256: loaded.sha256, task: oracle.task, cases: oracle.cases.length };
		// 3. The candidate, from Git objects at the commit.
		const staging = join(work, "candidate");
		const exported = exportCommit(repo, commit, staging);
		if (!exported.ok) return finish("BLOCKED", exported.reason);
		record.candidate = exported.candidate;
		// 4. The runtime (both mechanisms: a root-owned node and its libraries), then the isolation (sandbox only).
		const runtime = resolveRuntimeV0([node]);
		if (!runtime.ok) return finish("BLOCKED", `runtime-${runtime.reason}`);
		const nodeFile = runtime.files.find((f) => f.target === node);
		const version = spawnSync(node, ["--version"], { env: {}, encoding: "utf8", timeout: 5_000 }).stdout.trim();
		record.runtime = { node, sha256: nodeFile?.sha256 ?? null, version, files: runtime.files.length };
		let bwrap: EndoBubblewrapV0 | null = null;
		let containment: EndoContainmentV0 | null = null;
		if (mechanism === "sandbox") {
			const bw = arg(argv, "--bwrap");
			const detected = detectBubblewrapV0(bw === undefined ? undefined : [bw]);
			if (!detected.ok) return finish("BLOCKED", `isolation-${detected.reason}`);
			bwrap = detected.bwrap;
			const sr = arg(argv, "--systemd-run");
			const contained = await detectContainmentV0(sr === undefined ? {} : { systemdRun: sr });
			if (!contained.ok) return finish("BLOCKED", contained.reason);
			containment = contained.containment;
			record.isolation = {
				mechanism: "bubblewrap+systemd-user-scope",
				bubblewrap: bwrap,
				containment: {
					version: containment.version,
					systemdRunSha256: containment.systemdRunSha256,
					tasksMax: containment.tasksMax,
				},
			};
		} else record.isolation = { mechanism: "none", environment: FILTERED_ENV_NAMES, executable: node };
		const ctx: Context = { mechanism, oracle, node, runtime: runtime.files, bwrap, containment, work, journal };
		// 5. The boundary, checked from inside the candidate's own profile (sandbox only).
		if (mechanism === "sandbox") {
			const profile = sandboxProfile(ctx, staging);
			const uid = process.getuid?.() ?? 0;
			const preflight: EndoPreflightV0 = await preflightV0(
				bwrap as EndoBubblewrapV0,
				profile,
				node,
				{
					protectedPaths: {
						"host-home": userInfo().homedir,
						"candidate-repository": resolve(repo),
						"oracle-directory": dirname(resolve(oracleFile)),
						"verifier-directory": HERE,
						"record-directory": dirname(resolve(out)),
					},
					readOnlyRuntime: [node],
					readOnlyMounts: ["/submission/.endo-probe", "/usr/.endo-probe"],
					writable: "/tmp",
					environment: [...Object.keys(SANDBOX_ENV), "PWD"],
					sockets: [
						`/run/user/${uid}`,
						"/run/dbus/system_bus_socket",
						"/var/run/docker.sock",
						"/run/docker.sock",
						"/run/systemd/private",
						"/tmp/.X11-unix",
					],
				},
				containment as EndoContainmentV0,
				{ onScope: (unit) => journal({ event: "scope", phase: "preflight", unit }) },
			);
			record.preflight = preflight;
			(record.isolation as Record<string, unknown>).profileSha256 = profile.sha256;
			(record.isolation as Record<string, unknown>).profile = profile.logical;
			if (preflight.status !== "established") return finish("BLOCKED", `preflight-${preflight.status}`);
		}
		// 6. Qualification: the reference must pass and the negative must fail, by this mechanism.
		const qualification: Record<string, Verdict> = {};
		for (const [role, rel] of [
			["reference", oracle.reference],
			["negative", oracle.negative],
		] as const) {
			const dir = join(dirname(resolve(oracleFile)), dirname(rel));
			const files = readdirSync(dir).filter((f) => lstatSync(join(dir, f)).isFile());
			const copy = join(work, role);
			const got = exportSubmissionV0(dir, files, BOUNDS, copy);
			if (got.status !== "collected") return finish("BLOCKED", `qualification-${role}-unreadable`);
			qualification[role] = (await runAll(ctx, copy, role)).verdict;
		}
		record.qualification = qualification;
		if (qualification.reference !== "PASS" || qualification.negative !== "FAIL")
			return finish("BLOCKED", "qualification-failed");
		// 7. The candidate.
		casesStarted = true;
		const result = await runAll(ctx, staging, "candidate");
		record.cases = result.observations;
		return finish(result.verdict, null);
	} catch (error) {
		return finish(
			casesStarted ? "INCOMPLETE" : "BLOCKED",
			`controller-error: ${String((error as Error).message).slice(0, 200)}`,
		);
	}
}

// ---- read: re-derive a record's class from its observations and the pinned oracle --------------------------------------------------------

/**
 * `expect.commit` (addendum 1, C2) binds the record to the commit the reader asks about: a record of any other candidate reads UNKNOWN.
 * Without it, the class says only that some candidate was observed, as the recorded runs' reader did.
 */
export function readRecord(
	file: string,
	oracleFile: string,
	pin: string,
	expect: { commit?: string } = {},
): { class: ReadClass; reason: string | null } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return existsSync(`${file}.journal`)
			? { class: "INCOMPLETE", reason: "journal-without-record" }
			: { class: "UNKNOWN", reason: "no-record" };
	}
	let r: Record<string, unknown>;
	try {
		r = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { class: "UNKNOWN", reason: "unreadable" };
	}
	// Addendum 1, C5: valid JSON that is not a record object.
	if (typeof r !== "object" || r === null || Array.isArray(r)) return { class: "UNKNOWN", reason: "not-a-record" };
	if (r.schemaVersion !== RECORD_SCHEMA) return { class: "UNKNOWN", reason: "not-a-record" };
	if (r.recordSha256 !== seal(r)) return { class: "UNKNOWN", reason: "seal-mismatch" };
	if (expect.commit !== undefined && (r.candidate as { commit?: unknown } | null)?.commit !== expect.commit)
		return { class: "UNKNOWN", reason: "candidate-mismatch" };
	const loaded = loadOracle(oracleFile, pin);
	if (!loaded.ok) return { class: "UNKNOWN", reason: `oracle: ${loaded.reason}` };
	const oracle = loaded.oracle;
	const recorded = r.verdict as ReadClass;
	if (recorded === "BLOCKED") return { class: "BLOCKED", reason: (r.reason as string | null) ?? null };
	if ((r.oracle as { sha256?: unknown })?.sha256 !== loaded.sha256)
		return { class: "UNKNOWN", reason: "oracle-mismatch" };
	const cases = r.cases as Observation[];
	if (!Array.isArray(cases)) return { class: "UNKNOWN", reason: "cases-unreadable" };
	if (r.mechanism === "sandbox" && (r.preflight as { status?: unknown })?.status !== "established")
		return { class: "UNKNOWN", reason: "preflight-inconsistent" };
	const q = r.qualification as Record<string, unknown> | null;
	if (q?.reference !== "PASS" || q?.negative !== "FAIL")
		return { class: "UNKNOWN", reason: "qualification-inconsistent" };
	if (recorded !== "INCOMPLETE") {
		if (cases.length !== oracle.cases.length || cases.some((c, i) => c?.name !== oracle.cases[i]?.name))
			return { class: "UNKNOWN", reason: "case-set" };
		for (const [i, c] of cases.entries()) {
			const e = oracle.cases[i] as OracleCase;
			const matched =
				c.started === true &&
				c.termination === "confirmed" &&
				c.timedOut === false &&
				c.truncated === false &&
				c.exitCode === e.expect.exitCode &&
				c.stdoutSha256 === sha256(e.expect.stdout);
			if (matched !== c.matched) return { class: "UNKNOWN", reason: `case-inconsistent: ${e.name}` };
		}
	}
	const derived = verdictOf(cases, oracle.cases.length);
	if (derived !== recorded) return { class: "UNKNOWN", reason: "verdict-inconsistent" };
	return { class: derived, reason: (r.reason as string | null) ?? null };
}

// ---- entry -----------------------------------------------------------------------------------------------------------------------------

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "run") process.exitCode = await run(rest);
	else if (command === "read" && rest[0] !== undefined) {
		const commit = arg(rest, "--commit");
		const got = readRecord(
			rest[0],
			arg(rest, "--oracle") ?? "",
			arg(rest, "--oracle-sha256") ?? "",
			commit === undefined ? {} : { commit },
		);
		process.stdout.write(`${JSON.stringify(got)}\n`);
		process.exitCode = got.class === "PASS" ? 0 : 1;
	} else {
		process.stderr.write(
			"usage: verify.ts run ... | verify.ts read <record> --oracle f --oracle-sha256 h [--commit c]\n",
		);
		process.exitCode = 64;
	}
}
