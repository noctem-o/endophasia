import { preflightPassesV0 } from "../../adapters/sandbox/preflight.ts";

export const LIVE_PROBE_PREFIX = "ENDO-OFFLINE-BOUNDARY ";

export const OFFLINE_EXPECTED = {
	"fs-canary-read": "ENOENT",
	"fs-root-readonly": "EROFS",
	"fs-dev-readonly": "EROFS",
	"fs-workspace-writable": "ok",
	"env-minimal": "ok",
	"workspace-identity": "same",
	"outside-write": "ENOENT",
	"symlink-read": "ENOENT",
	"traversal-read": "ENOENT",
	"run-directory": "ENOENT",
	"synthetic-socket-path": "ENOENT",
	"git-config-write": "EROFS",
	"git-config-rename": "EBUSY",
	"scratch-writable": "ok",
	"private-pi-dir": "ok",
	"isolated-namespaces": "ok",
	"network-namespace": "different",
	"network-interfaces": "lo-only",
	"terminal-fds": "none",
	"terminal-open": "ENXIO",
	"terminal-session": "none",
	"controller-proc": "ENOENT",
	"controller-signal-zero": "ESRCH",
	"privilege-status": "ok",
	"nested-userns": "ENOSPC",
	"detached-child": "alive-in-sandbox",
	"pi-rpc": "not-requested",
	"pi-extension-marker": "not-requested",
	"pi-mcp-marker": "not-requested",
} as const;

export type OfflineObservationKey = keyof typeof OFFLINE_EXPECTED;

export function readOfflineProbe(stdout: string, challenge: string): Record<OfflineObservationKey, string> | null {
	if (!stdout.startsWith(LIVE_PROBE_PREFIX) || !stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1)
		return null;
	try {
		const raw = stdout.slice(LIVE_PROBE_PREFIX.length, -1);
		const report = JSON.parse(raw);
		if (report === null || typeof report !== "object" || Array.isArray(report)) return null;
		if (JSON.stringify(report) !== raw) return null;
		const { challenge: observed, ...checks } = report;
		const keys = Object.keys(OFFLINE_EXPECTED) as OfflineObservationKey[];
		if (
			observed !== challenge ||
			Object.keys(checks).length !== keys.length ||
			!keys.every(
				(key) =>
					Object.hasOwn(checks, key) && typeof checks[key] === "string" && /^[a-z0-9-]{1,40}$/i.test(checks[key]),
			)
		)
			return null;
		return checks;
	} catch {
		return null;
	}
}

export function failedOfflineChecks(
	checks: Record<OfflineObservationKey, string>,
	expected: Partial<Record<OfflineObservationKey, string>> = {},
): OfflineObservationKey[] {
	return (Object.keys(OFFLINE_EXPECTED) as OfflineObservationKey[]).filter((id) => {
		const override = expected[id];
		if (override !== undefined) return override !== checks[id];
		if (Object.hasOwn(expected, id)) return true;
		return ["fs-canary-read", "fs-root-readonly", "fs-dev-readonly", "fs-workspace-writable", "env-minimal"].includes(
			id,
		)
			? !preflightPassesV0(id, checks[id])
			: OFFLINE_EXPECTED[id] !== checks[id];
	});
}

