// Process containment for protected sandboxes: each sandbox runs inside its own transient systemd user scope, a cgroup that the user
// manager owns, independently of the controller (docs/protected-experiments.md, "Process lifetime").
//
// Why: Bubblewrap's own lifetime binding (--die-with-parent) does not hold in its launch window (containers/bubblewrap#633, open; 0.13.1
// affected). A process stranded there, or a launcher orphaned by a controller that died, is still in the scope's cgroup: stopping the
// scope ends it whatever its pid, process group or session, and the scope's RuntimeMaxSec makes the user manager end it on its own
// deadline even if no controller remains. TasksMax bounds how many processes the sandbox can start.
//
// The scope is established before Bubblewrap runs: `systemd-run --user --scope` registers the scope, with this process in it, with the
// user manager and only then execs the command. Its lifecycle is driven through the user manager (`systemctl --user stop`), never by
// writing to cgroup files. Where the user manager or the properties are unavailable, protected execution is refused (detectContainmentV0).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export const ENDO_SYSTEMD_RUN_V0 = "/usr/bin/systemd-run";
export const ENDO_SYSTEMCTL_V0 = "/usr/bin/systemctl";
/** The most processes and threads one sandbox's scope may hold. */
export const ENDO_SANDBOX_TASKS_MAX_V0 = 512;

export interface EndoContainmentV0 {
	mechanism: "systemd-user-scope";
	systemdRun: string;
	systemctl: string;
	/** The systemd version the user manager tools report. */
	version: string;
	/** sha256 of systemd-run, the command that establishes each scope. */
	systemdRunSha256: string;
	/** Only what the tools need to reach this user's manager. */
	env: Record<string, string>;
	tasksMax: number;
}

export type EndoContainmentRefusalV0 = { ok: false; reason: "containment-unavailable"; detail: string };

const unitPattern = /^endo-sandbox-[0-9a-f]{24}$/;

/** A new, unique unit name for one sandbox's scope. */
export const newScopeUnitV0 = (): string => `endo-sandbox-${randomBytes(12).toString("hex")}`;

const trusted = (path: string): string | null => {
	const s = lstatSync(path, { throwIfNoEntry: false });
	if (s === undefined) return `${path} does not exist`;
	if (!s.isFile()) return `${path} is not a regular file`;
	if (s.uid !== 0 || (s.mode & 0o022) !== 0) return `${path} is not a root-owned, non-writable file`;
	return null;
};

