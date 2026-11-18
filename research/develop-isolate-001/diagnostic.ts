import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { piRpcArgumentsV0 } from "../../adapters/pi/rpc.ts";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	ENDO_SANDBOX_NAMESPACES_V0,
	type EndoSandboxMountV0,
	type EndoSandboxProfileInputV0,
	type EndoSandboxRunV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0 } from "../../adapters/sandbox/containment.ts";
import {
	failedOfflineChecks,
	OFFLINE_EXPECTED,
	OFFLINE_PROBE,
	type OfflineObservationKey,
	readOfflineProbe,
} from "./probe.ts";

const NODE = "/usr/bin/node";
const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_VERSION = "1.5.2";
const ENV = {
	PATH: "/usr/bin",
	LC_ALL: "C",
	HOME: "/home/agent",
	PI_CODING_AGENT_DIR: "/home/agent",
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	NODE_DISABLE_COMPILE_CACHE: "1",
};

function trustedPiInstallation(): boolean {
	const trusted = (s: ReturnType<typeof lstatSync>) => s.uid === 0 && (s.mode & 0o022) === 0;
	for (let path = PI; ; path = dirname(path)) {
		const s = lstatSync(path);
		if (!trusted(s) || !s.isDirectory()) return false;
		if (path === "/") break;
	}
	const walk = (directory: string): boolean =>
		readdirSync(directory).every((name) => {
			const path = join(directory, name);
			const s = lstatSync(path);
			if (s.isSymbolicLink()) {
				const target = readlinkSync(path);
				return (
					s.uid === 0 &&
					!isAbsolute(target) &&
					resolve(directory, target).startsWith(PI + sep) &&
					realpathSync(path).startsWith(PI + sep)
				);
			}
			return trusted(s) && (s.isDirectory() ? walk(path) : s.isFile());
		});
	return (
		realpathSync("/usr/bin/pi") === `${PI}/dist/bundle/cli.js` &&
		walk(PI) &&
		JSON.parse(readFileSync(join(PI, "package.json"), "utf8")).version === PI_VERSION
	);
}

export function completedOfflineRun(run: EndoSandboxRunV0): boolean {
	return (
		run.started &&
		run.scope.established &&
		run.scope.ended === "confirmed" &&
		run.termination === "confirmed" &&
		run.exitCode === 0 &&
		run.signal === null &&
		!run.timedOut &&
		run.init !== null &&
		run.initGone === true &&
		run.truncated.stdout === 0 &&
		run.truncated.stderr === 0
	);
}

type Checks = Partial<Record<OfflineObservationKey, string>>;

