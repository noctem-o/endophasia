// Shared write-once execution-route reservation for DEVELOP attempts (DEVELOP-PROTECTED-ATTEMPT-001).
//
// Each prepared attempt may execute through at most ONE route: either the live Pi workbench (`workbench`) or the
// terminal-authorised protected attempt launcher (`protected`). Keeping reservations in `<root>/develop/attempt-routes/`
// leaves `<root>/develop/attempts/` untouched (so its closed-directory reader never sees an unknown file) while giving
// both routes ONE shared path (`<attemptId>.route.json`) claimed atomically with `storage/write-once.ts` (`linkSync`).
//
// Of any number of sequential or concurrent workbench and protected-attempt dispatchers racing on the same attempt,
// POSIX `link(2)` admits at most one winner; every other dispatcher gets `exists` and stops before writing its route's
// own record or executing anything.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_ATTEMPT_ROUTES_DIRECTORY_V0 = "attempt-routes";
export const ENDO_DEVELOP_ATTEMPT_ROUTE_SCHEMA_V0 = "endo.develop-attempt-route.v0";
const ENDO_PROTECTED_ATTEMPTS_DIR = "protected-attempts";
const MAX_ROUTE_RECORD_BYTES = 4 * 1024;

export type EndoDevelopAttemptRouteV0 = "workbench" | "protected";

export interface EndoDevelopAttemptRouteReservationV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_ROUTE_SCHEMA_V0;
	attemptId: string;
	route: EndoDevelopAttemptRouteV0;
	recordedAtMs: number;
}

export type EndoDevelopAttemptRouteReadV0 =
	| { state: "absent" }
	| { state: "present"; record: EndoDevelopAttemptRouteReservationV0 }
	| { state: "problem"; reason: string };

export function validateEndoDevelopAttemptRouteReservationV0(value: unknown): EndoDevelopAttemptRouteReservationV0 {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		throw new EndoInvalidRecordV0("route reservation is not an object");
	const keys = ["schemaVersion", "attemptId", "route", "recordedAtMs"] as const;
	if (endoFirstUnknownKeyV0(value, keys) !== undefined)
		throw new EndoInvalidRecordV0("route reservation has an unknown member");
	const r = value as Record<string, unknown>;
	for (const k of keys) if (!Object.hasOwn(r, k)) throw new EndoInvalidRecordV0(`route reservation lacks ${k}`);
	if (r.schemaVersion !== ENDO_DEVELOP_ATTEMPT_ROUTE_SCHEMA_V0)
		throw new EndoInvalidRecordV0("route reservation schemaVersion");
	if (typeof r.attemptId !== "string" || !ENDO_ATTEMPT_ID_PATTERN_V0.test(r.attemptId))
		throw new EndoInvalidRecordV0("route reservation attemptId");
	if (r.route !== "workbench" && r.route !== "protected") throw new EndoInvalidRecordV0("route reservation route");
	if (
		typeof r.recordedAtMs !== "number" ||
		!Number.isSafeInteger(r.recordedAtMs) ||
		r.recordedAtMs < 0 ||
		r.recordedAtMs > 8.64e15
	)
		throw new EndoInvalidRecordV0("route reservation recordedAtMs");
	return {
		schemaVersion: ENDO_DEVELOP_ATTEMPT_ROUTE_SCHEMA_V0,
		attemptId: r.attemptId,
		route: r.route,
		recordedAtMs: r.recordedAtMs,
	};
}

/**
 * Read-only check for whether `<developDir>/protected-attempts/<attemptId>.{launch,candidate}.json` already exists
 * (or whether the directory/file is unsafe). Allows the workbench dispatcher to refuse an attempt that already has a
 * protected launch or binding even if it predates `attempt-routes/`.
 */
export function checkProtectedAttemptPresenceSyncV0(
	developDir: string,
	attemptId: string,
): "absent" | "present" | "problem" {
	if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return "problem";
	const dir = join(developDir, ENDO_PROTECTED_ATTEMPTS_DIR);
	const dirs = checkDirectoriesSyncV0([developDir, dir]);
	if (dirs === "missing") return "absent";
	if (dirs !== "ok") return "problem";
	for (const suffix of ["launch", "candidate"] as const) {
		try {
			const st = lstatSync(join(dir, `${attemptId}.${suffix}.json`), { throwIfNoEntry: false });
			if (st !== undefined) return st.isFile() ? "present" : "problem";
		} catch {
			return "problem";
		}
	}
	return "absent";
}

export class DevelopAttemptRoutesStoreV0 {
	readonly #develop: string;
	readonly #dir: string;
	readonly #beforeLink: (() => void) | undefined;

	constructor(developDir: string, options: { beforeLink?: () => void } = {}) {
		this.#develop = developDir;
		this.#dir = join(developDir, ENDO_DEVELOP_ATTEMPT_ROUTES_DIRECTORY_V0);
		this.#beforeLink = options.beforeLink;
	}

	static forRoot(root: string, options: { beforeLink?: () => void } = {}): DevelopAttemptRoutesStoreV0 {
		return new DevelopAttemptRoutesStoreV0(join(root, ENDO_DEVELOP_DIRECTORY_V0), options);
	}

	get directory(): string {
		return this.#dir;
	}

	read(attemptId: string): EndoDevelopAttemptRouteReadV0 {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return { state: "problem", reason: "invalid-id" };
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir]);
		if (dirs === "missing") return { state: "absent" };
		if (dirs !== "ok") return { state: "problem", reason: dirs };
		const path = join(this.#dir, `${attemptId}.route.json`);
		let present: ReturnType<typeof lstatSync> | undefined;
		try {
			present = lstatSync(path, { throwIfNoEntry: false });
		} catch {
			return { state: "problem", reason: "io" };
		}
		if (present === undefined) return { state: "absent" };
		const read = readBoundedJsonSyncV0(path, MAX_ROUTE_RECORD_BYTES);
		if (!read.ok) return { state: "problem", reason: read.reason };
		try {
			const record = validateEndoDevelopAttemptRouteReservationV0(read.value);
			if (record.attemptId !== attemptId) return { state: "problem", reason: "misnamed" };
			return { state: "present", record };
		} catch {
			return { state: "problem", reason: "invalid" };
		}
	}

	claim(
		attemptId: string,
		route: EndoDevelopAttemptRouteV0,
		recordedAtMs: number,
	): "created" | "exists" | "unsafe-path" | "failed" {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return "failed";
		let record: EndoDevelopAttemptRouteReservationV0;
		try {
			record = validateEndoDevelopAttemptRouteReservationV0({
				schemaVersion: ENDO_DEVELOP_ATTEMPT_ROUTE_SCHEMA_V0,
				attemptId,
				route,
				recordedAtMs,
			});
		} catch {
			return "failed";
		}
		const bytes = Buffer.from(`${canonicalEndoJsonV0(record as never)}\n`, "utf8");
		if (bytes.length > MAX_ROUTE_RECORD_BYTES) return "failed";
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir])) return "unsafe-path";
		return writeOnceSyncV0(this.#dir, `${attemptId}.route.json`, bytes, this.#beforeLink);
	}
}
