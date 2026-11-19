import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { declaredObjectFormat, readPackedRefs, verifyCapture } from "../research/develop-verify-trust-004/reanalyze.ts";

const files = [
	"principals.txt",
	"listing.txt",
	"ancestors.txt",
	"state.tar",
	"install.tar",
	"repos-availability.tar",
	"repos-installed-1.tar",
	"repos-installed-2.tar",
	"acl.txt",
];
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string;
let source: string;
let verified: string;
const manifest = (names: string[]) => names.map((name) => `${digest(name)}  ${name}\n`).join("");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dvt004-offline-test-"));
	source = join(root, "source");
	verified = join(root, "verified");
	mkdirSync(source);
	mkdirSync(verified);
	for (const file of files) writeFileSync(join(source, file), file);
	writeFileSync(join(source, "SHA256SUMS"), manifest(files));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("uses only verified copies for analysis and reports the digest of the manifest checked", () => {
	expect(verifyCapture(source, verified)).toEqual({
		repoArchives: ["repos-availability.tar", "repos-installed-1.tar", "repos-installed-2.tar"],
		preManifestSha256: digest(manifest(files)),
	});
	writeFileSync(join(source, "repos-installed-1.tar"), "changed after verification");
	expect(readFileSync(join(verified, "repos-installed-1.tar"), "utf8")).toBe("repos-installed-1.tar");
	expect(readdirSync(verified).sort()).toEqual(files.filter((n) => n !== "acl.txt").sort());
});

it("rejects an injected extra tar before extraction", () => {
	writeFileSync(join(source, "repos-extra.tar"), Buffer.alloc(1024));
	expect(() => verifyCapture(source, verified)).toThrow("repos-extra.tar absent from manifest");
	expect(readdirSync(verified)).toEqual([]);
});

it("requires both installed repositories even when an archive and its entry are both missing", () => {
	rmSync(join(source, "repos-installed-2.tar"));
	writeFileSync(join(source, "SHA256SUMS"), manifest(files.filter((n) => n !== "repos-installed-2.tar")));
	expect(() => verifyCapture(source, verified)).toThrow("repos-installed-2.tar absent from manifest");
});

it.each(files.filter((name) => name !== "acl.txt"))("rejects an unlisted %s before staging anything", (omitted) => {
	writeFileSync(join(source, "SHA256SUMS"), manifest(files.filter((name) => name !== omitted)));
	expect(() => verifyCapture(source, verified)).toThrow(`${omitted} absent from manifest`);
	expect(readdirSync(verified)).toEqual([]);
});

it.each(["../outside", "sub/path", "state.tar"])("rejects an unsafe or duplicate manifest name: %s", (name) => {
	writeFileSync(join(source, "SHA256SUMS"), manifest([...files, name]));
	expect(() => verifyCapture(source, verified)).toThrow("invalid pre-read capture manifest");
});

it("checks even listed files that the analyzer does not consume", () => {
	writeFileSync(join(source, "acl.txt"), "different");
	expect(() => verifyCapture(source, verified)).toThrow("acl.txt does not match its manifest");
});

it("treats missing packed refs as optional and reads ordinary packed refs", () => {
	const path = join(root, "packed-refs");
	expect(readPackedRefs(path)).toBe("");
	writeFileSync(path, "regular contents");
	expect(readPackedRefs(path)).toBe("regular contents");
});

it("refuses to follow a packed-refs symlink", () => {
	const path = join(root, "packed-refs");
	symlinkSync(join(source, "listing.txt"), path);
	expect(() => readPackedRefs(path)).toThrow(expect.objectContaining({ code: "ELOOP" }));
});

it("rejects a nonregular packed-refs descriptor without waiting for a writer", () => {
	const path = join(root, "packed-refs");
	expect(spawnSync("mkfifo", [path]).status).toBe(0);
	const module = new URL("../research/develop-verify-trust-004/reanalyze.ts", import.meta.url);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { readPackedRefs } from ${JSON.stringify(module.href)}; readPackedRefs(process.argv[1]);`,
			path,
		],
		{
			timeout: 5000,
			encoding: "utf8",
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(`not a regular file: ${path}`);
});

it.each([
	["no extension", "[core]\n\trepositoryformatversion = 0\n\tbare = false\n", "sha1"],
	["sha1 extension", "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha1\n", "sha1"],
	[
		"sha256 extension",
		"[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256 # comment\n",
		"sha256",
	],
	["key on the section line", "[core] repositoryformatversion = 1\n[extensions] objectformat = sha256\n", "sha256"],
	[
		"subsection keys ignored",
		'[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n[extensions "x"]\n\tobjectformat = sha1\n',
		"sha256",
	],
])("reads the declared object format: %s", (_, config, format) => {
	expect(declaredObjectFormat(config)).toBe(format);
});

it.each([
	["missing version", "[extensions]\n\tobjectformat = sha256\n", "version missing"],
	[
		"repeated version",
		"[core]\n\trepositoryformatversion = 1\n\trepositoryformatversion = 1\n",
		"version missing, repeated",
	],
	["unknown version", "[core]\n\trepositoryformatversion = 2\n", "unknown"],
	[
		"extension in version 0",
		"[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectformat = sha256\n",
		"version 0",
	],
	[
		"repeated format",
		"[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n\tobjectformat = sha256\n",
		"repeated",
	],
	[
		"unknown format",
		"[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = md5\n",
		"unknown object format",
	],
	["quoted value", '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = "sha256"\n', "malformed"],
	["include", "[core]\n\trepositoryformatversion = 1\n[include]\n\tpath = /elsewhere\n", "include"],
	["includeIf", '[core]\n\trepositoryformatversion = 1\n[includeIf "gitdir:/"]\n\tpath = x\n', "include"],
	["continuation", "[core]\n\trepositoryformatversion = 1\n\tx = a \\\n[extensions]\n", "continuation"],
	["unparsable section", "[core\n\trepositoryformatversion = 1\n", "malformed config section"],
])("refuses malformed format metadata: %s", (_, config, message) => {
	expect(() => declaredObjectFormat(config)).toThrow(message);
});
