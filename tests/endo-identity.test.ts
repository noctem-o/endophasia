import { describe, expect, it } from "vitest";
import {
	ENDO_IDENTIFIER_KINDS_V0,
	formatEndoIdentifierV0,
	isEndoIdentifierV0,
	isWellFormedEventKindV0,
	isWellFormedKindV0,
	parseEndoIdentifierV0,
} from "../protocol/identity.ts";

describe("parseEndoIdentifierV0", () => {
	it("parses every v0 namespace with an opaque local part", () => {
		for (const kind of ENDO_IDENTIFIER_KINDS_V0) {
			expect(parseEndoIdentifierV0(`endo.${kind}.abc-123.x_y`)).toEqual({ kind, local: "abc-123.x_y" });
		}
	});

	it("treats the local part as opaque: dots, underscores, and hyphens round-trip", () => {
		const parsed = parseEndoIdentifierV0("endo.event.session.started");
		expect(parsed).toEqual({ kind: "event", local: "session.started" });
	});

	it("rejects the boundary cases of the grammar", () => {
		const invalid = [
			"",
			"endo.",
			"endo",
			"endo.session",
			"endo.session.",
			"endo..x",
			"ENDO.session.x",
			"Endo.session.x",
			"endo.artifact.x",
			"endo.sessions.x",
			"endo.session.a b",
			"endo.session.a/b",
			`endo.session.${"a".repeat(257)}`,
		];
		for (const value of invalid) expect(parseEndoIdentifierV0(value)).toBeNull();
	});

	it("accepts a 256-character local part, the grammar maximum", () => {
		const local = "a".repeat(256);
		expect(parseEndoIdentifierV0(`endo.session.${local}`)).toEqual({ kind: "session", local });
	});
});

describe("formatEndoIdentifierV0", () => {
	it("formats a canonical identifier", () => {
		expect(formatEndoIdentifierV0("session", "s-1")).toBe("endo.session.s-1");
	});

	it("returns null, not a throw, for malformed parts", () => {
		expect(formatEndoIdentifierV0("session", "")).toBeNull();
		expect(formatEndoIdentifierV0("session", "a b")).toBeNull();
		expect(formatEndoIdentifierV0("session", "a".repeat(257))).toBeNull();
	});
});

describe("parse/format round-trip", () => {
	it("format after parse is the identity on valid input", () => {
		const valid = [
			"endo.session.s1",
			"endo.run.r-2",
			"endo.event.e-3",
			"endo.node.n-4",
			"endo.edge.e-5",
			"endo.model.m-6",
			"endo.tool.t-7",
			"endo.experiment.x-8",
			"endo.candidate.c-9",
			"endo.evidence.v-10",
			"endo.session.a.b-c.d_e",
		];
		for (const value of valid) {
			const parsed = parseEndoIdentifierV0(value);
			expect(parsed).not.toBeNull();
			expect(formatEndoIdentifierV0(parsed!.kind, parsed!.local)).toBe(value);
		}
	});
});

describe("isEndoIdentifierV0", () => {
	it("accepts well-formed identifiers and honors a namespace constraint", () => {
		expect(isEndoIdentifierV0("endo.session.s1")).toBe(true);
		expect(isEndoIdentifierV0("endo.session.s1", "session")).toBe(true);
		expect(isEndoIdentifierV0("endo.session.s1", "run")).toBe(false);
		expect(isEndoIdentifierV0("endo.session a", "session")).toBe(false);
	});
});

describe("dotted-kind grammars", () => {
	it("accepts well-formed kinds and rejects malformed ones", () => {
		expect(isWellFormedKindV0("claim")).toBe(true);
		expect(isWellFormedKindV0("thought.note")).toBe(true);
		expect(isWellFormedKindV0("a-b.c_1")).toBe(false); // underscores are not kind characters
		expect(isWellFormedKindV0("")).toBe(false);
		expect(isWellFormedKindV0(".a")).toBe(false);
		expect(isWellFormedKindV0("a.")).toBe(false);
		expect(isWellFormedKindV0("A.b")).toBe(false);
		expect(isWellFormedKindV0(`a.${"b".repeat(130)}`)).toBe(false);
		expect(isWellFormedEventKindV0("session.started")).toBe(true);
		expect(isWellFormedEventKindV0("a.b.c")).toBe(true);
		expect(isWellFormedEventKindV0("claim")).toBe(false); // event kinds need two or more segments
		expect(isWellFormedEventKindV0(".started")).toBe(false);
	});
});
