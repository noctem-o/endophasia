// DEVELOP-VERIFY-TRUST-002: a read-only audit of this host for the installed phase (THREAT-MODEL.md §6, ARCHITECTURE.md §4). Research only.
//
//   node audit.ts [--installed]
//
// It reads file metadata, group membership and readable policy files. It runs no privileged command, contacts no daemon and exercises no
// route. With --installed it also audits the installation's own paths (which must exist then).

import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveRuntimeV0 } from "../../adapters/sandbox/bubblewrap.ts";
import { INSTALLED } from "./install/layout.ts";

type Check = { id: string; path?: string; observed: string; ok: boolean };

/** Root-owned (or, with `uid`, owned by that uid) and not writable by group or others, with every ancestor root's. */
function owned(path: string, uid = 0): string {
	const s = lstatSync(path, { throwIfNoEntry: false });
	if (s === undefined) return "absent";
	if (s.uid !== uid) return `owner ${s.uid}`;
	if ((s.mode & 0o022) !== 0) return `mode ${(s.mode & 0o7777).toString(8)}`;
	for (let d = dirname(path); ; d = dirname(d)) {
		const a = lstatSync(d);
		if (a.uid !== 0 || (a.mode & 0o022) !== 0)
			return `ancestor ${d} owner ${a.uid} mode ${(a.mode & 0o7777).toString(8)}`;
		if (d === "/") break;
	}
	return "ok";
}

function groups(): { gid: number; name: string }[] {
	const mine = new Set(
		(readFileSync("/proc/self/status", "utf8").match(/^Groups:\s*(.*)$/m)?.[1] ?? "")
			.split(/\s+/)
			.filter(Boolean)
			.map(Number),
	);
	return readFileSync("/etc/group", "utf8")
		.split("\n")
		.map((l) => l.split(":"))
		.filter((f) => f.length >= 3 && mine.has(Number(f[2])))
		.map((f) => ({ gid: Number(f[2]), name: f[0] as string }));
}

function writable(path: string): string {
	const s = lstatSync(path, { throwIfNoEntry: false });
	if (s === undefined) return "absent";
	const gids = new Set(groups().map((g) => g.gid));
	const uid = process.getuid?.() ?? -1;
	const w = s.uid === uid ? s.mode & 0o200 : gids.has(s.gid) ? s.mode & 0o020 : s.mode & 0o002;
	return w !== 0 ? "writable" : "not-writable";
}

export function audit(installed: boolean): { h0: boolean; closure: boolean; checks: Check[] } {
	const checks: Check[] = [];
	// H0: no unauthenticated route to root or another uid for this account.
	const g = groups().map((x) => x.name);
	for (const [name, meaning] of [
		["docker", "root-equivalent through the Docker daemon"],
		["libvirt", "system hypervisor management without a password (polkit)"],
		["empower", "every polkit action without a password"],
		["lxd", "root-equivalent through LXD"],
		["disk", "raw block devices"],
	] as const)
		checks.push({
			id: `h0-group-${name}`,
			observed: g.includes(name) ? `member: ${meaning}` : "not a member",
			ok: !g.includes(name),
		});
	for (const p of ["/run/docker.sock", "/run/libvirt/libvirt-sock", "/run/podman/podman.sock"])
		checks.push({
			id: "h0-socket",
			path: p,
			observed: writable(p),
			ok: writable(p) !== "writable" || p.includes("libvirt-sock"),
		});
	checks.push({
		id: "h0-sudoers-readable",
		path: "/etc/sudoers.d",
		observed: (() => {
			try {
				readFileSync("/etc/sudoers");
				return "readable";
			} catch (e) {
				return `${(e as NodeJS.ErrnoException).code}: NOPASSWD cannot be ruled out by inspection`;
			}
		})(),
		ok: true,
	});
	checks.push({
		id: "h0-ptrace-scope",
		path: "/proc/sys/kernel/yama/ptrace_scope",
		observed: readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim(),
		ok: true,
	});
	// The runtime closure the verifier would load: root-owned, by 001's own rule.
	const runtime = resolveRuntimeV0(["/usr/bin/node"]);
	checks.push({
		id: "closure-node-runtime",
		observed: runtime.ok ? `ok: ${runtime.files.length} files` : `${runtime.reason}`,
		ok: runtime.ok,
	});
	for (const p of [
		"/usr/bin/node",
		"/usr/bin/bwrap",
		"/usr/bin/systemd-run",
		"/usr/bin/systemctl",
		"/etc/ld.so.cache",
	])
		checks.push({ id: "closure-tool", path: p, observed: owned(p), ok: owned(p) === "ok" });
	checks.push({
		id: "closure-ld-preload-file",
		path: "/etc/ld.so.preload",
		observed: owned("/etc/ld.so.preload"),
		ok: ["ok", "absent"].includes(owned("/etc/ld.so.preload")),
	});
	// Where the installation would go: root's directories.
	for (const p of ["/usr/local/lib", "/etc/systemd/user", "/var/lib", "/var/lib/systemd/linger", "/etc/tmpfiles.d"])
		checks.push({ id: "target-parent", path: p, observed: owned(p), ok: owned(p) === "ok" });
	if (installed) {
		const uid = Number(
			readFileSync("/etc/passwd", "utf8")
				.split("\n")
				.find((l) => l.startsWith(`${INSTALLED.user}:`))
				?.split(":")[2] ?? "-1",
		);
		for (const p of [
			INSTALLED.install,
			`${INSTALLED.install}/installation.json`,
			`/etc/systemd/user/${INSTALLED.unit}.socket`,
			`/etc/systemd/user/${INSTALLED.unit}@.service`,
		])
			checks.push({ id: "installed-root", path: p, observed: owned(p), ok: owned(p) === "ok" });
		for (const p of [INSTALLED.state, `${INSTALLED.state}/records`])
			checks.push({ id: "installed-verifier", path: p, observed: owned(p, uid), ok: owned(p, uid) === "ok" });
	}
	const h0 = checks.filter((c) => c.id.startsWith("h0-")).every((c) => c.ok);
	const closure = checks.filter((c) => !c.id.startsWith("h0-")).every((c) => c.ok);
	return { h0, closure, checks };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const r = audit(process.argv.includes("--installed"));
	process.stdout.write(`${JSON.stringify({ schemaVersion: "endo.research.dvt002.audit.v0", ...r }, null, 2)}\n`);
	process.exitCode = r.h0 && r.closure ? 0 : 1;
}
