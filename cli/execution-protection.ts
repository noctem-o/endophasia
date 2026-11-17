/**
 * What bounds the agent on THIS host, for a live workbench session (runtime/contracts/execution-protection.ts; DEVELOP-UX-002 §5).
 *
 * Today the answer is always "nothing": `endo develop` starts Pi as the operator's own account, in the operator's session, with the
 * operator's environment, files and network, and no launcher in this build places it inside a boundary. This provider therefore never
 * reports `enforced`. It exists so that the reason is said precisely, on the terminal and on the page, and so that the day a launcher
 * does place Pi in a boundary it has one place to report what it OBSERVED from inside it.
 *
 * What it reads is read-only and unprivileged: this process's uid and groups, whether two well-known sockets are writable by it, and
 * one kernel setting. It runs nothing, and it is not an audit: a host with none of these findings is not thereby safe.
 */
import { accessSync, constants, readFileSync } from "node:fs";
import type {
	EndoExecutionProtectionStatusV0,
	EndoExecutionProtectionV0,
} from "../runtime/contracts/execution-protection.ts";

/** What the provider looks at, replaceable in tests. */
export interface HostFactsV0 {
	uid(): number | null;
	/** Whether this process may connect to (write) the Unix socket at `path`. */
	writable(path: string): boolean;
	/** The text of a small file, or null. */
	read(path: string): string | null;
}

const HOST: HostFactsV0 = {
	uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
	writable: (path) => {
		try {
			accessSync(path, constants.W_OK);
			return true;
		} catch {
			return false;
		}
	},
	read: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
};

/** Sockets whose use is a documented route to root (DEVELOP-VERIFY-TRUST-002 §6). */
const PRIVILEGED_SOCKETS: readonly (readonly [string, string])[] = [
	["/run/docker.sock", "the Docker daemon's socket"],
	["/var/run/docker.sock", "the Docker daemon's socket"],
	["/run/libvirt/libvirt-sock", "the system libvirt socket"],
	["/var/run/libvirt/libvirt-sock", "the system libvirt socket"],
];

/**
 * The findings for this host, most decisive first. The first is always present: it is the reason no session grant can be issued, and
 * the others would each void a boundary that shared them with the agent.
 */
export function hostExecutionLimitationsV0(facts: HostFactsV0 = HOST): string[] {
	const uid = facts.uid();
	const lines = [
		`Pi is not placed inside an execution boundary by this build: it runs as your account${uid === null ? "" : ` (uid ${uid})`}, with your files, credentials, terminal and network. A session grant would let a page cause anything that account can do.`,
	];
	if (uid === 0) lines.push("This process is root: nothing on this host is outside the agent's reach.");
	const seen = new Set<string>();
	for (const [path, what] of PRIVILEGED_SOCKETS)
		if (!seen.has(what) && facts.writable(path)) {
			seen.add(what);
			lines.push(
				`This account can use ${what} (${path}) without a password, which is a route to root; a boundary must hide it from the agent.`,
			);
		}
	if (facts.read("/proc/sys/dev/tty/legacy_tiocsti")?.trim() === "1")
		lines.push(
			"This kernel lets a process inject input into its controlling terminal (dev.tty.legacy_tiocsti=1), so an agent in this terminal's session could type an approval; a boundary must give the agent no terminal.",
		);
	return lines;
}

/** The production provider. It observes no boundary because none is built; it never returns `enforced`. */
export function hostExecutionProtectionV0(facts: HostFactsV0 = HOST): EndoExecutionProtectionV0 {
	return {
		observe: (): EndoExecutionProtectionStatusV0 => ({
			state: "not-enforced",
			level: "none",
			mechanism: null,
			session: null,
			workspaceRoot: null,
			limitations: hostExecutionLimitationsV0(facts),
		}),
	};
}
