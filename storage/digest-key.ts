// Comparison-domain key files (runtime/contracts/keyed-digest.ts): host infrastructure, held outside every store.
//
// The INSTALLATION key (real work) is zero-config: on first use it is generated in Endophasia's own data directory
// with owner-only permissions, and every store recorded on this machine shares it, so comparing runs on one machine
// just works. Where it lives, first match wins:
//   1. ENDO_DIGEST_KEY_FILE                            an explicit file (scratch runs, tests)
//   2. $XDG_DATA_HOME/endophasia/digest-key
//   3. $HOME/.local/share/endophasia/digest-key        the default
//
// It is created with 32 random bytes, written exclusively (never overwriting a concurrent creator's key), mode 0600 in
// a 0700 directory. An existing key file is never chmodded: if its permissions are wider than owner-only, or another
// user owns it, a warning says so and the run continues. Whoever can read the key can confirm guesses against every
// digest made with it. Cross-machine sharing (docs/trajectory.md, "Comparing across machines") is a manual copy of
// this file; `endo digest-key id` prints the id to check that both machines hold the same key.
//
// PUBLIC fixture keys (the fixture recorder only): committed with the repository (research/fixture-keys/), so anyone
// can confirm guesses against digests made with them. That is acceptable only because fixtures hold synthetic scratch
// content. Their ids are their names (`fixture-public`), and the bytes each name stands for are pinned below. A public
// key file is never accepted as the installation key, and the Pi attachment refuses to record a normal session under a
// public key or a fixture under the installation key.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EndoDigestKeyV0, endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

export const ENDO_DIGEST_KEY_FILE_SCHEMA_V0 = "endo.digest-key.v0";

/** The cross-machine section of the docs, named by warnings and comparison hints. */
export const ENDO_DIGEST_KEY_DOC_V0 = "docs/trajectory.md#comparing-across-machines";

/** The committed public fixture keys: name to the fingerprint of the bytes the name stands for. */
export const ENDO_FIXTURE_DIGEST_KEYS_V0: Readonly<Record<string, string>> = Object.freeze({
	/** Every fixture recording. */
	"fixture-public": "bb5fa3907b81f81a32258c8a3c454adc",
	/** A second public domain, only for the hostile fixture that exercises a digest-domain difference. */
	"fixture-public-alt": "3728013ff5edfbb1f980f0629d642e43",
});

type Env = Readonly<Record<string, string | undefined>>;
type Warn = (message: string) => void;

const stderrWarn: Warn = (message) => process.stderr.write(`warning: ${message}\n`);

/** The installation key file the environment selects (see the header). Throws when no location is set. */
export function endoDigestKeyPathV0(env: Env = process.env): string {
	if (env.ENDO_DIGEST_KEY_FILE) return env.ENDO_DIGEST_KEY_FILE;
	if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "endophasia", "digest-key");
	if (env.HOME) return join(env.HOME, ".local", "share", "endophasia", "digest-key");
	throw new TypeError("no digest key location: set ENDO_DIGEST_KEY_FILE, XDG_DATA_HOME or HOME");
}

interface KeyFileV0 {
	domain: string;
	public: boolean;
	key: Buffer;
}

function parseFile(path: string): KeyFileV0 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new TypeError(`the digest key ${path} is not valid JSON`);
	}
	const record = parsed as { schemaVersion?: unknown; domain?: unknown; key?: unknown; public?: unknown };
	if (
		record.schemaVersion !== ENDO_DIGEST_KEY_FILE_SCHEMA_V0 ||
		typeof record.domain !== "string" ||
		typeof record.key !== "string" ||
		!/^[0-9a-f]{64,}$/.test(record.key) ||
		record.key.length % 2 !== 0 ||
		(record.public !== undefined && typeof record.public !== "boolean")
	) {
		throw new TypeError(`the digest key ${path} is not an ${ENDO_DIGEST_KEY_FILE_SCHEMA_V0} file`);
	}
	return { domain: record.domain, public: record.public === true, key: Buffer.from(record.key, "hex") };
}

/**
 * Read the installation key at `path`. Never creates it and never changes its permissions: permissions wider than
 * owner-only, or another owner, produce a warning and the key is used. A public fixture key is refused.
 */
export function readEndoDigestKeyV0(path: string, warn: Warn = stderrWarn): EndoDigestKeyV0 {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		throw new TypeError(`no digest key at ${path}; one is created on the first recorded session`);
	}
	if (process.platform !== "win32") {
		const mode = stat.mode & 0o777;
		if ((mode & 0o077) !== 0)
			warn(
				`the digest key ${path} has mode ${mode.toString(8).padStart(4, "0")}, wider than owner-only; anyone who can read it can confirm guesses against your digests (chmod 600 ${path})`,
			);
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid)
			warn(`the digest key ${path} is owned by uid ${stat.uid}, not by the current user (${uid})`);
	}
	const file = parseFile(path);
	if (file.public || file.domain in ENDO_FIXTURE_DIGEST_KEYS_V0)
		throw new TypeError(
			`${path} is a public fixture key (${file.domain}); its digests offer no secrecy and it is never used as the installation key`,
		);
	return endoDigestKeyV0(file.key, file.domain);
}

/** Load the installation key at `path`, generating it first if it does not exist. */
export function loadOrCreateEndoDigestKeyV0(path: string, warn: Warn = stderrWarn): EndoDigestKeyV0 {
	try {
		statSync(path);
	} catch {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const body = `${JSON.stringify({ schemaVersion: ENDO_DIGEST_KEY_FILE_SCHEMA_V0, domain: "installation", key: randomBytes(32).toString("hex") })}\n`;
		try {
			writeFileSync(path, body, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return readEndoDigestKeyV0(path, warn);
}

/** The installation key the environment selects, generated on first use. */
export function endoDigestKeyFromEnvironmentV0(env: Env = process.env, warn: Warn = stderrWarn): EndoDigestKeyV0 {
	return loadOrCreateEndoDigestKeyV0(endoDigestKeyPathV0(env), warn);
}

/** Where the committed public fixture key `name` lives in this repository (research/fixture-keys/<name>.json). */
export function endoFixtureDigestKeyPathV0(name = "fixture-public"): string {
	if (!(name in ENDO_FIXTURE_DIGEST_KEYS_V0)) throw new TypeError(`${name} is not a committed public fixture key`);
	return fileURLToPath(new URL(`../research/fixture-keys/${name}.json`, import.meta.url));
}

/**
 * Load a committed public fixture key. The file must be marked public, its name must be a pinned fixture key, and its
 * bytes must match the pinned fingerprint. Its permissions are not checked: it is public by definition.
 */
export function loadEndoFixtureDigestKeyV0(path: string): EndoDigestKeyV0 {
	const file = parseFile(path);
	const pinned = ENDO_FIXTURE_DIGEST_KEYS_V0[file.domain];
	if (!file.public || pinned === undefined) throw new TypeError(`${path} is not a committed public fixture key`);
	const key = endoDigestKeyV0(file.key, file.domain, { public: true });
	if (key.fingerprint !== pinned) throw new TypeError(`${path} does not hold the pinned ${file.domain} key`);
	return key;
}
