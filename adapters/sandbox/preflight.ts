// The boundary check run before every protected attempt, in that attempt's own profile (the agent's mounts, environment and namespaces), by
// trusted code: what the sandbox can actually see and reach, observed from inside. The probe reports only what it observed (an error code,
// a count, a fixed word); this module decides pass or fail from its own expectations, so a probe's opinion is never trusted.
//
// The controller plants what the probe should fail to find: a canary file in a protected host directory, a TCP listener on the host's
// loopback, an abstract Unix socket on the host and a path socket. Each probe has a test in which the matching restriction is removed
// (tests/protected-isolation.test.ts), so a probe that cannot detect its own restriction's absence is caught.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndoProtectedProbeV0 } from "../../protocol/protected-experiment.ts";
import { type EndoBubblewrapV0, type EndoSandboxProfileV0, runSandboxV0 } from "./bubblewrap.ts";
import type { EndoContainmentV0 } from "./containment.ts";

/** Host paths the sandbox must not see, by role (their paths are not secret; their absence inside is what is checked). */
export interface EndoPreflightTargetsV0 {
	protectedPaths: Record<string, string>;
	/**
	 * The runtime's executables: a write must fail. They are root-owned, so their own mode may answer (EACCES) before the read-only mount is
	 * reached; this shows they cannot be changed, not by which mechanism.
	 */
	readOnlyRuntime: string[];
	/** Inside paths on read-only mounts (a file to create under /agent, /usr): a write must fail with EROFS, the mount's own answer. */
	readOnlyMounts: string[];
	/** An inside directory that must be writable (the workspace). */
	writable: string;
	/** Environment variable names the sandbox may have. */
	environment: string[];
	/** Host paths where privileged sockets commonly live. */
	sockets: string[];
}

export interface EndoPreflightV0 {
	status: "established" | "failed" | "unavailable";
	probes: EndoProtectedProbeV0[];
	reason: string | null;
}

/** The probe, run as `node --input-type=module -e <PROBE> <config json>` inside the sandbox. Self-contained; reports observations only. */
export const ENDO_PREFLIGHT_PROBE_V0 = String.raw`
import fs from "node:fs"; import net from "node:net"; import os from "node:os";
const c = JSON.parse(process.argv[1]);
const out = {};
const code = (f) => { try { f(); return "ok"; } catch (e) { return String(e && e.code || "error"); } };
for (const [role, path] of Object.entries(c.protectedPaths)) out["fs-hidden-" + role] = code(() => fs.lstatSync(path));
out["fs-canary-read"] = code(() => fs.readFileSync(c.canary));
out["fs-root-readonly"] = code(() => fs.writeFileSync("/.endo-probe", "x"));
c.readOnlyRuntime.forEach((p, i) => { out["fs-readonly-runtime-" + i] = code(() => fs.appendFileSync(p, "")); });
c.readOnlyMounts.forEach((p, i) => { out["fs-readonly-mount-" + i] = code(() => fs.appendFileSync(p, "")); });
out["fs-dev-readonly"] = code(() => fs.writeFileSync("/dev/.endo-probe", "x"));
out["fs-workspace-writable"] = code(() => { const p = c.writable + "/" + c.probeName; fs.writeFileSync(p, "x", { flag: "wx" }); fs.unlinkSync(p); });
out["fs-tmp-private"] = (() => { try { return "entries:" + fs.readdirSync("/tmp").length; } catch (e) { return String(e.code); } })();
out["proc-private"] = (() => { try { const p = fs.readdirSync("/proc").filter((x) => /^[0-9]+$/.test(x)); return "pids:" + p.length + (fs.readlinkSync("/proc/self/ns/pid") === c.controllerPidNamespace ? " pidns:controller" : " pidns:own"); } catch (e) { return String(e.code); } })();
out["env-minimal"] = (() => { const extra = Object.keys(process.env).filter((k) => !c.environment.includes(k)); return extra.length === 0 ? "ok" : "extra:" + extra.length; })();
out["fds-inherited"] = (() => { let bad = 0; for (const f of fs.readdirSync("/proc/self/fd")) { if (Number(f) <= 2) continue; try { const l = fs.readlinkSync("/proc/self/fd/" + f); if (!/^(anon_inode:|pipe:)/.test(l)) bad++; } catch { } } return "unexpected:" + bad; })();
out["net-interfaces"] = Object.keys(os.networkInterfaces()).filter((n) => n !== "lo").length === 0 ? "lo-only" : "other-interfaces";
c.sockets.forEach((p, i) => { out["socket-hidden-" + i] = code(() => fs.lstatSync(p)); });
const attempt = (opts) => new Promise((resolve) => { const s = net.connect(opts); const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 2000); s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); }); s.on("error", (e) => { clearTimeout(t); resolve(String(e.code || "error")); }); });
out["net-host-loopback"] = await attempt({ host: "127.0.0.1", port: c.loopbackPort });
out["net-external"] = await attempt({ host: "192.0.2.1", port: 80 });
out["net-host-abstract-socket"] = await attempt({ path: "\0" + c.abstractName });
out["net-host-path-socket"] = await attempt({ path: c.pathSocket });
process.stdout.write("ENDO-PREFLIGHT " + JSON.stringify(out) + "\n");
`;

const OBSERVED = /^[A-Za-z0-9_:.\- ]{1,80}$/;

