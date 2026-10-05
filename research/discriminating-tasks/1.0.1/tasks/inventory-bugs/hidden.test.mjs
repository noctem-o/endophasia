// ENDO-HIDDEN-MARKER-inventory-bugs
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { Inventory } = await import(new URL("src/inventory.js", WORK).href);
const row = (sku, onHand, reserved) => ({ sku, onHand, reserved, available: onHand - reserved });

test("R1: SKUs are normalized by every method", () => {
	const inv = new Inventory();
	inv.add(" ab-1 ", 10);
	inv.reserve("Ab-1", 4);
	inv.release("  aB-1", 1);
	inv.remove("ab-1 ", 2);
	assert.deepEqual(inv.snapshot(), [row("AB-1", 8, 3)]);
	for (const bad of ["", "   ", 5, null, undefined, {}]) {
		assert.throws(() => inv.add(bad, 1), TypeError, String(bad));
		assert.throws(() => inv.reserve(bad, 1), TypeError, String(bad));
		assert.throws(() => inv.release(bad, 1), TypeError, String(bad));
		assert.throws(() => inv.remove(bad, 1), TypeError, String(bad));
	}
});

test("R2: quantities are positive integers", () => {
	const inv = new Inventory();
	inv.add("X", 5);
	inv.reserve("X", 1);
	for (const bad of [0, -1, 1.5, "2", NaN, Infinity, null, undefined]) {
		assert.throws(() => inv.add("X", bad), RangeError, String(bad));
		assert.throws(() => inv.reserve("X", bad), RangeError, String(bad));
		assert.throws(() => inv.release("X", bad), RangeError, String(bad));
		assert.throws(() => inv.remove("X", bad), RangeError, String(bad));
	}
	assert.deepEqual(inv.snapshot(), [row("X", 5, 1)]);
});

test("R3: add increases stock", () => {
	const inv = new Inventory();
	inv.add("x", 2);
	inv.add("X", 3);
	assert.deepEqual(inv.snapshot(), [row("X", 5, 0)]);
});

test("R4: reserve is limited to what is available and changes nothing on failure", () => {
	const inv = new Inventory();
	assert.throws(() => inv.reserve("none", 1), RangeError);
	inv.add("X", 10);
	inv.reserve("X", 6);
	assert.throws(() => inv.reserve("X", 5), RangeError);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 6)]);
	inv.reserve("X", 4);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 10)]);
	assert.throws(() => inv.reserve("X", 1), RangeError);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 10)]);
});

test("R5: release is limited to what is reserved and changes nothing on failure", () => {
	const inv = new Inventory();
	assert.throws(() => inv.release("none", 1), RangeError);
	inv.add("X", 10);
	inv.add("Y", 10);
	inv.reserve("X", 3);
	assert.throws(() => inv.release("X", 4), RangeError);
	assert.throws(() => inv.release("Y", 1), RangeError);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 3), row("Y", 10, 0)]);
	inv.release("X", 3);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 0), row("Y", 10, 0)]);
});

test("R6: remove cannot take reserved stock", () => {
	const inv = new Inventory();
	assert.throws(() => inv.remove("none", 1), RangeError);
	inv.add("X", 10);
	inv.reserve("X", 7);
	assert.throws(() => inv.remove("X", 4), RangeError);
	assert.deepEqual(inv.snapshot(), [row("X", 10, 7)]);
	inv.remove("X", 3);
	assert.deepEqual(inv.snapshot(), [row("X", 7, 7)]);
	assert.throws(() => inv.remove("X", 1), RangeError);
	inv.release("X", 7);
	inv.remove("X", 7);
	assert.deepEqual(inv.snapshot(), []);
});

test("R7: snapshot order and omissions", () => {
	const inv = new Inventory();
	for (const sku of ["b", "AB", "a_1", "A-2", "a10", "A9", "Z"]) inv.add(sku, 1);
	inv.add("gone", 2);
	inv.remove("gone", 2);
	inv.add("held", 1);
	inv.reserve("held", 1);
	const skus = inv.snapshot().map((r) => r.sku);
	assert.deepEqual(skus, ["A-2", "A10", "A9", "AB", "A_1", "B", "HELD", "Z"]);
	assert.ok(!skus.includes("GONE"));
	assert.deepEqual(new Inventory().snapshot(), []);
});
