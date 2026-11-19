// DEVELOP-VERIFY-TRUST-003 guest run: the trusted reader's core (ENDO-11 remediation). Research only.
//
// One path from untrusted objects to three separate results for one protected record:
//   1. authenticity: the existing TRUST-002 reader (records.ts) over the protected state root;
//   2. binding: the candidate's objects, acquired with the repository owner's own authority (never root's), are verified by content
//      address (objects.ts), and the export digest recomputed from exactly those objects must equal the record's;
//   3. correctness: those same verified bytes, and nothing re-exported from a repository, are staged and run against the oracle in a
//      bubblewrap PID namespace that is killed outright at a hard deadline.
// A failed binding, an unreadable repository, an unavailable sandbox or an unconfirmed termination is never success.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectBubblewrapV0 } from "../../../adapters/sandbox/bubblewrap.ts";
import { GIT_ENV } from "../../develop-verify-trust-002/client/client.ts";
import {
	type ObjectFormat,
	type ObjectType,
	resolveCandidate,
	type StagedFile,
} from "../../develop-verify-trust-002/service/objects.ts";
import { type FileSystem, hostFileSystem, readAuthoritative } from "../../develop-verify-trust-002/service/records.ts";

// ---- bounded execution -------------------------------------------------------------------------------------------------------------

export interface Bounded {
	outcome: "exited" | "signaled" | "timeout" | "output-limit" | "spawn-error";
	exitCode: number | null;
	signal: string | null;
	stdout: Buffer;
	stderrHead: string;
	/** The process group was gone (pipes closed, exit reported) within the grace period after the kill. */
	terminationConfirmed: boolean;
	durationMs: number;
}

/**
 * Run argv in its own process group with a hard deadline: at the deadline, or once stdout passes maxOutput, the group gets SIGKILL,
 * which cannot be caught. Only that group is signalled. The call itself returns within deadline + grace even if the kill could not be
 * confirmed (then terminationConfirmed is false and callers must not trust the result).
 */
export function runBounded(
	argv: readonly string[],
	options: {
		env: Record<string, string>;
		cwd?: string;
		input?: Buffer;
		deadlineMs: number;
		maxOutput: number;
		graceMs?: number;
	},
): Promise<Bounded> {
	const grace = options.graceMs ?? 2000;
	const start = Date.now();
	return new Promise((done) => {
		const out: Buffer[] = [];
		let outBytes = 0;
		let err = "";
		let reason: "timeout" | "output-limit" | null = null;
		let settled = false;
		let hard: NodeJS.Timeout | undefined;
		const finish = (r: Omit<Bounded, "stdout" | "stderrHead" | "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(hard);
			done({ ...r, stdout: Buffer.concat(out), stderrHead: err.slice(0, 2000), durationMs: Date.now() - start });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(argv[0] as string, argv.slice(1), {
				env: options.env,
				cwd: options.cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e) {
			done({
				outcome: "spawn-error",
				exitCode: null,
				signal: null,
				stdout: Buffer.alloc(0),
				stderrHead: String(e),
				terminationConfirmed: true,
				durationMs: 0,
			});
			return;
		}
		const kill = (why: "timeout" | "output-limit") => {
			if (reason !== null) return;
			reason = why;
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {}
			hard = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish({ outcome: why, exitCode: null, signal: null, terminationConfirmed: false });
			}, grace);
		};
		const deadline = setTimeout(() => kill("timeout"), options.deadlineMs);
		child.on("error", (e) => {
			err += String(e);
			finish({ outcome: "spawn-error", exitCode: null, signal: null, terminationConfirmed: true });
		});
		child.stdout?.on("data", (b: Buffer) => {
			outBytes += b.length;
			if (outBytes > options.maxOutput) {
				kill("output-limit");
				return;
			}
			out.push(b);
		});
		child.stderr?.on("data", (b: Buffer) => {
			outBytes += b.length;
			if (outBytes > options.maxOutput) kill("output-limit");
			if (err.length < 2000) err += b.subarray(0, 2000 - err.length).toString("utf8");
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.input ?? Buffer.alloc(0));
		child.on("close", async (code, signal) => {
			if (settled) return;
			clearTimeout(deadline);
			const pid = child.pid;
			const groupGone = () => {
				if (pid === undefined) return false;
				try {
					process.kill(-pid, 0);
					return false;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "ESRCH";
				}
			};
			let confirmed = groupGone();
			if (!confirmed && pid !== undefined) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {}
				const until = Math.min(start + options.deadlineMs + grace, Date.now() + grace);
				while (!settled && !confirmed && Date.now() < until) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					confirmed = groupGone();
				}
			}
			finish({
				outcome: reason ?? (signal !== null ? "signaled" : "exited"),
				exitCode: code,
				signal,
				terminationConfirmed: confirmed,
			});
		});
	});
}

