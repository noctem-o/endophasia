// The one isolation mechanism of protected experiments (docs/protected-experiments.md): Bubblewrap, run unprivileged in fresh user,
// mount, PID, network, IPC, UTS and cgroup namespaces, with an empty read-only root into which only declared files and directories are
// mounted. Nothing here accepts a flag, a host path or a network destination from trial content: the profile is built by trusted code from
// the operator's spec, and every host path in it has a role.
//
// What this enforces is checked from inside by the preflight probes (preflight.ts), never assumed from the arguments. What it does not
// cover (kernel exploits, resource exhaustion of the host disk, side channels) is in the documentation.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { type EndoContainmentV0, newScopeUnitV0, processInScopeV0, scopeArgsV0, stopScopeV0 } from "./containment.ts";

/** The only places the executable is looked for: never PATH, which trial content or the operator's shell could shape. */
export const ENDO_BUBBLEWRAP_CANDIDATES_V0 = ["/usr/bin/bwrap"] as const;

export interface EndoBubblewrapV0 {
	path: string;
	version: string;
	sha256: string;
}

export type EndoIsolationRefusalV0 =
	| { ok: false; reason: "missing"; detail: string }
	| { ok: false; reason: "untrusted-executable"; detail: string }
	| { ok: false; reason: "setuid-unsupported"; detail: string }
	| { ok: false; reason: "namespaces-unavailable"; detail: string }
	| { ok: false; reason: "runtime-unacceptable"; detail: string };

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A file the sandbox may execute or load: a regular file owned by root, writable by no one else, in directories owned by root. */
function trustedFileProblem(path: string): string | null {
	const s = lstatSync(path, { throwIfNoEntry: false });
	if (s === undefined) return `${path} does not exist`;
	if (!s.isFile()) return `${path} is not a regular file`;
	if (s.uid !== 0) return `${path} is not owned by root`;
	if ((s.mode & 0o022) !== 0) return `${path} is writable by group or others`;
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		const d = statSync(dir);
		if (d.uid !== 0 || (d.mode & 0o022) !== 0)
			return `${dir} (a parent of ${path}) is not a root-owned, non-writable directory`;
		if (dir === "/") break;
	}
	return null;
}

/**
 * Find Bubblewrap and check that this host can enforce the profile: a trusted executable, not setuid (its privileged mode behaves
 * differently and is not supported), and a real sandbox started with every namespace this profile needs.
 */
