import { closeSync, constants, fstatSync, opendirSync, openSync } from "node:fs";
import { join } from "node:path";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { WRITE_ONCE_TEMPORARY_V0 } from "../../storage/write-once.ts";

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

export function pinCoordinatorStoreV0(store: string, projectId?: string) {
	const mounts: string[] = [];
	const fds: number[] = [];
	let entries = 0;
	let coordinationUnsafe = false;
	let reviewsUnsafe = false;
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
	const MAX_REVIEW_ENTRIES = 320;
	const enumerate = (
		fd: number,
		dest: string,
		receiptRoot: boolean,
		skipTemporaries = false,
		maxLocalEntries?: number,
	) => {
		const listing = opendirSync(fdPath(fd));
		let localCount = 0;
		try {
			for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
				if (skipTemporaries && WRITE_ONCE_TEMPORARY_V0.test(entry.name)) continue;
				if (maxLocalEntries !== undefined && ++localCount > maxLocalEntries) {
					throw new Error("status-reviews-too-large");
				}
				const path = join(dest, entry.name);
				if (entry.isDirectory() && receiptRoot)
					dir(fd, entry.name, path, (child) => enumerate(child, path, false, skipTemporaries, maxLocalEntries));
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
			// Mount primary Coordinator inputs FIRST so a bloated or unsafe review directory can NEVER starve
			// `MAX_ENTRIES` or FDs for `tasks.json`, `attempts/`, `receipts/`, or `events/events.log` (Adversarial Finding #3).
			dir(root, "develop", develop, (fd) => {
				file(fd, "tasks.json", join(develop, "tasks.json"));
				// E1: exactly the coordination FILE, descriptor-pinned, when it exists (a pre-E1 store has none). Never its directory, its
				// writer locks (`coordination.lock.<n>`) or temporaries, and nothing a coordination record names.
				try {
					file(fd, "coordination.json", join(develop, "coordination.json"), true);
				} catch {
					coordinationUnsafe = true;
				}
				const attempts = join(develop, "attempts");
				const receipts = join(develop, "receipts");
				dir(fd, "attempts", attempts, (child) => enumerate(child, attempts, false), true);
				dir(fd, "receipts", receipts, (child) => enumerate(child, receipts, true), true);
			});
			dir(root, "events", events, (fd) => file(fd, "events.log", join(events, "events.log"), true), true);
			// E2-D: descriptor-pin ONLY the requested project's advisory review directory LAST, with a dedicated
			// per-project entry cap and full mount/FD/entry rollback on any error so primary status stays isolated.
			if (projectId !== undefined && ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) {
				const snapMounts = mounts.length;
				const snapFds = fds.length;
				const snapEntries = entries;
				const reviewsRoot = join(develop, "coordination-reviews");
				const projectReviews = join(reviewsRoot, projectId);
				try {
					open(
						join(fdPath(root), "develop"),
						"directory",
						(devFd) => {
							dir(
								devFd,
								"coordination-reviews",
								reviewsRoot,
								(revRootFd) => {
									dir(
										revRootFd,
										projectId,
										projectReviews,
										(projRevFd) => enumerate(projRevFd, projectReviews, false, true, MAX_REVIEW_ENTRIES),
										true,
									);
								},
								true,
							);
							return false;
						},
						true,
					);
				} catch {
					reviewsUnsafe = true;
					// Roll back partial review mounts and close any FDs opened for reviews.
					mounts.length = snapMounts;
					while (fds.length > snapFds) {
						const leaked = fds.pop();
						if (leaked !== undefined) {
							try {
								closeSync(leaked);
							} catch {
								// ignore close failure
							}
						}
					}
					entries = snapEntries;
				}
			}
			return false;
		});
		return { mounts, fds, close, coordinationUnsafe, reviewsUnsafe };
	} catch (error) {
		close();
		throw error;
	}
}
