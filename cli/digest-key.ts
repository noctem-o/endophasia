/**
 * `endo digest-key id`: print the id of the private comparison-domain key this environment selects
 * (storage/digest-key.ts), its domain label and its path, as one canonical-JSON document. Read-only: it never creates a
 * key and never prints the key itself. After copying a key file to another machine, run it on both: the ids must match,
 * or every comparison between their stores comes out UNAVAILABLE ("different digest domains").
 */

import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyPathV0, readEndoDigestKeyV0 } from "../storage/digest-key.ts";

export function digestKeyCommand(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): void {
	if (argv.length !== 1 || argv[0] !== "id") throw new TypeError("usage: endo digest-key id");
	const path = endoDigestKeyPathV0(env);
	const key = readEndoDigestKeyV0(path);
	process.stdout.write(canonicalEndoJsonV0({ keyId: key.keyId, domain: key.domain, path }));
}
