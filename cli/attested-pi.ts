import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { PiRpcClientV0, type PiRpcLaunchOptionsV0, piRpcArgumentsV0 } from "../adapters/pi/rpc.ts";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	ENDO_SANDBOX_NAMESPACES_V0,
	type EndoSandboxMountV0,
	processStartTimeV0,
	resolveRuntimeV0,
	resolveTrustedRuntimeFileV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, scopeControlGroupV0 } from "../adapters/sandbox/containment.ts";
import { ENV, NODE, PI, trustedPiInstallation } from "../adapters/sandbox/pi-runtime.ts";
import type { AdmittedWorkspaceV0 } from "../adapters/sandbox/workspace-admission.ts";

const PYTHON = "/usr/bin/python3.14";
const PYTHON_LIB = "/usr/lib/python3.14";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const PI_ENTRY = "/pi/dist/bundle/cli.js";
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
if sys.argv[1] == "model":
    actions = [(posix.POSIX_SPAWN_OPEN, n, "/dev/null", posix.O_RDWR, 0) for n in range(3)]
    actions.append((posix.POSIX_SPAWN_CLOSE, fd))
    posix.posix_spawn(sys.argv[2], [sys.argv[2], "/run/endo/bridge.cjs", "18080", "/run/endo/model.sock"], posix.environ, file_actions=actions)
