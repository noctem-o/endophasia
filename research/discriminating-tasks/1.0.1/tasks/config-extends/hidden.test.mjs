// ENDO-HIDDEN-MARKER-config-extends
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { loadConfig } = await import(new URL("src/config.js", WORK).href);

function vfs(files) {
	const reads = [];
	const readFile = (path) => {
		reads.push(path);
		if (!(path in files)) throw new Error(`ENOENT ${path}`);
		const value = files[path];
		return typeof value === "string" ? value : JSON.stringify(value);
	};
	return { readFile, reads };
}

test("R1: names are resolved against the extending file and normalized", () => {
	const fs = vfs({
		"/etc/app/main.json": { extends: ["./base.json", "../shared//common.json", "/opt/abs.json"], own: 1 },
		"/etc/app/base.json": { a: 1 },
		"/etc/shared/common.json": { b: 2 },
		"/opt/abs.json": { c: 3 },
	});
	assert.deepEqual(loadConfig("/etc/app/../app/./main.json", fs), { a: 1, b: 2, c: 3, own: 1 });
	assert.deepEqual(fs.reads, ["/etc/app/main.json", "/etc/app/base.json", "/etc/shared/common.json", "/opt/abs.json"]);
	const single = vfs({ "conf/app.json": { extends: "base.json" }, "conf/base.json": { x: true } });
	assert.deepEqual(loadConfig("conf/app.json", single), { x: true });
	const relative = vfs({ "app.json": { extends: "sub/../base.json" }, "base.json": { y: 1 } });
	assert.deepEqual(loadConfig("./app.json", relative), { y: 1 });
	assert.deepEqual(relative.reads, ["app.json", "base.json"]);
	for (const bad of [5, [1], ["a.json", 2], {}, null, true]) {
		const f = vfs({ "/a.json": { extends: bad } });
		assert.throws(() => loadConfig("/a.json", f), (error) => error instanceof TypeError && error.message.includes("/a.json"), JSON.stringify(bad));
	}
	assert.deepEqual(loadConfig("/a.json", vfs({ "/a.json": { extends: [] , k: 1 } })), { k: 1 });
});

test("R2: order of merging, and extends is dropped", () => {
	const fs = vfs({
		"/m.json": { extends: ["/b1.json", "/b2.json"], k: "own", only: "m" },
		"/b1.json": { extends: "/root.json", k: "b1", one: 1, shared: "b1" },
		"/b2.json": { k: "b2", two: 2, shared: "b2" },
		"/root.json": { k: "root", deep: "root", root: 0 },
	});
	const result = loadConfig("/m.json", fs);
	assert.deepEqual(result, { k: "own", deep: "root", root: 0, one: 1, shared: "b2", two: 2, only: "m" });
	assert.equal("extends" in result, false);
	const plain = loadConfig("/p.json", vfs({ "/p.json": { a: 1 } }));
	assert.deepEqual(plain, { a: 1 });
});

test("R3: deep merge for objects, replacement for everything else", () => {
	const fs = vfs({
		"/m.json": {
			extends: "/b.json",
			obj: { y: { z2: 2 }, w: 9 },
			arr: [3],
			nul: null,
			str: { was: "string" },
			flip: "now a string",
			emptyObj: {},
		},
		"/b.json": {
			obj: { x: 1, y: { z1: 1, z2: 1 } },
			arr: [1, 2],
			nul: { still: "here" },
			str: "text",
			flip: { was: "object" },
			emptyObj: { keep: 1 },
			nu: 1,
		},
	});
	assert.deepEqual(loadConfig("/m.json", fs), {
		obj: { x: 1, y: { z1: 1, z2: 2 }, w: 9 },
		arr: [3],
		nul: null,
		str: { was: "string" },
		flip: "now a string",
		emptyObj: { keep: 1 },
		nu: 1,
	});
	const over = vfs({ "/m.json": { extends: "/b.json", v: null, list: { a: 1 } }, "/b.json": { v: 5, list: [1] } });
	assert.deepEqual(loadConfig("/m.json", over), { v: null, list: { a: 1 } });
	const nullOver = vfs({ "/m.json": { extends: "/b.json", v: { a: 1 } }, "/b.json": { v: null } });
	assert.deepEqual(loadConfig("/m.json", nullOver), { v: { a: 1 } });
	const shared = { deep: { n: 1 } };
	const a = loadConfig("/m.json", vfs({ "/m.json": { extends: ["/b.json", "/b.json"], deep: { m: 1 } }, "/b.json": shared }));
	assert.deepEqual(a, { deep: { n: 1, m: 1 } });
});

