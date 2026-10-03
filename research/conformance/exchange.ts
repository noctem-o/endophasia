// Whether this host can atomically exchange two directories. Node exposes no renameat2(RENAME_EXCHANGE), so publication
// goes through GNU mv's `--exchange` (coreutils 9.5 or later, Linux). A host without it can still publish a reference
// the first time (a plain rename) but cannot replace one atomically, and publication refuses that up front rather than
// partway through.
import { spawnSync } from "node:child_process";

/** The mv binary publication calls. */
export const EXCHANGE_MV = "/usr/bin/mv";

let probed: boolean | undefined;

/**
 * True when this host's mv accepts `--exchange`. Probed once from `mv --help`, which moves nothing. A filesystem that
 * does not support the exchange syscall can still make the exchange itself fail; that surfaces as an mv error at
 * exchange time and leaves the old target in place.
 */
export function atomicExchangeAvailable(): boolean {
	if (probed !== undefined) return probed;
	if (process.platform !== "linux") {
		probed = false;
		return probed;
	}
	const help = spawnSync(EXCHANGE_MV, ["--help"], { encoding: "utf8", timeout: 10_000 });
	probed = help.status === 0 && /(^|\s)--exchange\b/m.test(help.stdout ?? "");
	return probed;
}

/** Thrown before anything is staged when a replacement would need an exchange this host cannot perform. */
export class AtomicExchangeUnavailableError extends Error {
	constructor(target: string) {
		super(
			`replacing ${target} needs an atomic directory exchange, and ${EXCHANGE_MV} has no --exchange (GNU coreutils 9.5 or later on Linux); nothing was changed`,
		);
		this.name = "AtomicExchangeUnavailableError";
	}
}
