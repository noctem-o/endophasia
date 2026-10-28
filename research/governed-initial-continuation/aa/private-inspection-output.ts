import { closeSync, constants, fstatSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";

export function validatePrivateDirectoryV0(fd: number): void {
	const dir = fstatSync(fd);
	if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
		throw new Error("private output directory required");
}

/** The pinned directory, not a potentially replaced path, owns the no-clobber output. */
export function publishPrivateInspectionV0(parent: number, path: string, value: unknown): void {
	validatePrivateDirectoryV0(parent);
	const name = basename(path);
	if (!name || name === "." || name === "..") throw new Error("invalid output name");
	const fd = openSync(
		`/proc/self/fd/${parent}/${name}`,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncSync(parent);
}