export function detectBubblewrapV0(
	candidates: readonly string[] = ENDO_BUBBLEWRAP_CANDIDATES_V0,
): { ok: true; bwrap: EndoBubblewrapV0 } | EndoIsolationRefusalV0 {
	const path = candidates.find((c) => existsSync(c));
	if (path === undefined)
		return { ok: false, reason: "missing", detail: `bubblewrap was not found at ${candidates.join(", ")}` };
	const problem = trustedFileProblem(path);
	if (problem !== null) return { ok: false, reason: "untrusted-executable", detail: problem };
	if ((lstatSync(path).mode & 0o6000) !== 0)
		return { ok: false, reason: "setuid-unsupported", detail: `${path} is setuid or setgid` };
	const version = spawnSync(path, ["--version"], { env: {}, encoding: "utf8", timeout: 5000 });
	const v = /^bubblewrap ([0-9][0-9.]*)\s*$/.exec(version.stdout ?? "");
	if (version.status !== 0 || v === null)
		return { ok: false, reason: "missing", detail: `${path} --version did not report a bubblewrap version` };
	// A real sandbox, with the same namespace flags as every profile: refused here if the kernel or its policy does not allow them. This
	// capability check alone mounts the host's /usr read-only, to run a trusted /usr/bin/true; no trial profile does.
	const probe = spawnSync(
		path,
		[
			...NAMESPACE_FLAGS,
			"--ro-bind",
			"/usr",
			"/usr",
			"--symlink",
			"usr/lib",
			"/lib",
			"--symlink",
			"usr/lib64",
			"/lib64",
			"--remount-ro",
			"/",
			"--",
			"/usr/bin/true",
		],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	if (probe.status !== 0)
		return {
			ok: false,
			reason: "namespaces-unavailable",
			detail: `a sandbox could not be started: ${(probe.stderr ?? "").trim().slice(0, 300) || `exit ${probe.status}`}`,
		};
	return { ok: true, bwrap: { path, version: v[1] as string, sha256: sha256File(path) } };
}

// ---- the runtime ---------------------------------------------------------------------------------------------------------------------------

/** One file of the runtime: where it appears inside, where it comes from, and its content digest. */
export interface EndoRuntimeFileV0 {
	target: string;
	source: string;
	sha256: string;
}

/**
 * The executables and every shared library they load (by `ldd`, run on the trusted executables only), each a trusted file. Each library is
 * mounted at the path the loader asks for, from its real file: a link in the host's library directory is followed here, never inside.
 */
export function resolveRuntimeV0(
	executables: readonly string[],
): { ok: true; files: EndoRuntimeFileV0[] } | EndoIsolationRefusalV0 {
	const files = new Map<string, EndoRuntimeFileV0>();
	const add = (target: string, source: string): string | null => {
		const real = realpathSync(source);
		const problem = trustedFileProblem(real);
		if (problem !== null) return problem;
		if (!files.has(target)) files.set(target, { target, source: real, sha256: sha256File(real) });
		return null;
	};
	for (const exe of executables) {
		const s = lstatSync(exe, { throwIfNoEntry: false });
		if (s === undefined || s.isSymbolicLink())
			return {
				ok: false,
				reason: "runtime-unacceptable",
				detail: `${exe} must be the executable's real path, not a link`,
			};
		const problem = add(exe, exe);
		if (problem !== null) return { ok: false, reason: "runtime-unacceptable", detail: problem };
		const ldd = spawnSync("/usr/bin/ldd", [exe], { env: {}, encoding: "utf8", timeout: 10_000 });
		if (ldd.status !== 0)
			return { ok: false, reason: "runtime-unacceptable", detail: `ldd could not list ${exe}'s libraries` };
		for (const line of (ldd.stdout ?? "").split("\n")) {
			const linked = /^\s*(\S+) => (\/\S+) \(0x[0-9a-f]+\)\s*$/.exec(line);
			const direct = /^\s*(\/\S+) \(0x[0-9a-f]+\)\s*$/.exec(line);
			const pairs: [string, string][] = [];
			if (linked !== null) {
				const [, name, path] = linked as unknown as [string, string, string];
				pairs.push([path, path]);
				if (name.startsWith("/")) pairs.push([name, path]);
			} else if (direct !== null) pairs.push([direct[1] as string, direct[1] as string]);
			else if (/^\s*linux-vdso\.so\.1 \(0x[0-9a-f]+\)\s*$/.test(line) || line.trim() === "") continue;
			else return { ok: false, reason: "runtime-unacceptable", detail: `unexpected ldd line for ${exe}` };
			for (const [target, source] of pairs) {
				const p = add(target, source);
				if (p !== null) return { ok: false, reason: "runtime-unacceptable", detail: p };
			}
		}
	}
	return { ok: true, files: [...files.values()].sort((a, b) => (a.target < b.target ? -1 : 1)) };
}

// ---- the profile ---------------------------------------------------------------------------------------------------------------------------

/** Every namespace, no new user namespaces inside, no capabilities, a new session (no terminal injection), killed with its parent. */
const NAMESPACE_FLAGS = [
	"--unshare-all",
	"--unshare-user",
	"--disable-userns",
	"--assert-userns-disabled",
	"--die-with-parent",
	"--new-session",
	"--cap-drop",
	"ALL",
	"--clearenv",
] as const;
export const ENDO_SANDBOX_NAMESPACES_V0 = ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"] as const;

export interface EndoSandboxMountV0 {
	target: string;
	kind: "ro-file" | "ro-dir" | "rw-dir";
	/** The role of the host source: recorded and digested instead of its path. */
	role: string;
	source: string;
	/** For a read-only file, its content digest; for a read-only directory, the digest of its tree (endoTreeDigestV0). */
	sha256?: string;
}

/**
 * The digest of a directory tree a sandbox mounts read-only: every entry by relative path, kind, size and content digest, sorted. A link or
 * special file is refused (a mounted link would point at the host's namespace, not the sandbox's).
 */
export function endoTreeDigestV0(root: string): string {
	const entries: [string, string, number, string][] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = `${dir}/${name}`;
			const s = lstatSync(path);
			if (s.isDirectory()) {
				entries.push([`${prefix}${name}`, "dir", 0, ""]);
				walk(path, `${prefix}${name}/`);
			} else if (s.isFile())
				// The permission bits a copy keeps (owner, group, others; read and execute; and the owner's write) are part of the identity: an
				// executable bit changes what a file does.
				entries.push([`${prefix}${name}`, `file:${(s.mode & 0o755).toString(8)}`, s.size, sha256File(path)]);
			else throw new TypeError(`${path} is not a regular file or directory`);
		}
	};
	walk(root, "");
	return sha256HexV0(canonicalEndoJsonV0(entries));
}