export async function runOfflineBoundary({ realPi = false }: { realPi?: boolean } = {}) {
	const unavailable = (reason: string) => ({ kind: "offline-diagnostic", passed: false, reason });
	if (process.platform !== "linux" || process.getuid?.() === 0)
		return unavailable("the diagnostic requires an unprivileged Linux controller");
	const bwrap = detectBubblewrapV0();
	if (!bwrap.ok) return unavailable(`${bwrap.reason}: ${bwrap.detail}`);
	const containment = await detectContainmentV0();
	if (!containment.ok) return unavailable(containment.detail);
	const runtime = resolveRuntimeV0([NODE, "/usr/bin/unshare", "/usr/bin/true"]);
	if (!runtime.ok) return unavailable(runtime.detail);
	if (realPi && !trustedPiInstallation()) return unavailable("the pinned Arch Pi installation did not validate");

	const scratch = mkdtempSync("/tmp/endo-isolate-");
	try {
		const workspace = join(scratch, "workspace");
		const protectedDir = join(scratch, "synthetic-host");
		const secret = join(protectedDir, "synthetic-auth.json");
		mkdirSync(protectedDir, { mode: 0o700 });
		writeFileSync(secret, '{"credential":"synthetic-canary"}', { mode: 0o600 });
		writeFileSync(join(protectedDir, "docker.sock"), "pathname canary (not a socket)", { mode: 0o600 });
		mkdirSync(join(workspace, ".git"), { recursive: true, mode: 0o700 });
		writeFileSync(join(workspace, ".git/config"), "[core]\n\tbare = false\n");
		symlinkSync(secret, join(workspace, "host-link"));
		const s = statSync(workspace, { bigint: true });
		const mounts: EndoSandboxMountV0[] = [
			{ kind: "rw-dir", source: workspace, target: "/work", role: "disposable-workspace" },
			{ kind: "ro-dir", source: join(workspace, ".git"), target: "/work/.git", role: "git-fixture" },
		];
		if (realPi) mounts.push({ kind: "ro-dir", source: PI, target: "/pi", role: "pinned-offline-pi" });
		const base: EndoSandboxProfileInputV0 = {
			runtime: runtime.files,
			mounts,
			env: ENV,
			cwd: "/work",
			tmpfsBytes: 32 * 1024 * 1024,
		};
		const runOptions = { containment: containment.containment, timeoutMs: 15_000, outputBytes: 8192 };
		const controller = {
			controllerPid: process.pid,
			namespaces: Object.fromEntries(
				ENDO_SANDBOX_NAMESPACES_V0.map((name) => [name, readlinkSync(`/proc/self/ns/${name}`)]),
			),
			protectedDir,
			secret,
			workspace: `${s.dev}:${s.ino}`,
			env: { ...ENV, PWD: "/work" },
		};
		const inspect = async (
			label: string,
			input: EndoSandboxProfileInputV0,
			expected: Checks = {},
			adjust: (args: string[]) => string[] = (args) => args,
		) => {
			const profile = buildSandboxProfileV0(input);
			profile.args = adjust(profile.args);
			const challenge = randomBytes(16).toString("hex");
			const piArgs =
				realPi && label === "offline"
					? [
							...piRpcArgumentsV0({
								executable: NODE,
								cwd: "/work",
								env: ENV,
								session: { kind: "ephemeral" },
								tools: "none",
								offline: true,
								governedToolFree: true,
							}),
							"--no-themes",
						]
					: undefined;
			const run = await runSandboxV0(
				bwrap.bwrap,
				profile,
				[
					NODE,
					"--input-type=module",
					"-e",
					OFFLINE_PROBE,
					JSON.stringify({
						...controller,
						challenge,
						piArgs,
						beforePi:
							piArgs === undefined
								? undefined
								: {
										...OFFLINE_EXPECTED,
										"pi-rpc": "not-requested",
									},
					}),
				],
				runOptions,
			);
			const checks = readOfflineProbe(run.stdout.toString("utf8"), challenge);
			const failed = checks === null ? null : failedOfflineChecks(checks, expected);
			return {
				label,
				passed: completedOfflineRun(run) && failed?.length === 0,
				failed,
				checks,
				started: run.started,
				timedOut: run.timedOut,
				exitCode: run.exitCode,
				signal: run.signal,
				initGone: run.initGone,
				termination: run.termination,
			};
		};
		const offline = await inspect(
			"offline",
			base,
			realPi
				? {
						"pi-rpc": "state",
						"pi-extension-marker": "ENOENT",
						"pi-mcp-marker": "ENOENT",
					}
				: {},
		);
		if (!offline.passed)
			return { ...unavailable("the baseline did not complete with every required observation"), offline };
		const controls = [
			await inspect(
				"shared-network-namespace",
				{ ...base, unsafeForTests: { shareNet: true } },
				{
					"network-namespace": "shared",
					"network-interfaces": Object.keys(networkInterfaces()).some((name) => name !== "lo")
						? "other"
						: "lo-only",
				},
			),
			await inspect(
				"synthetic-exposure",
				{ ...base, unsafeForTests: { extraRoBind: { source: protectedDir, target: protectedDir } } },
				{
					"fs-canary-read": "ok",
					"outside-write": "EROFS",
					"symlink-read": "ok",
					"traversal-read": "ok",
					"synthetic-socket-path": "ok",
				},
			),
			await inspect(
				"writable-git-metadata",
				{ ...base, mounts: mounts.filter((mount) => mount.role !== "git-fixture") },
				{ "git-config-write": "ok", "git-config-rename": "ok" },
			),
			await inspect("nested-userns-enabled", base, { "nested-userns": "allowed" }, (args) =>
				args.filter((arg) => arg !== "--disable-userns" && arg !== "--assert-userns-disabled"),
			),
		];
		const invalid = buildSandboxProfileV0(base);
		invalid.args.push("--endo-deliberate-invalid-option");
		const rejected = await runSandboxV0(bwrap.bwrap, invalid, ["/usr/bin/true"], runOptions);
		const brokenLaunch = {
			started: rejected.started,
			exitCode: rejected.exitCode,
			scopeEnded: rejected.scope.ended,
			passed:
				!rejected.started &&
				!rejected.timedOut &&
				rejected.exitCode === 1 &&
				rejected.scope.ended === "confirmed" &&
				/Unknown option --endo-deliberate-invalid-option/i.test(rejected.stderr.toString("utf8")),
		};
		return {
			kind: "offline-diagnostic",
			passed: brokenLaunch.passed && controls.every((c) => c.passed),
			controllerTTY: process.stdin.isTTY === true,
			bubblewrapVersion: bwrap.bwrap.version,
			systemdVersion: containment.containment.version,
			offline,
			controls,
			brokenLaunch,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 1 || args[0] !== "--operator-approved-offline-pi")) {
		process.stderr.write("Usage: node research/develop-isolate-001/diagnostic.ts [--operator-approved-offline-pi]\n");
		process.exitCode = 2;
	} else {
		try {
			const result = await runOfflineBoundary({ realPi: args.length === 1 });
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			process.exitCode = result.passed ? 0 : 1;
		} catch (error) {
			process.stderr.write(
				`Offline diagnostic unavailable: ${error instanceof Error ? error.message : "unknown error"}\n`,
			);
			process.exitCode = 1;
		}
	}
}
