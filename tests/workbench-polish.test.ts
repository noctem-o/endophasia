// Workbench polish after the first real-task session (2026-11-11): the reasoning reveal's rule, and the not-clean refusal of
// `endo attempt check` naming what is uncommitted and how to commit it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { revealFrom, safeCut } from "../studio-ui/src/model/reveal.ts";
import { git, haveGit } from "./git-fixtures.ts";

describe("the reasoning reveal decides only how fast read text appears, never what", () => {
	it("reveals only an extension of what was shown, while it is still being written, with motion allowed", () => {
		expect(revealFrom("The plan", 8, "The plan is to", true, false)).toBe(8);
		// Not still being written, or reduced motion: drawn at once.
		expect(revealFrom("The plan", 8, "The plan is to", false, false)).toBeNull();
		expect(revealFrom("The plan", 8, "The plan is to", true, true)).toBeNull();
		// Replaced rather than extended, or not longer: drawn at once.
		expect(revealFrom("The plan", 8, "Another plan entirely", true, false)).toBeNull();
		expect(revealFrom("The plan", 8, "The plan", true, false)).toBeNull();
		// A reveal in progress continues from where it was drawn to.
		expect(revealFrom("The plan is", 5, "The plan is to", true, false)).toBe(5);
		// A very large block is drawn at once.
		expect(revealFrom("a", 1, `a${"b".repeat(5000)}`, true, false)).toBeNull();
	});

	it("never cuts a character in two", () => {
		const text = "a😀b";
		expect(safeCut(text, 2)).toBe(1);
		expect(safeCut(text, 3)).toBe(3);
		expect(safeCut(text, 99)).toBe(text.length);
		expect(safeCut(text, -1)).toBe(0);
	});
});

describe.skipIf(!haveGit)(
	"a check refused on an uncommitted tree says what is uncommitted and how to commit it",
	() => {
		const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
		const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-polish-")));
		afterAll(() => rmSync(base, { recursive: true, force: true }));
		const HOME = join(base, "home");
		mkdirSync(HOME);
		const endo = (cwd: string, args: string[]) =>
			spawnSync(process.execPath, [CLI, ...args], {
				cwd,
				encoding: "utf8",
				env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config") },
				timeout: 60_000,
			});

		it("lists the untracked file and the commands, and still runs and records nothing", () => {
			const root = join(base, "store");
			const repo = join(base, "repo");
			mkdirSync(repo);
			git(repo, "init", "-q", "-b", "main");
			writeFileSync(join(repo, "README.md"), "x\n");
			git(repo, "add", ".");
			git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "start");
			const id = (out: string, kind: string) =>
				out.match(new RegExp(`endo\\.${kind}\\.[0-9a-f]{32}`))?.[0] as string;
			const P = id(endo(repo, ["project", "add", "--root", root, "--name", "R", "--path", repo]).stdout, "project");
			const T = id(endo(repo, ["task", "add", "--root", root, "--project", P, "--title", "T"]).stdout, "task");
			const A = id(
				endo(repo, ["attempt", "prepare", "--root", root, "--project", P, "--task", T, "--objective", "x"]).stdout,
				"attempt",
			);
			writeFileSync(join(repo, "index.html"), "<p>hi</p>\n");
			const refused = endo(repo, ["attempt", "check", "--root", root, "--attempt", A, "--", "node", "--version"]);
			expect(refused.status).toBe(2);
			expect(refused.stderr).toContain("Nothing was run and nothing was recorded.");
			expect(refused.stderr).toContain(`Not committed in ${repo}`);
			expect(refused.stderr).toContain("  ?? index.html");
			expect(refused.stderr).toContain(
				`git -C ${JSON.stringify(repo)} add -A && git -C ${JSON.stringify(repo)} commit -m "<message>"`,
			);
		});
	},
);
