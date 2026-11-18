import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	ENDO_SANDBOX_NAMESPACES_V0,
	type EndoProcessIdentityV0,
	processStartTimeV0,
	resolveRuntimeV0,
	resolveTrustedRuntimeFileV0,
	runSandboxV0,
} from "../../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, scopeControlGroupV0 } from "../../adapters/sandbox/containment.ts";
import { admitWorkspaceV0, type WorkspaceAdmissionInputV0 } from "../../adapters/sandbox/workspace-admission.ts";
import { OFFLINE_ENV, OFFLINE_NODE, PINNED_PI_ROOT, trustedPiInstallation } from "../develop-isolate-001/diagnostic.ts";

const PYTHON = "/usr/bin/python3.14";
const PYTHON_LIB = "/usr/lib/python3.14";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const PI_ENTRY = "/pi/dist/bundle/cli.js";
const PI_ARGV = [
	OFFLINE_NODE,
	PI_ENTRY,
	"--mode",
	"rpc",
	"--offline",
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-approve",
	"--no-themes",
] as const;
const SHIM = `import posix, sys
fd = 6
posix.set_inheritable(fd, False)
if posix.write(fd, b"R") != 1:
    sys.exit(121)
challenge = b""
while len(challenge) != 32:
    block = posix.read(fd, 32 - len(challenge))
    if not block:
        sys.exit(122)
    challenge += block
if posix.write(fd, challenge) != 32 or posix.read(fd, 1) != b"G":
    sys.exit(123)
posix.execv(sys.argv[1], sys.argv[1:])`;
const SHIM_ARGV = [PYTHON, "-I", "-S", "-B", "-c", SHIM, ...PI_ARGV] as const;

const statId = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
const inode = (path: string) => statId(statSync(path, { bigint: true }));

function workspaceId(path: string): string {
	const s = lstatSync(path, { bigint: true });
	if (!s.isDirectory() || realpathSync(path) !== path) throw new Error("workspace path is no longer canonical");
	return statId(s);
}

function procRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(
			`host cannot read ${path.replace(/^\/proc\/\d+\//, "/proc/<pid>/")}: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
		);
	}
}

function processFields(proc: string): string[] {
	const stat = procRead(`${proc}/stat`);
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function execImage(proc: string): string {
	const fields = processFields(proc);
	const locations = [fields[23], fields[25], fields[42], fields[44], fields[45], fields[47]];
	demand(
		locations.every((part) => part !== undefined && /^[1-9]\d+$/.test(part)),
		"process image fields unavailable",
	);
	return locations.join(":");
}

const namespaces = (proc: string) => ENDO_SANDBOX_NAMESPACES_V0.map((name) => readlinkSync(`${proc}/ns/${name}`));

function demand(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(reason);
}

function credentialsClosed(proc: string, pid: number, uid: number): boolean {
	const status = procRead(`${proc}/status`);
	const numbers = (key: string) =>
		new RegExp(`^${key}:[ \\t]+([0-9 \\t]+)$`, "m").exec(status)?.[1]?.trim().split(/\s+/);
	const uids = numbers("Uid");
	const pids = numbers("NSpid");
	return (
		uids?.length === 4 &&
		uids.every((value) => value === String(uid)) &&
		pids?.length === 2 &&
		pids[0] === String(pid) &&
		pids[1] === "1" &&
		/^NoNewPrivs:[ \t]+1$/m.test(status) &&
		["Inh", "Prm", "Eff", "Bnd", "Amb"].every((cap) => new RegExp(`^Cap${cap}:[ \\t]+0{16}$`, "m").test(status))
	);
}

function readFrame(stream: Readable, limit: number, length?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let frame = Buffer.alloc(0);
		const cleanup = () => {
			stream.off("data", data);
			stream.off("error", closed);
			stream.off("end", closed);
			stream.off("close", closed);
		};
		const closed = () => {
			cleanup();
			reject(new Error("launch transport closed before a complete frame"));
		};
		const data = (chunk: Buffer) => {
			if (frame.length + chunk.length > limit) {
				cleanup();
				reject(new Error("launch frame exceeded its limit or contained extra bytes"));
				return;
			}
			frame = Buffer.concat([frame, chunk]);
			const end = length === undefined ? frame.indexOf(10) + 1 : frame.length === length ? length : 0;
			if (end === 0) return;
			cleanup();
			if (end !== frame.length) reject(new Error("unexpected bytes after launch frame"));
			else resolve(frame);
		};
		if (stream.destroyed || stream.readableEnded) {
			closed();
			return;
		}
		stream.once("error", closed);
		stream.once("end", closed);
		stream.once("close", closed);
		stream.on("data", data);
	});
}

type SubjectState = "matches" | "wrong-session-or-workspace" | "protection-lost";

export function watchPiSubjectV0(sessionId: string, root: string, matches: () => boolean) {
	let lost = false;
	return {
		observe(candidateSession: string, candidateRoot: string): SubjectState {
			if (candidateSession !== sessionId || candidateRoot !== root) return "wrong-session-or-workspace";
			if (!lost) {
				try {
					lost = !matches();
				} catch {
					lost = true;
				}
			}
			return lost ? "protection-lost" : "matches";
		},
	};
}

type Subject = ReturnType<typeof watchPiSubjectV0>;

export async function runAttestedPiV0(
	input: WorkspaceAdmissionInputV0,
	onObserved?: (subject: Subject, sessionId: string, process: EndoProcessIdentityV0) => void,
) {
	let stage = "admission";
	const refused = (detail: string) => ({ ok: false as const, stage, detail });
	const admitted = admitWorkspaceV0(input);
	if (!admitted.ok) return refused(admitted.detail);
	try {
		stage = "trusted-launch";
		const uid = process.getuid?.();
		demand(uid !== undefined && uid > 0, "requires an unprivileged Linux controller");
		demand(trustedPiInstallation(), "the pinned Pi installation did not validate");
		const bwrap = detectBubblewrapV0();
		if (!bwrap.ok) return refused(bwrap.detail);
		const scope = await detectContainmentV0();
		if (!scope.ok) return refused(scope.detail);
		const runtime = resolveRuntimeV0([PYTHON, OFFLINE_NODE]);
		if (!runtime.ok) return refused(runtime.detail);
		const bootstrap = [
			"os.py",
			"linecache.py",
			"encodings/__init__.py",
			"encodings/aliases.py",
			"encodings/utf_8.py",
		].map((name) => resolveTrustedRuntimeFileV0(`${PYTHON_LIB}/${name}`));
		demand(
			bootstrap.every((file) => file !== null),
			"Python shim bootstrap is not root-managed",
		);
		demand(
			[PYTHON, OFFLINE_NODE].every((path) => (lstatSync(path).mode & 0o6000) === 0),
			"set-ID shim or Pi runtime",
		);
		const profile = buildSandboxProfileV0({
			runtime: [...runtime.files, ...bootstrap],
			mounts: [
				{ kind: "ro-dir", source: admitted.snapshot, target: "/work", role: "admitted-workspace" },
				{ kind: "ro-dir", source: PINNED_PI_ROOT, target: "/pi", role: "pinned-offline-pi" },
			],
			env: OFFLINE_ENV,
			cwd: "/work",
			tmpfsBytes: 32 * 1024 * 1024,
		});
		const hostNamespaces = namespaces("/proc/self");
		const bootId = procRead(BOOT_ID).trim();
		demand(/^[a-f0-9-]{36}$/.test(bootId), "boot ID unavailable");
		const mountedWorkspace = workspaceId(admitted.snapshot);
		const shimExe = inode(PYTHON);
		const piExe = inode(OFFLINE_NODE);
		const piEntry = inode(`${PINNED_PI_ROOT}/dist/bundle/cli.js`);
		let detail = "launcher did not complete the handshake";
		let observed: { subject: Subject; sessionId: string; pid: number; atRpc: SubjectState } | undefined;
		let endpoints: string[] | undefined;
		stage = "scope";
		const run = await runSandboxV0(bwrap.bwrap, profile, SHIM_ARGV, {
			containment: scope.containment,
			timeoutMs: 12_000,
			outputBytes: 32 * 1024,
			onLauncher(launcher) {
				try {
					endpoints = [0, 1, 2, 6].map((fd) => readlinkSync(`/proc/${launcher.pid}/fd/${fd}`));
				} catch {
					endpoints = undefined;
				}
			},
			experimentalLaunch: async ({ unit, launcher, init, challenge, stdin, stdout }) => {
				try {
					const group = scopeControlGroupV0(scope.containment, unit);
					demand(group !== null, "systemd did not report the exact active scope path");
					const proc = `/proc/${init.pid}`;
					const parent = `/proc/${launcher.pid}`;
					const inGroup = (base: string) => procRead(`${base}/cgroup`).trim() === `0::${group}`;
					stage = "shim";
					demand((await readFrame(challenge, 1, 1)).equals(Buffer.from("R")), "unexpected shim readiness marker");
					const expectedNamespaces = namespaces(proc);
					demand(
						expectedNamespaces.every((link, i) => link !== hostNamespaces[i]),
						"sandbox namespace is shared with host",
					);
					demand(
						!procRead(`${proc}/mountinfo`)
							.split("\n")
							.some((line) => / - cgroup2? /.test(line)),
						"a cgroup filesystem is visible inside the sandbox",
					);
					demand(
						endpoints?.length === 4 &&
							endpoints.every((link) => /^socket:\[\d+\]$/.test(link)) &&
							new Set(endpoints).size === 4,
						"the launched child did not inherit four distinct transport sockets",
					);
					const stdio = endpoints.slice(0, 3);
					const socket = readlinkSync(`${proc}/fd/6`);
					const flags = /^flags:[ \t]+([0-7]+)$/m.exec(procRead(`${proc}/fdinfo/6`))?.[1];
					demand(
						/^socket:\[\d+\]$/.test(socket) &&
							!stdio.includes(socket) &&
							endpoints[3] === socket &&
							flags !== undefined &&
							(BigInt(`0o${flags}`) & 0o2000000n) !== 0n,
						"shim challenge descriptor is not the inherited, close-on-exec transport",
					);
					const sameKernelSubject = () => {
						const fields = processFields(proc);
						return (
							fields[0] !== "Z" &&
							fields[0] !== "X" &&
							fields[1] === String(launcher.pid) &&
							fields[19] === init.startTime &&
							processStartTimeV0(launcher.pid) === launcher.startTime &&
							inGroup(parent) &&
							inGroup(proc) &&
							procRead(BOOT_ID).trim() === bootId &&
							credentialsClosed(proc, init.pid, uid) &&
							namespaces(proc).every((value, i) => value === expectedNamespaces[i]) &&
							inode(`${proc}/root/work`) === mountedWorkspace &&
							inode(`${proc}/cwd`) === mountedWorkspace &&
							workspaceId(admitted.snapshot) === mountedWorkspace &&
							workspaceId(admitted.workspaceRoot) === admitted.workspaceIdentity &&
							stdio.every((link, fd) => readlinkSync(`${proc}/fd/${fd}`) === link)
						);
					};
					const cmdline = (argv: readonly string[]) => procRead(`${proc}/cmdline`) === `${argv.join("\0")}\0`;
					demand(
						sameKernelSubject() && inode(`${proc}/exe`) === shimExe && cmdline(SHIM_ARGV),
						"host could not bind the trusted shim to the launcher, scope and admitted workspace",
					);
					stage = "challenge";
					const nonce = randomBytes(32);
					const answer = readFrame(challenge, nonce.length, nonce.length);
					challenge.write(nonce);
					demand(timingSafeEqual(nonce, await answer), "shim challenge response did not match");
					demand(
						sameKernelSubject() && inode(`${proc}/exe`) === shimExe && cmdline(SHIM_ARGV),
						"shim identity changed before release",
					);
					stage = "exec";
					const frame = readFrame(stdout, 32 * 1024);
					void frame.catch(() => {});
					challenge.write("G");
					const deadline = performance.now() + 3000;
					while (inode(`${proc}/exe`) === shimExe && performance.now() < deadline) await sleep(10);
					demand(inode(`${proc}/exe`) === piExe, "the trusted shim did not exec the pinned Pi runtime");
					const piImage = execImage(proc);
					const challengeGone = () => {
						try {
							return readlinkSync(`${proc}/fd/6`) !== socket;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
							throw error;
						}
					};
					const samePi = () => {
						demand(sameKernelSubject(), "Pi lifetime, scope, namespaces, workspace or transport no longer match");
						demand(inode(`${proc}/exe`) === piExe, "Pi executable inode no longer matches the launch");
						demand(execImage(proc) === piImage, "Pi process image no longer matches the launch");
						demand(inode(`${proc}/root${PI_ENTRY}`) === piEntry, "Pi package entry inode no longer matches");
						demand(challengeGone(), "Pi inherited the challenge descriptor");
						return processStartTimeV0(init.pid) === init.startTime;
					};
					demand(
						samePi(),
						"same-PID exec into the pinned Pi with the challenge descriptor closed was not verified",
					);
					challenge.end();
					stage = "rpc-state";
					const id = randomBytes(16).toString("hex");
					stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
					const reply = JSON.parse((await frame).toString("utf8"));
					demand(
						reply?.id === id &&
							reply.type === "response" &&
							reply.command === "get_state" &&
							reply.success === true &&
							typeof reply.data?.sessionId === "string" &&
							reply.data.sessionId.length > 0 &&
							reply.data.sessionId.length <= 256,
						"the first Pi RPC response did not bind get_state to an ephemeral session ID",
					);
					const sessionId = reply.data.sessionId as string;
					demand(samePi(), "Pi exited or changed process identity before get_state completed");
					const subject = watchPiSubjectV0(sessionId, admitted.workspaceRoot, samePi);
					const atRpc = subject.observe(sessionId, admitted.workspaceRoot);
					demand(atRpc === "matches", "the Pi subject no longer matched when get_state completed");
					onObserved?.(subject, sessionId, init);
					observed = { subject, sessionId, pid: init.pid, atRpc };
					stdin.end();
				} catch (error) {
					detail = error instanceof Error ? error.message : "host launch observation failed";
					throw error;
				}
			},
		});
		const cleanup = { termination: run.termination, initGone: run.initGone };
		if (observed === undefined) return { ...refused(detail), ...cleanup, exitCode: run.exitCode };
		stage = "cleanup";
		if (
			!run.started ||
			run.timedOut ||
			run.exitCode !== 0 ||
			run.termination !== "confirmed" ||
			run.initGone !== true ||
			run.truncated.stdout !== 0 ||
			run.truncated.stderr !== 0
		)
			return { ...refused("the attested offline Pi run did not exit and clean up normally"), ...cleanup };
		const afterExit = observed.subject.observe(observed.sessionId, admitted.workspaceRoot);
		demand(afterExit === "protection-lost", "the subject failed open after process exit");
		return { ok: true as const, pid: observed.pid, atRpc: observed.atRpc, afterExit, ...cleanup };
	} catch (error) {
		return refused(error instanceof Error ? error.message : "host launch observation failed");
	} finally {
		admitted.dispose();
	}
}
