import assert from "node:assert/strict";
import { test } from "node:test";
import { findConflicts } from "../src/booking-conflicts.js";

test("finds an overlap in one room", () => {
	const bookings = [
		{ id: "b", room: "R1", start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z" },
		{ id: "a", room: "R1", start: "2026-03-01T09:30:00Z", end: "2026-03-01T11:00:00Z" },
	];
	assert.deepEqual(findConflicts(bookings), [["a", "b"]]);
});

test("different rooms do not conflict", () => {
	const bookings = [
		{ id: "a", room: "R1", start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z" },
		{ id: "b", room: "R2", start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z" },
	];
	assert.deepEqual(findConflicts(bookings), []);
});
