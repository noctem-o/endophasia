// A content-addressed blob store for captured bytes (HTTP bodies, workspace archives), held beside an event store and
// outside canonical evidence.
//
// Blobs are addressed by their KEYED digest (runtime/contracts/keyed-digest.ts: HMAC-SHA256 under the comparison-domain
// key, `digestBytes`), never by a plain sha256. Events carry those keyed digests and lengths; a plain hash in an event
// would be a confirmation oracle for short, guessable bodies, and an address made of one would be the same oracle in a
// file name. Layout: `<root>/blobs/<key id>/<64 lowercase hex>`. A blob verifies only under the key it was stored with,
// so reading needs that key: a reader in another digest domain cannot even locate the bytes, let alone check them.
//
// Writes are atomic (tmp + rename + directory fsync). A put for an address that already holds verifying bytes is a
// no-op; one whose existing file does not verify is a tamper and throws. Every get re-verifies. Synchronous node:fs.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { writeExactSyncV0 } from "./log.ts";

const ADDRESS = /^[0-9a-f]{64}$/;

export interface EndoBlobStoreV0 {
	/** The digest domain this store reads and writes in. */
	readonly keyId: string;
	/** Store `bytes`; returns their keyed digest and length. Idempotent. Throws when read-only or on a tampered address. */
	put(bytes: Uint8Array): { digest: EndoKeyedDigestV0; bytes: number; created: boolean };
	/** The bytes at `digest`, re-verified. Throws when missing, tampered, or in another digest domain. */
	get(digest: EndoKeyedDigestV0): Uint8Array;
	/** True when the blob exists and verifies. */
	has(digest: EndoKeyedDigestV0): boolean;
	/** Every stored address in this domain, sorted. */
	list(): string[];
}

/** The blob store under `root/blobs/<key id>/`. Opened read-only, it creates nothing and `put` throws. */
export function createEndoBlobStoreV0(
	root: string,
	key: EndoDigestKeyV0,
	options: { readOnly?: boolean } = {},
): EndoBlobStoreV0 {
	const dir = join(root, "blobs", key.keyId);
	const fileOf = (value: string) => {
		if (!ADDRESS.test(value)) throw new TypeError(`a blob address is 64 lowercase hex characters, got ${value}`);
		return join(dir, value);
	};
	const domain = (digest: EndoKeyedDigestV0) => {
		if (digest.keyId !== key.keyId)
			throw new TypeError(
				`blob ${digest.value} was digested in another digest domain (${digest.keyId}); this store reads ${key.keyId}`,
			);
	};
	const verified = (value: string): Uint8Array => {
		const bytes = new Uint8Array(readFileSync(fileOf(value)));
		const actual = key.digestBytes(bytes).value;
		if (actual !== value) throw new TypeError(`blob ${value} does not verify: its bytes digest to ${actual}`);
		return bytes;
	};
	return {
		keyId: key.keyId,
		put(bytes) {
			if (options.readOnly === true) throw new TypeError("the blob store is open read-only");
			const digest = key.digestBytes(bytes);
			const file = fileOf(digest.value);
			try {
				verified(digest.value);
				return { digest, bytes: bytes.length, created: false };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			mkdirSync(dir, { recursive: true });
			const tmp = `${file}.tmp`;
			const fd = openSync(tmp, "w");
			try {
				writeExactSyncV0(fd, bytes, tmp);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, file);
			const dirFd = openSync(dir, "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
			return { digest, bytes: bytes.length, created: true };
		},
		get(digest) {
			domain(digest);
			try {
				return verified(digest.value);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new TypeError(`blob ${digest.value} is not stored`);
				throw error;
			}
		},
		has(digest) {
			if (digest.keyId !== key.keyId) return false;
			try {
				verified(digest.value);
				return true;
			} catch {
				return false;
			}
		},
		list() {
			try {
				return readdirSync(dir)
					.filter((name) => ADDRESS.test(name))
					.sort();
			} catch {
				return [];
			}
		},
	};
}
