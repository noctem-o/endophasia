// ENDO-HIDDEN-MARKER-fetch-cache
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { createClient } = await import(new URL("src/client.js", WORK).href);

function setup(options = {}, responder = () => ({ status: 200, body: { n: 1 } })) {
	const calls = [];
	let time = 1000;
	const fetchImpl = async (url) => {
		calls.push(url);
		return responder(url, calls.length);
	};
	const client = createClient({ fetchImpl, now: () => time, ...options });
	return { client, calls, advance: (ms) => (time += ms) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

test("R1: ttlMs is validated, and 0 means no caching", async () => {
	for (const bad of [-1, 1.5, "100", NaN, Infinity, null])
		assert.throws(() => createClient({ fetchImpl: async () => ({ status: 200 }), ttlMs: bad }), RangeError, String(bad));
	assert.doesNotThrow(() => createClient({ fetchImpl: async () => ({ status: 200 }), ttlMs: 0 }));
	const { client, calls } = setup({ ttlMs: 0 });
	await client.get("http://x/a");
	await client.get("http://x/a");
	assert.equal(calls.length, 2);
	const defaulted = setup();
	await defaulted.client.get("http://x/a");
	await defaulted.client.get("http://x/a");
	assert.equal(defaulted.calls.length, 2);
});

test("R2: caching, expiry and fragments", async () => {
	const { client, calls, advance } = setup({ ttlMs: 100 });
	assert.deepEqual(await client.get("http://x/a#top"), { status: 200, body: { n: 1 } });
	assert.deepEqual(calls, ["http://x/a"]);
	advance(99);
	await client.get("http://x/a#bottom");
	await client.get("http://x/a");
	assert.equal(calls.length, 1);
	advance(1);
	await client.get("http://x/a");
	assert.equal(calls.length, 2);
	advance(99);
	await client.get("http://x/a");
	assert.equal(calls.length, 2);
	await client.get("http://x/b");
	assert.deepEqual(calls, ["http://x/a", "http://x/a", "http://x/b"]);
	assert.deepEqual(await client.get("http://x/c?q=1#f"), { status: 200, body: { n: 1 } });
	assert.equal(calls.at(-1), "http://x/c?q=1");
});

test("R2: the stamp is read after the fetch resolves", async () => {
	let time = 0;
	const calls = [];
	const client = createClient({
		ttlMs: 100,
		now: () => time,
		fetchImpl: async (url) => {
			calls.push(url);
			time += 60;
			return { status: 200, body: "x" };
		},
	});
	await client.get("http://x/a"); // stamped at 60
	time = 150;
	await client.get("http://x/a"); // 90 < 100: a hit
	assert.equal(calls.length, 1);
	time = 160;
	await client.get("http://x/a"); // 100 >= 100: expired
	assert.equal(calls.length, 2);
});

test("R3: only 2xx responses are stored, and errors are not", async () => {
	const statuses = { "http://x/ok": 200, "http://x/edge": 299, "http://x/no": 300, "http://x/lo": 199, "http://x/missing": 404, "http://x/boom": 500 };
	const { client, calls } = setup({ ttlMs: 1000 }, (url) => ({ status: statuses[url], body: url }));
	for (const url of Object.keys(statuses)) {
		const first = await client.get(url);
		assert.equal(first.status, statuses[url]);
		await client.get(url);
	}
	assert.equal(calls.filter((u) => u === "http://x/ok").length, 1);
	assert.equal(calls.filter((u) => u === "http://x/edge").length, 1);
	for (const url of ["http://x/no", "http://x/lo", "http://x/missing", "http://x/boom"]) assert.equal(calls.filter((u) => u === url).length, 2, url);
	let fail = true;
	const flaky = setup({ ttlMs: 1000 }, () => {
		if (fail) throw new Error("network down");
		return { status: 200, body: "fine" };
	});
	await assert.rejects(() => flaky.client.get("http://x/a"), /network down/);
	fail = false;
	assert.deepEqual(await flaky.client.get("http://x/a"), { status: 200, body: "fine" });
	assert.equal(flaky.calls.length, 2);
});

test("R4: calls in flight share one fetch", async () => {
	for (const ttlMs of [0, 1000]) {
		const gate = deferred();
		const calls = [];
		const client = createClient({
			ttlMs,
			now: () => 0,
			fetchImpl: (url) => {
				calls.push(url);
				return gate.promise;
			},
		});
		const a = client.get("http://x/a");
		const b = client.get("http://x/a#frag");
		const c = client.get("http://x/other");
		await tick();
		assert.equal(calls.length, 2);
		gate.resolve({ status: 200, body: "shared" });
		assert.deepEqual(await a, { status: 200, body: "shared" });
		assert.deepEqual(await b, { status: 200, body: "shared" });
		await c;
		await client.get("http://x/a");
		assert.equal(calls.length, ttlMs === 0 ? 3 : 2, `ttlMs ${ttlMs}`);
	}
	const gate = deferred();
	let n = 0;
	const client = createClient({ ttlMs: 1000, now: () => 0, fetchImpl: () => (++n === 1 ? gate.promise : Promise.resolve({ status: 200, body: "second" })) });
	const a = client.get("http://x/a");
	const b = client.get("http://x/a");
	gate.reject(new Error("first failed"));
	await assert.rejects(a, /first failed/);
	await assert.rejects(b, /first failed/);
	assert.deepEqual(await client.get("http://x/a"), { status: 200, body: "second" });
	assert.equal(n, 2);
});

test("R5: fresh bypasses the cache and replaces the entry", async () => {
	let version = 1;
	const { client, calls } = setup({ ttlMs: 1000 }, () => ({ status: 200, body: `v${version}` }));
	assert.equal((await client.get("http://x/a")).body, "v1");
	version = 2;
	assert.equal((await client.get("http://x/a")).body, "v1");
	assert.equal((await client.get("http://x/a", { fresh: true })).body, "v2");
	assert.equal((await client.get("http://x/a")).body, "v2");
	assert.equal(calls.length, 2);
	const gate = deferred();
	let n = 0;
	const slow = createClient({ ttlMs: 1000, now: () => 0, fetchImpl: () => (++n === 1 ? gate.promise : Promise.resolve({ status: 200, body: "fresh" })) });
	const first = slow.get("http://x/a");
	const second = slow.get("http://x/a", { fresh: true });
	await tick();
	assert.equal(n, 2);
	assert.equal((await second).body, "fresh");
	gate.resolve({ status: 200, body: "slow" });
	assert.equal((await first).body, "slow");
	let status = 200;
	const keep = setup({ ttlMs: 1000 }, () => ({ status, body: `s${status}` }));
	await keep.client.get("http://x/a");
	status = 500;
	assert.equal((await keep.client.get("http://x/a", { fresh: true })).status, 500);
	status = 200;
	assert.equal((await keep.client.get("http://x/a")).body, "s200");
	assert.equal(keep.calls.length, 2);
});

test("R6: clear and stats", async () => {
	const { client, calls, advance } = setup({ ttlMs: 100 });
	assert.deepEqual(client.stats(), { hits: 0, misses: 0, fetches: 0 });
	await client.get("http://x/a");
	await client.get("http://x/a");
	await client.get("http://x/b");
	assert.deepEqual(client.stats(), { hits: 1, misses: 2, fetches: 2 });
	client.clear("http://x/a#frag");
	await client.get("http://x/a");
	await client.get("http://x/b");
	assert.deepEqual(client.stats(), { hits: 2, misses: 3, fetches: 3 });
	client.clear();
	await client.get("http://x/a");
	await client.get("http://x/b");
	assert.equal(calls.length, 5);
	advance(100);
	await client.get("http://x/a");
	await client.get("http://x/a", { fresh: true });
	assert.deepEqual(client.stats(), { hits: 2, misses: 7, fetches: 7 });
	const snapshot = client.stats();
	snapshot.hits = 99;
	assert.equal(client.stats().hits, 2);
	const gate = deferred();
	const joined = createClient({ ttlMs: 100, now: () => 0, fetchImpl: () => gate.promise });
	const p1 = joined.get("http://x/a");
	const p2 = joined.get("http://x/a");
	joined.clear();
	await tick();
	assert.deepEqual(joined.stats(), { hits: 0, misses: 2, fetches: 1 });
	gate.resolve({ status: 200, body: "z" });
	await Promise.all([p1, p2]);
});

test("R7: returned responses are copies, and the URL check stays", async () => {
	const { client, calls } = setup({ ttlMs: 1000 });
	const first = await client.get("http://x/a");
	first.body.n = 99;
	first.status = 500;
	const second = await client.get("http://x/a");
	assert.deepEqual(second, { status: 200, body: { n: 1 } });
	second.body.n = 7;
	assert.deepEqual(await client.get("http://x/a"), { status: 200, body: { n: 1 } });
	assert.equal(calls.length, 1);
	const gate = deferred();
	const shared = createClient({ ttlMs: 0, now: () => 0, fetchImpl: () => gate.promise });
	const p1 = shared.get("http://x/a");
	const p2 = shared.get("http://x/a");
	gate.resolve({ status: 200, body: { list: [1] } });
	const [r1, r2] = await Promise.all([p1, p2]);
	r1.body.list.push(2);
	assert.deepEqual(r2.body.list, [1]);
	for (const bad of ["", null, undefined, 5, {}]) await assert.rejects(() => client.get(bad), TypeError, String(bad));
	assert.deepEqual(client.stats().fetches, 1);
	assert.throws(() => createClient({}), TypeError);
});
