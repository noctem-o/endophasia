// ENDO-HIDDEN-MARKER-booking-conflicts
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { findConflicts } = await import(new URL("src/booking-conflicts.js", WORK).href);
const bk = (id, room, start, end) => ({ id, room, start, end });
const D = "2026-03-01T";
const t = (hm) => `${D}${hm}:00Z`;

test("R1: shape and timestamp validation is a TypeError", () => {
	const ok = bk("a", "R1", t("09:00"), t("10:00"));
	for (const bad of [null, undefined, {}, "x", 5])
		assert.throws(() => findConflicts(bad), TypeError, String(bad));
	for (const broken of [
		{ ...ok, id: "" },
		{ ...ok, id: 7 },
		{ ...ok, id: undefined },
		{ ...ok, room: "" },
		{ ...ok, room: 3 },
		{ ...ok, start: "2026-03-01T09:00:00" },
		{ ...ok, start: "2026-03-01 09:00:00Z" },
		{ ...ok, start: "2026-03-01T09:00:00.000Z" },
		{ ...ok, start: "2026-03-01T09:00:00+00:00" },
		{ ...ok, end: "2026-02-30T10:00:00Z" },
		{ ...ok, end: "2026-03-01T25:00:00Z" },
		{ ...ok, end: "2026-13-01T10:00:00Z" },
		{ ...ok, end: 1772355600000 },
		null,
	])
		assert.throws(() => findConflicts([broken]), TypeError, JSON.stringify(broken));
	assert.deepEqual(findConflicts([ok]), []);
	assert.deepEqual(findConflicts([bk("x", "R", "2028-02-29T23:59:59Z", "2028-03-01T00:00:00Z")]), []);
});

test("R2: end after start, and unique ids", () => {
	assert.throws(() => findConflicts([bk("a", "R1", t("10:00"), t("10:00"))]), RangeError);
	assert.throws(() => findConflicts([bk("a", "R1", t("10:00"), t("09:00"))]), RangeError);
	assert.throws(
		() => findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("a", "R2", t("11:00"), t("12:00"))]),
		TypeError,
	);
});

test("R3: the first problem in array order is the one thrown", () => {
	const good = bk("g", "R1", t("08:00"), t("09:00"));
	assert.throws(() => findConflicts([bk("a", "R1", t("10:00"), t("09:00")), bk("b", "", t("09:00"), t("10:00"))]), RangeError);
	assert.throws(() => findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "", t("09:00"), t("10:00")), bk("c", "R1", t("11:00"), t("10:00"))]), TypeError);
	// within one booking: a bad timestamp (TypeError) comes before the end check (RangeError)
	assert.throws(() => findConflicts([bk("a", "R1", "2026-02-30T10:00:00Z", t("09:00"))]), TypeError);
	// the end check comes before the duplicate-id check
	assert.throws(() => findConflicts([good, bk("g", "R1", t("11:00"), t("10:00"))]), RangeError);
	// a duplicate id on an earlier booking comes before a range error on a later one
	assert.throws(() => findConflicts([good, bk("g", "R2", t("09:00"), t("10:00")), bk("z", "R1", t("11:00"), t("10:00"))]), TypeError);
});

test("R4: same room, half-open ranges, case-sensitive rooms", () => {
	assert.deepEqual(findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "R1", t("10:00"), t("11:00"))]), []);
	assert.deepEqual(findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "R1", t("08:00"), t("09:00"))]), []);
	assert.deepEqual(findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "R1", t("09:59"), t("11:00"))]), [["a", "b"]]);
	assert.deepEqual(findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "R1", t("09:00"), t("10:00"))]), [["a", "b"]]);
	assert.deepEqual(findConflicts([bk("a", "R1", t("08:00"), t("12:00")), bk("b", "R1", t("09:00"), t("10:00"))]), [["a", "b"]]);
	assert.deepEqual(findConflicts([bk("a", "A1", t("09:00"), t("10:00")), bk("b", "a1", t("09:00"), t("10:00"))]), []);
	assert.deepEqual(findConflicts([bk("a", "R1", t("09:00"), t("10:00")), bk("b", "R2", t("09:00"), t("10:00"))]), []);
	assert.deepEqual(
		findConflicts([bk("a", "R1", "2026-03-01T23:59:59Z", "2026-03-02T00:00:01Z"), bk("b", "R1", "2026-03-02T00:00:00Z", "2026-03-02T01:00:00Z")]),
		[["a", "b"]],
	);
});

test("R5: pairs are ordered and sorted", () => {
	const input = [
		bk("m", "R1", t("09:00"), t("12:00")),
		bk("c", "R1", t("10:00"), t("11:00")),
		bk("x", "R1", t("11:30"), t("13:00")),
		bk("B", "R1", t("08:00"), t("09:30")),
		bk("a", "R2", t("09:00"), t("10:00")),
		bk("b", "R2", t("09:30"), t("10:30")),
	];
	assert.deepEqual(findConflicts(input), [["B", "m"], ["a", "b"], ["c", "m"], ["m", "x"]]);
	assert.deepEqual(findConflicts([]), []);
	assert.deepEqual(findConflicts([bk("10", "R", t("09:00"), t("10:00")), bk("9", "R", t("09:00"), t("10:00"))]), [["10", "9"]]);
});

test("R6: the input is not changed", () => {
	const input = [
		bk("z", "R1", t("09:00"), t("10:00")),
		bk("a", "R1", t("09:30"), t("10:30")),
		bk("m", "R1", t("09:45"), t("10:45")),
	];
	const before = JSON.stringify(input);
	const frozen = input.map((b) => Object.freeze({ ...b }));
	findConflicts(frozen);
	findConflicts(input);
	assert.equal(JSON.stringify(input), before);
	assert.deepEqual(
		input.map((b) => b.id),
		["z", "a", "m"],
	);
});
