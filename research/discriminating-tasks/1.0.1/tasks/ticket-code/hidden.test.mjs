// ENDO-HIDDEN-MARKER-ticket-code
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { decodeTicket, encodeTicket } = await import(new URL("src/ticket-code.js", WORK).href);
const make = (venue, row, seat) => encodeTicket({ venue, row, seat });
const ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ";
const checkOf = (body) => ALPHABET[[...body].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 23];

test("R1: out-of-range or non-integer parts make encodeTicket throw a RangeError", () => {
	for (const bad of [
		{ venue: 0, row: 1, seat: 1 },
		{ venue: 100, row: 1, seat: 1 },
		{ venue: 1.5, row: 1, seat: 1 },
		{ venue: "7", row: 1, seat: 1 },
		{ venue: 7, row: 0, seat: 1 },
		{ venue: 7, row: 2.5, seat: 1 },
		{ venue: 7, row: 1, seat: 0 },
		{ venue: 7, row: 1, seat: 1000 },
	])
		assert.throws(() => encodeTicket(bad), RangeError, JSON.stringify(bad));
	assert.equal(typeof make(1, 1, 1), "string");
	assert.equal(typeof make(99, 5, 999), "string");
});

test("R2: the shape of a code", () => {
	assert.equal(make(7, 28, 12), "V07-AB-012-G");
	assert.match(make(99, 702, 999), /^V99-[A-Z]+-999-[A-Z]$/);
	assert.match(make(5, 3, 7), /^V05-C-007-[A-Z]$/);
});

test("R3: row labels in bijective base 26", () => {
	const labels = [1, 2, 26, 27, 52, 53, 702, 703, 18278, 18279].map((row) => make(1, row, 1).split("-")[1]);
	assert.deepEqual(labels, ["A", "B", "Z", "AA", "AZ", "BA", "ZZ", "AAA", "ZZZ", "AAAA"]);
});

test("R4: the check letter", () => {
	assert.equal(make(7, 28, 12), "V07-AB-012-G");
	assert.equal(make(1, 1, 1), "V01-A-001-A");
	assert.equal(make(99, 702, 999), "V99-ZZ-999-X");
	assert.equal(make(12, 703, 45), "V12-AAA-045-D");
	assert.equal(make(30, 26, 300), "V30-Z-300-H");
	assert.equal(make(5, 27, 7), "V05-AA-007-H");
	assert.equal(make(5, 52, 7), "V05-AZ-007-K");
	assert.equal(make(5, 53, 7), "V05-BA-007-J");
	for (const [v, r, s] of [[3, 100, 9], [44, 1000, 321], [8, 12345, 77]]) {
		const code = make(v, r, s);
		assert.equal(code.at(-1), checkOf(code.slice(0, code.lastIndexOf("-"))));
	}
});

test("R5: decode is the exact inverse of encode", () => {
	assert.deepEqual(decodeTicket("V07-AB-012-G"), { venue: 7, row: 28, seat: 12 });
	for (const venue of [1, 9, 10, 57, 99])
		for (const row of [1, 25, 26, 27, 28, 51, 52, 53, 676, 677, 702, 703, 18278, 18279, 100000])
			for (const seat of [1, 12, 100, 999]) {
				const decoded = decodeTicket(make(venue, row, seat));
				assert.deepEqual(decoded, { venue, row, seat });
				assert.equal(typeof decoded.venue, "number");
			}
});

test("R6: a code of the wrong form is a SyntaxError", () => {
	for (const bad of [
		"v07-AB-012-G",
		"V7-AB-012-G",
		"V07-ab-012-G",
		"V07-AB-12-G",
		"V07--012-G",
		"V07-A1-012-G",
		"V07-AB-012",
		"V07-AB-012-GG",
		"V07-AB-012-g",
		"V07-AB-012-G-",
		" V07-AB-012-G",
		"V07-AB-0120-G",
		"X07-AB-012-G",
		"",
		123,
		null,
		undefined,
	])
		assert.throws(() => decodeTicket(bad), SyntaxError, String(bad));
});

test("R6: a code of the right form with a bad value or check letter is a RangeError", () => {
	const good = make(7, 28, 12);
	assert.throws(() => decodeTicket(`${good.slice(0, -1)}H`), RangeError);
	assert.throws(() => decodeTicket(`${good.slice(0, -1)}A`), RangeError);
	const withCheck = (body) => `${body}-${checkOf(body)}`;
	assert.throws(() => decodeTicket(withCheck("V00-A-001")), RangeError);
	assert.throws(() => decodeTicket(withCheck("V05-C-000")), RangeError);
	assert.deepEqual(decodeTicket(withCheck("V05-C-001")), { venue: 5, row: 3, seat: 1 });
});
