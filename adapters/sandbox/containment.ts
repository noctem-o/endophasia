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
import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { ProcessScopeV0 } from "../rpc-jsonl/process-group.ts";

export const ENDO_SYSTEMD_RUN_V0 = "/usr/bin/systemd-run";
export const ENDO_SYSTEMCTL_V0 = "/usr/bin/systemctl";
/** The most processes and threads one sandbox's scope may hold. */
export const ENDO_SANDBOX_TASKS_MAX_V0 = 512;
/**
 * Scopes end with SIGKILL, not systemd's default SIGTERM and a 90-second grace: a sandbox gets no chance to linger. TimeoutStopSec bounds
 * how long the manager waits for the kill to take before it gives up on the unit (and the controller then records `unconfirmed`).
 */
export const ENDO_SCOPE_STOP_TIMEOUT_SEC_V0 = 5;
/** Where the unified cgroup v2 hierarchy is read (read-only): a scope's emptiness is confirmed from its `cgroup.events` there. */
export const ENDO_CGROUP_ROOT_V0 = "/sys/fs/cgroup";

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

/** A scope this code made: a protected sandbox's (`endo-sandbox-`) or a live harness process's (`endo-live-`, LIVE-PROCESS-CONTAINMENT-001). */
const unitPattern = /^endo-(?:sandbox|live)-[0-9a-f]{24}$/;
const sandboxUnitPattern = /^endo-sandbox-[0-9a-f]{24}$/;

/** A new, unique unit name for one sandbox's scope. */
export const newScopeUnitV0 = (): string => `endo-sandbox-${randomBytes(12).toString("hex")}`;

