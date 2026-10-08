import { describe, expect, it, vi } from "vitest";
import { announceEndoRootV0, takeEndoRootV0 } from "../cli/root-args.ts";

const env = { ENDO_STORE_ROOT: "/data/endo" };

describe("takeEndoRootV0", () => {
	it("takes a positional root, a named root, or the default", () => {
		expect(takeEndoRootV0(["/r", "--limit", "2"], 0, new Set(), env)).toMatchObject({
			root: "/r",
			rest: ["--limit", "2"],
		});
		expect(takeEndoRootV0(["--root", "/r", "--limit", "2"], 0, new Set(), env)).toMatchObject({
			root: "/r",
			rest: ["--limit", "2"],
		});
		expect(takeEndoRootV0(["--limit", "2", "--root", "/r"], 0, new Set(), env)).toMatchObject({
			root: "/r",
			rest: ["--limit", "2"],
		});
		expect(takeEndoRootV0([], 0, new Set(), env)).toMatchObject({ root: "/data/endo", rest: [] });
		expect(takeEndoRootV0(["--limit", "2"], 0, new Set(), env)).toMatchObject({
			root: "/data/endo",
			rest: ["--limit", "2"],
		});
	});

	it("counts the command's own positionals before deciding whether a root was given", () => {
		expect(takeEndoRootV0(["file.json"], 1, new Set(), env)).toMatchObject({
			root: "/data/endo",
			rest: ["file.json"],
		});
		expect(takeEndoRootV0(["/r", "file.json"], 1, new Set(), env)).toMatchObject({ root: "/r", rest: ["file.json"] });
		expect(takeEndoRootV0(["--root", "/r", "file.json"], 1, new Set(), env)).toMatchObject({
			root: "/r",
			rest: ["file.json"],
		});
	});

	it("refuses a root named twice, a repeated or valueless --root", () => {
		expect(() => takeEndoRootV0(["/a", "--root", "/b"], 0, new Set(), env)).toThrow(/given twice/);
		// --root first: the leading positionals after it are still classified
		expect(() => takeEndoRootV0(["--root", "/a", "/b", "proposal", "--x", "1"], 1, new Set(), env)).toThrow(
			/given twice/,
		);
		expect(() => takeEndoRootV0(["--root", "/a", "/b", "--x", "1"], 0, new Set(), env)).toThrow(/given twice/);
		expect(() => takeEndoRootV0(["/a", "file", "--root", "/b"], 1, new Set(), env)).toThrow(/given twice/);
		expect(() => takeEndoRootV0(["--root", "/a", "--root", "/b"], 0, new Set(), env)).toThrow(/more than once/);
		expect(() => takeEndoRootV0(["--root"], 0, new Set(), env)).toThrow(/needs a value/);
		expect(() => takeEndoRootV0(["--root", "--limit"], 0, new Set(), env)).toThrow(/needs a value/);
	});

	it("reports the default store as a note, only when it chose one, and prints it only when announced", () => {
		expect(takeEndoRootV0(["/r"], 0, new Set(), env).defaultNote).toBeNull();
		expect(takeEndoRootV0([], 0, new Set(), env).defaultNote).toBe(
			"using the default store /data/endo (ENDO_STORE_ROOT)",
		);
		const written: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
			written.push(String(text));
			return true;
		});
		try {
			takeEndoRootV0([], 0, new Set(), env); // taking the root announces nothing by itself
			expect(written).toEqual([]);
			announceEndoRootV0(takeEndoRootV0([], 0, new Set(), env));
			expect(written).toEqual(["using the default store /data/endo (ENDO_STORE_ROOT)\n"]);
		} finally {
			spy.mockRestore();
		}
	});

	it("refuses an empty root, named or positional", () => {
		expect(() => takeEndoRootV0(["--root", ""], 0, new Set(), env)).toThrow(/empty/);
		expect(() => takeEndoRootV0(["", "--limit", "1"], 0, new Set(), env)).toThrow(/empty/);
	});

	it("does not read an option's value as --root", () => {
		const flags = new Set(["--prompt"]);
		expect(takeEndoRootV0(["/r", "--prompt", "--root"], 0, flags, env)).toMatchObject({
			root: "/r",
			rest: ["--prompt", "--root"],
		});
		expect(takeEndoRootV0(["--prompt", "--root", "--root", "/s"], 0, flags, env)).toMatchObject({
			root: "/s",
			rest: ["--prompt", "--root"],
		});
	});

	it("refuses to guess a default when none can be resolved", () => {
		expect(() => takeEndoRootV0([], 0, new Set(), {})).toThrow(/no store location/);
	});
});
