// DEVELOP-VERIFY-TRUST-002: the request (ARCHITECTURE.md §5.2). Research only.
//
// One JSON document, exactly these keys. Nothing in it can name a program, a path, an environment variable, an argument, a limit or an
// expected result: `task` picks an installed oracle by name, and the candidate is a set of Git objects.

import type { ObjectFormat, ObjectType } from "./objects.ts";

export const REQUEST_SCHEMA = "endo.research.dvt002.request.v0";
export const MAX_REQUEST_BYTES = 8 << 20;
const TASK = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface Request {
	task: string;
	objectFormat: ObjectFormat;
	commit: string;
	objects: { type: ObjectType; data: Buffer }[];
}

const exactKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	typeof v === "object" &&
	v !== null &&
	!Array.isArray(v) &&
	Object.keys(v).length === keys.length &&
	keys.every((k) => Object.hasOwn(v, k));

/** Parse a request's bytes. Any deviation is `request-invalid`; nothing is coerced, defaulted or ignored. */
export function parseRequest(bytes: Buffer): { ok: true; request: Request } | { ok: false; reason: string } {
	if (bytes.length > MAX_REQUEST_BYTES) return { ok: false, reason: "request-too-large" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { ok: false, reason: "request-invalid" };
	}
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return { ok: false, reason: "request-invalid" };
	}
	if (!exactKeys(v, ["schemaVersion", "task", "objectFormat", "commit", "objects"]))
		return { ok: false, reason: "request-invalid" };
	if (v.schemaVersion !== REQUEST_SCHEMA) return { ok: false, reason: "request-invalid" };
	if (typeof v.task !== "string" || !TASK.test(v.task)) return { ok: false, reason: "request-invalid" };
	if (v.objectFormat !== "sha1" && v.objectFormat !== "sha256") return { ok: false, reason: "request-invalid" };
	const hex = v.objectFormat === "sha1" ? 40 : 64;
	if (typeof v.commit !== "string" || !new RegExp(`^[0-9a-f]{${hex}}$`).test(v.commit))
		return { ok: false, reason: "request-invalid" };
	if (!Array.isArray(v.objects)) return { ok: false, reason: "request-invalid" };
	const objects: Request["objects"] = [];
	for (const o of v.objects) {
		if (!exactKeys(o, ["type", "data"])) return { ok: false, reason: "request-invalid" };
		if (o.type !== "commit" && o.type !== "tree" && o.type !== "blob")
			return { ok: false, reason: "request-invalid" };
		if (typeof o.data !== "string" || o.data.length % 4 !== 0 || !BASE64.test(o.data))
			return { ok: false, reason: "request-invalid" };
		const data = Buffer.from(o.data, "base64");
		// Canonical base64 only: one encoding per byte string.
		if (data.toString("base64") !== o.data) return { ok: false, reason: "request-invalid" };
		objects.push({ type: o.type, data });
	}
	return { ok: true, request: { task: v.task, objectFormat: v.objectFormat, commit: v.commit, objects } };
}

/**
 * The requester, from the instance name systemd gives an `Accept=yes` service for a Unix socket: `<n>-<cookie>-<pid>_<pidfd id>-<uid>`
 * (systemd 262 here: the socket cookie, then the peer's pid and its pidfd's inode id) or, from older versions, `<n>-<pid>-<uid>`. The pid
 * and uid are the peer's credentials (`SO_PEERCRED`) at connection time: a uid, never a person.
 */
export function parsePeer(instance: string): { pid: number; uid: number } | null {
	const m = /^\d+-(?:\d+-)?(\d+)(?:_\d+)?-(\d+)$/.exec(instance);
	if (m === null) return null;
	const pid = Number(m[1]);
	const uid = Number(m[2]);
	return Number.isSafeInteger(pid) && Number.isSafeInteger(uid) ? { pid, uid } : null;
}
