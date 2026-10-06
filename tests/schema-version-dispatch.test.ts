import { describe, expect, it } from "vitest";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	EndoSchemaVersionErrorV0,
	endoFirstUnknownKeyV0,
	endoSafeVersionLabelV0,
	parseEndoVersionedV0,
	readEndoVersionedV0,
} from "../protocol/versioned.ts";

interface Foo {
	schemaVersion: string;
	n?: number;
	m?: number;
}

const calls: string[] = [];
const foo = (version: string, extra: string[]) => (value: unknown) => {
	calls.push(version);
	const v = value as Record<string, unknown>;
	if (endoFirstUnknownKeyV0(v, ["schemaVersion", ...extra]) !== undefined) return null;
	if ((v.n !== undefined && typeof v.n !== "number") || (v.m !== undefined && typeof v.m !== "number")) return null;
	return v.schemaVersion === version ? (value as Foo) : null;
};
const TABLE = defineEndoVersionTableV0<Foo>("endo.foo", [
	["endo.foo.v0", foo("endo.foo.v0", ["n"])],
	["endo.foo.v1", foo("endo.foo.v1", ["n", "m"])],
]);

describe("version dispatch", () => {
	it("returns the very record it was given, selected by its own version", () => {
		calls.length = 0;
		const v1 = { schemaVersion: "endo.foo.v1", n: 1, m: 2 };
		const read = readEndoVersionedV0(TABLE, v1);
		expect(read.ok && read.value).toBe(v1);
		expect(calls).toEqual(["endo.foo.v1"]);
	});

	it("never tries another version's validator", () => {
		calls.length = 0;
		// A v1 record that is malformed does not fall back to v0.
		expect(readEndoVersionedV0(TABLE, { schemaVersion: "endo.foo.v1", n: "x" })).toMatchObject({ ok: false });
		const read = readEndoVersionedV0(TABLE, { schemaVersion: "endo.foo.v1", unknown: 1 });
		expect(read).toMatchObject({ ok: false, kind: "invalid", schemaVersion: "endo.foo.v1" });
		expect(new Set(calls)).toEqual(new Set(["endo.foo.v1"]));
	});

	it("rejects a v1-only field on a v0 record, and an unknown version before any validator runs", () => {
		calls.length = 0;
		expect(readEndoVersionedV0(TABLE, { schemaVersion: "endo.foo.v0", m: 1 })).toMatchObject({
			ok: false,
			kind: "invalid",
		});
		calls.length = 0;
		expect(readEndoVersionedV0(TABLE, { schemaVersion: "endo.foo.v2" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
			schemaVersion: "endo.foo.v2",
		});
		expect(calls).toEqual([]);
	});

	it("tells missing, non-string, unknown and malformed-known apart", () => {
		const kind = (value: unknown) => {
			const read = readEndoVersionedV0(TABLE, value);
			return read.ok ? "ok" : read.kind;
		};
		expect(kind({})).toBe("missing-version");
		expect(kind({ schemaVersion: 0 })).toBe("version-not-string");
		expect(kind({ schemaVersion: null })).toBe("version-not-string");
		expect(kind({ schemaVersion: "endo.foo.v999" })).toBe("unsupported-version");
		expect(kind({ schemaVersion: "endo.foo.v0", n: "x", extra: 1 })).toBe("invalid");
		expect(kind("endo.foo.v0")).toBe("not-an-object");
		expect(kind(null)).toBe("not-an-object");
		expect(kind([{ schemaVersion: "endo.foo.v0" }])).toBe("not-an-object");
	});

	it("looks versions up as keys, never as properties of an object", () => {
		for (const version of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", ""]) {
			expect(readEndoVersionedV0(TABLE, { schemaVersion: version })).toMatchObject({
				ok: false,
				kind: "unsupported-version",
			});
		}
		// A `__proto__` own key from JSON.parse is data, not a prototype.
		expect(
			readEndoVersionedV0(TABLE, JSON.parse('{"schemaVersion":"endo.foo.v0","__proto__":{"n":1}}')),
		).toMatchObject({
			ok: false,
			kind: "invalid",
		});
	});

	it("accepts only plain JSON objects with an own data property schemaVersion", () => {
		class Klass {
			schemaVersion = "endo.foo.v0";
		}
		const inherited = Object.create({ schemaVersion: "endo.foo.v0" });
		const getter = Object.defineProperty({}, "schemaVersion", { get: () => "endo.foo.v0", enumerable: true });
		const nullProto = Object.assign(Object.create(null), { schemaVersion: "endo.foo.v0" });
		expect(readEndoVersionedV0(TABLE, new Klass())).toMatchObject({ ok: false, kind: "not-an-object" });
		expect(readEndoVersionedV0(TABLE, inherited)).toMatchObject({ ok: false, kind: "not-an-object" });
		expect(readEndoVersionedV0(TABLE, getter)).toMatchObject({ ok: false, kind: "version-not-string" });
		expect(readEndoVersionedV0(TABLE, nullProto)).toMatchObject({ ok: true });
	});

	it("bounds and quotes an attacker-controlled version in its message, and never echoes the record", () => {
		const long = `endo.foo.v${"9".repeat(500)}\u0000\n`;
		const read = readEndoVersionedV0(TABLE, { schemaVersion: long, secret: "hunter2" });
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.message.length).toBeLessThan(300);
		expect(read.message).not.toContain("hunter2");
		expect(read.message).not.toMatch(/[\u0000\n]/);
		expect(endoSafeVersionLabelV0("a\nb")).toBe('"a\\nb"');
	});

	it("does not mutate its input, on success or failure", () => {
		const ok = Object.freeze({ schemaVersion: "endo.foo.v0", n: 1 });
		const bad = { schemaVersion: "endo.foo.v0", n: 1, extra: { deep: [1] } };
		const before = JSON.stringify(bad);
		readEndoVersionedV0(TABLE, ok);
		readEndoVersionedV0(TABLE, bad);
		expect(JSON.stringify(bad)).toBe(before);
	});

	it("throws a TypeError subclass from the throwing form, carrying the kind", () => {
		try {
			parseEndoVersionedV0(TABLE, { schemaVersion: "endo.foo.v2" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(TypeError);
			expect(error).toBeInstanceOf(EndoSchemaVersionErrorV0);
			expect((error as EndoSchemaVersionErrorV0).kind).toBe("unsupported-version");
			expect((error as EndoSchemaVersionErrorV0).schemaVersion).toBe("endo.foo.v2");
		}
	});

	it("lets a validator explain why through EndoInvalidRecordV0, and propagates any other throw", () => {
		const explaining = defineEndoVersionTableV0<Foo>("endo.bar", [
			[
				"endo.bar.v0",
				() => {
					throw new EndoInvalidRecordV0("bad thing");
				},
			],
			[
				"endo.bar.v1",
				() => {
					throw new RangeError("defect");
				},
			],
		]);
		expect(readEndoVersionedV0(explaining, { schemaVersion: "endo.bar.v0" })).toMatchObject({
			ok: false,
			kind: "invalid",
			message: expect.stringContaining("bad thing"),
		});
		expect(() => readEndoVersionedV0(explaining, { schemaVersion: "endo.bar.v1" })).toThrow(RangeError);
	});

	it("builds a frozen table and refuses a duplicate or empty version", () => {
		expect(Object.isFrozen(TABLE)).toBe(true);
		expect(TABLE.versions).toEqual(["endo.foo.v0", "endo.foo.v1"]);
		expect(() =>
			defineEndoVersionTableV0("x", [
				["a", () => null],
				["a", () => null],
			]),
		).toThrow(/duplicate/);
		expect(() => defineEndoVersionTableV0("x", [["", () => null]])).toThrow(TypeError);
	});
});
