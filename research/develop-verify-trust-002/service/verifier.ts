// DEVELOP-VERIFY-TRUST-002: the verifier instance (ARCHITECTURE.md, arrangement B). Research only; not a product path.
//
// One process per request. The verifier principal's user manager starts it for one connection on its socket (`Accept=yes`): the
// connection is standard input and output, and the arguments come from the unit, which root owns:
//
//   node verifier.ts serve --install <installation dir> --state <state dir> --peer <systemd instance name>
//
// It reads one request (request.ts), resolves the candidate from the request's own objects (objects.ts, no Git), stages it in a working
// directory of its own, qualifies itself against the installed oracle's reference and negative, runs every case in its own Bubblewrap
// sandbox in a systemd scope (001's adapters, unchanged), writes one record named by a fresh invocation id, and answers with one line.
//
// Nothing the caller controls reaches it but the request's bytes: not its environment, arguments, descriptors, limits or directory.
// What protects its code, configuration, working files and records from the operator's account is ownership (the installed phase), not
// this file. In the rehearsal every one of them is the operator's, and the reader (records.ts) never treats such a record as authoritative.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	type EndoBubblewrapV0,
	type EndoRuntimeFileV0,
	type EndoSandboxProfileV0,
	endoTreeDigestV0,
	processStartTimeV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../../../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, type EndoContainmentV0 } from "../../../adapters/sandbox/containment.ts";
import { type EndoPreflightV0, preflightV0 } from "../../../adapters/sandbox/preflight.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import { type Candidate, resolveCandidate } from "./objects.ts";
import { MAX_REQUEST_BYTES, parsePeer, parseRequest } from "./request.ts";