export interface EndoSandboxProfileInputV0 {
	runtime: readonly EndoRuntimeFileV0[];
	mounts: readonly EndoSandboxMountV0[];
	env: Readonly<Record<string, string>>;
	cwd: string;
	tmpfsBytes: number;
	/** Test-only weakenings, used to show that each probe detects its restriction's removal. Never reachable from a spec or the CLI. */
	unsafeForTests?: {
		shareNet?: boolean;
		extraRoBind?: { source: string; target: string };
		extraEnv?: Record<string, string>;
		writableRoot?: boolean;
	};
}

export interface EndoSandboxProfileV0 {
	args: string[];
	/** What the profile requests, as recorded: no host path, every file by digest. */
	logical: {
		namespaces: string[];
		network: "none";
		rootReadOnly: true;
		userNamespacesDisabled: true;
		environment: string[];
		mounts: { target: string; kind: string; role: string | null; sha256: string | null }[];
	};
	/** sha256 of the canonical logical profile, with the environment's values and the working directory. */
	sha256: string;
}

const LOGICAL_PATH = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._+\-/]{1,200}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** The arguments for one sandbox, from trusted inputs. Pure: the same inputs give the same arguments and digest. */
export function buildSandboxProfileV0(input: EndoSandboxProfileInputV0): EndoSandboxProfileV0 {
	const args: string[] = [...NAMESPACE_FLAGS];
	if (input.unsafeForTests?.shareNet === true) args.splice(1, 0, "--share-net");
	const mounts: EndoSandboxProfileV0["logical"]["mounts"] = [];
	const check = (target: string) => {
		if (!LOGICAL_PATH.test(target)) throw new TypeError(`sandbox target ${target} is not a plain absolute path`);
	};
	for (const [name, value] of Object.entries(input.env)) {
		if (!ENV_NAME.test(name) || value.includes("\0"))
			throw new TypeError(`environment variable ${name} is not acceptable`);
		args.push("--setenv", name, value);
	}
	args.push("--proc", "/proc", "--dev", "/dev");
	mounts.push(
		{ target: "/proc", kind: "proc", role: null, sha256: null },
		{ target: "/dev", kind: "dev", role: null, sha256: null },
	);
	for (const target of ["/tmp", "/home/agent"]) {
		args.push("--size", String(input.tmpfsBytes), "--tmpfs", target);
		mounts.push({ target, kind: "tmpfs", role: null, sha256: null });
	}
	for (const f of input.runtime) {
		check(f.target);
		args.push("--ro-bind", f.source, f.target);
		mounts.push({ target: f.target, kind: "ro-file", role: "runtime", sha256: f.sha256 });
	}
	// The loader's own path on this layout: /lib64 is a link into /usr/lib64 on the host; inside, it is a link too, to the mounted file.
	if (
		input.runtime.some((f) => f.target.startsWith("/usr/lib64/")) &&
		!input.runtime.some((f) => f.target.startsWith("/lib64/"))
	) {
		args.push("--symlink", "usr/lib64", "/lib64");
		mounts.push({ target: "/lib64", kind: "symlink", role: null, sha256: null });
	}
	for (const m of input.mounts) {
		check(m.target);
		if (m.kind === "ro-file" && m.sha256 === undefined)
			throw new TypeError(`read-only file ${m.target} needs its digest`);
		args.push(m.kind === "rw-dir" ? "--bind" : "--ro-bind", m.source, m.target);
		mounts.push({
			target: m.target,
			kind: m.kind,
			role: m.role,
			sha256: m.kind === "ro-file" ? (m.sha256 as string) : null,
		});
	}
	if (input.unsafeForTests?.extraRoBind !== undefined)
		args.push("--ro-bind", input.unsafeForTests.extraRoBind.source, input.unsafeForTests.extraRoBind.target);
	check(input.cwd);
	args.push("--chdir", input.cwd);
	for (const [name, value] of Object.entries(input.unsafeForTests?.extraEnv ?? {})) args.push("--setenv", name, value);
	// Last: everything not mounted writable above is read-only, including the sandbox's own root and its /dev (writable, /dev would be an
	// unbounded tmpfs; its device nodes stay usable).
	if (input.unsafeForTests?.writableRoot !== true) args.push("--remount-ro", "/", "--remount-ro", "/dev");
	const logical: EndoSandboxProfileV0["logical"] = {
		namespaces: [...ENDO_SANDBOX_NAMESPACES_V0],
		network: "none",
		rootReadOnly: true,
		userNamespacesDisabled: true,
		environment: Object.keys(input.env).sort(),
		mounts: [...mounts].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
	};
	const sha256 = sha256HexV0(
		canonicalEndoJsonV0({
			logical,
			env: Object.fromEntries(Object.entries(input.env).sort()),
			cwd: input.cwd,
			tmpfsBytes: input.tmpfsBytes,
			directories: input.mounts.filter((m) => m.kind === "ro-dir").map((m) => [m.target, m.sha256 ?? null]),
			unsafe: input.unsafeForTests === undefined ? null : "weakened-for-tests",
		}),
	);
	return { args, logical, sha256 };
}