posix.execv(sys.argv[2], sys.argv[2:])`;

export interface PiLaunchAttestationV0 {
	readonly session: string;
	readonly workspaceRoot: string;
	readonly check: () => boolean;
}

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
			{ cause: error },
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

function readFrame(stream: Readable, limit: number): Promise<Buffer> {
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
			const end = frame.length === limit ? limit : 0;
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

export async function startAttestedPiV0(
	admitted: AdmittedWorkspaceV0,
	input: {
		readonly model?: { readonly name: string; readonly mounts: readonly EndoSandboxMountV0[] };
		readonly onDiagnostic?: PiRpcLaunchOptionsV0["onDiagnostic"];
		readonly onClosed: () => Promise<void>;
	},
) {
	const uid = process.getuid?.();
	demand(
		uid !== undefined && uid > 0 && trustedPiInstallation(),
		"The pinned unprivileged Pi installation did not validate.",
	);
	const bwrap = detectBubblewrapV0();
	demand(bwrap.ok, "Bubblewrap isolation is unavailable.");
	const scope = await detectContainmentV0();
	demand(scope.ok, "An unprivileged user scope is unavailable.");
	const runtime = resolveRuntimeV0([PYTHON, NODE]);
	demand(runtime.ok, "The pinned launcher runtime did not validate.");
	const bootstrap = [
		"os.py",
		"linecache.py",
		"encodings/__init__.py",
		"encodings/aliases.py",
		"encodings/utf_8.py",
	].map((name) => resolveTrustedRuntimeFileV0(`${PYTHON_LIB}/${name}`));
	demand(
		bootstrap.every((file) => file !== null),
		"The Python shim bootstrap did not validate.",
	);
	demand(
		[PYTHON, NODE].every((path) => (lstatSync(path).mode & 0o6000) === 0),
		"The shim or Pi runtime has set-ID bits.",
	);
	const profile = buildSandboxProfileV0({
		runtime: [...runtime.files, ...bootstrap],
		mounts: [
			{ kind: "ro-dir", source: admitted.snapshot, target: "/work", role: "admitted-workspace" },
			{ kind: "ro-dir", source: PI, target: "/pi", role: "pinned-pi" },
			...(input.model?.mounts ?? []),
		],
		env: ENV,
		cwd: "/work",
		tmpfsBytes: 32 * 1024 * 1024,
	});
	const rpc: PiRpcLaunchOptionsV0 = {
		executable: PI_ENTRY,
		cwd: "/work",
		env: ENV,
		session: { kind: "ephemeral" },
		offline: true,
		tools: "none",
		governedToolFree: true,
		requestTimeoutMs: 4000,
		maxOutputBytes: 32 * 1024 * 1024,
		...(input.model === undefined ? {} : { provider: "relay", model: input.model.name }),
		...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
	};
	const argv = [
		PYTHON,
		"-I",
		"-S",
		"-B",
		"-c",
		SHIM,
		input.model === undefined ? "offline" : "model",
		NODE,
		PI_ENTRY,
		"--mode",
		"rpc",
		...piRpcArgumentsV0(rpc),
		"--no-themes",
		...(input.model === undefined ? [] : ["--thinking", "off"]),
	];
	const hostNamespaces = namespaces("/proc/self");
	const boot = procRead(BOOT_ID).trim();
	demand(/^[a-f0-9-]{36}$/.test(boot), "The kernel boot identity could not be read.");
	const snapshot = workspaceId(admitted.snapshot);
	const shimExe = inode(PYTHON);
	const piExe = inode(NODE);
	const piEntry = inode(`${PI}/dist/bundle/cli.js`);
	let endpoints: string[] | undefined;
	const ready = Promise.withResolvers<{
		client: PiRpcClientV0;
		initialState: Awaited<ReturnType<PiRpcClientV0["getState"]>>;
		attestation: PiLaunchAttestationV0;
	}>();
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 10_000);
	const finished = runSandboxV0(bwrap.bwrap, profile, argv, {
		containment: scope.containment,
		timeoutMs: 15 * 60_000,
		outputBytes: 0,
		signal: abort.signal,
		onLauncher(launcher) {
			try {
				endpoints = [0, 1, 2, 6].map((fd) => readlinkSync(`/proc/${launcher.pid}/fd/${fd}`));
			} catch {
				endpoints = undefined;
			}
		},
		async experimentalLaunch({ unit, launcher, init, challenge, stdin, stdout, stderr, exited, kill }) {
			try {
				const group = scopeControlGroupV0(scope.containment, unit);
				demand(group !== null, "The exact user scope is unavailable.");
				const proc = `/proc/${init.pid}`;
				const parent = `/proc/${launcher.pid}`;
				demand((await readFrame(challenge, 1)).equals(Buffer.from("R")), "The shim did not report readiness.");
				const expectedNamespaces = namespaces(proc);
				demand(
					expectedNamespaces.every((link, i) => link !== hostNamespaces[i]),
					"A sandbox namespace matches the host.",
				);
				demand(
					!procRead(`${proc}/mountinfo`)
						.split("\n")
						.some((line) => / - cgroup2? /.test(line)),
					"A cgroup filesystem is visible to Pi.",
				);
				demand(
					endpoints?.length === 4 &&
						endpoints.every((link) => /^socket:\[\d+\]$/.test(link)) &&
						new Set(endpoints).size === 4,
					"The launcher transport endpoints did not match.",
				);
				const stdio = endpoints.slice(0, 3);
				const socket = readlinkSync(`${proc}/fd/6`);
				const flags = /^flags:[ \t]+([0-7]+)$/m.exec(procRead(`${proc}/fdinfo/6`))?.[1];
				demand(
					endpoints[3] === socket && flags !== undefined && (BigInt(`0o${flags}`) & 0o2000000n) !== 0n,
					"The challenge endpoint was not private and close-on-exec.",
				);
				const sameKernel = () => {
					const stat = processFields(proc);
					return (
						stat[0] !== "Z" &&
						stat[0] !== "X" &&
						stat[1] === String(launcher.pid) &&
						stat[19] === init.startTime &&
						processStartTimeV0(launcher.pid) === launcher.startTime &&
						procRead(`${proc}/cgroup`).trim() === `0::${group}` &&
						procRead(`${parent}/cgroup`).trim() === `0::${group}` &&
						procRead(BOOT_ID).trim() === boot &&
						credentialsClosed(proc, init.pid, uid) &&
						namespaces(proc).every((value, i) => value === expectedNamespaces[i]) &&
						inode(`${proc}/root/work`) === snapshot &&
						inode(`${proc}/cwd`) === snapshot &&
						workspaceId(admitted.workspaceRoot) === admitted.workspaceIdentity &&
						stdio.every((link, fd) => readlinkSync(`${proc}/fd/${fd}`) === link)
					);
				};
				const exactShim = () =>
					sameKernel() &&
					inode(`${proc}/exe`) === shimExe &&
					procRead(`${proc}/cmdline`) === `${argv.join("\0")}\0`;
				demand(exactShim(), "The host could not bind the shim to this launch and workspace.");
				const nonce = randomBytes(32);
				const answer = readFrame(challenge, nonce.length);
				challenge.write(nonce);
				demand(timingSafeEqual(nonce, await answer) && exactShim(), "The shim challenge did not verify.");
				challenge.write("G");
				const deadline = performance.now() + 3000;
				while (inode(`${proc}/exe`) === shimExe && performance.now() < deadline) await sleep(10);
				demand(inode(`${proc}/exe`) === piExe, "The shim did not exec pinned Pi in place.");
				const image = execImage(proc);
				const challengeGone = (base: string) => {
					try {
						return readlinkSync(`${base}/fd/6`) !== socket;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
						throw error;
					}
				};
				const check = () => {
					try {
						return (
							sameKernel() &&
							inode(`${proc}/exe`) === piExe &&
							execImage(proc) === image &&
							inode(`${proc}/root${PI_ENTRY}`) === piEntry &&
							challengeGone(proc) &&
							processStartTimeV0(init.pid) === init.startTime
						);
					} catch (error) {
						if (
							(error as NodeJS.ErrnoException).code === "ENOENT" ||
							((error as Error).cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
						)
							return false;
						throw error;
					}
				};
				demand(check(), "The same Pi process and closed challenge endpoint could not be verified.");
				if (input.model !== undefined) {
					const bridgePid = procRead(`${proc}/task/${init.pid}/children`).trim();
					demand(/^\d+$/.test(bridgePid), "The launcher did not identify exactly one trusted bridge child.");
					const bridge = `/proc/${bridgePid}`;
					const bridgeArgs = [NODE, "/run/endo/bridge.cjs", "18080", "/run/endo/model.sock"];
					demand(
						inode(`${bridge}/exe`) === piExe &&
							procRead(`${bridge}/cmdline`) === `${bridgeArgs.join("\0")}\0` &&
							procRead(`${bridge}/cgroup`).trim() === `0::${group}` &&
							namespaces(bridge).every((link, i) => link === expectedNamespaces[i]) &&
							stdio.every((_link, fd) => readlinkSync(`${bridge}/fd/${fd}`) === "/dev/null") &&
							challengeGone(bridge),
						"The bridge did not match the scope and separate transport.",
					);
				}
				challenge.end();
				const client = new PiRpcClientV0(rpc, {
					stdin,
					stdout,
					stderr,
					exited,
					pid: init.pid,
					scopeUnit: unit,
					groupId: undefined,
					killGroup: kill,
					signalGroup: kill,
					liveMembers: () => undefined,
					release: async () =>
						(await finished).termination === "confirmed"
							? { boundary: "scope", result: "confirmed", unit }
							: { boundary: "scope", result: "incomplete", remaining: null, unit },
				});
				const initialState = await client.getState();
				demand(
					/^[A-Za-z0-9._-]{1,128}$/.test(initialState.sessionId) && check(),
					"The first Pi state did not bind an ephemeral session to this launch.",
				);
				const attestation = Object.freeze({
					session: `endo.session.pi.${initialState.sessionId}`,
					workspaceRoot: admitted.workspaceRoot,
					check,
				});
				ready.resolve({ client, initialState, attestation });
			} catch (error) {
				ready.reject(error);
				throw error;
			}
		},
	}).finally(input.onClosed);
	void finished.then(
		() => ready.reject(new Error("Pi ended before attestation completed.")),
		(error: unknown) => ready.reject(error),
	);
	try {
		return await ready.promise;
	} catch (error) {
		abort.abort();
		await finished;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
