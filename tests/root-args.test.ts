import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { takeEndoRootV0 } from "../cli/root-args.ts";

const quiet = () => {};
const env = { ENDO_STORE_ROOT: "/data/endo" };

describe("takeEndoRootV0", () => {
	it("takes a positional root, a named root, or the default", () => {
		expect(takeEndoRootV0(["/r", "--limit", "2"], 0, env, quiet)).toEqual({ root: "/r", rest: ["--limit", "2"] });
		expect(takeEndoRootV0(["--root", "/r", "--limit", "2"], 0, env, quiet)).toEqual({
			root: "/r",
			rest: ["--limit", "2"],
		});
		expect(takeEndoRootV0(["--limit", "2", "--root", "/r"], 0, env, quiet)).toEqual({
			root: "/r",
			rest: ["--limit", "2"],
		});
		expect(takeEndoRootV0([], 0, env, quiet)).toEqual({ root: "/data/endo", rest: [] });
		expect(takeEndoRootV0(["--limit", "2"], 0, env, quiet)).toEqual({ root: "/data/endo", rest: ["--limit", "2"] });
	});

	it("counts the command's own positionals before deciding whether a root was given", () => {
		expect(takeEndoRootV0(["file.json"], 1, env, quiet)).toEqual({ root: "/data/endo", rest: ["file.json"] });
		expect(takeEndoRootV0(["/r", "file.json"], 1, env, quiet)).toEqual({ root: "/r", rest: ["file.json"] });
		expect(takeEndoRootV0(["--root", "/r", "file.json"], 1, env, quiet)).toEqual({ root: "/r", rest: ["file.json"] });
	});

	it("refuses a root named twice, a repeated or valueless --root", () => {
		expect(() => takeEndoRootV0(["/a", "--root", "/b"], 0, env, quiet)).toThrow(/given twice/);
		expect(() => takeEndoRootV0(["/a", "file", "--root", "/b"], 1, env, quiet)).toThrow(/given twice/);
		expect(() => takeEndoRootV0(["--root", "/a", "--root", "/b"], 0, env, quiet)).toThrow(/more than once/);
		expect(() => takeEndoRootV0(["--root"], 0, env, quiet)).toThrow(/needs a value/);
		expect(() => takeEndoRootV0(["--root", "--limit"], 0, env, quiet)).toThrow(/needs a value/);
	});

	it("says which default store it used, only when it used one", () => {
		const lines: string[] = [];
		takeEndoRootV0(["/r"], 0, env, (line) => lines.push(line));
		expect(lines).toEqual([]);
		takeEndoRootV0([], 0, env, (line) => lines.push(line));
		expect(lines).toEqual(["using the default store /data/endo (ENDO_STORE_ROOT)"]);
	});

	it("refuses to guess a default when none can be resolved", () => {
		expect(() => takeEndoRootV0([], 0, {}, quiet)).toThrow(/no store location/);
	});
});