/** Whether one observation is what an enforced boundary gives. Unknown probes fail. */
export function preflightPassesV0(id: string, observed: string): boolean {
	if (id.startsWith("fs-hidden-") || id.startsWith("socket-hidden-") || id === "fs-canary-read")
		return observed === "ENOENT";
	if (id.startsWith("fs-readonly-runtime-")) return observed === "EROFS" || observed === "EACCES";
	if (id === "fs-root-readonly" || id === "fs-dev-readonly" || id.startsWith("fs-readonly-mount-"))
		return observed === "EROFS";
	if (id === "fs-workspace-writable") return observed === "ok";
	if (id === "fs-tmp-private") return observed === "entries:0";
	if (id === "proc-private") {
		// PID numbers from two namespaces are not comparable (the sandbox has its own PID 1): what is checked is that the probe's PID
		// namespace is not the controller's, and that the sandbox shows only its few processes.
		const m = /^pids:([0-9]+) pidns:own$/.exec(observed);
		return m !== null && Number(m[1]) <= 4;
	}
	if (id === "env-minimal") return observed === "ok";
	if (id === "fds-inherited") return observed === "unexpected:0";
	if (id === "net-interfaces") return observed === "lo-only";
	// From a new network namespace, the host's loopback and the host's abstract sockets do not exist, and there is no route out.
	if (id === "net-host-loopback" || id === "net-host-abstract-socket") return observed === "ECONNREFUSED";
	if (id === "net-external") return observed === "ENETUNREACH";
	if (id === "net-host-path-socket") return observed === "ENOENT";
	return false;
}

const listen = (server: Server, target: { port: number; host: string } | { path: string }) =>
	new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(target, () => resolve());
	});

/**
 * Check the boundary of `profile` from inside it. The canary and the path socket are made in a new private directory under the host's
 * temporary directory (short enough for a socket path, and never mounted in any profile), removed afterwards.
 */
export async function preflightV0(
	bwrap: EndoBubblewrapV0,
	profile: EndoSandboxProfileV0,
	node: string,
	targets: EndoPreflightTargetsV0,
	containment: EndoContainmentV0,
	record: Pick<Parameters<typeof runSandboxV0>[3], "onScope" | "onLauncher"> = {},
): Promise<EndoPreflightV0> {
	let controllerPidNamespace: string;
	try {
		controllerPidNamespace = readlinkSync("/proc/self/ns/pid");
	} catch {
		return { status: "unavailable", probes: [], reason: "the controller's own PID namespace could not be read" };
	}
	const scratch = mkdtempSync(join(tmpdir(), "endo-preflight-"));
	const canary = join(scratch, `canary-${randomBytes(8).toString("hex")}`);
	writeFileSync(canary, randomBytes(16).toString("hex"), { mode: 0o600 });
	const tcp = createServer((s) => s.destroy());
	const abstract = createServer((s) => s.destroy());
	const unix = createServer((s) => s.destroy());
	const abstractName = `endo-preflight-${randomBytes(8).toString("hex")}`;
	const pathSocket = join(scratch, "socket");
	try {
		await listen(tcp, { port: 0, host: "127.0.0.1" });
		await listen(abstract, { path: `\0${abstractName}` });
		await listen(unix, { path: pathSocket });
		const address = tcp.address();
		const config = {
			protectedPaths: targets.protectedPaths,
			canary,
			readOnlyRuntime: targets.readOnlyRuntime,
			readOnlyMounts: targets.readOnlyMounts,
			writable: targets.writable,
			environment: targets.environment,
			sockets: targets.sockets,
			controllerPidNamespace,
			loopbackPort: typeof address === "object" && address !== null ? address.port : 0,
			abstractName,
			pathSocket,
			// A new name, created exclusively and removed: a task's own files in the workspace are never touched.
			probeName: `.endo-preflight-${randomBytes(12).toString("hex")}`,
		};
		const run = await runSandboxV0(
			bwrap,
			profile,
			[node, "--input-type=module", "-e", ENDO_PREFLIGHT_PROBE_V0, JSON.stringify(config)],
			{
				timeoutMs: 30_000,
				outputBytes: 64 * 1024,
				containment,
				...record,
			},
		);
		if (!run.started)
			return {
				status: "unavailable",
				probes: [],
				reason: `the sandbox did not start: ${run.stderr.toString("utf8").trim().slice(0, 200)}`,
			};
		const line = run.stdout
			.toString("utf8")
			.split("\n")
			.filter((l) => l.startsWith("ENDO-PREFLIGHT "));
		if (line.length !== 1 || run.exitCode !== 0 || run.termination !== "confirmed")
			return { status: "failed", probes: [], reason: "the probe did not report exactly once, exit 0, and end" };
		let observed: unknown;
		try {
			observed = JSON.parse((line[0] as string).slice("ENDO-PREFLIGHT ".length));
		} catch {
			return { status: "failed", probes: [], reason: "the probe's report was not readable" };
		}
		const probes: EndoProtectedProbeV0[] = Object.entries(observed as Record<string, unknown>)
			.map(([id, value]) => {
				const o = typeof value === "string" && OBSERVED.test(value) ? value : "unreadable";
				return { id, passed: preflightPassesV0(id, o), observed: o };
			})
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const expectedCount =
			Object.keys(targets.protectedPaths).length +
			targets.readOnlyRuntime.length +
			targets.readOnlyMounts.length +
			targets.sockets.length +
			13;
		if (probes.length !== expectedCount)
			return { status: "failed", probes, reason: "the probe did not report every check" };
		return probes.every((p) => p.passed)
			? { status: "established", probes, reason: null }
			: { status: "failed", probes, reason: null };
	} finally {
		for (const s of [tcp, abstract, unix]) s.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}
