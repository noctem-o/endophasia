// ENDO-HIDDEN-MARKER-slot-pack
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { packSlots } = await import(new URL("src/slot-pack.js", WORK).href);
const item = (id, size) => ({ id, size });

test("R1: an item as large as the slot fits exactly", () => {
	assert.deepEqual(packSlots([item("a", 10)], 10), [["a"]]);
	assert.deepEqual(packSlots([item("a", 10), item("b", 10)], 10), [["a"], ["b"]]);
});

test("R2: decreasing size, then ascending id", () => {
	assert.deepEqual(packSlots([item("b", 3), item("a", 3), item("c", 5)], 8), [["c", "a"], ["b"]]);
	assert.deepEqual(packSlots([item("x2", 4), item("x10", 4), item("x1", 4)], 4), [["x1"], ["x10"], ["x2"]]);
});

test("R3: the first slot with room, in creation order", () => {
	const items = [item("p6", 6), item("p5", 5), item("p4", 4), item("p3", 3), item("p2", 2)];
	assert.deepEqual(packSlots(items, 10), [
		["p6", "p4"],
		["p5", "p3", "p2"],
	]);
	assert.deepEqual(packSlots([item("a", 5), item("b", 4), item("c", 4), item("d", 1)], 9), [["a", "b"], ["c", "d"]]);
});

test("R4: slots in creation order, ids in placement order", () => {
	const result = packSlots([item("a", 1), item("b", 2), item("c", 3)], 3);
	assert.deepEqual(result, [["c"], ["b", "a"]]);
	assert.ok(Array.isArray(result) && result.every((slot) => Array.isArray(slot)));
	assert.ok(result.flat().every((id) => typeof id === "string"));
});

test("R5: an item larger than a slot throws a RangeError naming the first such item in placement order", () => {
	assert.throws(
		() => packSlots([item("small", 1), item("ZED2", 11), item("ZED1", 11)], 10),
		(error) => error instanceof RangeError && error.message.includes("ZED1") && !error.message.includes("ZED2"),
	);
	assert.throws(
		() => packSlots([item("MID", 11), item("TOP", 12)], 10),
		(error) => error instanceof RangeError && error.message.includes("TOP") && !error.message.includes("MID"),
	);
});

test("R6: the input is not modified", () => {
	const items = Object.freeze([Object.freeze(item("b", 2)), Object.freeze(item("a", 3))]);
	assert.deepEqual(packSlots(items, 5), [["a", "b"]]);
	assert.deepEqual(items.map((entry) => entry.id), ["b", "a"]);
});

test("R7: no items, no slots", () => {
	assert.deepEqual(packSlots([], 7), []);
});
