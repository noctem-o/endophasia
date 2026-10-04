import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory } from "../src/inventory.js";

test("add and snapshot", () => {
	const inv = new Inventory();
	inv.add("ab-1", 5);
	inv.add(" AB-1 ", 2);
	assert.deepEqual(inv.snapshot(), [{ sku: "AB-1", onHand: 7, reserved: 0, available: 7 }]);
});

test("reserve and release", () => {
	const inv = new Inventory();
	inv.add("X", 10);
	inv.reserve("X", 4);
	assert.throws(() => inv.reserve("X", 7), RangeError);
	inv.release("X", 1);
	assert.deepEqual(inv.snapshot(), [{ sku: "X", onHand: 10, reserved: 3, available: 7 }]);
});

test("remove", () => {
	const inv = new Inventory();
	inv.add("X", 3);
	inv.remove("X", 3);
	assert.deepEqual(inv.snapshot(), []);
});
