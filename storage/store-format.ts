import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	ENDO_ATTACHMENT_STORE_FORMAT_V0,
	type EndoLegacySealV0,
	type EndoStoreFormatSentinelV0,
	readEndoStoreFormatSentinelV0,
} from "../protocol/store-format.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { readEndoLockRecordV0 } from "./writer-lock.ts";

export const ENDO_STORE_INIT_LABEL_V0 = "endo-store-init:";
export const ENDO_FORMAT_TEMP_V0 = /^(session-attachment\.lock\.format-tmp)-(\d+)-[a-f0-9]{24}$/;

export function endoStoreFormatPathsV0(root: string) {
	const events = join(root, "events");
	const streams = join(events, "attachments");
	const lock = join(events, "session-attachment.lock");
	return {
		root,
		events,
		streams,
		lock,
		recovery: `${lock}.recover`,
		witness: join(streams, "FORMAT"),
		legacy: join(events, "events.log"),
	};
}

type BarrierFinding = {
	readonly kind: "sentinel-lost" | "sentinel-unreadable" | "format-unknown" | "witness-format-mismatch";
	readonly path: string;
	readonly detail: string;
};
type LegacyDrift = {
	readonly kind:
		| "appeared"
		| "deleted"
		| "truncated"
		| "grown-append"
		| "grown-rewritten"
		| "rewritten-same-size"
		| "unreadable"
		| "witness-seal-mismatch";
	readonly path: string;
	readonly sealedBytes: number | null;
	readonly sealedSha256: string | null;
	readonly observedBytes: number | null;
	readonly observedSha256: string | null;
	readonly observedPrefixSha256?: string;
};

type Established = {
	readonly state: "mixed" | "e4-sentinel-only";
	readonly sentinel: EndoStoreFormatSentinelV0;
	readonly raw: string;
	readonly witness: "present" | "missing" | "seal-mismatch";
	readonly residue: string[];
};
export type EndoStoreBarrierV0 =
	| { readonly state: "absent" | "legacy-only" | "legacy-uninitialised"; readonly residue: string[] }
	| { readonly state: "initialising"; readonly pid: number; readonly residue: string[] }
	| { readonly state: "format-barrier-broken"; readonly finding: BarrierFinding }
	| Established;

export type EndoStoreFormatV0 =
	| EndoStoreBarrierV0
	| (Omit<Established, "state"> & {
			readonly state: "legacy-seal-drift";
			readonly findings: readonly LegacyDrift[];
	  });

export function hasEndoStoreSentinelV0(
	value: EndoStoreFormatV0,
): value is Established | Extract<EndoStoreFormatV0, { state: "legacy-seal-drift" }> {
	return "sentinel" in value;
}

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
function everyEntry(directory: string, test: (name: string) => boolean): boolean {
	const dir = opendirSync(directory);
	try {
		let entry = dir.readSync();
		while (entry !== null) {
			if (!test(entry.name)) return false;
			entry = dir.readSync();
		}
		return true;
	} finally {
		dir.closeSync();
	}
}

export function inspectEndoStoreBarrierV0(root: string): EndoStoreBarrierV0 {
	const { lock } = endoStoreFormatPathsV0(root);
	const identity = () => {
		try {
			const info = lstatSync(lock, { bigint: true, throwIfNoEntry: false });
			return info === undefined ? null : `${info.dev}:${info.ino}:${info.ctimeNs}:${info.size}`;
		} catch {
			return null;
		}
	};
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const before = identity();
		const state = inspectBarrier(root);
		if (before === identity()) return state;
	}
	return {
		state: "format-barrier-broken",
		finding: { kind: "sentinel-unreadable", path: lock, detail: "lock changed repeatedly during inspection" },
	};
}

