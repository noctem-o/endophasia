// Write-once store for harness-neutral attempt authorizations, pre-transport aborts, and controller-observed
// dispatch outcomes (`<root>/develop/adapter-authorizations/<attemptId>.{authorized,aborted,outcome}.json`).
//
// Design invariants (docs/designs/coordinator-assignment.md §6.2–§6.3, E2-A/E2-B):
// - Keeps `<root>/develop/attempts/` closed and untouched.
// - Every record is strictly write-once via `storage/write-once.ts` (`O_EXCL` temp -> fsync -> `link(2)`).
// - Never deletes or resets records on revocation, crash, or disconnect.
// - Shares `<root>/develop/attempt-routes/<attemptId>.route.json` with Pi workbench and protected attempts.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
	type EndoDevelopAdapterAbortV0,
	type EndoDevelopAdapterAuthorizationV0,
	type EndoDevelopAdapterOutcomeV0,
	validateEndoDevelopAdapterAbortV0,
	validateEndoDevelopAdapterAuthorizationV0,
	validateEndoDevelopAdapterOutcomeV0,
} from "../protocol/develop-adapter-authorization.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_ADAPTER_AUTHORIZATIONS_DIRECTORY_V0 = "adapter-authorizations";
const MAX_RECORD_BYTES = 16 * 1024;

export type EndoAdapterRecordReadV0<T> =
	| { state: "absent" }
	| { state: "present"; record: T }
	| { state: "problem"; reason: string };

export interface EndoAdapterAttemptRecordsV0 {
	authorization: EndoAdapterRecordReadV0<EndoDevelopAdapterAuthorizationV0>;
	abort: EndoAdapterRecordReadV0<EndoDevelopAdapterAbortV0>;
	outcome: EndoAdapterRecordReadV0<EndoDevelopAdapterOutcomeV0>;
}

export interface DevelopAdapterAuthorizationsStoreOptionsV0 {
	beforeAuthorizationLink?: () => void;
	beforeAbortLink?: () => void;
	beforeOutcomeLink?: () => void;
}

/**
 * Read-only check for whether `<developDir>/adapter-authorizations/<attemptId>.authorized.json` already exists
 * (or whether the directory/file is unsafe). Allows workbench and protected dispatchers to detect an existing
 * harness-neutral authorization even if `.route.json` were missing or unreadable.
 */
export function checkAdapterAuthorizationPresenceSyncV0(
	developDir: string,
	attemptId: string,
): "absent" | "present" | "problem" {
	if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return "problem";
	const dir = join(developDir, ENDO_DEVELOP_ADAPTER_AUTHORIZATIONS_DIRECTORY_V0);
	const dirs = checkDirectoriesSyncV0([developDir, dir]);
	if (dirs === "missing") return "absent";
	if (dirs !== "ok") return "problem";
	for (const suffix of ["authorized", "aborted", "outcome"] as const) {
		try {
			const st = lstatSync(join(dir, `${attemptId}.${suffix}.json`), { throwIfNoEntry: false });
			if (st !== undefined) return st.isFile() ? "present" : "problem";
		} catch {
			return "problem";
		}
	}
	return "absent";
}

export class DevelopAdapterAuthorizationsStoreV0 {
	readonly #develop: string;
	readonly #dir: string;
	readonly #options: DevelopAdapterAuthorizationsStoreOptionsV0;

	constructor(developDir: string, options: DevelopAdapterAuthorizationsStoreOptionsV0 = {}) {
		this.#develop = developDir;
		this.#dir = join(developDir, ENDO_DEVELOP_ADAPTER_AUTHORIZATIONS_DIRECTORY_V0);
		this.#options = options;
	}

	static forRoot(
		root: string,
		options: DevelopAdapterAuthorizationsStoreOptionsV0 = {},
	): DevelopAdapterAuthorizationsStoreV0 {
		return new DevelopAdapterAuthorizationsStoreV0(join(root, ENDO_DEVELOP_DIRECTORY_V0), options);
	}

	get directory(): string {
		return this.#dir;
	}

	#readOne<T extends { attemptId: string }>(
		attemptId: string,
		suffix: "authorized" | "aborted" | "outcome",
		validate: (value: unknown) => T,
	): EndoAdapterRecordReadV0<T> {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return { state: "problem", reason: "invalid" };
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir]);
		if (dirs === "missing") return { state: "absent" };
		if (dirs !== "ok") return { state: "problem", reason: dirs };
		const filePath = join(this.#dir, `${attemptId}.${suffix}.json`);
		let present: ReturnType<typeof lstatSync> | undefined;
		try {
			present = lstatSync(filePath, { throwIfNoEntry: false });
		} catch {
			return { state: "problem", reason: "io" };
		}
		if (present === undefined) return { state: "absent" };
		const read = readBoundedJsonSyncV0(filePath, MAX_RECORD_BYTES);
		if (!read.ok) return { state: "problem", reason: read.reason };
		try {
			const record = validate(read.value);
			if (record.attemptId !== attemptId) return { state: "problem", reason: "misnamed" };
			return { state: "present", record };
		} catch {
			return { state: "problem", reason: "invalid" };
		}
	}

	read(attemptId: string): EndoAdapterAttemptRecordsV0 {
		return {
			authorization: this.#readOne(attemptId, "authorized", validateEndoDevelopAdapterAuthorizationV0),
			abort: this.#readOne(attemptId, "aborted", validateEndoDevelopAdapterAbortV0),
			outcome: this.#readOne(attemptId, "outcome", validateEndoDevelopAdapterOutcomeV0),
		};
	}

	#writeOne<T extends { attemptId: string }>(
		record: T,
		suffix: "authorized" | "aborted" | "outcome",
		validate: (value: unknown) => T,
		beforeLink?: () => void,
	): "created" | "exists" | "unsafe-path" | "failed" {
		let checked: T;
		try {
			checked = validate(record);
		} catch {
			return "failed";
		}
		const bytes = Buffer.from(`${canonicalEndoJsonV0(checked as never)}\n`, "utf8");
		if (bytes.length > MAX_RECORD_BYTES) return "failed";
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir])) return "unsafe-path";
		return writeOnceSyncV0(this.#dir, `${checked.attemptId}.${suffix}.json`, bytes, beforeLink);
	}

	writeAuthorization(record: EndoDevelopAdapterAuthorizationV0): "created" | "exists" | "unsafe-path" | "failed" {
		return this.#writeOne(
			record,
			"authorized",
			validateEndoDevelopAdapterAuthorizationV0,
			this.#options.beforeAuthorizationLink,
		);
	}

	writeAbort(record: EndoDevelopAdapterAbortV0): "created" | "exists" | "unsafe-path" | "failed" {
		return this.#writeOne(record, "aborted", validateEndoDevelopAdapterAbortV0, this.#options.beforeAbortLink);
	}

	writeOutcome(record: EndoDevelopAdapterOutcomeV0): "created" | "exists" | "unsafe-path" | "failed" {
		return this.#writeOne(record, "outcome", validateEndoDevelopAdapterOutcomeV0, this.#options.beforeOutcomeLink);
	}
}
