import { closeSync, constants, fstatSync, opendirSync, openSync } from "node:fs";
import { join } from "node:path";

const PATH_FLAGS = 0o10000000 | constants.O_NOFOLLOW;
const MAX_ENTRIES = 4096;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;

export class CoordinatorStoreMountErrorV0 extends Error {
	readonly reason: "status-source-not-regular" | "status-source-too-large";

	constructor(reason: CoordinatorStoreMountErrorV0["reason"]) {
		super(reason);
		this.reason = reason;
	}
}

export function pinCoordinatorStoreV0(store: string) {
	const mounts: string[] = [];
	const fds: number[] = [];
	let entries = 0;
	const close = () => {
		for (const fd of fds.splice(0)) closeSync(fd);
	};
	const open = (path: string, expected: "file" | "directory", action: (fd: number) => boolean, optional = false) => {
		let fd: number;
		try {
			fd = openSync(path, PATH_FLAGS);
		} catch (error) {
			if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		let retained = false;
		try {
			const stat = fstatSync(fd);
			if (expected === "file" ? !stat.isFile() : !stat.isDirectory())
				throw new CoordinatorStoreMountErrorV0("status-source-not-regular");
			if (++entries > MAX_ENTRIES) throw new CoordinatorStoreMountErrorV0("status-source-too-large");
			retained = action(fd);
		} finally {
			if (!retained) closeSync(fd);
		}
	};
	const file = (parent: number, name: string, dest: string, optional = false) =>
		open(
			join(fdPath(parent), name),
			"file",
			(fd) => {
				mounts.push("--ro-bind-fd", String(fds.length + 3), dest);
				fds.push(fd);
				return true;
			},
			optional,
		);
	const dir = (parent: number, name: string, dest: string, read: (fd: number) => void, optional = false) =>
		open(
			join(fdPath(parent), name),
			"directory",
			(fd) => {
				mounts.push("--dir", dest);
				read(fd);
				return false;
			},
			optional,
		);
	const enumerate = (fd: number, dest: string, receiptRoot: boolean) => {
		const listing = opendirSync(fdPath(fd));
		try {
			for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
				const path = join(dest, entry.name);
				if (entry.isDirectory() && receiptRoot) dir(fd, entry.name, path, (child) => enumerate(child, path, false));
				else file(fd, entry.name, path);
			}
		} finally {
			listing.closeSync();
		}
	};
	try {
		open(store, "directory", (root) => {
			const develop = join(store, "develop");
			const events = join(store, "events");
			dir(root, "develop", develop, (fd) => {
				file(fd, "tasks.json", join(develop, "tasks.json"));
				// E1: exactly the coordination FILE, descriptor-pinned, when it exists (a pre-E1 store has none). Never its directory, its
				// writer locks (`coordination.lock.<n>`) or temporaries, and nothing a coordination record names.
				file(fd, "coordination.json", join(develop, "coordination.json"), true);
				const attempts = join(develop, "attempts");
				const receipts = join(develop, "receipts");
				dir(fd, "attempts", attempts, (child) => enumerate(child, attempts, false), true);
				dir(fd, "receipts", receipts, (child) => enumerate(child, receipts, true), true);
			});
			dir(root, "events", events, (fd) => file(fd, "events.log", join(events, "events.log"), true), true);
			return false;
		});
		return { mounts, fds, close };
	} catch (error) {
		close();
		throw error;
	}
}
