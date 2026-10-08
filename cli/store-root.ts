/**
 * Where Endophasia's durable store would live when the operator names none. One resolver, one precedence:
 *
 *   1. an explicit root the operator supplied               (source "explicit")
 *   2. ENDO_STORE_ROOT                                       (source "ENDO_STORE_ROOT")
 *   3. $XDG_DATA_HOME/endophasia/store                       (source "XDG_DATA_HOME")
 *   4. $HOME/.local/share/endophasia/store                   (source "HOME")
 *
 * This is the store, not the installation digest key: the key keeps its own location and override
 * (storage/digest-key.ts, endoDigestKeyPathV0), which this module never reads or changes. The working directory and the
 * repository checkout are never defaults. Resolving a path creates nothing.
 */

import { isAbsolute, join, resolve } from "node:path";

export type EndoStoreRootSourceV0 = "explicit" | "ENDO_STORE_ROOT" | "XDG_DATA_HOME" | "HOME";

export interface EndoStoreRootV0 {
	readonly path: string;
	readonly source: EndoStoreRootSourceV0;
}

type Env = Readonly<Record<string, string | undefined>>;

export function resolveEndoStoreRootV0(
	explicit: string | undefined,
	env: Env = process.env,
	cwd: string = process.cwd(),
): EndoStoreRootV0 {
	if (explicit !== undefined) {
		if (explicit.length === 0) throw new TypeError("the store root is empty");
		return { path: resolve(cwd, explicit), source: "explicit" };
	}
	if (env.ENDO_STORE_ROOT) {
		if (!isAbsolute(env.ENDO_STORE_ROOT)) throw new TypeError("ENDO_STORE_ROOT must be an absolute path");
		return { path: env.ENDO_STORE_ROOT, source: "ENDO_STORE_ROOT" };
	}
	// A relative base would make the store depend on where the command is launched: refuse it, as for ENDO_STORE_ROOT.
	if (env.XDG_DATA_HOME) {
		if (!isAbsolute(env.XDG_DATA_HOME)) throw new TypeError("XDG_DATA_HOME must be an absolute path");
		return { path: join(env.XDG_DATA_HOME, "endophasia", "store"), source: "XDG_DATA_HOME" };
	}
	if (env.HOME) {
		if (!isAbsolute(env.HOME)) throw new TypeError("HOME must be an absolute path");
		return { path: join(env.HOME, ".local", "share", "endophasia", "store"), source: "HOME" };
	}
	throw new TypeError("no store location: pass a root, or set ENDO_STORE_ROOT, XDG_DATA_HOME or HOME");
}