export const RECORD_SCHEMA = "endo.research.dvt002.record.v0";
export const RESPONSE_SCHEMA = "endo.research.dvt002.response.v0";
export const INSTALLATION_SCHEMA = "endo.research.dvt002.installation.v0";
const ORACLE_SCHEMA = "endo.research.trust-oracle.v0";
/** Variables that load code into this process or change how its runtime links (as 001). Seen here, they refuse the run. */
const HOSTILE = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"] as const;
const TMPFS_BYTES = 16 << 20;
const SANDBOX_ENV = { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" };
export const INVOCATION = /^[0-9a-f]{32}$/;

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";

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
export interface Observation {
	name: string;
	started: boolean;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	termination: "confirmed" | "unconfirmed";
	stdoutBytes: number;
	stdoutSha256: string | null;
	stderrHead: string;
	durationMs: number;
	matched: boolean;
}
/** The installation manifest (root-owned when installed). Its SHA-256 is the installation identity. */
export interface Installation {
	schemaVersion: string;
	mode: "installed" | "rehearsal";
	sourceCommit: string;
	operatorUid: number;
	operatorHome: string;
	tools: { node: string; bwrap: string; systemdRun: string };
	/** Every installed file, relative to the installation directory, by SHA-256. */
	files: { path: string; sha256: string }[];
	tasks: Record<string, { dir: string; manifestSha256: string; referenceSha256: string; negativeSha256: string }>;
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export const seal = (record: Record<string, unknown>): string => {
	const { recordSha256: _omit, ...rest } = record;
	return sha256HexV0(canonicalEndoJsonV0(rest as never));
};

export function verdictOf(observations: readonly Observation[], total: number): Verdict {
	if (observations.length !== total || observations.some((o) => !o.started || o.termination !== "confirmed"))
		return "INCOMPLETE";
	return observations.every((o) => o.matched) ? "PASS" : "FAIL";
}

/** Signs of an environment the sandbox does not provide (001's R7), read from the candidate's own standard error: advisory only. */
export function compatibilitySignals(observations: readonly Observation[]): string[] {
	const signals = new Set<string>();
	for (const o of observations) {
		if (o.matched) continue;
		const e = o.stderrHead;
		if (/\bEROFS\b/.test(e)) signals.add("EROFS");
		if (/\bENOSPC\b/.test(e)) signals.add("ENOSPC");
		if (/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/.test(e)) signals.add("ERR_MODULE_NOT_FOUND");
		if (/ENOENT[^\n]*\/bin\/(?:ba)?sh|\/bin\/(?:ba)?sh[^\n]*ENOENT/.test(e)) signals.add("no-shell");
		if (/uv_os_get_passwd|getpwuid/.test(e)) signals.add("no-passwd");
	}
	return [...signals].sort();
}

// ---- the installation and its oracle ---------------------------------------------------------------------------------------------------

export function loadInstallation(
	dir: string,
): { ok: true; installation: Installation; id: string } | { ok: false; reason: string } {
	let bytes: Buffer;
	let inst: Installation;
	try {
		bytes = readFileSync(join(dir, "installation.json"));
		inst = JSON.parse(bytes.toString("utf8")) as Installation;
	} catch {
		return { ok: false, reason: "installation-unreadable" };
	}
	if (inst?.schemaVersion !== INSTALLATION_SCHEMA || !Array.isArray(inst.files) || typeof inst.tasks !== "object")
		return { ok: false, reason: "installation-invalid" };
	// Drift, not adversaries: a file that changed since installation refuses the run. Who can change them is the boundary.
	for (const f of inst.files) {
		let got: string;
		try {
			got = sha256(readFileSync(join(dir, f.path)));
		} catch {
			return { ok: false, reason: "installation-drift" };
		}
		if (got !== f.sha256) return { ok: false, reason: "installation-drift" };
	}
	return { ok: true, installation: inst, id: sha256(bytes) };
}

export function loadOracle(
	installDir: string,
	pin: Installation["tasks"][string],
): { ok: true; oracle: Oracle; dir: string; reference: Buffer; negative: Buffer } | { ok: false; reason: string } {
	const dir = join(installDir, pin.dir);
	let manifest: Buffer;
	try {
		manifest = readFileSync(join(dir, "manifest.json"));
	} catch {
		return { ok: false, reason: "oracle-unreadable" };
	}
	if (sha256(manifest) !== pin.manifestSha256) return { ok: false, reason: "oracle-not-pinned" };
	let o: Oracle;
	try {
		o = JSON.parse(manifest.toString("utf8")) as Oracle;
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
		Array.isArray(o.cases) &&
		o.cases.length > 0 &&
		o.cases.length <= 64 &&
		o.cases.every(
			(c) =>
				typeof c.name === "string" &&
				Array.isArray(c.argv) &&
				c.argv[0] === "node" &&
				c.argv.length >= 2 &&
				c.argv.every((a) => typeof a === "string" && !a.includes("\0")) &&
				Number.isSafeInteger(c.expect?.exitCode) &&
				typeof c.expect?.stdout === "string",
		);
	if (!good) return { ok: false, reason: "oracle-invalid" };
	let reference: Buffer;
	let negative: Buffer;
	try {
		reference = readFileSync(join(dir, o.reference));
		negative = readFileSync(join(dir, o.negative));
	} catch {
		return { ok: false, reason: "oracle-unreadable" };
	}
	// 001's R9: the qualification programs are pinned too.
	if (sha256(reference) !== pin.referenceSha256 || sha256(negative) !== pin.negativeSha256)
		return { ok: false, reason: "oracle-not-pinned" };
	return { ok: true, oracle: o, dir, reference, negative };
}

// ---- staging -------------------------------------------------------------------------------------------------------------------------

/** Write files into `root` (which must not exist), then make every file and directory read-only. */
function stage(root: string, files: readonly { path: string; mode: string; content: Buffer }[]): void {
	mkdirSync(root, { mode: 0o700 });
	const dirs = new Set<string>([root]);
	for (const f of files) {
		const target = join(root, f.path);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		for (let d = dirname(target); d.startsWith(root) && d !== root; d = dirname(d)) dirs.add(d);
		writeFileSync(target, f.content, { flag: "wx", mode: 0o600 });
		chmodSync(target, f.mode === "100755" ? 0o555 : 0o444);
	}
	for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o555);
}

/** Make a staged tree removable again. */
function unstage(root: string): void {
	if (!existsSync(root)) return;
	spawnSync("/usr/bin/chmod", ["-R", "u+w", root], { env: {}, stdio: "ignore", timeout: 10_000 });
	rmSync(root, { recursive: true, force: true });
}

// ---- running the cases ---------------------------------------------------------------------------------------------------------------

interface Context {
	oracle: Oracle;
	node: string;
	runtime: readonly EndoRuntimeFileV0[];
	bwrap: EndoBubblewrapV0;
	containment: EndoContainmentV0;
	journal: (event: Record<string, unknown>) => void;
}

function sandboxProfile(ctx: Pick<Context, "runtime">, tree: string): EndoSandboxProfileV0 {
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

async function runCase(
	ctx: Context,
	tree: string,
	c: { name: string; argv: string[]; expect: OracleCase["expect"] },
	phase: string,
) {
	const expected = Buffer.from(c.expect.stdout, "utf8");
	const run = await runSandboxV0(ctx.bwrap, sandboxProfile(ctx, tree), [ctx.node, ...c.argv.slice(1)], {
		timeoutMs: ctx.oracle.timeoutMs,
		outputBytes: ctx.oracle.maxOutputBytes,
		containment: ctx.containment,
		onScope: (unit) => ctx.journal({ event: "scope", phase, case: c.name, unit }),
	});
	const stdout = run.stdout;
	// One budget for both streams (001's C4).
	const total = run.stdout.length + run.truncated.stdout + run.stderr.length + run.truncated.stderr;
	const truncated = run.truncated.stdout > 0 || run.truncated.stderr > 0 || total > ctx.oracle.maxOutputBytes;
	const o: Omit<Observation, "name" | "matched"> = {
		started: run.started,
		exitCode: run.timedOut ? null : run.exitCode,
		timedOut: run.timedOut,
		truncated,
		termination: run.termination,
		stdoutBytes: run.stdout.length + run.truncated.stdout,
		stdoutSha256: truncated ? null : sha256(stdout),
		stderrHead: run.stderr.subarray(0, 256).toString("utf8"),
		durationMs: run.durationMs,
	};
	const matched =
		o.started &&
		o.termination === "confirmed" &&
		!o.timedOut &&
		!o.truncated &&
		o.exitCode === c.expect.exitCode &&
		stdout.equals(expected);
	return { name: c.name, ...o, matched } satisfies Observation;
}

async function runAll(
	ctx: Context,
	tree: string,
	phase: string,
): Promise<{ verdict: Verdict; observations: Observation[] }> {
	const observations: Observation[] = [];
	for (const c of ctx.oracle.cases) {
		const o = await runCase(ctx, tree, c, phase);
		observations.push(o);
		ctx.journal({ event: "case", phase, observation: o });
	}
	return { verdict: verdictOf(observations, ctx.oracle.cases.length), observations };
}

// ---- state ---------------------------------------------------------------------------------------------------------------------------

/** How long a half-made working directory (`.new-<id>`, before its rename) is left alone: its instance may still be creating it. */
const HALF_MADE_MS = 10 * 60_000;

/**
 * Remove working directories whose instance is gone (an interrupted run). Their journals stay: that invocation reads INCOMPLETE. A working
 * directory appears under its id only after its owner file is in it (made as `.new-<id>`, then renamed), so a live instance's directory
 * always names its owner (correction D1).
 */
export function collectOrphans(work: string, own: string, now = Date.now()): string[] {
	const removed: string[] = [];
	for (const id of readdirSync(work)) {
		if (id === own) continue;
		if (/^\.new-[0-9a-f]{32}$/.test(id)) {
			// Interrupted between creating and naming it. Removed only once old enough that no instance can still be making it.
			const age = now - (lstatSync(join(work, id), { throwIfNoEntry: false })?.mtimeMs ?? now);
			if (age > HALF_MADE_MS) {
				rmSync(join(work, id), { recursive: true, force: true });
				removed.push(id);
			}
			continue;
		}
		if (!INVOCATION.test(id)) continue;
		let owner: { pid?: unknown; startTime?: unknown } = {};
		try {
			owner = JSON.parse(readFileSync(join(work, id, "owner.json"), "utf8"));
		} catch {
			// Cannot happen for a directory this version made; an unreadable owner is treated as gone.
		}
		const alive = typeof owner.pid === "number" && processStartTimeV0(owner.pid) === owner.startTime;
		if (alive) continue;
		for (const sub of ["candidate", "reference", "negative"]) unstage(join(work, id, sub));
		rmSync(join(work, id), { recursive: true, force: true });
		removed.push(id);
	}
	return removed;
}

/** How long a client has to send its request and close its side (correction D2): an idle connection otherwise holds an instance. */
export const REQUEST_DEADLINE_MS = 30_000;

async function readInput(limit: number, deadlineMs: number): Promise<Buffer | "too-large" | "timeout"> {
	const chunks: Buffer[] = [];
	let size = 0;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<"timeout">((done) => {
		timer = setTimeout(() => done("timeout"), deadlineMs);
	});
	const read = (async () => {
		for await (const chunk of process.stdin) {
			size += (chunk as Buffer).length;
			if (size > limit) return "too-large" as const;
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks);
	})();
	try {
		const got = await Promise.race([read, deadline]);
		// Stop reading: an open connection must not keep this process alive once its answer is decided.
		if (!Buffer.isBuffer(got)) process.stdin.destroy();
		return got;
	} finally {
		clearTimeout(timer);
	}
}

function arg(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

// ---- serve ---------------------------------------------------------------------------------------------------------------------------

export async function serve(argv: readonly string[]): Promise<number> {
	const installDir = resolve(arg(argv, "--install") ?? "");
	const state = resolve(arg(argv, "--state") ?? "");
	const peerName = arg(argv, "--peer") ?? "";
	const invocation = randomBytes(16).toString("hex");
	const work = join(state, "work");
	const journalDir = join(state, "journal");
	const records = join(state, "records");
	for (const d of [state, journalDir, records]) mkdirSync(d, { recursive: true, mode: 0o755 });
	mkdirSync(work, { recursive: true, mode: 0o700 });
	const mine = join(work, invocation);
	// D1: the directory gets its id only once it names its owner, so a concurrent instance never takes it for an orphan.
	const halfMade = join(work, `.new-${invocation}`);
	mkdirSync(halfMade, { mode: 0o700 });
	writeFileSync(
		join(halfMade, "owner.json"),
		JSON.stringify({ pid: process.pid, startTime: processStartTimeV0(process.pid) }),
		{
			flag: "wx",
		},
	);
	renameSync(halfMade, mine);
	const journalFd = openSync(join(journalDir, `${invocation}.jsonl`), "wx", 0o644);
	const journal = (event: Record<string, unknown>) =>
		writeSync(journalFd, `${JSON.stringify({ atMs: Date.now(), invocation, ...event })}\n`);
	const startedAtMs = Date.now();
	const peer = parsePeer(peerName);
	const hostile = HOSTILE.filter((k) => process.env[k] !== undefined);
	const record: Record<string, unknown> = {
		schemaVersion: RECORD_SCHEMA,
		verdict: "BLOCKED",
		reason: null,
		invocation: {
			id: invocation,
			requestSha256: null,
			requester: peer,
			instance: peerName.slice(0, 100),
			startedAtMs,
		},
		installation: null,
		oracle: null,
		candidate: null,
		runtime: null,
		isolation: null,
		preflight: null,
		qualification: null,
		staging: null,
		cases: [],
		compatibility: [],
		controller: {
			uid: process.getuid?.() ?? null,
			pid: process.pid,
			hostileVariables: hostile,
			execArgv: process.execArgv.length,
			environmentNames: Object.keys(process.env).sort(),
		},
		endedAtMs: null,
		recordSha256: null,
	};
	journal({ event: "start", requester: peer });
	const orphans = collectOrphans(work, invocation);
	if (orphans.length > 0) journal({ event: "orphans-removed", invocations: orphans });
	const finish = (verdict: Verdict, reason: string | null): number => {
		record.verdict = verdict;
		record.reason = reason;
		record.endedAtMs = Date.now();
		record.recordSha256 = seal(record);
		const tmp = join(records, `.${invocation}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o644 });
		renameSync(tmp, join(records, `${invocation}.json`));
		journal({ event: "end", verdict, reason });
		closeSync(journalFd);
		for (const sub of ["candidate", "reference", "negative"]) unstage(join(mine, sub));
		rmSync(mine, { recursive: true, force: true });
		const response = {
			schemaVersion: RESPONSE_SCHEMA,
			invocation,
			verdict,
			reason,
			record: `records/${invocation}.json`,
			recordSha256: record.recordSha256,
		};
		// The client may be gone; its absence changes nothing about the record.
		process.stdout.on("error", () => {});
		process.stdout.write(`${JSON.stringify(response)}\n`);
		// The verdict travels in the response and the record; the process's status says only that both were written.
		return 0;
	};
	let casesStarted = false;
	try {
		// 1. The start: nothing may have been loaded into this process by its environment.
		if (hostile.length > 0 || process.execArgv.length > 0) return finish("BLOCKED", "controller-environment");
		// 2. The installation, its identity and its requester.
		const inst = loadInstallation(installDir);
		if (!inst.ok) return finish("BLOCKED", inst.reason);
		const installation = inst.installation;
		record.installation = { id: inst.id, mode: installation.mode, sourceCommit: installation.sourceCommit };
		if (peer === null || peer.uid !== installation.operatorUid) return finish("BLOCKED", "requester-not-permitted");
		// 3. The request.
		const bytes = await readInput(MAX_REQUEST_BYTES, REQUEST_DEADLINE_MS);
		if (bytes === "too-large") return finish("BLOCKED", "request-too-large");
		if (bytes === "timeout") return finish("BLOCKED", "request-timeout");
		(record.invocation as Record<string, unknown>).requestSha256 = sha256(bytes);
		const parsed = parseRequest(bytes);
		if (!parsed.ok) return finish("BLOCKED", parsed.reason);
		const request = parsed.request;
		journal({ event: "request", task: request.task, commit: request.commit, objects: request.objects.length });
		// 4. The oracle, by the installation's pins.
		const pin = Object.hasOwn(installation.tasks, request.task) ? installation.tasks[request.task] : undefined;
		if (pin === undefined) return finish("BLOCKED", "task-unknown");
		const loaded = loadOracle(installDir, pin);
		if (!loaded.ok) return finish("BLOCKED", loaded.reason);
		const oracle = loaded.oracle;
		record.oracle = {
			task: request.task,
			manifestSha256: pin.manifestSha256,
			referenceSha256: pin.referenceSha256,
			negativeSha256: pin.negativeSha256,
			cases: oracle.cases.length,
		};
		// 5. The candidate, from its own objects.
		const resolved = resolveCandidate(request.objectFormat, request.commit, request.objects);
		if (!resolved.ok) {
			record.candidate = { objectFormat: request.objectFormat, commit: request.commit };
			return finish("BLOCKED", resolved.reason);
		}
		const candidate: Candidate = resolved.candidate;
		record.candidate = {
			objectFormat: candidate.objectFormat,
			commit: candidate.commit,
			tree: candidate.tree,
			exportSha256: candidate.exportSha256,
			files: candidate.files.map(({ content: _c, ...f }) => f),
		};
		const staging = join(mine, "candidate");
		stage(staging, candidate.files);
		// 6. Runtime, isolation and containment, from the installation's tools.
		const runtime = resolveRuntimeV0([installation.tools.node]);
		if (!runtime.ok) return finish("BLOCKED", `runtime-${runtime.reason}`);
		const nodeFile = runtime.files.find((f) => f.target === installation.tools.node);
		const version = spawnSync(installation.tools.node, ["--version"], {
			env: {},
			encoding: "utf8",
			timeout: 5_000,
		}).stdout.trim();
		record.runtime = {
			node: installation.tools.node,
			sha256: nodeFile?.sha256 ?? null,
			version,
			files: runtime.files.length,
		};
		const detected = detectBubblewrapV0([installation.tools.bwrap]);
		if (!detected.ok) return finish("BLOCKED", `isolation-${detected.reason}`);
		const contained = await detectContainmentV0({ systemdRun: installation.tools.systemdRun });
		if (!contained.ok) return finish("BLOCKED", contained.reason);
		const ctx: Context = {
			oracle,
			node: installation.tools.node,
			runtime: runtime.files,
			bwrap: detected.bwrap,
			containment: contained.containment,
			journal,
		};
		record.isolation = {
			mechanism: "bubblewrap+systemd-user-scope",
			bubblewrap: detected.bwrap,
			containment: {
				version: contained.containment.version,
				systemdRunSha256: contained.containment.systemdRunSha256,
				tasksMax: contained.containment.tasksMax,
			},
		};
		// 7. The boundary, checked from inside the candidate's own profile.
		const profile = sandboxProfile(ctx, staging);
		const uid = process.getuid?.() ?? 0;
		const preflight: EndoPreflightV0 = await preflightV0(
			ctx.bwrap,
			profile,
			ctx.node,
			{
				protectedPaths: {
					"operator-home": installation.operatorHome,
					"state-directory": state,
					"installation-directory": installDir,
					"oracle-directory": loaded.dir,
				},
				readOnlyRuntime: [ctx.node],
				readOnlyMounts: ["/submission/.endo-probe", "/usr/.endo-probe"],
				writable: "/tmp",
				environment: [...Object.keys(SANDBOX_ENV), "PWD"],
				sockets: [
					`/run/user/${uid}`,
					`/run/user/${installation.operatorUid}`,
					"/run/dbus/system_bus_socket",
					"/var/run/docker.sock",
					"/run/docker.sock",
					"/run/libvirt/libvirt-sock",
					"/run/systemd/private",
					"/tmp/.X11-unix",
				],
			},
			ctx.containment,
			{ onScope: (unit) => journal({ event: "scope", phase: "preflight", unit }) },
		);
		record.preflight = preflight;
		(record.isolation as Record<string, unknown>).profileSha256 = profile.sha256;
		if (preflight.status !== "established") return finish("BLOCKED", `preflight-${preflight.status}`);
		// 8. Qualification: the pinned reference must pass and the pinned negative must fail, here and now.
		const qualification: Record<string, Verdict> = {};
		for (const [role, rel, content] of [
			["reference", oracle.reference, loaded.reference],
			["negative", oracle.negative, loaded.negative],
		] as const) {
			const copy = join(mine, role);
			stage(copy, [{ path: rel.split("/").pop() as string, mode: "100644", content }]);
			qualification[role] = (await runAll(ctx, copy, role)).verdict;
		}
		record.qualification = qualification;
		if (qualification.reference !== "PASS" || qualification.negative !== "FAIL")
			return finish("BLOCKED", "qualification-failed");
		// 9. The candidate. Its staged tree is digested before and after: a change in between makes the run INCOMPLETE. This detects an
		// unreverted change in the rehearsal; it is not the boundary (a change that is reverted in time is not seen).
		const before = endoTreeDigestV0(staging);
		journal({ event: "phase", phase: "candidate", stagingSha256: before });
		casesStarted = true;
		const result = await runAll(ctx, staging, "candidate");
		const after = endoTreeDigestV0(staging);
		record.staging = { before, after };
		record.cases = result.observations;
		record.compatibility = compatibilitySignals(result.observations);
		if (before !== after) return finish("INCOMPLETE", "staging-changed");
		return finish(result.verdict, null);
	} catch (error) {
		return finish(
			casesStarted ? "INCOMPLETE" : "BLOCKED",
			`controller-error: ${String((error as Error).message).slice(0, 200)}`,
		);
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "serve") process.exitCode = await serve(rest);
	else {
		process.stderr.write("usage: verifier.ts serve --install <dir> --state <dir> --peer <instance>\n");
		process.exitCode = 64;
	}
}
