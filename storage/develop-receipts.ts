// DEVELOP verification receipts: `<root>/develop/receipts/<attempt id>/<receipt id>.json`, beside `develop/attempts/` and never inside it
// (protocol/develop-receipts.ts, docs/designs/develop-verification-receipts.md).
//
// One directory per attempt, so reading one attempt's receipts reads only that directory, and removing them is removing it (the operator's
// act; there is no command). Each receipt is written once, by the write-once protocol in storage/write-once.ts, and never rewritten: a
// failed receipt stays beside the passing one that followed it. Nothing here reads or writes the task file or the attempt records.
//
// Every directory and file is checked with lstat and opened with O_NOFOLLOW: a symbolic link is refused, not followed. A file that is
// malformed, invalid (its verdict does not follow from its facts, among others), over its bound, misnamed, of another attempt or not a
// receipt at all is reported as a problem by name and left exactly as found.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_RECEIPT_LIMITS_V0,
	ENDO_RECEIPT_ID_PATTERN_V0,
	type EndoDevelopReceiptV0,
	validateEndoDevelopReceiptV0,
} from "../protocol/develop-receipts.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_RECEIPTS_DIRECTORY_V0 = "receipts";
const RECORD = /^(endo\.receipt\.[0-9a-f]{32})\.json$/;

/** A file that is not a usable receipt, with a closed reason. It is never shown as a receipt and never written over. */
export interface EndoReceiptProblemV0 {
	name: string;
	reason: "unsafe-path" | "too-large" | "malformed" | "invalid" | "misnamed" | "unknown-file" | "io";
}

export type EndoReceiptsReadV0 =
	| { ok: true; receipts: EndoDevelopReceiptV0[]; problems: EndoReceiptProblemV0[] }
	| { ok: false; reason: "unsafe-path" | "io" };

export interface EndoDevelopReceiptsStoreOptionsV0 {
	/** For tests: runs after the temporary file is complete and before it is linked (see storage/write-once.ts). */
	beforeLink?: () => void;
}

export class DevelopReceiptsStoreV0 {
	readonly #develop: string;
	readonly #dir: string;
	readonly #beforeLink: (() => void) | undefined;

	constructor(root: string, options: EndoDevelopReceiptsStoreOptionsV0 = {}) {
		this.#develop = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#dir = join(this.#develop, ENDO_DEVELOP_RECEIPTS_DIRECTORY_V0);
		this.#beforeLink = options.beforeLink;
	}

	get directory(): string {
		return this.#dir;
	}

	#attemptDir(attemptId: string): string | null {
		return ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId) ? join(this.#dir, attemptId) : null;
	}

	/** One attempt's receipts, oldest first, read now. A missing directory is no receipts (nothing is created). */
	read(attemptId: string): EndoReceiptsReadV0 {
		return this.#read(attemptId, undefined) as EndoReceiptsReadV0;
	}

	/**
	 * As `read`, bounded: refused (`too-many`) before any file is read when the directory holds more than `maxFiles` entries (temporary files
	 * aside), so a caller reading many attempts can bound the whole read.
	 */
	readAtMost(attemptId: string, maxFiles: number): EndoReceiptsReadV0 | { ok: false; reason: "too-many" } {
		return this.#read(attemptId, maxFiles);
	}

	#read(attemptId: string, maxFiles: number | undefined): EndoReceiptsReadV0 | { ok: false; reason: "too-many" } {
		const dir = this.#attemptDir(attemptId);
		if (dir === null) return { ok: false, reason: "unsafe-path" };
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir, dir]);
		if (dirs === "missing") return { ok: true, receipts: [], problems: [] };
		if (dirs !== "ok") return { ok: false, reason: dirs };
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			return { ok: false, reason: code === "ENOTDIR" || code === "ELOOP" ? "unsafe-path" : "io" };
		}
		if (maxFiles !== undefined && names.filter((n) => !WRITE_ONCE_TEMPORARY_V0.test(n)).length > maxFiles)
			return { ok: false, reason: "too-many" };
		const receipts: EndoDevelopReceiptV0[] = [];
		const problems: EndoReceiptProblemV0[] = [];
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const match = RECORD.exec(name);
			if (match === null) {
				problems.push({ name, reason: "unknown-file" });
				continue;
			}
			const read = readBoundedJsonSyncV0(join(dir, name), ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxFileBytes);
			if (!read.ok) {
				problems.push({ name, reason: read.reason });
				continue;
			}
			let receipt: EndoDevelopReceiptV0;
			try {
				receipt = validateEndoDevelopReceiptV0(read.value);
			} catch {
				problems.push({ name, reason: "invalid" });
				continue;
			}
			// A receipt is the one its name says, of the attempt whose directory holds it: a copy elsewhere is not that attempt's.
			if (receipt.id !== match[1] || receipt.attemptId !== attemptId) {
				problems.push({ name, reason: "misnamed" });
				continue;
			}
			receipts.push(receipt);
		}
		receipts.sort((a, b) => a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : 1));
		return { ok: true, receipts, problems };
	}

	/** The bytes a receipt is written as, or null when it does not fit its bound. */
	static encode(receipt: EndoDevelopReceiptV0): Buffer | null {
		const bytes = Buffer.from(`${canonicalEndoJsonV0(receipt as never)}\n`, "utf8");
		return bytes.length > ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxFileBytes ? null : bytes;
	}

	/**
	 * Write one receipt, once. `unsafe-path`: a directory on the way is not a plain directory. `failed`: nothing was written (including a
	 * receipt over its bound, or a name already taken, which a fresh random id cannot be).
	 */
	write(receipt: EndoDevelopReceiptV0): "created" | "unsafe-path" | "failed" {
		const dir = this.#attemptDir(receipt.attemptId);
		if (dir === null || !ENDO_RECEIPT_ID_PATTERN_V0.test(receipt.id)) return "failed";
		try {
			validateEndoDevelopReceiptV0(receipt);
		} catch {
			return "failed";
		}
		const bytes = DevelopReceiptsStoreV0.encode(receipt);
		if (bytes === null) return "failed";
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir, dir])) return "unsafe-path";
		const written = writeOnceSyncV0(dir, `${receipt.id}.json`, bytes, this.#beforeLink);
		return written === "created" ? "created" : "failed";
	}
}
