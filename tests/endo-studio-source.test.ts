// Rules on the source of the Studio command and its packaging, held where a regression would otherwise pass every behavioural test:
// that ordinary commands never load HTTP or the browser page, that the command's modules import only what they should, that the access
// address has exactly one place it can be printed, that nothing here ends the process before it has cleaned up, and that the package
// keeps its conventions (one binary, `dist/`, no runtime dependency, the page built after the build empties `dist/`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENDO_USAGE_LINE_V0, endoHelpV0, endoStudioHelpV0 } from "../cli/help.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const staticImports = (source: string) =>
	[...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map((m) => m[1]!);
const dynamicImports = (source: string) =>
	[...code(source).matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);

describe("what loads when", () => {
	it("the command table loads Studio lazily: cli/index.ts has no static import of it, and one dynamic import", () => {
		const index = read("cli/index.ts");
		expect(staticImports(index).filter((s) => /studio|cockpit/.test(s))).toEqual([]);
		expect(dynamicImports(index)).toEqual(["./studio.ts"]);
	});

	it("Studio loads HTTP and the cockpit library lazily too: its static imports are small, and the host is imported after validation", () => {
		const studio = read("cli/studio.ts");
		expect(staticImports(studio).sort()).toEqual(
			["./help.ts", "./root-args.ts", "node:fs", "node:path", "node:url"].sort(),
		);
		expect(dynamicImports(studio)).toEqual(["../cockpit-http/host.ts"]);
		const body = code(studio);
		// ...and only after the arguments were parsed and the page's directory found.
		expect(body.indexOf("parseEndoStudioArgsV0(argv)")).toBeLessThan(
			body.indexOf('import("../cockpit-http/host.ts")'),
		);
		expect(body.indexOf("endoStudioUiDirectoryV0()")).toBeLessThan(body.indexOf('import("../cockpit-http/host.ts")'));
	});

	it("the help module stays pure: it imports only what it needs to read the version", () => {
		expect(staticImports(read("cli/help.ts")).sort()).toEqual(["node:fs", "node:path", "node:url"].sort());
	});
});

describe("the command and the host end nothing early and say nothing they should not", () => {
	it("neither Studio nor the host calls process.exit, so cleanup is never bypassed (cli/index.ts, which ends a failed command, may)", () => {
		for (const file of ["cli/studio.ts", "cockpit-http/host.ts", "cockpit-http/launch.ts"])
			expect(code(read(file)), file).not.toMatch(/process\.exit\b/);
	});

	it("the access address has one place it can be printed: a single read of baseUrl, written to stdout", () => {
		for (const file of ["cli/studio.ts", "cockpit-http/launch.ts"]) {
			const body = code(read(file));
			expect(body.match(/baseUrl/g), file).toHaveLength(1);
			expect(body, file).toMatch(/process\.stdout\.write\(`[^`]*\$\{server\.baseUrl\}\/\\n`\)/);
		}
		for (const file of ["cli/studio.ts", "cockpit-http/host.ts", "cockpit-http/launch.ts"]) {
			const body = code(read(file));
			expect(body, file).not.toMatch(/console\./);
			expect(body, file).not.toMatch(/\.capability|stack\b|inspect\(/);
		}
	});

	it("Studio writes its notes to stderr before it writes the address to stdout, so a reader that has the address has the notes", () => {
		const body = code(read("cli/studio.ts"));
		const note = body.indexOf("private to this launch");
		const address = body.indexOf("process.stdout.write(`Endophasia Studio");
		expect(note).toBeGreaterThan(-1);
		expect(address).toBeGreaterThan(note);
	});

	it("an error from starting is turned into a fixed sentence or this program's own validation message, never the raw error", () => {
		const studio = code(read("cli/studio.ts"));
		expect(studio).toMatch(/throw new Error\(startupFailure\(error, args\.port\)\)/);
		expect(studio).not.toMatch(/String\(error\)|error\.stack|\$\{error\}/);
		// The only raw message passed on is a TypeError's, which the host and the server write as fixed validation sentences.
		expect(studio).toMatch(/error instanceof TypeError\) return `studio: \$\{error\.message\}`/);
	});

	it("the host reads no environment, starts no process or timer and writes no file itself", () => {
		const host = code(read("cockpit-http/host.ts"));
		expect(host).not.toMatch(/process\.env|child_process|spawn|setTimeout|setInterval|setImmediate/);
		expect(host).not.toMatch(/writeFile|appendFile|mkdir|unlink|\brm\(|rename|copyFile/);
	});

	it("the server is untouched by the launcher work: it still imports only what it did and exposes no listen address option", () => {
		const server = code(read("cockpit-http/server.ts"));
		expect(server).not.toMatch(/\bhost\??:\s*string|options\.host|listen\([^)]*options/);
		expect(server).toMatch(/server\.listen\(\{ host: LOOPBACK, port \}/);
	});
});

describe("what the user is told", () => {
	it("endo --help describes Studio as a long-running command, with its two exceptions, and the usage line lists it", () => {
		expect(ENDO_USAGE_LINE_V0).toMatch(/\|studio\|/);
		const help = endoHelpV0();
		expect(help).toMatch(/Interactive, read-only with respect to the store \(long-running/);
		expect(help).toMatch(/studio \[<root>\] \[--root dir\] \[--port n\] \[--key-file path\]/);
		expect(help).toMatch(/Prints a human line, not a JSON document/);
		expect(help).toMatch(/the first launch creates its own digest key/);
		expect(help).toMatch(/for "studio", also invalid arguments/);
		// The read-only section promises no key is created; Studio is not in it.
		const readOnly = help.slice(help.indexOf("Read-only inspection"), help.indexOf("Interactive, read-only"));
		expect(readOnly).not.toMatch(/studio/);
	});

	it("endo studio --help says what it shows and does not, the loopback binding, the key side effect, the secret address and the exit codes", () => {
		const help = endoStudioHelpV0();
		for (const phrase of [
			/127\.0\.0\.1 only/,
			/single read-only observation page/,
			/does not yet implement the other modes/,
			/nothing to the store/,
			/does not poll/,
			/creates its dedicated key file/,
			/mode 0600, in a 0700 directory/,
			/secret for this launch/,
			/never logged and never part of an error/,
			/never created/,
			/0 to 65535, written without leading zeros/,
			/may not be the installation key/,
			/SIGINT \(Ctrl-C\) or SIGTERM/,
		])
			expect(help).toMatch(phrase);
	});

	it("neither help text, nor the page, calls the public command by its development name", () => {
		const visible = (text: string) => text.replaceAll("cockpit-digest-key", "");
		expect(visible(endoHelpV0())).not.toMatch(/cockpit/i);
		expect(visible(endoStudioHelpV0())).not.toMatch(/cockpit/i);
		const page = read("cockpit-ui/index.html");
		expect(page).toMatch(/<title>Endophasia Studio<\/title>/);
		expect(page).toMatch(/<span class="page-name">Studio<\/span>/);
		const text = page.replace(/<[^>]*>/g, " ").replace(/\.\/assets\/\S+/g, "");
		expect(text).not.toMatch(/cockpit/i);
	});
});

describe("the package keeps its conventions", () => {
	const manifest = JSON.parse(read("package.json")) as {
		bin: Record<string, string>;
		files: string[];
		dependencies?: object;
		scripts: Record<string, string>;
	};

	it("one binary, the same files list, no runtime dependency, and the development convenience kept", () => {
		expect(manifest.bin).toEqual({ endo: "dist/cli/index.js" });
		expect(manifest.files).toEqual(["dist/", "README.md", "CHANGELOG.md", "LICENSE"]);
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.scripts.cockpit).toBe("node scripts/build-cockpit-ui.mjs && node cockpit-http/launch.ts");
		expect(manifest.scripts.prepack).toBe("npm run build");
	});

	it("the page is built into dist/ by the existing builder, after the build has emptied dist/", () => {
		const build = read("scripts/build-cli.mjs");
		expect(build).toMatch(/import \{ buildCockpitUi \} from "\.\/build-cockpit-ui\.mjs"/);
		expect(build.indexOf("rmSync(")).toBeGreaterThan(-1);
		const page = build.search(/buildCockpitUi\(`\$\{root\}dist\/cockpit-ui`\)/);
		expect(page).toBeGreaterThan(build.indexOf("rmSync("));
		expect(build.indexOf("buildCockpitUi(")).toBeGreaterThan(build.indexOf("tsc"));
		expect(read("tsconfig.cli.json")).toMatch(/"files": \["cli\/index\.ts", "cli\/cassette-child\.ts"\]/);
	});

	it("the package-smoke inventory allows exactly the page's three non-JavaScript files and compares whole sets, not a pattern", () => {
		const smoke = read("scripts/package-smoke.mjs");
		for (const file of [
			"dist/cockpit-ui/index.html",
			"dist/cockpit-ui/cockpit.css",
			"dist/cockpit-ui/icon.svg",
			"dist/research/fixture-keys/fixture-public.json",
			"dist/research/fixture-keys/fixture-public-alt.json",
		])
			expect(smoke, file).toContain(`"${file}"`);
		// The non-JavaScript files are compared as one sorted list, and the page's files as one set derived from cockpit-ui/src.
		expect(smoke).toMatch(/!p\.endsWith\("\.js"\)\)\.sort\(\)\.join\(\) ===\s*\[/);
		expect(smoke).toMatch(/startsWith\("dist\/cockpit-ui\/"\)\)\.sort\(\)\.join\(\) === expectedUi\.join\(\)/);
		expect(smoke).toMatch(/no installed JavaScript points at a source map/);
	});
});
