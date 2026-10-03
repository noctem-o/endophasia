// The comparison-domain key file (runtime/contracts/keyed-digest.ts): host infrastructure, held outside every store.
//
// Where it lives, first match wins:
//   1. ENDO_DIGEST_KEY_FILE                         an explicit file (scratch runs, tests, a shared team domain)
//   2. $XDG_CONFIG_HOME/endophasia/digest-key
//   3. $HOME/.config/endophasia/digest-key          the default: one domain per installation
//
// Every store recorded with the same key file is in one digest domain, so their digests compare. To compare stores
// across machines, give the machines the same key file. The file is created on first use: 32 random bytes, written
// exclusively (never overwriting a concurrent creator's key) with mode 0600 in a 0700 directory. A key file that group
// or others can read is refused: whoever can read the key can confirm guesses against every digest made with it.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type EndoDigestKeyV0, endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

export const ENDO_DIGEST_KEY_FILE_SCHEMA_V0 = "endo.digest-key.v0";

/** The key file the environment selects (see the header). Throws when neither a file, XDG_CONFIG_HOME nor HOME is set. */
export function endoDigestKeyPathV0(env: Readonly<Record<string, string | undefined>> = process.env): string {
	if (env.ENDO_DIGEST_KEY_FILE) return env.ENDO_DIGEST_KEY_FILE;
	if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "endophasia", "digest-key");
	if (env.HOME) return join(env.HOME, ".config", "endophasia", "digest-key");
	throw new TypeError("no digest key location: set ENDO_DIGEST_KEY_FILE, XDG_CONFIG_HOME or HOME");
}

function parse(path: string): EndoDigestKeyV0 {
	if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
		throw new TypeError(`the digest key ${path} is readable by group or others; chmod 600 it`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new TypeError(`the digest key ${path} is not valid JSON`);
	}
	const record = parsed as { schemaVersion?: unknown; domain?: unknown; key?: unknown };
	if (
		record.schemaVersion !== ENDO_DIGEST_KEY_FILE_SCHEMA_V0 ||
		typeof record.domain !== "string" ||
		typeof record.key !== "string" ||
		!/^[0-9a-f]{64,}$/.test(record.key) ||
		record.key.length % 2 !== 0
	) {
		throw new TypeError(`the digest key ${path} is not an ${ENDO_DIGEST_KEY_FILE_SCHEMA_V0} file`);
	}
	return endoDigestKeyV0(Buffer.from(record.key, "hex"), record.domain);
}

/** Load the key at `path`, creating it first if it does not exist. */
export function loadOrCreateEndoDigestKeyV0(path: string, domain = "installation"): EndoDigestKeyV0 {
	try {
		statSync(path);
	} catch {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const body = `${JSON.stringify({ schemaVersion: ENDO_DIGEST_KEY_FILE_SCHEMA_V0, domain, key: randomBytes(32).toString("hex") })}\n`;
		try {
			writeFileSync(path, body, { flag: "wx", mode: 0o600 });
			chmodSync(path, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return parse(path);
}

/** The key the environment selects, created on first use. */
export function endoDigestKeyFromEnvironmentV0(
	env: Readonly<Record<string, string | undefined>> = process.env,
): EndoDigestKeyV0 {
	return loadOrCreateEndoDigestKeyV0(endoDigestKeyPathV0(env));
}
