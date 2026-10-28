import { readlinkSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

export type OwnershipStatusV0 = "MATCH" | "MISMATCH" | "UNAVAILABLE";
/** Bounded procfs scan. Incomplete process/FD visibility never establishes sole ownership. */
export async function inspectSocketOwnersV0(
	procRoot: string,
	inode: string,
	selectedPid: number,
	check: () => void,
): Promise<OwnershipStatusV0> {
	if (!/^[0-9]+$/.test(inode) || !Number.isSafeInteger(selectedPid) || selectedPid < 1)
		throw new Error("invalid ownership input");
	let visible = true,
		processCount = 0,
		descriptorCount = 0;
	const owners = new Set<number>();
	const processes = await opendir(procRoot);
	for await (const process of processes) {
		check();
		if (!/^[0-9]+$/.test(process.name)) continue;
		if (++processCount > 4096) return "UNAVAILABLE";
		try {
			const fds = await opendir(join(procRoot, process.name, "fd"));
			for await (const entry of fds) {
				check();
				if (++descriptorCount > 65536) return "UNAVAILABLE";
				try {
					if (readlinkSync(join(procRoot, process.name, "fd", entry.name)) === `socket:[${inode}]`)
						owners.add(Number(process.name));
				} catch {
					visible = false;
				}
			}
		} catch {
			check();
			visible = false;
		}
	}
	if (owners.size > 1 || (owners.size === 1 && !owners.has(selectedPid))) return "MISMATCH";
	if (!visible || !owners.has(selectedPid)) return "UNAVAILABLE";
	return "MATCH";
}
