import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../src/client.js";

test("get returns status and body", async () => {
	const client = createClient({ fetchImpl: async () => ({ status: 200, body: "hi", extra: 1 }) });
	assert.deepEqual(await client.get("http://x/a"), { status: 200, body: "hi" });
});

test("get rejects a bad url and a missing fetchImpl", async () => {
	const client = createClient({ fetchImpl: async () => ({ status: 200, body: "" }) });
	await assert.rejects(() => client.get(""), TypeError);
	assert.throws(() => createClient({}), TypeError);
});