// ---- running -------------------------------------------------------------------------------------------------------------------------------

export interface EndoSandboxRunV0 {
	/** Whether bubblewrap started the sandbox (it reported its first process, and that process could be identified). */
	started: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	durationMs: number;
	stdout: Buffer;
	stderr: Buffer;
	/** Bytes the controller did not keep because of the bound. */
	truncated: { stdout: number; stderr: number };
	/** The sandbox's first process (the init of its PID namespace), by host pid and start time: an identity, unlike a namespace number. */
	init: EndoProcessIdentityV0 | null;
	/**
	 * The sandbox's scope (containment.ts): its unit, whether bubblewrap was seen running inside it, and whether the user manager confirmed
	 * it ended (every process of its cgroup gone).
	 */
	scope: { unit: string; established: boolean; ended: "confirmed" | "unconfirmed" };
	/** Supplementary: whether the sandbox's init (that pid with that start time) is gone. Not, on its own, the termination guarantee. */
	initGone: boolean | null;
	/**
	 * `confirmed` exactly when the sandbox ran in its scope and the user manager confirmed the scope ended: no process the sandbox started,
	 * whatever its pid, group or session, can still run. `unconfirmed` otherwise.
	 */
	termination: "confirmed" | "unconfirmed";
}

/** A host process by pid and kernel start time (/proc/<pid>/stat, field 22): a pid is reused, the pair is not. */
export interface EndoProcessIdentityV0 {
	pid: number;
	startTime: string;
}

/** The start time of a host process, or null when there is no such process. */
export function processStartTimeV0(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) is in parentheses and may contain spaces: count the fields after its closing parenthesis.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const start = rest[19];
		return start !== undefined && /^[0-9]+$/.test(start) ? start : null;
	} catch {
		return null;
	}
}

/** Whether exactly this process (pid and start time) still exists. */
export const processAliveV0 = (p: EndoProcessIdentityV0): boolean => processStartTimeV0(p.pid) === p.startTime;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * End a sandbox for certain: kill its init, identified by pid and start time (never a process found by namespace number, which the kernel
 * reuses), and wait until it is gone. Confirmed only when it is.
 */
export async function endSandboxV0(init: EndoProcessIdentityV0): Promise<"confirmed" | "unconfirmed"> {
	// Up to ten seconds: a namespace with many processes or much memory takes time to tear down.
	for (let i = 0; i < 200 && processAliveV0(init); i++) {
		try {
			process.kill(init.pid, "SIGKILL");
		} catch {
			// already gone
		}
		await sleep(50);
	}
	return processAliveV0(init) ? "unconfirmed" : "confirmed";
}

/**
 * Run one command in one sandbox. Bubblewrap's options are passed through a pipe (`--args`), so no host path appears in the sandbox's
 * /proc/1/cmdline; the command itself (logical paths only) follows `--`. Bubblewrap gets no environment; stdio is three pipes, and the
 * status and option pipes are bubblewrap's own. On timeout bubblewrap is killed, which kills the sandbox (it dies with its parent), and
 * afterwards the sandbox's init is ended for certain (endSandboxV0).
 */
