import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";

/** Owner-only, never overwrites, and survives a crash once it returns. */
export function publishExclusiveV0(file: string, value: unknown): void {
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const parent = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}
