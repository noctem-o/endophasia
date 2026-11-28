import { isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, endoFirstUnknownKeyV0, readEndoVersionedV0 } from "./versioned.ts";

export const ENDO_ATTACHMENT_STORE_FORMAT_V0 = "per-attachment-v1";
const SCHEMA = "endo.store-format.v0";
const SHA256 = /^[a-f0-9]{64}$/;

export type EndoLegacySealV0 =
	| { readonly logPresent: false }
	| { readonly bytes: number; readonly frames: number; readonly sha256: string; readonly prefixDigest: string };

export type EndoStoreFormatSentinelV0 = {
	readonly schemaVersion: typeof SCHEMA;
	readonly format: typeof ENDO_ATTACHMENT_STORE_FORMAT_V0;
	readonly createdAt: string;
	readonly attachment: string;
} & (
	| { readonly origin: "created"; readonly legacy: null }
	| { readonly origin: "migrated"; readonly legacy: EndoLegacySealV0 }
);

function validate(value: unknown): EndoStoreFormatSentinelV0 | null {
	if (!isPlainJsonObjectV0(value)) return null;
	const body = value as Record<string, unknown>;
	if (
		endoFirstUnknownKeyV0(body, ["schemaVersion", "format", "createdAt", "attachment", "origin", "legacy"]) !==
			undefined ||
		body.schemaVersion !== SCHEMA ||
		body.format !== ENDO_ATTACHMENT_STORE_FORMAT_V0 ||
		typeof body.attachment !== "string" ||
		!/^[-\x20-\x7e]{1,256}$/.test(body.attachment) ||
		typeof body.createdAt !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(body.createdAt) ||
		!Number.isFinite(Date.parse(body.createdAt))
	)
		return null;
	if (body.origin === "created") return body.legacy === null ? (body as EndoStoreFormatSentinelV0) : null;
	if (body.origin !== "migrated" || !isPlainJsonObjectV0(body.legacy)) return null;
	const legacy = body.legacy as Record<string, unknown>;
	if (legacy.logPresent === false && Reflect.ownKeys(legacy).length === 1) return body as EndoStoreFormatSentinelV0;
	if (
		endoFirstUnknownKeyV0(legacy, ["bytes", "frames", "sha256", "prefixDigest"]) !== undefined ||
		typeof legacy.bytes !== "number" ||
		!Number.isSafeInteger(legacy.bytes) ||
		legacy.bytes < 0 ||
		typeof legacy.frames !== "number" ||
		!Number.isSafeInteger(legacy.frames) ||
		legacy.frames < 0 ||
		legacy.frames * 36 > legacy.bytes ||
		(legacy.frames === 0 && legacy.bytes !== 0) ||
		typeof legacy.sha256 !== "string" ||
		!SHA256.test(legacy.sha256) ||
		typeof legacy.prefixDigest !== "string" ||
		!SHA256.test(legacy.prefixDigest)
	)
		return null;
	return body as EndoStoreFormatSentinelV0;
}

export const ENDO_STORE_FORMAT_VERSIONS_V0 = defineEndoVersionTableV0("endo.store-format", [[SCHEMA, validate]]);

export function readEndoStoreFormatSentinelV0(value: unknown) {
	return readEndoVersionedV0(ENDO_STORE_FORMAT_VERSIONS_V0, value);
}
