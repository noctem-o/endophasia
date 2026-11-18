import { accessSync, constants, readFileSync } from "node:fs";
import type {
	EndoExecutionProtectionStatusV0,
	EndoExecutionProtectionV0,
} from "../runtime/contracts/execution-protection.ts";
import type { PiLaunchAttestationV0 } from "./attested-pi.ts";

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
		`No attested execution boundary is available for this launch. Pi runs as your account${uid === null ? "" : ` (uid ${uid})`}, with your files, credentials, terminal and network. A session grant would let a page cause anything that account can do.`,
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

export const PI_WORKSPACE_PROTECTION_V0 = "endo.pi-bubblewrap-workspace.v0";

export function attestedExecutionProtectionV0(
	record: () => PiLaunchAttestationV0 | null,
	expected: () => { session: string | null; workspaceRoot: string },
): EndoExecutionProtectionV0 {
	const refused = (state: "not-enforced" | "unknown", reason: string): EndoExecutionProtectionStatusV0 => ({
		state,
		level: "none",
		mechanism: null,
		session: null,
		workspaceRoot: null,
		limitations: [reason],
	});
	let held: PiLaunchAttestationV0 | null = null;
	let lost: EndoExecutionProtectionStatusV0 | null = null;
	const lose = (state: "not-enforced" | "unknown", reason: string) => {
		lost = refused(state, reason);
		return lost;
	};
	return {
		observe(): EndoExecutionProtectionStatusV0 {
			if (lost !== null) return lost;
			try {
				const found = record();
				if (found === null) {
					const status = refused("not-enforced", "No live execution attestation is available for this launch.");
					if (held !== null) lost = status;
					return status;
				}
				if (
					typeof found.session !== "string" ||
					!/^endo\.session\.pi\.[A-Za-z0-9._-]{1,128}$/.test(found.session) ||
					typeof found.workspaceRoot !== "string" ||
					!found.workspaceRoot.startsWith("/") ||
					typeof found.check !== "function"
				)
					return lose("unknown", "The live execution attestation is inconsistent.");
				const subject = expected();
				if (found.session !== subject.session || found.workspaceRoot !== subject.workspaceRoot)
					return lose("not-enforced", "The execution attestation is for a different session or workspace.");
				if (held !== null && found !== held)
					return lose("unknown", "The live execution attestation is inconsistent.");
				const check = found.check();
				if (check === false)
					return lose("not-enforced", "The attested process, scope, namespaces, or workspace no longer match.");
				if (check !== true) return lose("unknown", "The live execution attestation is inconsistent.");
				held = found;
				return {
					state: "enforced",
					level: "workspace",
					mechanism: PI_WORKSPACE_PROTECTION_V0,
					session: found.session,
					workspaceRoot: found.workspaceRoot,
					limitations: [
						"No credential route is available.",
						"Restricted protection is not established.",
						"RPC frames are not attributed to individual writers.",
					],
				};
			} catch {
				return lose("unknown", "The live execution evidence could not be read.");
			}
		},
	};
}
