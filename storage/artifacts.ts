/**
 * Phase 12 — the content-addressed artifact store (README "## Phase 12 — Operational
 * substrate & integration", work item: "storage/ durable append store"). A directory of
 * files, one per artifact digest: `root/artifacts/<64-lowercase-hex>`. Writes are atomic
 * (tmp+rename+directory fsync); a `put` for an existing digest is idempotent when the
 * existing file verifies to the same digest and a tamper error when it does not — an
 * artifact that does not hash to its name is not that artifact. Reads re-verify on every
 * `get`, so a later tamper is detected, never served. Synchronous node:fs only.
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const DIGEST = /^[0-9a-f]{64}$/;

/** The 32-byte sha256 of `bytes`, lowercase hex. */
export function sha256HexOfBytesV0(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A content-addressed artifact store rooted at `root/artifacts/`.
 */
export interface EndoArtifactStoreV0 {
	/**
	 * Store `content` under `digest` (a 64-lowercase-hex sha256). Idempotent: when the file
	 * already exists and hashes to `digest`, nothing is rewritten and `created` is false.
	 * When the file exists but hashes differently, throws TypeError — the digest address is
	 * taken by different bytes. Returns `{ created }`.
	 */
	put(digest: string, content: Uint8Array): { created: boolean };
	/** Read the artifact at `digest`, re-verifying its hash. Throws TypeError when missing or tampered. */
	get(digest: string): Uint8Array;
	/** True when the artifact exists and verifies to its digest. */
	has(digest: string): boolean;
	/** All stored digests, sorted ascending. */
	list(): string[];
}

function requireDigest(digest: string): void {
	if (typeof digest !== "string" || !DIGEST.test(digest)) {
		throw new TypeError(`artifact digests are 64 lowercase hex characters, got ${JSON.stringify(digest)}`);
	}
}

/**
 * Create the artifact store rooted at `root` (the `root/artifacts/` directory is created
 * on first `put`).
 */
export function createEndoArtifactStoreV0(root: string): EndoArtifactStoreV0 {
	const dir = join(root, "artifacts");

	const fileOf = (digest: string) => join(dir, digest);

	const verifyFile = (digest: string, file: string): Uint8Array => {
		const content = readFileSync(file);
		const actual = sha256HexOfBytesV0(content);
		if (actual !== digest) throw new TypeError(`artifact ${digest} does not verify: the file hashes to ${actual}`);
		return new Uint8Array(content);
	};

	return {
		put(digest: string, content: Uint8Array): { created: boolean } {
			requireDigest(digest);
			mkdirSync(dir, { recursive: true });
			const file = fileOf(digest);
			try {
				// The existing file must verify to the same digest; otherwise the address is
				// taken by different bytes and the put is a tamper, not a duplicate.
				verifyFile(digest, file);
				return { created: false };
			} catch (error) {
				if (error instanceof TypeError) throw error;
				// Missing file: the expected path for a first put.
			}
			if (sha256HexOfBytesV0(content) !== digest) {
				throw new TypeError(`content does not hash to ${digest}; refusing to store it there`);
			}
			const tmp = `${file}.tmp`;
			const fd = openSync(tmp, "w");
			try {
				writeSync(fd, content);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, file);
			const dirFd = openSync(dirname(file), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
			return { created: true };
		},
		get(digest: string): Uint8Array {
			requireDigest(digest);
			let file: string;
			try {
				file = fileOf(digest);
				return verifyFile(digest, file);
			} catch (error) {
				if (error instanceof TypeError) throw error;
				throw new TypeError(`artifact ${digest} is not stored`);
			}
		},
		has(digest: string): boolean {
			requireDigest(digest);
			try {
				verifyFile(digest, fileOf(digest));
				return true;
			} catch {
				return false;
			}
		},
		list(): string[] {
			try {
				return readdirSync(dir)
					.filter((name) => DIGEST.test(name))
					.sort();
			} catch {
				return [];
			}
		},
	};
}
