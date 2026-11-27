// Deterministic process-lifecycle and loopback port helpers for integration tests.
//
// Distinguishes:
// - a running executable from an unreaped dead zombie (`Z` / `X` state in `/proc/<pid>/stat`), because POSIX
//   `kill(pid, 0)` returns 0 on a zombie until PID 1 reaps it;
// - non-ephemeral loopback ports from Linux's active ephemeral range (`ip_local_port_range`, typically 32768–60999),
//   eliminating bind-release-rebind collisions with concurrent `listen(0)` and outbound TCP sockets in sibling workers.

import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

/**
 * True if `pid` is still a running (non-zombie, non-dead) process.
 * On Linux, a process killed by SIGKILL may briefly remain in state `Z` (zombie) awaiting PID 1 reaping while
 * `process.kill(pid, 0)` still succeeds. A zombie cannot execute instructions or hold sockets/FDs.
 */
export function isProcessRunningV0(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
			if (state === "Z" || state === "X") return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		}
	}
	return true;
}

/** True when a loopback bind on `port` succeeds right now. */
export function loopbackPortIsFreeV0(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}

let portCursor = 0;

/**
 * Allocate a verified-free loopback port outside Linux's active ephemeral port range (`ip_local_port_range`)
 * when possible, partitioned by Vitest worker ID and PID to prevent cross-worker bind-release-rebind races.
 */
export async function allocateIsolatedLoopbackPortV0(): Promise<number> {
	let ephemeralMin = 32768;
	if (process.platform === "linux") {
		try {
			const [low] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/);
			const parsed = Number(low);
			if (Number.isSafeInteger(parsed) && parsed >= 10240) ephemeralMin = parsed;
		} catch {
			// Fall back to standard Linux default (32768).
		}
	}
	const rangeStart = 12000;
	const rangeEnd = Math.min(ephemeralMin - 1024, 31000);
	const span = rangeEnd - rangeStart;
	if (span >= 1024) {
		const workerId = Math.max(0, Number(process.env.VITEST_POOL_ID ?? 1) - 1);
		const stride = 256;
		const buckets = Math.max(1, Math.floor(span / stride));
		const bucket = (workerId + (process.pid % buckets)) % buckets;
		const base = rangeStart + bucket * stride;
		for (let attempt = 0; attempt < 128; attempt++) {
			const offset = portCursor++ % stride;
			const candidate = base + offset;
			if (await loopbackPortIsFreeV0(candidate)) return candidate;
		}
	}
	// Fallback: OS ephemeral allocation.
	const reservation = createServer();
	await new Promise<void>((resolve, reject) => {
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", resolve);
	});
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("port reservation failed");
	await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

/**
 * Return a numeric file descriptor guaranteed absent from `/proc/<pid>/fd` so tests never collide with
 * inherited parent file descriptors.
 */
export function absentFdForPidV0(pid: number): string {
	let maxFd = 1024;
	if (process.platform === "linux") {
		try {
			for (const entry of readdirSync(`/proc/${pid}/fd`)) {
				const n = Number(entry);
				if (Number.isSafeInteger(n) && n > maxFd) maxFd = n;
			}
		} catch {
			// Process already exited or /proc unavailable; 1088 is still far above standard FDs.
		}
	}
	return String(maxFd + 64);
}
