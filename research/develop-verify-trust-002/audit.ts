// DEVELOP-VERIFY-TRUST-002: a read-only audit of this host for the installed phase (THREAT-MODEL.md §6, ARCHITECTURE.md §4). Research only.
//
//   node audit.ts [--installed]
//
// It reads file metadata, group membership and readable policy files. It runs no privileged command, contacts no daemon and exercises no
// route. With --installed it also audits the installation's own paths (which must exist then).

import { accessSync, constants, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";

/** lstat that reports an unreadable path by its error code instead of throwing (a socket in a directory this account cannot search). */
export function look(path: string): Stats | "absent" | string {
	try {
		return lstatSync(path, { throwIfNoEntry: false }) ?? "absent";
	} catch (e) {
		return String((e as NodeJS.ErrnoException).code ?? "error");
	}
}

import { dirname, resolve } from "node:path";
import { resolveRuntimeV0 } from "../../adapters/sandbox/bubblewrap.ts";
import { INSTALLED } from "./install/layout.ts";

type Check = { id: string; path?: string; observed: string; ok: boolean };

/** Root-owned (or, with `uid`, owned by that uid) and not writable by group or others, with every ancestor root's. */
function owned(path: string, uid = 0): string {
	const s = look(path);
	if (typeof s === "string") return s;
	if (s.uid !== uid) return `owner ${s.uid}`;
	if ((s.mode & 0o022) !== 0) return `mode ${(s.mode & 0o7777).toString(8)}`;
	for (let d = dirname(path); ; d = dirname(d)) {
		const a = look(d);
		if (typeof a === "string") return `ancestor ${d} ${a}`;
		if (a.uid !== 0 || (a.mode & 0o022) !== 0)
			return `ancestor ${d} owner ${a.uid} mode ${(a.mode & 0o7777).toString(8)}`;
		if (d === "/") break;
	}
	return "ok";
}

/** Where the audit reads the account from; injectable so that tests can describe another account. */
export interface AccountSource {
	/** `/proc/self/status`: the groups this process holds now. */
	status: string;
	/** `/etc/group`. */
	group: string;
	/** `/etc/passwd`. */
	passwd: string;
	uid: number;
	/** True when the account is this very process's, so that access(2) may answer for it (ACLs included). */
	effective?: boolean;
}
const hostAccount = (): AccountSource => ({
	effective: true,
	status: readFileSync("/proc/self/status", "utf8"),
	group: readFileSync("/etc/group", "utf8"),
	passwd: readFileSync("/etc/passwd", "utf8"),
	uid: process.getuid?.() ?? -1,
});

/**
 * The account's groups: those this process holds **and** those `/etc/group` and `/etc/passwd` give the account. A member listed in
 * `/etc/group` regains a group without a password (`newgrp`, `sg`, a new login), so dropping it from one process proves nothing (review V5).
 */
export function accountGroups(a: AccountSource): { gid: number; name: string; held: boolean; configured: boolean }[] {
	const held = new Set((a.status.match(/^Groups:\s*(.*)$/m)?.[1] ?? "").split(/\s+/).filter(Boolean).map(Number));
	const me = a.passwd
		.split("\n")
		.map((l) => l.split(":"))
		.find((f) => f.length >= 4 && Number(f[2]) === a.uid);
	const user = me?.[0];
	const primary = me === undefined ? Number.NaN : Number(me[3]);
	return a.group
		.split("\n")
		.map((l) => l.split(":"))
		.filter((f) => f.length >= 4)
		.map((f) => {
			const gid = Number(f[2]);
			const configured = gid === primary || (user !== undefined && (f[3] ?? "").split(",").includes(user));
			return { gid, name: f[0] as string, held: held.has(gid), configured };
		})
		.filter((g) => g.held || g.configured);
}

/**
 * Writable by this account: by mode bits for every group the account has or could regain, and, for this process's own account, by
 * access(2), which also counts ACLs (operator review: mode bits alone miss an ACL grant).
 */
function writable(path: string, account: AccountSource): string {
	const s = look(path);
	if (typeof s === "string") return s;
	const gids = new Set(accountGroups(account).map((g) => g.gid));
	const uid = account.uid;
	const w = s.uid === uid ? s.mode & 0o200 : gids.has(s.gid) ? s.mode & 0o020 : s.mode & 0o002;
	if (w !== 0) return "writable";
	if (account.effective === true) {
		try {
			accessSync(path, constants.W_OK);
			return "writable (access)";
		} catch {
			// not writable for this process either
		}
	}
	return "not-writable";
}

function accountUser(a: AccountSource): string | undefined {
	return a.passwd
		.split("\n")
		.map((l) => l.split(":"))
		.find((f) => f.length >= 4 && Number(f[2]) === a.uid)?.[0];
}

const POLKIT_RULES = ["/etc/polkit-1/rules.d", "/usr/share/polkit-1/rules.d"];

/**
 * Readable polkit rules that return YES for one of this account's groups or for the account by name: a heuristic over the rule files'
 * text, not an evaluation of polkit's JavaScript. Directories it cannot read are reported, not assumed empty.
 */
export function polkitGrants(
	account: AccountSource,
	read: (dir: string) => { name: string; text: string }[] | string = readRules,
): { grants: string[]; unread: string[] } {
	const groups = accountGroups(account).map((g) => g.name);
	const user = accountUser(account);
	const grants: string[] = [];
	const unread: string[] = [];
	for (const dir of POLKIT_RULES) {
		const files = read(dir);
		if (typeof files === "string") {
			unread.push(`${dir}: ${files}`);
			continue;
		}
		for (const f of files) {
			if (!/Result\.YES/.test(f.text)) continue;
			const names = groups.filter(
				(g) => f.text.includes(`isInGroup("${g}")`) || f.text.includes(`isInGroup('${g}')`),
			);
			if (user !== undefined && new RegExp(`user\\s*==\\s*["']${user}["']`).test(f.text)) names.push(`user ${user}`);
			if (names.length > 0) grants.push(`${dir}/${f.name}: YES for ${names.join(", ")}`);
		}
	}
	return { grants, unread };
}

function readRules(dir: string): { name: string; text: string }[] | string {
	try {
		return readdirSync(dir)
			.filter((n) => n.endsWith(".rules"))
			.map((name) => {
				try {
					return { name, text: readFileSync(`${dir}/${name}`, "utf8") };
				} catch {
					return { name, text: "" };
				}
			});
	} catch (e) {
		return String((e as NodeJS.ErrnoException).code ?? "error");
	}
}

/**
 * What a passing H0 does **not** establish (operator review). The audit checks known routes; it is a necessary check, not a proof that
 * no unauthenticated route to root or to the verifier exists.
 */
export const H0_LIMITS = [
	"sudo rules: /etc/sudoers and /etc/sudoers.d are not readable to the account; NOPASSWD and global timestamps are not inspected (the installed gate adds `sudo -n true`, which must fail)",
	"polkit: rules are matched by text, not evaluated; unreadable rule directories are not inspected",
	"other local daemons and their sockets (beyond docker, libvirt and podman), and ACLs on objects other than those sockets",
	"setuid and file-capability programs and their own policies",
	"credentials the account holds for root or for the verifier elsewhere (ssh keys, cached tokens), and scheduled jobs run by root from files the account can write",
	"kernel and service vulnerabilities",
];

export function audit(
	installed: boolean,
	account: AccountSource = hostAccount(),
): { h0: boolean; closure: boolean; scope: string; limits: string[]; checks: Check[] } {
	const checks: Check[] = [];
	// H0: no unauthenticated route to root or another uid for this account, held now or configured.
	const g = accountGroups(account).map((x) => x.name);
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
			observed: writable(p, account),
			ok: writable(p, account) !== "writable" || p.includes("libvirt-sock"),
		});
	// Rules granting YES to a group known to be root-equivalent fail H0. Other passwordless grants are privileged actions that are not known
	// routes to root (and whose local/active conditions are not evaluated): they are listed for the operator to review, not decided here.
	const polkit = polkitGrants(account);
	const rootEquivalent = polkit.grants.filter((x) => /YES for .*\b(libvirt|empower|docker|lxd)\b/.test(x));
	const review = polkit.grants.filter((x) => !rootEquivalent.includes(x));
	checks.push({
		id: "h0-polkit-yes",
		observed:
			rootEquivalent.length === 0 ? "none to a root-equivalent group in readable rules" : rootEquivalent.join("; "),
		ok: rootEquivalent.length === 0,
	});
	if (review.length > 0)
		checks.push({
			id: "h0-polkit-review",
			observed: `passwordless grants to review: ${review.join("; ")}`,
			ok: true,
		});
	if (polkit.unread.length > 0) checks.push({ id: "h0-polkit-unread", observed: polkit.unread.join("; "), ok: true });
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
		// The socket's gate: its directory is the verifier's, mode 0750, group the operator's primary group, which has no other member.
		const dir = look(dirname(INSTALLED.socket));
		const me = account.passwd
			.split("\n")
			.map((l) => l.split(":"))
			.find((f) => f.length >= 4 && Number(f[2]) === account.uid);
		const primary = Number(me?.[3] ?? Number.NaN);
		const others = account.group
			.split("\n")
			.map((l) => l.split(":"))
			.find((f) => f.length >= 4 && Number(f[2]) === primary)?.[3]
			?.split(",")
			.filter((m) => m !== "" && m !== me?.[0]);
		const gate =
			typeof dir === "string"
				? dir
				: `owner ${dir.uid} group ${dir.gid} mode ${(dir.mode & 0o7777).toString(8)}; other members of the group: ${others?.join(",") || "none"}`;
		checks.push({
			id: "installed-socket-gate",
			path: dirname(INSTALLED.socket),
			observed: gate,
			ok:
				typeof dir !== "string" &&
				dir.uid === uid &&
				dir.gid === primary &&
				(dir.mode & 0o7777) === 0o750 &&
				(others?.length ?? 0) === 0,
		});
	}
	const h0 = checks.filter((c) => c.id.startsWith("h0-")).every((c) => c.ok);
	const closure = checks.filter((c) => !c.id.startsWith("h0-")).every((c) => c.ok);
	return {
		h0,
		closure,
		scope: "known routes only: a necessary check, not a proof of separation",
		limits: H0_LIMITS,
		checks,
	};
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const r = audit(process.argv.includes("--installed"));
	process.stdout.write(`${JSON.stringify({ schemaVersion: "endo.research.dvt002.audit.v0", ...r }, null, 2)}\n`);
	process.exitCode = r.h0 && r.closure ? 0 : 1;
}
