// Fresh-process, read-only evidence inspection; output is exclusively created and private.
import { closeSync, constants, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { readEndoDigestKeyV0 } from "../../../storage/digest-key.ts";
import { readStudy } from "./reader.ts";

async function main() {
	const [plan, keyFile, output] = process.argv.slice(2);
	if (process.argv.length !== 5 || !plan || !keyFile || !output || ![plan, keyFile, output].every(isAbsolute))
		throw new Error("usage: node read-private.ts /private/study /private/key /private/new-output");
	const parent = lstatSync(dirname(output));
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		parent.uid !== process.getuid?.() ||
		(parent.mode & 0o077) !== 0
	)
		throw new Error("output directory must be owner-only");
	const key = readEndoDigestKeyV0(keyFile, () => {
		throw new Error("key unavailable");
	});
	const result = await readStudy(plan, key);
	const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(result));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const parentFd = openSync(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
	process.stdout.write(`Private evidence reader: ${result.status}; server identity ${result.serverIdentity}.\n`);
}
main().catch(() => {
	process.stderr.write("Private evidence reader refused the study.\n");
	process.exitCode = 1;
});