function inspectBarrier(root: string): EndoStoreBarrierV0 {
	const paths = endoStoreFormatPathsV0(root);
	const broken = (kind: BarrierFinding["kind"], path: string, detail: string): EndoStoreBarrierV0 => ({
		state: "format-barrier-broken",
		finding: { kind, path, detail },
	});
	let inspected = paths.root;
	try {
		for (const dir of [paths.root, paths.events]) {
			inspected = dir;
			const info = stat(dir);
			if (info !== undefined && !info.isDirectory())
				return broken("sentinel-unreadable", dir, "not a regular directory");
		}
		inspected = paths.lock;
		const record = readEndoLockRecordV0(paths.lock);
		const residue = stat(paths.recovery) === undefined ? [] : [paths.recovery];
		const raw = record?.value;
		if (raw !== undefined && Object.hasOwn(raw, "format")) {
			if (raw.format !== ENDO_ATTACHMENT_STORE_FORMAT_V0)
				return broken("format-unknown", paths.lock, "unsupported format");
			const parsed = readEndoStoreFormatSentinelV0(raw);
			if (!parsed.ok) return broken("sentinel-unreadable", paths.lock, parsed.message);
			const sentinel = parsed.value;
			inspected = paths.witness;
			try {
				const streams = stat(paths.streams);
				if (streams !== undefined && !streams.isDirectory())
					return broken("witness-format-mismatch", paths.streams, "not a regular streams directory");
				const witness = readEndoLockRecordV0(paths.witness);
				let state: Established["witness"] = "missing";
				if (witness !== null) {
					const copy = readEndoStoreFormatSentinelV0(witness.value);
					if (!copy.ok) return broken("witness-format-mismatch", paths.witness, copy.message);
					const { legacy: witnessSeal, ...witnessMetadata } = copy.value;
					const { legacy: seal, ...sentinelMetadata } = sentinel;
					if (canonicalEndoJsonV0(witnessMetadata) !== canonicalEndoJsonV0(sentinelMetadata))
						return broken("witness-format-mismatch", paths.witness, "sentinel metadata differs");
					state = canonicalEndoJsonV0(witnessSeal) === canonicalEndoJsonV0(seal) ? "present" : "seal-mismatch";
				}
				return {
					state: sentinel.origin === "created" ? "e4-sentinel-only" : "mixed",
					sentinel,
					raw: record!.raw,
					witness: state,
					residue,
				};
			} catch (error) {
				return broken("witness-format-mismatch", inspected, reason(error));
			}
		}
		const pid = raw?.pid;
		if (raw !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff))
			return broken("format-unknown", paths.lock, "neither a valid PID lock nor a supported sentinel");
		if (stat(paths.streams) !== undefined || stat(join(paths.events, "witness")) !== undefined) {
			return broken("sentinel-lost", paths.lock, "E4 stream directory or witness survives without a sentinel");
		}

		const init = typeof raw?.attachment === "string" && raw.attachment.startsWith(ENDO_STORE_INIT_LABEL_V0);
		if (
			init &&
			typeof pid === "number" &&
			everyEntry(root, (name) => name === "events") &&
			everyEntry(
				paths.events,
				(name) =>
					name === "session-attachment.lock" ||
					name === "session-attachment.lock.recover" ||
					ENDO_FORMAT_TEMP_V0.test(name),
			)
		) {
			return { state: "initialising", pid, residue };
		}
		const legacy = stat(paths.legacy) !== undefined;
		const migrating = typeof raw?.attachment === "string" && raw.attachment.startsWith("endo-store-migrate:");
		if (
			init ||
			(!legacy &&
				!migrating &&
				stat(paths.events) !== undefined &&
				!everyEntry(paths.events, (name) => !ENDO_FORMAT_TEMP_V0.test(name)))
		)
			return broken("sentinel-lost", paths.lock, "E4 initialisation residue without an accountable owner");
		if (legacy) return { state: "legacy-only", residue };
		if (stat(root) === undefined || everyEntry(root, () => false)) return { state: "absent", residue };
		return { state: "legacy-uninitialised", residue };
	} catch (error) {
		return broken("sentinel-unreadable", inspected, reason(error));
	}
}