/** A new, unique unit name for one live harness process's scope (docs/live-process-containment.md). */
export const newLiveScopeUnitV0 = (): string => `endo-live-${randomBytes(12).toString("hex")}`;

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
	tools: { systemdRun?: string; systemctl?: string; cgroupRoot?: string } = {},
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
			"-p",
			"KillSignal=SIGKILL",
			"-p",
			`TimeoutStopSec=${ENDO_SCOPE_STOP_TIMEOUT_SEC_V0}s`,
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
			props = show(c, unit, [
				"ActiveState",
				"RuntimeMaxUSec",
				"TasksMax",
				"ControlGroup",
				"KillSignal",
				"TimeoutStopUSec",
			]);
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
			props.KillSignal !== "9" ||
			props.TimeoutStopUSec !== `${ENDO_SCOPE_STOP_TIMEOUT_SEC_V0}s` ||
			!(props.ControlGroup ?? "").endsWith(`/${unit}.scope`)
		)
			return {
				ok: false,
				reason: "containment-unavailable",
				detail: "the probe scope does not carry the required properties",
			};
		// Emptiness is confirmed from a scope's cgroup.events in the unified (v2) hierarchy, and a cgroup that is gone holds nothing. Both
		// readings are trustworthy only where that file is really there for a live scope: check it on this one, which is populated now.
		// Elsewhere (cgroup v1, a hybrid layout, a hierarchy not mounted where it is read) a missing file would read as "gone".
		const root = tools.cgroupRoot ?? ENDO_CGROUP_ROOT_V0;
		let events = "";
		try {
			events = readFileSync(`${root}${props.ControlGroup}/cgroup.events`, "utf8");
		} catch {
			// unreadable: refused below
		}
		if (!existsSync(`${root}/cgroup.controllers`) || !/^populated 1$/m.test(events))
			return {
				ok: false,
				reason: "containment-unavailable",
				detail: `a live scope's cgroup.events is not readable in a unified cgroup v2 hierarchy at ${root}: an empty scope could not be confirmed`,
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

/**
 * Optional resource limits on a sandbox's scope (EVAL-ISO-002): the kernel enforces them on the whole cgroup. `memoryMaxBytes` sets
 * MemoryMax and MemorySwapMax=0 (exceeding it is an OOM kill inside the scope, not swapping); `cpuQuotaPercent` sets CPUQuota (100 is one
 * CPU). Absent, nothing is set, as in EVAL-ISO-001.
 */
export interface EndoScopeLimitsV0 {
	readonly memoryMaxBytes?: number;
	readonly cpuQuotaPercent?: number;
}

const limitArgs = (limits: EndoScopeLimitsV0 | undefined): string[] => {
	const args: string[] = [];
	if (limits?.memoryMaxBytes !== undefined) {
		if (!Number.isSafeInteger(limits.memoryMaxBytes) || limits.memoryMaxBytes < 16 * 1024 * 1024)
			throw new TypeError("memoryMaxBytes must be an integer of at least 16 MiB");
		args.push("-p", `MemoryMax=${limits.memoryMaxBytes}`, "-p", "MemorySwapMax=0");
	}
	if (limits?.cpuQuotaPercent !== undefined) {
		if (!Number.isSafeInteger(limits.cpuQuotaPercent) || limits.cpuQuotaPercent < 1 || limits.cpuQuotaPercent > 6400)
			throw new TypeError("cpuQuotaPercent must be an integer from 1 to 6400");
		args.push("-p", `CPUQuota=${limits.cpuQuotaPercent}%`);
	}
	return args;
};

/** The arguments that run `command` inside a new scope `unit`, ended by the user manager after `runtimeMaxSec` whatever happens. */
export function scopeArgsV0(
	c: EndoContainmentV0,
	unit: string,
	runtimeMaxSec: number,
	command: readonly string[],
	limits?: EndoScopeLimitsV0,
): string[] {
	if (!sandboxUnitPattern.test(unit)) throw new TypeError("a scope unit name must be one the controller made");
	const limited = limitArgs(limits);
	return [
		"--user",
		"--scope",
		"--quiet",
		// A limited scope is kept after it ends, so that its result (an OOM kill) can be read; scopeResultV0 then has it forgotten.
		...(limited.length > 0 ? [] : ["--collect"]),
		`--unit=${unit}`,
		"-p",
		`RuntimeMaxSec=${Math.max(1, Math.ceil(runtimeMaxSec))}`,
		"-p",
		`TasksMax=${c.tasksMax}`,
		"-p",
		"KillSignal=SIGKILL",
		"-p",
		`TimeoutStopSec=${ENDO_SCOPE_STOP_TIMEOUT_SEC_V0}s`,
		...limited,
		"--",
		...command,
	];
}

/**
 * The arguments that run `command` inside a new live scope `unit` (docs/live-process-containment.md). Unlike a sandbox's, a live session
 * has no deadline of its own (an operator's session may run for hours) and no task bound beyond the user manager's (a harness runs real
 * builds and test suites): the scope is the record of what the session owns, and stopping it ends all of it with SIGKILL, whatever pid,
 * process group or session a process moved to. `owner` (pid and start time) is kept in the unit's description, so a scope whose owner
 * is gone can be found later (`liveScopesV0`).
 */
export function liveScopeArgsV0(
	unit: string,
	owner: { pid: number; startTime: string },
	command: readonly string[],
): string[] {
	if (!/^endo-live-[0-9a-f]{24}$/.test(unit))
		throw new TypeError("a live scope unit name must be one newLiveScopeUnitV0 made");
	if (!Number.isInteger(owner.pid) || !/^[0-9]+$/.test(owner.startTime))
		throw new TypeError("an owner is a pid and a start time");
	return [
		"--user",
		"--scope",
		"--quiet",
		"--collect",
		`--unit=${unit}`,
		`--description=${liveScopeDescription(owner)}`,
		"-p",
		"KillSignal=SIGKILL",
		"-p",
		`TimeoutStopSec=${ENDO_SCOPE_STOP_TIMEOUT_SEC_V0}s`,
		"--",
		...command,
	];
}

const liveScopeDescription = (owner: { pid: number; startTime: string }) =>
	`endo live session (owner pid ${owner.pid} start ${owner.startTime})`;

/** How long a live scope's stop waits for the user manager and an empty cgroup (the scope's own kill bound is TimeoutStopSec). */
const LIVE_SCOPE_STOP_WAIT_MS = 10_000;

/**
 * A new live scope for one harness process group (LIVE-PROCESS-CONTAINMENT-001), owned by this process: the shared transport starts its
 * keeper inside it (adapters/rpc-jsonl/process-group.ts) without knowing the mechanism.
 */
export function liveScopeV0(c: EndoContainmentV0): ProcessScopeV0 {
	const startTime = processStartTimeV0(process.pid);
	if (startTime === null) throw new TypeError("a live scope needs this process's start time (/proc)");
	const unit = newLiveScopeUnitV0();
	return {
		unit,
		wrap: (command) => ({
			command: c.systemdRun,
			args: liveScopeArgsV0(unit, { pid: process.pid, startTime }, command),
			env: { ...c.env },
		}),
		stopWithoutWaiting: [c.systemctl, "--user", "stop", "--no-block", `${unit}.scope`],
		stop: () => stopScopeV0(c, unit, LIVE_SCOPE_STOP_WAIT_MS),
		remaining: () => scopeProcessesV0(c, unit)?.length ?? null,
	};
}

/**
 * The processes in a scope's cgroup now, read-only from `cgroup.procs`: an empty list when the cgroup no longer exists, null when it
 * cannot be read or the unit is not one this code made. Used to say how many processes an incomplete cleanup left, never to signal one.
 */
export function scopeProcessesV0(c: Pick<EndoContainmentV0, "systemctl" | "env">, unit: string): number[] | null {
	if (!unitPattern.test(unit)) return null;
	const group = show(c, unit, ["ControlGroup"]).ControlGroup ?? "";
	if (group === "") return [];
	if (!group.endsWith(`/${unit}.scope`) || group.includes("..")) return null;
	try {
		return readFileSync(`${ENDO_CGROUP_ROOT_V0}${group}/cgroup.procs`, "utf8")
			.split("\n")
			.filter((line) => /^[0-9]+$/.test(line))
			.map(Number);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
	}
}

/**
 * The live scopes the user manager still runs, each with the owner its description names and whether that owner (exactly that pid and
 * start time) still exists. A scope whose owner is gone was left by a controller and keeper that both died: it is reported, never
 * stopped here (docs/live-process-containment.md, "When both the owner and the keeper die").
 */
export function liveScopesV0(
	c: Pick<EndoContainmentV0, "systemctl" | "env">,
): { unit: string; owner: { pid: number; startTime: string } | null; ownerAlive: boolean }[] {
	const r = spawnSync(
		c.systemctl,
		["--user", "list-units", "--type=scope", "--state=active", "--plain", "--no-legend", "--no-pager", "endo-live-*"],
		{ env: c.env, encoding: "utf8", timeout: 10_000 },
	);
	const found: { unit: string; owner: { pid: number; startTime: string } | null; ownerAlive: boolean }[] = [];
	for (const line of (r.stdout ?? "").split("\n")) {
		const unit = /^(endo-live-[0-9a-f]{24})\.scope\s/.exec(line)?.[1];
		if (unit === undefined) continue;
		const m = /\(owner pid ([0-9]+) start ([0-9]+)\)$/.exec(show(c, unit, ["Description"]).Description ?? "");
		const owner = m === null ? null : { pid: Number(m[1]), startTime: m[2] as string };
		found.push({ unit, owner, ownerAlive: owner !== null && processStartTimeV0(owner.pid) === owner.startTime });
	}
	return found;
}

/** The start time of a host process (/proc/<pid>/stat, field 22), or null when there is no such process. */
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

/**
 * A limited scope's result once it ended, read from the user manager, which then forgets the unit (`reset-failed`). A limited scope is not
 * collected on its own (scopeArgsV0), so a failed one is kept with its result (`oom-kill`, `timeout`, `signal`, …). Null when the manager
 * no longer knows the unit: it unloads a scope that ended without failing, so null is also what success looks like.
 */
export function scopeResultV0(c: Pick<EndoContainmentV0, "systemctl" | "env">, unit: string): string | null {
	if (!unitPattern.test(unit)) return null;
	const p = show(c, unit, ["LoadState", "Result"]);
	spawnSync(c.systemctl, ["--user", "reset-failed", `${unit}.scope`], {
		env: c.env,
		stdio: "ignore",
		timeout: 10_000,
	});
	return p.LoadState === "loaded" && typeof p.Result === "string" && /^[a-z-]{1,32}$/.test(p.Result) ? p.Result : null;
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
 * Stop a scope through the user manager and confirm that it holds no process: `confirmed` only when the manager no longer has the unit
 * running (not-found, inactive or failed) AND the scope's cgroup, read-only, has no process left (`cgroup.events` reports `populated 0`,
 * or the cgroup no longer exists). A unit the manager gave up on with processes still in it (it can enter `failed` "still around after
 * SIGKILL") is `unconfirmed`. Nothing is written to the cgroup; stopping a scope that already ended is harmless.
 */
export async function stopScopeV0(
	c: Pick<EndoContainmentV0, "systemctl" | "env">,
	unit: string,
	waitMs = 15_000,
): Promise<"confirmed" | "unconfirmed"> {
	if (!unitPattern.test(unit)) return "unconfirmed";
	// The cgroup, while the unit is known (it is the unit's own; the name is the controller's, never the sandbox's).
	const known = show(c, unit, ["ControlGroup"]).ControlGroup ?? "";
	spawnSync(c.systemctl, ["--user", "stop", `${unit}.scope`], { env: c.env, stdio: "ignore", timeout: waitMs });
	const until = Date.now() + waitMs;
	for (;;) {
		const p = show(c, unit, ["LoadState", "ActiveState", "ControlGroup"]);
		const stopped = p.LoadState === "not-found" || p.ActiveState === "inactive" || p.ActiveState === "failed";
		if (stopped && cgroupEmpty(p.ControlGroup || known, unit)) return "confirmed";
		if (Date.now() > until) return "unconfirmed";
		await new Promise((r) => setTimeout(r, 50));
	}
}

/**
 * Read-only: whether a scope's cgroup holds no process. A cgroup that no longer exists holds none, but only its directory's absence says
 * so: a missing `cgroup.events` in a cgroup that is still there is not emptiness (detectContainmentV0 refuses hosts where it is missing).
 */
function cgroupEmpty(group: string, unit: string): boolean {
	if (group === "") return true;
	if (!group.endsWith(`/${unit}.scope`) || group.includes("..")) return false;
	try {
		return /^populated 0$/m.test(readFileSync(`${ENDO_CGROUP_ROOT_V0}${group}/cgroup.events`, "utf8"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(`${ENDO_CGROUP_ROOT_V0}${group}`);
	}
}
