import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { ENV, NODE, PI, trustedPiInstallation } from "../../adapters/sandbox/pi-runtime.ts";
import { ENDO_FD_OBSERVER_V0, profileWithFdObserverV0 } from "../../adapters/sandbox/preflight.ts";
import {
	failedOfflineChecks,
	OFFLINE_EXPECTED,
	OFFLINE_PROBE,
	type OfflineObservationKey,
	readOfflineProbe,
} from "./probe.ts";

export { ENV as OFFLINE_ENV, NODE as OFFLINE_NODE, PI as PINNED_PI_ROOT, trustedPiInstallation };

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

export async function runOfflineBoundary({
	realPi = false,
	modelRoute,
}: {
	realPi?: boolean;
	modelRoute?: "probe" | "local";
} = {}) {
	const unavailable = (reason: string) => ({ kind: "offline-diagnostic", passed: false, reason });
	if (process.platform !== "linux" || !process.getuid?.())
		return unavailable("the diagnostic requires an unprivileged Linux controller");
	const bwrap = detectBubblewrapV0();
	if (!bwrap.ok) return unavailable(`${bwrap.reason}: ${bwrap.detail}`);
	const containment = await detectContainmentV0();
	if (!containment.ok) return unavailable(containment.detail);
	const runtime = resolveRuntimeV0([NODE, "/usr/bin/unshare", "/usr/bin/true"]);
	if (!runtime.ok) return unavailable(runtime.detail);
	if ((realPi || modelRoute === "local") && !trustedPiInstallation())
		return unavailable("the pinned Arch Pi installation did not validate");
	const capLast = Number(readFileSync("/proc/sys/kernel/cap_last_cap", "utf8").trim());
	if (!Number.isInteger(capLast) || capLast < 0 || capLast > 63)
		return unavailable("the kernel capability mask could not be determined");
	const allCaps = ((1n << BigInt(capLast + 1)) - 1n).toString(16).padStart(16, "0");

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
			env: { ...ENV, PWD: "/work", SHLVL: "0" },
			fdObserver: ENDO_FD_OBSERVER_V0,
		};
		const inspect = async (
			label: string,
			input: EndoSandboxProfileInputV0,
			expected: Checks = {},
			adjust: (args: string[]) => string[] = (args) => args,
		) => {
			const profile = profileWithFdObserverV0(buildSandboxProfileV0(input));
			if (profile === null) throw new Error("the trusted descriptor observer could not be resolved");
			profile.args = adjust(profile.args);
			const challenge = randomBytes(16).toString("hex");
			const smokePi = label === "offline-pi-smoke";
			const run = await runSandboxV0(
				bwrap.bwrap,
				profile,
				[
					...ENDO_FD_OBSERVER_V0,
					NODE,
					"--input-type=module",
					"-e",
					OFFLINE_PROBE,
					JSON.stringify({
						...controller,
						challenge,
						beforePi: smokePi ? OFFLINE_EXPECTED : undefined,
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
		const offline = await inspect("offline", base);
		if (!offline.passed)
			return { ...unavailable("the baseline did not complete with every required observation"), offline };
		const controls = [
			await inspect(
				"writable-root-and-extra-environment",
				{ ...base, unsafeForTests: { writableRoot: true, extraEnv: { ENDO_SYNTHETIC_EXTRA: "fixture" } } },
				{ "fs-root-readonly": "ok", "fs-dev-readonly": "ok", "env-minimal": "unexpected" },
			),
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
			await inspect(
				"namespace-capabilities-enabled",
				base,
				{ "privilege-status": "capability", "capability-masks": allCaps },
				(args) => {
					const index = args.indexOf("--cap-drop");
					if (index < 0 || args[index + 1] !== "ALL")
						throw new Error("the baseline does not explicitly drop every capability");
					args.splice(index, 2, "--uid", "0", "--cap-add", "ALL");
					return args;
				},
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
		const controlsPassed = brokenLaunch.passed && controls.every((c) => c.passed);
		const model =
			modelRoute !== undefined && controlsPassed
				? await (await import("./model-pilot.ts")).runModelPilot(
						{ bwrap: bwrap.bwrap, base, options: runOptions, scratch, piRoot: PI, controller },
						modelRoute === "local",
					)
				: undefined;
		const offlinePi =
			realPi && controlsPassed
				? await inspect(
						"offline-pi-smoke",
						{
							...base,
							mounts: [...mounts, { kind: "ro-dir", source: PI, target: "/pi", role: "pinned-offline-pi" }],
						},
						{
							"pi-rpc": "state",
							"pi-process": "same-namespace-and-workspace",
							"pi-extension-marker": "ENOENT",
							"pi-mcp-marker": "ENOENT",
						},
					)
				: undefined;
		return {
			kind: "offline-diagnostic",
			passed: controlsPassed && (!realPi || offlinePi?.passed === true),
			controllerTTY: process.stdin.isTTY === true,
			bubblewrapVersion: bwrap.bwrap.version,
			systemdVersion: containment.containment.version,
			offline,
			controls,
			brokenLaunch,
			offlinePi,
			model,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const flags = ["--operator-approved-offline-pi", "--probe-model-route-absent", "--operator-approved-local-model"];
	if (args.length !== 0 && (args.length !== 1 || !flags.includes(args[0] ?? ""))) {
		process.stderr.write(`Usage: node research/develop-isolate-001/diagnostic.ts [${flags.join(" | ")}]\n`);
		process.exitCode = 2;
	} else {
		try {
			const modelRoute = args[0] === flags[1] ? "probe" : args[0] === flags[2] ? "local" : undefined;
			const result = await runOfflineBoundary({
				realPi: args[0] === flags[0],
				...(modelRoute === undefined ? {} : { modelRoute }),
			});
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
