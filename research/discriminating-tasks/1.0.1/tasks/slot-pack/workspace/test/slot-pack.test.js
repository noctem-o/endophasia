import assert from "node:assert/strict";
import { test } from "node:test";
import { packSlots } from "../src/slot-pack.js";

test("packs by decreasing size into the first slot with room", () => {
	const items = [
		{ id: "a", size: 2 },
		{ id: "b", size: 5 },
		{ id: "c", size: 4 },
	];
	assert.deepEqual(packSlots(items, 6), [["b"], ["c", "a"]]);
});

test("an empty list needs no slots", () => {
	assert.deepEqual(packSlots([], 10), []);
});
