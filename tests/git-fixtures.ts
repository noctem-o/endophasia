// Real, throwaway Git repositories for the project-context tests. Git runs with no user or system configuration, so a developer's own
// settings cannot change a fixture, and every repository is made under one temporary directory that `cleanGitFixtures` removes.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];

export const gitEnv = (): NodeJS.ProcessEnv => ({
	PATH: process.env.PATH,
	GIT_CONFIG_GLOBAL: devNull,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	GIT_TERMINAL_PROMPT: "0",
});

export const haveGit = ((): boolean => {
	try {
		execFileSync("git", ["--version"], { env: gitEnv(), stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A directory that exists only for this test run. */
export function fixtureDir(name = "work"): string {
	if (roots.length === 0 || roots[0] === undefined)
		roots.push(realpathSync(mkdtempSync(join(tmpdir(), "endo-git-fixture-"))));
	const dir = join(roots[0] as string, `${name}-${roots.length}`);
	roots.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function write(root: string, path: string, content: string | Buffer, mode?: number): string {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	if (mode !== undefined) chmodSync(full, mode);
	return full;
}

/** A repository on branch `main` with one commit: `a.txt` (three lines), `old.txt`, `gone.txt`, `bin.dat`, `src/deep/file.ts`. */
export function commitedRepo(): string {
	const root = fixtureDir("repo");
	git(root, "init", "-q", "-b", "main");
	write(root, "a.txt", "one\ntwo\nthree\n");
	write(root, "old.txt", "renamed content that is long enough to be recognised\nsecond line\nthird line\n");
	write(root, "gone.txt", "del\n");
	write(root, "bin.dat", Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
	write(root, "src/deep/file.ts", "export const x = 1;\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
	return root;
}

/** The commited repository, then: a.txt staged and changed again, old.txt renamed (staged), gone.txt deleted, bin.dat changed, one untracked. */
export function dirtyRepo(): string {
	const root = commitedRepo();
	git(root, "mv", "old.txt", "new.txt");
	write(root, "a.txt", "one\nTWO\nthree\nfour\n");
	git(root, "add", "a.txt");
	write(root, "a.txt", "one\nTWO\nthree\nfour\nfive\n");
	rmSync(join(root, "gone.txt"));
	write(root, "bin.dat", Buffer.from([0, 1, 2, 3, 0, 255, 0, 8, 9]));
	write(root, "un tracked.txt", "u1\nu2\n");
	return root;
}

export function cleanGitFixtures(): void {
	const [first] = roots;
	roots.length = 0;
	if (first !== undefined) rmSync(first, { recursive: true, force: true });
}

/**
 * A believable project for screenshots and browser tests: synthetic code only. Staged, unstaged and untracked changes, a file changed in
 * both the index and the working tree, a rename, a deletion, a binary file, a very long path, and a long file to scroll.
 */
export function demoRepo(): string {
	const root = fixtureDir("endophasia-demo");
	git(root, "init", "-q", "-b", "main");
	const lines = (n: number, tag: string) =>
		Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n");
	write(
		root,
		"src/parser/tokenizer.ts",
		`// Reads the whole input before it yields a token.\nexport function tokenize(input: string): string[] {\n\tconst tokens: string[] = [];\n\tlet current = "";\n\tfor (const ch of input) {\n\t\tif (ch === " ") {\n\t\t\tif (current) tokens.push(current);\n\t\t\tcurrent = "";\n\t\t} else current += ch;\n\t}\n\tif (current) tokens.push(current);\n\treturn tokens;\n}\n`,
	);
	write(
		root,
		"src/parser/index.ts",
		`import { tokenize } from "./tokenizer";\n\nexport function parse(input: string) {\n\treturn tokenize(input);\n}\n`,
	);
	write(
		root,
		"tests/parser.test.ts",
		`import { parse } from "../src/parser";\n\ntest("parses words", () => {\n\texpect(parse("a b")).toEqual(["a", "b"]);\n});\n`,
	);
	write(
		root,
		"docs/old-name.md",
		"# Parser\n\nThe parser reads a string and returns tokens.\nIt keeps the API small.\nIt has no streaming mode.\n\n## Usage\n\nCall parse with a string.\nThe result is an array of words.\nEmpty input gives an empty array.\n",
	);
	write(root, "src/legacy/unused.ts", "export const unused = 1;\n");
	write(root, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
	write(root, "src/generated/table.ts", `${lines(180, "row")}\n`);
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "initial parser");

	// staged: a rename with edits, an API change, a test
	git(root, "mv", "docs/old-name.md", "docs/streaming.md");
	write(
		root,
		"docs/streaming.md",
		"# Parser\n\nThe parser reads a string and returns tokens.\nIt keeps the API small.\nIt also streams: see parseStream.\n\n## Usage\n\nCall parse with a string.\nThe result is an array of words.\nEmpty input gives an empty array.\n",
	);
	write(
		root,
		"src/parser/index.ts",
		`import { tokenize, tokenizeStream } from "./tokenizer";\n\nexport function parse(input: string) {\n\treturn tokenize(input);\n}\n\nexport function* parseStream(chunks: Iterable<string>) {\n\tyield* tokenizeStream(chunks);\n}\n`,
	);
	write(
		root,
		"tests/parser.test.ts",
		`import { parse, parseStream } from "../src/parser";\n\ntest("parses words", () => {\n\texpect(parse("a b")).toEqual(["a", "b"]);\n});\n\ntest("streams words split across chunks", () => {\n\texpect([...parseStream(["a", "b c"])]).toEqual(["ab", "c"]);\n});\n`,
	);
	git(root, "add", "docs/streaming.md", "src/parser/index.ts", "tests/parser.test.ts");

	// unstaged: the tokenizer, and the test again; a deletion; a binary change; a long generated file edited in two places
	write(
		root,
		"src/parser/tokenizer.ts",
		`// Reads the whole input before it yields a token.\nexport function tokenize(input: string): string[] {\n\treturn [...tokenizeStream([input])];\n}\n\n// Pulls chunks from an iterator and yields each token as soon as it is complete.\nexport function* tokenizeStream(chunks: Iterable<string>): Generator<string> {\n\tlet current = "";\n\tfor (const chunk of chunks) {\n\t\tfor (const ch of chunk) {\n\t\t\tif (ch === " ") {\n\t\t\t\tif (current) yield current;\n\t\t\t\tcurrent = "";\n\t\t\t} else current += ch;\n\t\t}\n\t}\n\tif (current) yield current;\n}\n`,
	);
	write(
		root,
		"tests/parser.test.ts",
		`import { parse, parseStream } from "../src/parser";\n\ntest("parses words", () => {\n\texpect(parse("a b")).toEqual(["a", "b"]);\n});\n\ntest("streams words split across chunks", () => {\n\texpect([...parseStream(["a", "b c"])]).toEqual(["ab", "c"]);\n});\n\ntest("an empty stream yields nothing", () => {\n\texpect([...parseStream([])]).toEqual([]);\n});\n`,
	);
	rmSync(join(root, "src/legacy/unused.ts"));
	write(root, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 255, 1]));
	write(
		root,
		"src/generated/table.ts",
		`${lines(180, "row").replace("row3 = 3", "row3 = 33").replace("row150 = 150", "row150 = 1500")}\n`,
	);

	// untracked
	write(
		root,
		"src/parser/stream.ts",
		`import { tokenizeStream } from "./tokenizer";\n\nexport const streamTokens = (chunks: Iterable<string>) => tokenizeStream(chunks);\n`,
	);
	write(
		root,
		"src/very/long/directory/structure/for/testing/truncation/of/paths/in/the/changes/list/component-with-a-rather-long-file-name.ts",
		"export {};\n",
	);
	return root;
}