function reason(error: unknown): string {
	return (
		(error as NodeJS.ErrnoException).code ??
		(error instanceof SyntaxError ? "invalid JSON" : "invalid or unreadable lock file")
	);
}

export function refuseEndoStoreBarrierV0(root: string, state: EndoStoreFormatV0): void {
	if (state.state !== "format-barrier-broken") return;
	const { kind, path, detail } = state.finding;
	throw new TypeError(
		`format-barrier-broken (${kind}): ${path}: ${detail}. Nothing was changed. Inspect with endo store status --root ${root}; do not remove a store-format sentinel.`,
	);
}

export function assertEndoLegacyStoreWritableV0(root: string, state = inspectEndoStoreBarrierV0(root)): void {
	refuseEndoStoreBarrierV0(root, state);
	if (hasEndoStoreSentinelV0(state) || state.state === "initialising")
		throw new TypeError("the legacy events.log is not writable under the per-attachment-v1 format barrier");
}

export function endoLegacySealPresenceV0(seal: EndoLegacySealV0 | null) {
	return seal !== null && "bytes" in seal ? seal : null;
}

export function detectEndoStoreFormatV0(root: string): EndoStoreFormatV0 {
	const state = inspectEndoStoreBarrierV0(root);
	if (!hasEndoStoreSentinelV0(state)) return state;
	const path = endoStoreFormatPathsV0(root).legacy;
	const seal = endoLegacySealPresenceV0(state.sentinel.legacy);
	const findings: LegacyDrift[] = [];
	let bytes: number | null = null;
	let hash: string | null = null;
	const finding = (kind: LegacyDrift["kind"], prefix?: string) =>
		findings.push({
			kind,
			path,
			sealedBytes: seal?.bytes ?? null,
			sealedSha256: seal?.sha256 ?? null,
			observedBytes: bytes,
			observedSha256: hash,
			...(prefix === undefined ? {} : { observedPrefixSha256: prefix }),
		});
	try {
		const info = stat(path);
		if (info === undefined) {
			if (seal !== null) finding("deleted");
		} else {
			bytes = info.size;
			const measured = hashEndoLegacyLogV0(path, seal?.bytes);
			bytes = measured.bytes;
			hash = measured.sha256;
			if (seal === null) finding("appeared");
			else if (bytes < seal.bytes) finding("truncated");
			else if (bytes > seal.bytes)
				finding(measured.prefix === seal.sha256 ? "grown-append" : "grown-rewritten", measured.prefix);
			else if (hash !== seal.sha256) finding("rewritten-same-size");
		}
	} catch {
		finding("unreadable");
	}
	if (state.witness === "seal-mismatch") finding("witness-seal-mismatch");
	return findings.length === 0 ? state : { ...state, state: "legacy-seal-drift", findings };
}

export function hashEndoLegacyLogV0(path: string, prefixBytes?: number) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
			throw new TypeError("not a regular bounded legacy log");
		const bytes = Number(before.size);
		const hash = createHash("sha256");
		let prefix = prefixBytes === 0 ? hash.copy().digest("hex") : undefined;
		const chunk = Buffer.alloc(64 * 1024);
		for (let offset = 0; offset < bytes; ) {
			const boundary = prefixBytes !== undefined && offset < prefixBytes ? Math.min(prefixBytes, bytes) : bytes;
			const count = readSync(fd, chunk, 0, Math.min(chunk.length, boundary - offset), offset);
			if (count === 0) throw new TypeError("legacy log changed while hashing");
			hash.update(chunk.subarray(0, count));
			offset += count;
			if (offset === prefixBytes) prefix = hash.copy().digest("hex");
		}
		const after = fstatSync(fd, { bigint: true });
		const named = lstatSync(path, { bigint: true });
		if (
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			before.size !== after.size ||
			named.ino !== before.ino ||
			named.dev !== before.dev ||
			named.ctimeNs !== before.ctimeNs
		)
			throw new TypeError("legacy log changed while hashing");
		return { bytes, sha256: hash.digest("hex"), prefix };
	} finally {
		closeSync(fd);
	}
}