test("R4: cycles are errors, diamonds are not", () => {
	const message = (files, start) => {
		try {
			loadConfig(start, vfs(files));
		} catch (error) {
			assert.ok(error instanceof RangeError, String(error));
			return error.message;
		}
		assert.fail("did not throw");
	};
	assert.match(message({ "/a.json": { extends: "/b.json" }, "/b.json": { extends: "/a.json" } }, "/a.json"), /cycle.*\/a\.json -> \/b\.json -> \/a\.json/);
	assert.match(message({ "/a.json": { extends: "/a.json" } }, "/a.json"), /cycle.*\/a\.json -> \/a\.json/);
	assert.match(message({ "/a.json": { extends: "/b.json" }, "/b.json": { extends: "/c.json" }, "/c.json": { extends: "/b.json" } }, "/a.json"), /cycle.*\/b\.json -> \/c\.json -> \/b\.json/);
	assert.match(message({ "d/a.json": { extends: "../d/./a.json" } }, "d/a.json"), /cycle.*d\/a\.json -> d\/a\.json/);
	const diamond = vfs({
		"/a.json": { extends: ["/b.json", "/c.json"] },
		"/b.json": { extends: "/d.json", b: 1 },
		"/c.json": { extends: "/d.json", c: 1 },
		"/d.json": { d: 1 },
	});
	assert.deepEqual(loadConfig("/a.json", diamond), { d: 1, b: 1, c: 1 });
});

test("R5: invalid JSON and non-object JSON name the file", () => {
	const fs = vfs({ "/m.json": { extends: ["/ok.json", "/bad.json"] }, "/ok.json": {}, "/bad.json": "{not json" });
	assert.throws(() => loadConfig("/m.json", fs), (e) => e instanceof SyntaxError && e.message.includes("/bad.json"));
	assert.throws(() => loadConfig("/bad.json", fs), (e) => e instanceof SyntaxError && e.message.includes("/bad.json"));
	for (const text of ["[1]", '"s"', "null", "5", "true"]) {
		const f = vfs({ "/m.json": { extends: "/x.json" }, "/x.json": text });
		assert.throws(() => loadConfig("/m.json", f), (e) => e instanceof TypeError && e.message.includes("/x.json"), text);
		assert.throws(() => loadConfig("/x.json", f), (e) => e instanceof TypeError && e.message.includes("/x.json"), text);
	}
	const missing = vfs({ "/m.json": { extends: "/gone.json" } });
	assert.throws(() => loadConfig("/m.json", missing), (e) => e.message === "ENOENT /gone.json" && !(e instanceof SyntaxError));
	const boom = new Error("disk on fire");
	assert.throws(() => loadConfig("/m.json", { readFile: () => { throw boom; } }), (e) => e === boom);
	assert.throws(() => loadConfig("", vfs({})), TypeError);
	assert.throws(() => loadConfig("/m.json", {}), TypeError);
});

test("R6: each file is read at most once", () => {
	const fs = vfs({
		"/a.json": { extends: ["/b.json", "/c.json", "/d.json"] },
		"/b.json": { extends: "/d.json" },
		"/c.json": { extends: ["/d.json", "/b.json"] },
		"/d.json": { d: 1 },
	});
	loadConfig("/a.json", fs);
	assert.deepEqual([...fs.reads].sort(), ["/a.json", "/b.json", "/c.json", "/d.json"]);
});

test("R7: __proto__ is plain data", () => {
	const fs = vfs({
		"/m.json": '{"extends":"/b.json","__proto__":{"own":1},"x":1}',
		"/b.json": '{"__proto__":{"polluted":true,"own":0},"nested":{"__proto__":{"deep":true}}}',
	});
	const result = loadConfig("/m.json", fs);
	assert.equal(Object.getPrototypeOf(result), Object.prototype);
	assert.equal(Object.hasOwn(result, "__proto__"), true);
	assert.deepEqual(Object.getOwnPropertyDescriptor(result, "__proto__").value, { polluted: true, own: 1 });
	assert.equal(result.polluted, undefined);
	assert.equal({}.polluted, undefined);
	assert.equal({}.deep, undefined);
	assert.equal(result.x, 1);
	const nested = Object.getOwnPropertyDescriptor(result.nested, "__proto__");
	assert.deepEqual(nested.value, { deep: true });
	assert.equal(Object.getPrototypeOf(result.nested), Object.prototype);
});
