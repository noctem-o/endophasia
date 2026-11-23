// A content manifest of a directory tree, for proving that a read wrote nothing: compare one taken before with one taken after.
// Each entry carries its relative path, type, mode and mtime, and for a file its size and the sha256 of its bytes, so a created, removed,
// rewritten, re-moded or merely touched entry shows up as a difference.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every entry under `dir`: its relative path, type, mode, size, mtime and (for files) the sha256 of its bytes. */
export function manifestOf(dir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		const abs = join(dir, rel);
		const st = lstatSync(abs, { bigint: true });
		const head = `${rel || "."} mode=${st.mode.toString(8)} mtime=${st.mtimeNs}`;
		if (st.isDirectory()) {
			out.push(`${head} dir`);
			for (const name of readdirSync(abs).sort()) walk(rel === "" ? name : `${rel}/${name}`);
		} else if (st.isFile()) {
			out.push(`${head} size=${st.size} sha256=${createHash("sha256").update(readFileSync(abs)).digest("hex")}`);
		} else out.push(`${head} other`);
	};
	walk("");
	return out;
}