export async function runSandboxV0(
	bwrap: EndoBubblewrapV0,
	profile: EndoSandboxProfileV0,
	argv: readonly string[],
	options: {
		timeoutMs: number;
		outputBytes: number;
		/** The containment the sandbox runs in. Required: a protected sandbox never runs outside a scope. */
		containment: EndoContainmentV0;
		stdin?: Buffer;
		/** Called with the scope's unit before anything is started, so a caller can record it durably first. */
		onScope?: (unit: string) => void;
		onStarted?: (init: EndoProcessIdentityV0) => void;
	},
): Promise<EndoSandboxRunV0> {
	const start = performance.now();
	const unit = newScopeUnitV0();
	options.onScope?.(unit);
	const opts = ["--json-status-fd", "3", ...profile.args];
	if ([...opts, ...argv].some((a) => a.includes("\0")))
		throw new TypeError("a sandbox argument holds a NUL character");
	// Its own process group (bubblewrap issue #633): until the sandbox's first process calls setsid (after bubblewrap releases it), it is
	// in this group, so a group kill reaches it even in the launch window where --die-with-parent does not yet hold for it.
	// systemd-run registers the scope (with itself in it) and only then execs bubblewrap: bubblewrap never runs outside the scope. The
	// scope's own deadline (the timeout and a margin) ends it even if this controller is gone.
	const runtimeMaxSec = options.timeoutMs / 1000 + 30;
	const child = spawn(
		options.containment.systemdRun,
		scopeArgsV0(options.containment, unit, runtimeMaxSec, [bwrap.path, "--args", "4", "--", ...argv]),
		{
			env: { ...options.containment.env },
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
			detached: true,
		},
	);
	const killGroup = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// the group is gone
		}
	};
	const argsPipe = child.stdio[4] as NodeJS.WritableStream;
	argsPipe.on("error", () => {});
	argsPipe.end(Buffer.from(`${opts.join("\0")}\0`, "utf8"));
	const bounded = () => {
		const chunks: Buffer[] = [];
		let kept = 0;
		let dropped = 0;
		return {
			push: (b: Buffer) => {
				const room = Math.max(0, options.outputBytes - kept);
				if (room > 0) chunks.push(b.subarray(0, room));
				kept += Math.min(room, b.length);
				dropped += Math.max(0, b.length - room);
			},
			value: () => ({ bytes: Buffer.concat(chunks), dropped }),
		};
	};
	const out = bounded();
	const err = bounded();
	let status = "";
	let init: EndoProcessIdentityV0 | null = null;
	let established = false;
	child.stdout.on("data", out.push);
	child.stderr.on("data", err.push);
	(child.stdio[3] as NodeJS.ReadableStream).on("data", (b: Buffer) => {
		status += b.toString("utf8");
		const m = /"child-pid":\s*([0-9]+)/.exec(status);
		if (m !== null && !established && child.pid !== undefined) established = processInScopeV0(child.pid, unit);
		if (m !== null && init === null) {
			const pid = Number(m[1]);
			// Read while the sandbox runs (bubblewrap waits on its init): that pid cannot belong to another process yet.
			const startTime = processStartTimeV0(pid);
			if (startTime !== null) {
				init = { pid, startTime };
				options.onStarted?.(init);
			}
		}
	});
	child.stdin.on("error", () => {});
	child.stdin.end(options.stdin ?? Buffer.alloc(0));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, options.timeoutMs);
	const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
		child.on("error", () => resolve([null, null]));
		child.on("close", (c, s) => resolve([c, s]));
		// A sandbox process stranded in bubblewrap's launch window (#633) can hold the output pipes open forever. Once bubblewrap itself
		// has exited, wait a bounded time for the pipes, then stop waiting: termination is then decided below, not by a pipe's end.
		child.on("exit", (c, s) => {
			// Bubblewrap is gone: stop its scope at once, which ends anything left in it (a process stranded in the launch window holds
			// the pipes open), so the pipes can close.
			void stopScopeV0(options.containment, unit);
			setTimeout(() => {
				// No group kill here: once bubblewrap is reaped its group number can be reused by an unrelated group. A process stranded in
				// the launch window is ended with the sandbox's scope (containment.ts), never by a number.
				for (const stream of [child.stdout, child.stderr, child.stdio[3]])
					(stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
				resolve([c, s]);
			}, 2000).unref();
		});
	});
	clearTimeout(timer);
	// bubblewrap reports the command's own exit code on the status fd.
	const exitStatus = /"exit-code":\s*([0-9]+)/.exec(status);
	const known = init as EndoProcessIdentityV0 | null;
	// The guarantee: the user manager confirms the scope ended. The init's identity is kept as a supplementary observation.
	const ended = await stopScopeV0(options.containment, unit);
	const initGone = known === null ? null : (await endSandboxV0(known)) === "confirmed";
	const termination = established && ended === "confirmed" ? "confirmed" : "unconfirmed";
	const o = out.value();
	const e = err.value();
	return {
		started: known !== null,
		exitCode: exitStatus !== null ? Number(exitStatus[1]) : known !== null ? null : code,
		signal: timedOut ? "SIGKILL" : signal,
		timedOut,
		durationMs: Math.round(performance.now() - start),
		stdout: o.bytes,
		stderr: e.bytes,
		truncated: { stdout: o.dropped, stderr: e.dropped },
		init: known,
		scope: { unit, established, ended },
		initGone,
		termination,
	};
}
