// ENDO-HIDDEN-MARKER-tax-brackets
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { computeTax } = await import(new URL("src/tax-brackets.js", WORK).href);
const S = [
	{ upTo: 100000, rateBp: 1000 },
	{ upTo: 400000, rateBp: 2000 },
	{ upTo: null, rateBp: 3000 },
];

test("R1: input validation", () => {
	for (const bad of [-1, 1.5, "100", NaN, Infinity, null, undefined]) assert.throws(() => computeTax(bad, S), RangeError, String(bad));
	for (const bad of [[], null, undefined, {}, "x"]) assert.throws(() => computeTax(100, bad), TypeError, String(bad));
	for (const broken of [
		[{ upTo: null, rateBp: -1 }],
		[{ upTo: null, rateBp: 10001 }],
		[{ upTo: null, rateBp: 12.5 }],
		[{ upTo: null, rateBp: "10" }],
		[{ upTo: 0, rateBp: 10 }, { upTo: null, rateBp: 10 }],
		[{ upTo: -5, rateBp: 10 }, { upTo: null, rateBp: 10 }],
		[{ upTo: 10.5, rateBp: 10 }, { upTo: null, rateBp: 10 }],
		[{ upTo: "10", rateBp: 10 }, { upTo: null, rateBp: 10 }],
		[null],
	])
		assert.throws(() => computeTax(100, broken), TypeError, JSON.stringify(broken));
	assert.equal(computeTax(0, [{ upTo: null, rateBp: 0 }]).totalCents, 0);
	assert.equal(computeTax(0, [{ upTo: null, rateBp: 10000 }]).totalCents, 0);
});

test("R2: schedule validity, and the schedule is checked first", () => {
	for (const broken of [
		[{ upTo: 100, rateBp: 10 }, { upTo: 100, rateBp: 20 }, { upTo: null, rateBp: 30 }],
		[{ upTo: 200, rateBp: 10 }, { upTo: 100, rateBp: 20 }, { upTo: null, rateBp: 30 }],
		[{ upTo: 100, rateBp: 10 }, { upTo: 200, rateBp: 20 }],
		[{ upTo: null, rateBp: 10 }, { upTo: null, rateBp: 20 }],
		[{ upTo: null, rateBp: 10 }, { upTo: 500, rateBp: 20 }],
		[{ upTo: 100, rateBp: 10 }],
	])
		assert.throws(() => computeTax(50, broken), TypeError, JSON.stringify(broken));
	assert.throws(() => computeTax(-1, [{ upTo: 100, rateBp: 10 }]), TypeError);
	assert.throws(() => computeTax(1.5, []), TypeError);
	assert.throws(() => computeTax(-1, S), RangeError);
});

test("R3: progressive brackets", () => {
	assert.equal(computeTax(50000, S).totalCents, 5000);
	assert.equal(computeTax(100000, S).totalCents, 10000);
	assert.equal(computeTax(100001, S).totalCents, 10000); // the extra cent is taxed at 20%: 0.2 -> 0
	assert.equal(computeTax(400000, S).totalCents, 10000 + 60000);
	assert.equal(computeTax(500000, S).totalCents, 10000 + 60000 + 30000);
	assert.equal(computeTax(1234567, [{ upTo: null, rateBp: 2500 }]).totalCents, 308642);
});

test("R4: each bracket rounds half to even before adding", () => {
	const one = (income, rateBp) => computeTax(income, [{ upTo: null, rateBp }]).totalCents;
	assert.equal(one(5, 5000), 2); // 2.5 -> 2
	assert.equal(one(7, 5000), 4); // 3.5 -> 4
	assert.equal(one(1, 5000), 0); // 0.5 -> 0
	assert.equal(one(3, 5000), 2); // 1.5 -> 2
	assert.equal(one(10, 1234), 1); // 1.234 -> 1
	assert.equal(one(10, 1666), 2); // 1.666 -> 2
	assert.equal(one(10, 1500), 2); // 1.5 -> 2
	assert.equal(one(10, 2500), 2); // 2.5 -> 2
	const two = [{ upTo: 5, rateBp: 5000 }, { upTo: null, rateBp: 5000 }];
	const r = computeTax(10, two);
	assert.deepEqual(r.perBracket.map((b) => b.taxCents), [2, 2]); // 2.5 -> 2 and 2.5 -> 2, not 5
	assert.equal(r.totalCents, 4);
	const three = [{ upTo: 3, rateBp: 5000 }, { upTo: 6, rateBp: 5000 }, { upTo: null, rateBp: 5000 }];
	assert.equal(computeTax(9, three).totalCents, 2 + 2 + 2); // each 1.5 -> 2; the exact total 4.5 is not used
});

test("R5: the result shape", () => {
	assert.deepEqual(computeTax(150000, S), {
		totalCents: 10000 + 10000,
		perBracket: [
			{ upTo: 100000, rateBp: 1000, taxableCents: 100000, taxCents: 10000 },
			{ upTo: 400000, rateBp: 2000, taxableCents: 50000, taxCents: 10000 },
			{ upTo: null, rateBp: 3000, taxableCents: 0, taxCents: 0 },
		],
	});
	assert.deepEqual(computeTax(0, S).perBracket.map((b) => b.taxableCents), [0, 0, 0]);
	assert.equal(computeTax(0, S).totalCents, 0);
});

test("R6: no mutation, and exact arithmetic for large incomes", () => {
	const copy = JSON.stringify(S);
	computeTax(999999, S);
	assert.equal(JSON.stringify(S), copy);
	const frozen = S.map((b) => Object.freeze({ ...b }));
	assert.doesNotThrow(() => computeTax(999999, Object.freeze(frozen)));
	const big = 900719925474; // 9007199254740991 / 10000, rounded down
	const r = computeTax(big, [{ upTo: null, rateBp: 3333 }]);
	assert.equal(r.totalCents, 300209951160); // 900719925474 * 3333 / 10000 = 300209951160.4842
	const half = computeTax(900719925475, [{ upTo: null, rateBp: 5000 }]);
	assert.equal(half.totalCents, 450359962738); // 450359962737.5 -> 450359962738 (even)
	const half2 = computeTax(900719925473, [{ upTo: null, rateBp: 5000 }]);
	assert.equal(half2.totalCents, 450359962736); // 450359962736.5 -> 450359962736 (even)
});
