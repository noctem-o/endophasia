import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const files = {
	"app.json": '{"name":"app","debug":true}',
	"list.json": "[1,2]",
};
const readFile = (path) => {
	if (!(path in files)) throw new Error(`ENOENT ${path}`);
	return files[path];
};

test("loads a plain config", () => {
	assert.deepEqual(loadConfig("app.json", { readFile }), { name: "app", debug: true });
});

test("rejects a config that is not an object", () => {
	assert.throws(() => loadConfig("list.json", { readFile }), TypeError);
	assert.throws(() => loadConfig("missing.json", { readFile }), /ENOENT/);
});
