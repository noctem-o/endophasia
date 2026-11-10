// DEVELOP attempt observations: `<root>/develop/observations/<attempt id>/<observation id>.json`, beside `develop/attempts/` and
// `develop/receipts/` and never inside them (protocol/develop-observations.ts, docs/designs/develop-candidate-provenance.md).
//
// The same layout and protocol as the receipts (storage/develop-receipts.ts): one directory per attempt; each record written once, by the
// write-once protocol in storage/write-once.ts, and never rewritten; every directory and file checked with lstat and opened with
// O_NOFOLLOW. A file that is malformed, invalid (its derived facts do not follow from its state), over its bound, misnamed, of another
// attempt or not an observation at all is reported as a problem by name and left exactly as found.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_OBSERVATION_LIMITS_V0,
	ENDO_OBSERVATION_ID_PATTERN_V0,
	type EndoDevelopObservationV0,
	validateEndoDevelopObservationV0,
} from "../protocol/develop-observations.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_OBSERVATIONS_DIRECTORY_V0 = "observations";
const RECORD = /^(endo\.observation\.[0-9a-f]{32})\.json$/;

/** A file that is not a usable observation, with a closed reason. It is never shown as an observation and never written over. */
export interface EndoObservationProblemV0 {
	name: string;
	reason: "unsafe-path" | "too-large" | "malformed" | "invalid" | "misnamed" | "unknown-file" | "io";
}

export type EndoObservationsReadV0 =
	| { ok: true; observations: EndoDevelopObservationV0[]; problems: EndoObservationProblemV0[] }
	| { ok: false; reason: "unsafe-path" | "io" };

export interface EndoDevelopObservationsStoreOptionsV0 {
	/** For tests: runs after the temporary file is complete and before it is linked (see storage/write-once.ts). */
	beforeLink?: () => void;
}

export class DevelopObservationsStoreV0 {
	readonly #develop: string;
	readonly #dir: string;
	readonly #beforeLink: (() => void) | undefined;

	constructor(root: string, options: EndoDevelopObservationsStoreOptionsV0 = {}) {
		this.#develop = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#dir = join(this.#develop, ENDO_DEVELOP_OBSERVATIONS_DIRECTORY_V0);
		this.#beforeLink = options.beforeLink;
	}

	get directory(): string {
		return this.#dir;
	}

	#attemptDir(attemptId: string): string | null {
		return ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId) ? join(this.#dir, attemptId) : null;
	}

	/** One attempt's observations, oldest first, read now. A missing directory is none (nothing is created). */
	read(attemptId: string): EndoObservationsReadV0 {
		return this.#read(attemptId, undefined) as EndoObservationsReadV0;
	}

	/**
	 * As `read`, bounded: refused (`too-many`) before any file is read when the directory holds more than `max.files` entries (temporary
	 * files aside), or entries whose sizes add up to more than `max.bytes`, so a caller reading many attempts can bound the whole read.
	 */
	readAtMost(
		attemptId: string,
		max: { files: number; bytes: number },
	): (EndoObservationsReadV0 & { bytes?: number }) | { ok: false; reason: "too-many" } {
		return this.#read(attemptId, max);
	}

	#read(
		attemptId: string,
		max: { files: number; bytes: number } | undefined,
	): (EndoObservationsReadV0 & { bytes?: number }) | { ok: false; reason: "too-many" } {
		const dir = this.#attemptDir(attemptId);
		if (dir === null) return { ok: false, reason: "unsafe-path" };
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir, dir]);
		if (dirs === "missing") return { ok: true, observations: [], problems: [] };
		if (dirs !== "ok") return { ok: false, reason: dirs };
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			return { ok: false, reason: code === "ENOTDIR" || code === "ELOOP" ? "unsafe-path" : "io" };
		}
		let bytes = 0;
		if (max !== undefined) {
			const entries = names.filter((n) => !WRITE_ONCE_TEMPORARY_V0.test(n));
			if (entries.length > max.files) return { ok: false, reason: "too-many" };
			for (const name of entries) bytes += lstatSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0;
			if (bytes > max.bytes) return { ok: false, reason: "too-many" };
		}
		const observations: EndoDevelopObservationV0[] = [];
		const problems: EndoObservationProblemV0[] = [];
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const match = RECORD.exec(name);
			if (match === null) {
				problems.push({ name, reason: "unknown-file" });
				continue;
			}
			const read = readBoundedJsonSyncV0(join(dir, name), ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxFileRecordBytes);
			if (!read.ok) {
				problems.push({ name, reason: read.reason });
				continue;
			}
			let observation: EndoDevelopObservationV0;
			try {
				observation = validateEndoDevelopObservationV0(read.value, sha256HexV0);
			} catch {
				problems.push({ name, reason: "invalid" });
				continue;
			}
			// An observation is the one its name says, of the attempt whose directory holds it: a copy elsewhere is not that attempt's.
			if (observation.id !== match[1] || observation.attemptId !== attemptId) {
				problems.push({ name, reason: "misnamed" });
				continue;
			}
			observations.push(observation);
		}
		observations.sort((a, b) => a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : 1));
		return max === undefined ? { ok: true, observations, problems } : { ok: true, observations, problems, bytes };
	}

	/** The bytes an observation is written as, or null when it does not fit its bound. */
	static encode(observation: EndoDevelopObservationV0): Buffer | null {
		const bytes = Buffer.from(`${canonicalEndoJsonV0(observation as never)}\n`, "utf8");
		return bytes.length > ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxFileRecordBytes ? null : bytes;
	}

	/**
	 * Write one observation, once. `unsafe-path`: a directory on the way is not a plain directory. `failed`: nothing was written (including a
	 * record over its bound, or a name already taken, which a fresh random id cannot be).
	 */
	write(observation: EndoDevelopObservationV0): "created" | "unsafe-path" | "failed" {
		const dir = this.#attemptDir(observation.attemptId);
		if (dir === null || !ENDO_OBSERVATION_ID_PATTERN_V0.test(observation.id)) return "failed";
		try {
			validateEndoDevelopObservationV0(observation, sha256HexV0);
		} catch {
			return "failed";
		}
		const bytes = DevelopObservationsStoreV0.encode(observation);
		if (bytes === null) return "failed";
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir, dir])) return "unsafe-path";
		const written = writeOnceSyncV0(dir, `${observation.id}.json`, bytes, this.#beforeLink);
		return written === "created" ? "created" : "failed";
	}
}