// ---- acquisition: the owner's authority, untrusted output ---------------------------------------------------------------------------

/**
 * Git with the agent's own authority, never root's: anything the repository's configuration can make Git run, the agent could already run.
 * As root the identity is the configured agent uid, never inferred from the path (a symbolic link could name another principal's
 * directory). Not as root, Git runs as the caller.
 */
export function gitArgv(
	repo: string,
	args: readonly string[],
	agent: { uid: number; gid: number } | null,
	uid = process.getuid?.(),
): string[] {
	const git = [
		"/usr/bin/git",
		"-c",
		"safe.directory=*",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"protocol.allow=never",
		"-C",
		repo,
		...args,
	];
	if (uid !== 0) return git;
	if (agent === null || agent.uid === 0 || agent.gid === 0)
		throw new Error("as root, Git runs only as a configured non-root agent identity");
	return [
		"/usr/bin/setpriv",
		`--reuid=${agent.uid}`,
		`--regid=${agent.gid}`,
		"--clear-groups",
		"--no-new-privs",
		"--",
		...git,
	];
}

export type Acquired =
	| { ok: true; objectFormat: ObjectFormat; objects: { type: ObjectType; data: Buffer }[] }
	| { ok: false; reason: string };

/** The commit's objects as untrusted bytes. Nothing here is believed: resolveCandidate verifies every id. */
export async function acquireObjects(
	repo: string,
	commit: string,
	agent: { uid: number; gid: number } | null = null,
): Promise<Acquired> {
	const run = async (args: string[], input?: Buffer) =>
		runBounded(gitArgv(repo, args, agent), { env: { ...GIT_ENV }, input, deadlineMs: 30_000, maxOutput: 64 << 20 });
	const format = await run(["rev-parse", "--show-object-format"]);
	const f = format.stdout.toString().trim();
	if (
		!format.terminationConfirmed ||
		format.outcome !== "exited" ||
		format.exitCode !== 0 ||
		(f !== "sha1" && f !== "sha256")
	)
		return { ok: false, reason: "repository-unreadable" };
	if (!/^[0-9a-f]+$/.test(commit)) return { ok: false, reason: "commit-invalid" };
	const list = await run(["ls-tree", "-r", "-t", "-z", "--full-tree", "--end-of-options", commit]);
	const tree = await run(["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
	if (
		!list.terminationConfirmed ||
		!tree.terminationConfirmed ||
		list.outcome !== "exited" ||
		tree.outcome !== "exited" ||
		list.exitCode !== 0 ||
		tree.exitCode !== 0
	)
		return { ok: false, reason: "commit-unreadable" };
	const ids = new Set<string>([commit, tree.stdout.toString().trim()]);
	for (const entry of list.stdout.toString("utf8").split("\0")) {
		const m = /^\d{5,6} (?:blob|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(entry);
		if (m !== null) ids.add(m[1] as string);
	}
	const batch = await run(["cat-file", "--batch"], Buffer.from(`${[...ids].join("\n")}\n`));
	if (!batch.terminationConfirmed || batch.outcome !== "exited" || batch.exitCode !== 0)
		return { ok: false, reason: "object-unreadable" };
	const out = batch.stdout;
	const objects: { type: ObjectType; data: Buffer }[] = [];
	let i = 0;
	while (i < out.length) {
		const nl = out.indexOf(0x0a, i);
		if (nl < 0) return { ok: false, reason: "object-unreadable" };
		const m = /^[0-9a-f]+ (commit|tree|blob) (\d+)$/.exec(out.subarray(i, nl).toString("latin1"));
		if (m === null) return { ok: false, reason: "object-unreadable" };
		const size = Number(m[2]);
		if (nl + 1 + size > out.length) return { ok: false, reason: "object-unreadable" };
		objects.push({ type: m[1] as ObjectType, data: Buffer.from(out.subarray(nl + 1, nl + 1 + size)) });
		i = nl + 1 + size + 1;
	}
	return { ok: true, objectFormat: f, objects };
}

// ---- binding ----------------------------------------------------------------------------------------------------------------------

export interface RecordCandidate {
	objectFormat?: unknown;
	commit?: unknown;
	tree?: unknown;
	exportSha256?: unknown;
	files?: unknown;
}
export type Binding =
	| { status: "valid"; exportSha256: string; files: StagedFile[] }
	| { status: "mismatch" | "unavailable"; reason: string; exportSha256: string | null };

/** The record's candidate against the given objects: same commit, same tree, same files, same export digest, all recomputed here. */
export function bindObjects(candidate: RecordCandidate, acquired: Acquired): Binding {
	if (!acquired.ok) return { status: "unavailable", reason: acquired.reason, exportSha256: null };
	if (candidate.objectFormat !== acquired.objectFormat)
		return { status: "mismatch", reason: "object-format", exportSha256: null };
	const r = resolveCandidate(acquired.objectFormat, String(candidate.commit), acquired.objects);
	if (!r.ok) return { status: "unavailable", reason: r.reason, exportSha256: null };
	return bindFiles(candidate, r.candidate.files, r.candidate.exportSha256, r.candidate.tree);
}

/** The record's file list and export digest against files whose bytes were digested here (tree is checked when known). */
export function bindFiles(
	candidate: RecordCandidate,
	files: StagedFile[],
	exportSha256: string,
	tree?: string,
): Binding {
	if (tree !== undefined && candidate.tree !== tree) return { status: "mismatch", reason: "tree", exportSha256 };
	if (candidate.exportSha256 !== exportSha256) return { status: "mismatch", reason: "export", exportSha256 };
	const listed = JSON.stringify(
		(Array.isArray(candidate.files) ? candidate.files : []).map((f: Record<string, unknown>) => [
			f.path,
			f.mode,
			f.bytes,
			f.sha256,
		]),
	);
	if (listed !== JSON.stringify(files.map((f) => [f.path, f.mode, f.bytes, f.sha256])))
		return { status: "mismatch", reason: "files", exportSha256 };
	return { status: "valid", exportSha256, files };
}

// ---- independent grade ------------------------------------------------------------------------------------------------------------

export interface Oracle {
	timeoutMs: number;
	maxOutputBytes: number;
	cases: { name: string; argv: string[]; expect: { exitCode: number; stdout: string } }[];
}
export interface CaseGrade {
	name: string;
	outcome: Bounded["outcome"];
	exitCode: number | null;
	signal: string | null;
	matched: boolean;
	terminationConfirmed: boolean;
	durationMs: number;
}
export type Grade =
	| { status: "graded"; correct: boolean; failing: string[]; cases: CaseGrade[] }
	| { status: "incomplete"; correct: null; reason: string; cases: CaseGrade[] };

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** Write verified files into a fresh directory; any path that is not plain segments refuses the whole set. */
export function stageFiles(files: readonly StagedFile[]): string {
	const dir = mkdtempSync(join(tmpdir(), "trust003-grade-"));
	for (const f of files) {
		const parts = f.path.split("/");
		if (parts.length === 0 || !parts.every((p) => SEGMENT.test(p))) {
			rmSync(dir, { recursive: true, force: true });
			throw new Error(`unsupported path ${JSON.stringify(f.path)}`);
		}
		const target = join(dir, ...parts);
		mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
		writeFileSync(target, f.content, { flag: "wx", mode: 0o644 });
		chmodSync(target, f.mode === "100755" ? 0o555 : 0o444);
	}
	chmodSync(dir, 0o755);
	return dir;
}

/** Grade exactly these files. Each case runs in a fresh bubblewrap PID namespace; SIGKILL to bubblewrap ends everything inside it. */
export async function gradeFiles(
	files: readonly StagedFile[],
	oracle: Oracle,
	options: { bwrapCandidates?: readonly string[]; deadlineMs?: number } = {},
): Promise<Grade> {
	const detected =
		options.bwrapCandidates === undefined ? detectBubblewrapV0() : detectBubblewrapV0(options.bwrapCandidates);
	if (!detected.ok)
		return { status: "incomplete", correct: null, reason: `containment-unavailable: ${detected.reason}`, cases: [] };
	let dir: string;
	try {
		dir = stageFiles(files);
	} catch (e) {
		return { status: "incomplete", correct: null, reason: `staging: ${(e as Error).message}`, cases: [] };
	}
	const asNobody =
		process.getuid?.() === 0
			? ["/usr/bin/setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", "--"]
			: [];
	const deadline = options.deadlineMs ?? oracle.timeoutMs;
	const cases: CaseGrade[] = [];
	try {
		for (const k of oracle.cases) {
			const argv = [
				...asNobody,
				detected.bwrap.path,
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				"--cap-drop",
				"ALL",
				"--clearenv",
				"--setenv",
				"PATH",
				"/usr/bin",
				"--setenv",
				"HOME",
				"/work",
				"--ro-bind",
				"/usr",
				"/usr",
				"--symlink",
				"usr/lib",
				"/lib",
				"--symlink",
				"usr/lib64",
				"/lib64",
				"--symlink",
				"usr/bin",
				"/bin",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--tmpfs",
				"/tmp",
				"--ro-bind",
				dir,
				"/work",
				"--chdir",
				"/work",
				"--",
				"/usr/bin/prlimit",
				`--cpu=${Math.ceil(deadline / 1000) + 1}`,
				"--fsize=1048576",
				"--nofile=256",
				"--core=0",
				"--",
				"/usr/bin/node",
				...k.argv.slice(1),
			];
			const r = await runBounded(argv, { env: {}, deadlineMs: deadline, maxOutput: oracle.maxOutputBytes });
			cases.push({
				name: k.name,
				outcome: r.outcome,
				exitCode: r.exitCode,
				signal: r.signal,
				matched:
					r.outcome === "exited" &&
					r.exitCode === k.expect.exitCode &&
					r.stdout.toString("utf8") === k.expect.stdout,
				terminationConfirmed: r.terminationConfirmed,
				durationMs: r.durationMs,
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const unconfirmed = cases.find((c) => !c.terminationConfirmed || c.outcome === "spawn-error");
	if (unconfirmed !== undefined)
		return {
			status: "incomplete",
			correct: null,
			reason: `${unconfirmed.name}: ${unconfirmed.outcome}, termination ${unconfirmed.terminationConfirmed ? "confirmed" : "unconfirmed"}`,
			cases,
		};
	const failing = cases.filter((c) => !c.matched).map((c) => c.name);
	return { status: "graded", correct: failing.length === 0, failing, cases };
}

// ---- one record, three results ----------------------------------------------------------------------------------------------------

export interface RecordResult {
	invocation: string;
	authenticity: { class: string; authoritative: boolean; reason: string | null };
	commit: string | null;
	binding: Binding | { status: "not-applicable"; reason: string };
	grade: Grade | { status: "not-applicable"; reason: string };
	/** Authentic PASS, binding valid, graded correct: the only state that confirms a PASS. */
	confirmedPass: boolean;
	/** Authentic PASS whose verified bytes graded incorrect. */
	falsePass: boolean;
	/** Authentic PASS that could not be confirmed (binding or grade unavailable): never counted as success. */
	unconfirmedPass: boolean;
}

export async function readRecord(options: {
	state: string;
	installDir: string;
	verifierUid: number;
	invocation: string;
	repos: readonly string[];
	/** The identity acquisition runs as when the reader is root. */
	agent?: { uid: number; gid: number } | null;
	oracle: Oracle;
	fs?: FileSystem;
	bwrapCandidates?: readonly string[];
}): Promise<RecordResult> {
	const fs = options.fs ?? hostFileSystem;
	const base = {
		state: options.state,
		installDir: options.installDir,
		verifierUid: options.verifierUid,
		invocation: options.invocation,
	};
	const auth = readAuthoritative(base, fs);
	const authenticity = { class: auth.class, authoritative: auth.authoritative, reason: auth.reason };
	const candidate = (auth.record?.candidate ?? null) as RecordCandidate | null;
	const commit = typeof candidate?.commit === "string" ? candidate.commit : null;
	const result = (binding: RecordResult["binding"], grade: RecordResult["grade"]): RecordResult => {
		const pass = auth.authoritative && auth.class === "PASS";
		const confirmed = pass && binding.status === "valid" && grade.status === "graded" && grade.correct === true;
		const falsePass = pass && binding.status === "valid" && grade.status === "graded" && grade.correct === false;
		return {
			invocation: options.invocation,
			authenticity,
			commit,
			binding,
			grade,
			confirmedPass: confirmed,
			falsePass,
			unconfirmedPass: pass && !confirmed && !falsePass,
		};
	};
	if (candidate === null || commit === null)
		return result(
			{ status: "not-applicable", reason: "no candidate in record" },
			{ status: "not-applicable", reason: "no candidate" },
		);
	let binding: Binding = { status: "unavailable", reason: "commit-not-found", exportSha256: null };
	for (const repo of options.repos) {
		const acquired = await acquireObjects(repo, commit, options.agent ?? null);
		if (!acquired.ok) continue;
		binding = bindObjects(candidate, acquired);
		if (binding.status === "valid") break;
	}
	if (binding.status === "valid") {
		const bound = readAuthoritative({ ...base, expect: { commit, exportSha256: binding.exportSha256 } }, fs);
		if (!bound.authoritative || bound.class !== auth.class)
			binding = {
				status: "mismatch",
				reason: `bound read: ${bound.class} ${bound.reason}`,
				exportSha256: binding.exportSha256,
			};
	}
	if (binding.status !== "valid") return result(binding, { status: "not-applicable", reason: "no verified bytes" });
	return result(
		binding,
		await gradeFiles(binding.files, options.oracle, { bwrapCandidates: options.bwrapCandidates }),
	);
}

/** Every invocation the state root knows: records, and journals without a record (INCOMPLETE must not disappear from the report). */
export function invocations(state: string): string[] {
	const ids = new Set<string>();
	for (const [dir, ext] of [
		["records", ".json"],
		["journal", ".jsonl"],
	] as const) {
		let names: string[] = [];
		try {
			names = readdirSync(join(state, dir));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const n of names) if (n.endsWith(ext) && /^[0-9a-f]{32}\./.test(n)) ids.add(n.slice(0, 32));
	}
	return [...ids].sort();
}
