import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readEventLogBytesV0(root: string, domain: "session" | "capture" = "session"): Buffer {
	const read = (directory: string) => {
		const stat = lstatSync(directory, { throwIfNoEntry: false });
		if (stat === undefined) return [];
		if (!stat.isDirectory()) throw new Error(`not an event directory: ${directory}`);
		return readdirSync(directory, { withFileTypes: true });
	};
	const bytes: Buffer[] = [];
	for (const base of [root, join(root, "capture")]) {
		const start = bytes.length;
		const events = join(base, "events");
		for (const directory of [
			events,
			...read(join(events, "attachments"))
				.filter((item) => item.isDirectory())
				.map((item) => join(events, "attachments", item.name)),
		]) {
			for (const entry of read(directory)) {
				if (entry.name !== "events.log") continue;
				if (!entry.isFile()) throw new Error(`not a regular event log: ${join(directory, entry.name)}`);
				const log = readFileSync(join(directory, entry.name));
				bytes.push(log);
			}
		}
		if ((base === root ? "session" : "capture") === domain && !bytes.slice(start).some((log) => log.length > 0))
			throw new Error(`no recorded event bytes in ${domain} streams`);
	}
	return Buffer.concat(bytes);
}