function show(c: Pick<EndoContainmentV0, "systemctl" | "env">, unit: string, properties: readonly string[]) {
	const r = spawnSync(
		c.systemctl,
		["--user", "show", `${unit}.scope`, ...properties.flatMap((p) => ["-p", p]), "--no-pager"],
		{ env: c.env, encoding: "utf8", timeout: 10_000 },
	);
	const out: Record<string, string> = {};
	for (const line of (r.stdout ?? "").split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

/**
 * Whether this host can contain a sandbox: trusted systemd tools, a reachable user manager, and a real probe scope that the manager
 * creates with the required properties, reports with them applied, and stops on request. Anything else is a refusal.
 */
export async function detectContainmentV0(
	tools: { systemdRun?: string; systemctl?: string } = {},
): Promise<{ ok: true; containment: EndoContainmentV0 } | EndoContainmentRefusalV0> {
	const systemdRun = tools.systemdRun ?? ENDO_SYSTEMD_RUN_V0;
	const systemctl = tools.systemctl ?? ENDO_SYSTEMCTL_V0;
	for (const tool of [systemdRun, systemctl]) {
		const p = trusted(tool);
		if (p !== null) return { ok: false, reason: "containment-unavailable", detail: p };
	}
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime === undefined || !runtime.startsWith("/"))
		return { ok: false, reason: "containment-unavailable", detail: "no user manager: XDG_RUNTIME_DIR is not set" };
	const env: Record<string, string> = { XDG_RUNTIME_DIR: runtime };
	if (process.env.DBUS_SESSION_BUS_ADDRESS !== undefined)
		env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
	const version = /^systemd ([0-9]+)/.exec(
		spawnSync(systemdRun, ["--version"], { env, encoding: "utf8", timeout: 5000 }).stdout ?? "",
	);
	if (version === null)
		return { ok: false, reason: "containment-unavailable", detail: "systemd-run did not report a version" };
	const c = { systemctl, env };
	const unit = newScopeUnitV0();
	const probe = spawn(
		systemdRun,
		[
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			`--unit=${unit}`,
			"-p",
			"RuntimeMaxSec=30",
			"-p",
			"TasksMax=8",
			"--",
			"/usr/bin/sleep",
			"20",
		],
		{ env, stdio: "ignore" },
	);
	const exited = new Promise<void>((resolve) => probe.on("close", () => resolve()));
	try {
		let props: Record<string, string> = {};
		for (let i = 0; i < 100; i++) {
			props = show(c, unit, ["ActiveState", "RuntimeMaxUSec", "TasksMax", "ControlGroup"]);
			if (props.ActiveState === "active") break;
			await new Promise((r) => setTimeout(r, 30));
		}
		if (props.ActiveState !== "active")
			return {
				ok: false,
				reason: "containment-unavailable",
				detail: "the user manager did not start a probe scope",
			};
		if (
			props.RuntimeMaxUSec !== "30s" ||
			props.TasksMax !== "8" ||
			!(props.ControlGroup ?? "").endsWith(`/${unit}.scope`)
		)
			return {
				ok: false,
				reason: "containment-unavailable",
				detail: "the probe scope does not carry the required properties",
			};
		const ended = await stopScopeV0({ systemctl, env } as EndoContainmentV0, unit);
		if (ended !== "confirmed")
			return {
				ok: false,
				reason: "containment-unavailable",
				detail: "the user manager did not stop the probe scope",
			};
	} finally {
		probe.kill("SIGKILL");
		await exited;
	}
	return {
		ok: true,
		containment: {
			mechanism: "systemd-user-scope",
			systemdRun,
			systemctl,
			version: version[1] as string,
			systemdRunSha256: createHash("sha256").update(readFileSync(systemdRun)).digest("hex"),
			env,
			tasksMax: ENDO_SANDBOX_TASKS_MAX_V0,
		},
	};
}

/** The arguments that run `command` inside a new scope `unit`, ended by the user manager after `runtimeMaxSec` whatever happens. */
export function scopeArgsV0(
	c: EndoContainmentV0,
	unit: string,
	runtimeMaxSec: number,
	command: readonly string[],
): string[] {
	if (!unitPattern.test(unit)) throw new TypeError("a scope unit name must be one the controller made");
	return [
		"--user",
		"--scope",
		"--quiet",
		"--collect",
		`--unit=${unit}`,
		"-p",
		`RuntimeMaxSec=${Math.max(1, Math.ceil(runtimeMaxSec))}`,
		"-p",
		`TasksMax=${c.tasksMax}`,
		"--",
		...command,
	];
}

/** Whether a process is in exactly this scope (its cgroup, read from /proc). Supplementary: the scope itself is the guarantee. */
export function processInScopeV0(pid: number, unit: string): boolean {
	try {
		return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().endsWith(`/${unit}.scope`);
	} catch {
		return false;
	}
}

/**
 * Stop a scope through the user manager and confirm it is gone: `confirmed` when the manager no longer has the unit loaded or reports it
 * inactive (every process of its cgroup ended), `unconfirmed` otherwise. Stopping a scope that already ended is harmless.
 */
export async function stopScopeV0(
	c: Pick<EndoContainmentV0, "systemctl" | "env">,
	unit: string,
	waitMs = 15_000,
): Promise<"confirmed" | "unconfirmed"> {
	if (!unitPattern.test(unit)) return "unconfirmed";
	spawnSync(c.systemctl, ["--user", "stop", `${unit}.scope`], { env: c.env, stdio: "ignore", timeout: waitMs });
	const until = Date.now() + waitMs;
	for (;;) {
		const p = show(c, unit, ["LoadState", "ActiveState"]);
		if (p.LoadState === "not-found" || p.ActiveState === "inactive" || p.ActiveState === "failed") return "confirmed";
		if (Date.now() > until) return "unconfirmed";
		await new Promise((r) => setTimeout(r, 50));
	}
}