export const OFFLINE_PROBE = String.raw`
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const c = JSON.parse(process.argv[1]);
const out = { challenge: c.challenge };
const code = (f) => { try { f(); return "ok"; } catch (e) { return e.code || "error"; } };
const write = (path) => { fs.writeFileSync(path, "canary", { flag: "wx" }); fs.unlinkSync(path); };
out["fs-canary-read"] = code(() => fs.readFileSync(c.secret));
out["fs-root-readonly"] = code(() => write("/endo-canary"));
out["fs-dev-readonly"] = code(() => write("/dev/endo-canary"));
out["fs-workspace-writable"] = code(() => write("/work/write-check"));
out["env-minimal"] = Object.keys(process.env).length === Object.keys(c.env).length &&
	Object.entries(c.env).every(([key, value]) => process.env[key] === value) ? "ok" : "unexpected";
const ws = fs.statSync("/work", { bigint: true });
out["workspace-identity"] = ws.dev + ":" + ws.ino === c.workspace ? "same" : "different";
out["outside-write"] = code(() => write(c.protectedDir + "/write-check"));
out["symlink-read"] = code(() => fs.readFileSync("/work/host-link"));
out["traversal-read"] = code(() => fs.readFileSync("/work/.." + c.secret));
out["run-directory"] = code(() => fs.lstatSync("/run"));
out["synthetic-socket-path"] = code(() => fs.lstatSync(c.protectedDir + "/docker.sock"));
out["git-config-write"] = code(() => fs.appendFileSync("/work/.git/config", ""));
out["git-config-rename"] = code(() => {
	fs.renameSync("/work/.git", "/work/.git-moved");
	fs.renameSync("/work/.git-moved", "/work/.git");
});
out["scratch-writable"] = code(() => write("/tmp/write-check"));
out["private-pi-dir"] = code(() => write(process.env.PI_CODING_AGENT_DIR + "/write-check"));
out["isolated-namespaces"] = Object.entries(c.namespaces).filter(([name]) => name !== "net").every(([name, host]) =>
	fs.readlinkSync("/proc/self/ns/" + name) !== host) ? "ok" : "shared";
out["network-namespace"] = fs.readlinkSync("/proc/self/ns/net") === c.namespaces.net ? "shared" : "different";
out["network-interfaces"] = Object.keys(os.networkInterfaces()).every((name) => name === "lo") ? "lo-only" : "other";
out["terminal-fds"] = [process.stdin, process.stdout, process.stderr].some((s) => s.isTTY) ? "tty" : "none";
out["terminal-open"] = code(() => fs.closeSync(fs.openSync("/dev/tty", fs.constants.O_RDONLY | fs.constants.O_NOCTTY)));
out["terminal-session"] = fs.readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).split(" ")[4] === "0" ? "none" : "tty";
out["controller-proc"] = code(() => fs.statSync("/proc/" + c.controllerPid));
out["controller-signal-zero"] = code(() => process.kill(c.controllerPid, 0));
const status = fs.readFileSync("/proc/self/status", "utf8");
out["privilege-status"] = /^NoNewPrivs:\s+1$/m.test(status) &&
	["Eff", "Prm", "Bnd", "Amb"].every((field) => new RegExp("^Cap" + field + ":\\s+0+$", "m").test(status))
	? "ok" : "unexpected";
const nested = spawnSync("/usr/bin/unshare", ["--user", "--", "/usr/bin/true"], { encoding: "utf8", timeout: 3000 });
out["nested-userns"] = nested.status === 1 && /unshare failed: No space left on device\s*$/.test(nested.stderr)
	? "ENOSPC" : nested.status === 0 ? "allowed" : "inconclusive";
const detached = spawn("/usr/bin/node", ["-e",
	'process.send(process.pid); process.once("disconnect", () => {}); setTimeout(() => {}, 30000)'],
	{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
out["detached-child"] = await new Promise((resolve) => {
	detached.once("error", () => resolve("error"));
	detached.once("message", (pid) => {
		detached.disconnect();
		detached.unref();
		try {
			const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ").at(-1).split(" ");
			resolve(pid === detached.pid && Number(stat[3]) === pid &&
				fs.readlinkSync("/proc/" + pid + "/ns/pid") === fs.readlinkSync("/proc/self/ns/pid") ? "alive-in-sandbox" : "unexpected");
		} catch { resolve("error"); }
	});
});
out["pi-rpc"] = "not-requested";
if (c.beforePi) {
	if (!Object.entries(out).every(([id, value]) => id === "challenge" || c.beforePi[id] === value)) {
		out["pi-rpc"] = "withheld";
	} else {
	const agent = process.env.PI_CODING_AGENT_DIR;
	fs.mkdirSync(agent + "/extensions", { mode: 0o700 });
	fs.writeFileSync(agent + "/extensions/canary.ts",
		'import { writeFileSync } from "node:fs"; writeFileSync("/work/extension-ran", "canary"); export default () => {};');
	fs.writeFileSync(agent + "/mcp.json", JSON.stringify({ mcpServers: { canary: {
		command: "/usr/bin/node", args: ["-e", 'require("node:fs").writeFileSync("/work/mcp-ran", "canary")'],
	} } }));
	const pi = spawn("/usr/bin/node", [
		"/pi/dist/bundle/cli.js", "--mode", "rpc", "--offline", "--no-session", "--no-tools",
		"--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
		"--no-approve", "--no-themes",
	], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lines = createInterface({ input: pi.stdout });
	let result = "no-state";
	const closed = new Promise((resolve) => pi.once("close", resolve));
	pi.on("error", () => { result = "spawn-error"; });
	pi.stdin.on("error", () => {});
	lines.on("line", (line) => {
		try {
			const r = JSON.parse(line);
			if (r.type !== "response" || r.id !== "offline-state" || r.command !== "get_state") return;
			result = r.success === true && typeof r.data?.sessionId === "string" && r.data.sessionId.length > 0
				? "state" : "invalid-state";
			pi.stdin.end();
		} catch {}
	});
	pi.stdin.write(JSON.stringify({ id: "offline-state", type: "get_state" }) + "\n");
	const timeout = setTimeout(() => { result = "timeout"; pi.kill("SIGKILL"); }, 8000);
	const exit = await closed;
	clearTimeout(timeout);
	lines.close();
	out["pi-rpc"] = exit === 0 ? result : result === "state" ? "nonzero-exit" : result;
	}
}
out["pi-extension-marker"] = c.beforePi ? code(() => fs.statSync("/work/extension-ran")) : "not-requested";
out["pi-mcp-marker"] = c.beforePi ? code(() => fs.statSync("/work/mcp-ran")) : "not-requested";
process.stdout.write("ENDO-OFFLINE-BOUNDARY " + JSON.stringify(out) + "\n");
`;
