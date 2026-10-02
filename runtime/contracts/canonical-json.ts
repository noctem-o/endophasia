// The canonical JSON serialization the event/evidence substrate digests with: a strict plain-data guard (no
// getters, proxies, custom serializers, symbol keys, or sparse arrays), sorted object keys, preserved array
// order, tab indent, one trailing LF. A local format, not RFC 8785. The discipline is demonstrated in
// research/conformance/json.ts, and research is quarantined from the production layers, so this is the
// production copy. SHA-256 comes from node:crypto; the protocol layer stays language-neutral.

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { JsonValueV0 } from "../../protocol/primitives.ts";

/** Validate without invoking getters, proxies or serializers. Undefined is not JSON, even in object slots. */
export function assertPlainJsonValueV0(value: unknown): asserts value is JsonValueV0 {
	const ancestors = new Set<object>();
	const walk = (item: unknown): void => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object" || types.isProxy(item) || ancestors.has(item))
			throw new TypeError("nonplain JSON value");
		const array = Array.isArray(item);
		const prototype = Object.getPrototypeOf(item);
		if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			throw new TypeError("nonplain JSON value");
		for (let parent: object | null = item; parent !== null; parent = Object.getPrototypeOf(parent))
			if (Object.getOwnPropertyDescriptor(parent, "toJSON")) throw new TypeError("custom JSON serializer");
		ancestors.add(item);
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Reflect.ownKeys(item).some((key) => typeof key !== "string")) throw new TypeError("symbol JSON key");
		if (array && Object.keys(descriptors).length !== item.length + 1) throw new TypeError("sparse JSON array");
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (array && key === "length") continue;
			if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError("nondata JSON property");
			if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
				throw new TypeError("custom JSON array property");
			walk(descriptor.value);
		}
		ancestors.delete(item);
	};
	walk(value);
}

/** Sorted object keys, preserved array order, UTF-8 with one LF. A local format, not RFC 8785. */
export function canonicalEndoJsonV0(value: unknown): string {
	assertPlainJsonValueV0(value);
	const sorted = (item: JsonValueV0): JsonValueV0 => {
		if (Array.isArray(item)) return item.map(sorted);
		if (item === null || typeof item !== "object") return item;
		const result: { [key: string]: JsonValueV0 } = Object.create(null);
		for (const key of Object.keys(item).sort()) result[key] = sorted(item[key]!);
		return result;
	};
	return `${JSON.stringify(sorted(value), null, "\t")}\n`;
}

/** The SHA-256 of the bytes as 64 lowercase hex characters. */
export function sha256HexV0(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
