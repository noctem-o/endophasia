import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTicket, encodeTicket } from "../src/ticket-code.js";

test("encodes the example from the rules", () => {
	assert.equal(encodeTicket({ venue: 7, row: 28, seat: 12 }), "V07-AB-012-G");
	assert.equal(encodeTicket({ venue: 1, row: 1, seat: 1 }), "V01-A-001-A");
});

test("decodes it back", () => {
	assert.deepEqual(decodeTicket("V07-AB-012-G"), { venue: 7, row: 28, seat: 12 });
});
