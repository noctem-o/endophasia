// `endo studio` through the development entry point: the argument parser, what an invalid invocation may and may not do, and a real
// launch from a checkout (the installed package is exercised by scripts/package-smoke.mjs, which is the authority for the tarball).
// What this file holds the command to: invalid arguments are refused with status 2 before anything is created or started; the page
// is served only behind the access address; the store is never written and an absent one stays absent; Studio's own key is the only
// file it creates; SIGINT and SIGTERM end it by itself with status 0 and release the port; the address is printed once and appears
// nowhere else.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endoStudioHelpV0 } from "../cli/help.ts";
import { endoStudioUiDirectoryV0, parseEndoStudioArgsV0 } from "../cli/studio.ts";
import { ingestAll, lifecycleEvents, removeTempRoots, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { listening, type StudioChild, startStudio } from "./studio-child.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(repo, "cli/index.ts");
const scratch = mkdtempSync(join(tmpdir(), "endo-studio-test-"));
const started: StudioChild[] = [];

beforeAll(() => {
	// A checkout serves the frontend built into studio-ui/dist (ignored by git), as `npm run cockpit` does.
	const built = spawnSync(process.execPath, [join(repo, "scripts/build-studio-ui.mjs")], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`the UI did not build: ${built.stderr}`);
}, 90_000);
afterEach(() => {
	for (const child of started.splice(0)) child.kill();
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A private HOME and XDG_DATA_HOME, so no run touches the real ones and what a run creates can be listed. */
function sandbox(name: string): { home: string; xdg: string; env: Record<string, string> } {
	const home = join(scratch, name, "home");
	const xdg = join(scratch, name, "xdg");
	mkdirSync(home, { recursive: true });
	mkdirSync(xdg, { recursive: true });
	return { home, xdg, env: { PATH: process.env.PATH ?? "", HOME: home, XDG_DATA_HOME: xdg } };
}

/** Every path under `dir` with the hash of each file: what "byte-for-byte unchanged" means. */
function tree(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d).sort()) {
			const path = join(d, name);
			const entry = statSync(path);
			if (entry.isDirectory()) {
				out.push(`${relative(dir, path)}/`);
				walk(path);
			} else out.push(`${relative(dir, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(dir);
	return out;
}

const run = (args: string[], env: Record<string, string>) =>
	spawnSync(process.execPath, [CLI, "studio", ...args], { cwd: scratch, env, encoding: "utf8", timeout: 30_000 });

function populated(): string {
	const root = tempRoot();
	ingestAll(root, lifecycleEvents("completes"));
	seedRegistry(root);
	return root;
}

describe("the arguments", () => {
	const env = { XDG_DATA_HOME: "/data" };
	const parse = (...argv: string[]) => parseEndoStudioArgsV0(argv, env);

	it("takes the default store, a positional root or --root, and a port and key file, in any order after the root", () => {
		expect(parse()).toEqual({
			root: "/data/endophasia/store",
			defaultNote: "using the default store /data/endophasia/store (XDG_DATA_HOME)",
			port: 0,
			keyFile: null,
		});
		expect(parse("./rec")).toMatchObject({ root: "./rec", defaultNote: null, port: 0 });
		expect(parse("--root", "./rec", "--port", "8085")).toMatchObject({ root: "./rec", port: 8085 });
		expect(parse("./rec", "--key-file", "k", "--port", "0")).toMatchObject({ root: "./rec", keyFile: "k", port: 0 });
		expect(parse("--port", "65535", "--root", "r")).toMatchObject({ port: 65535 });
		expect(parse("--key-file", "k")).toMatchObject({
			keyFile: "k",
			defaultNote: expect.stringContaining("default store"),
		});
	});

	it("returns help for --help or -h wherever it stands, before judging anything else", () => {
		for (const argv of [["--help"], ["-h"], ["--bogus", "--help"], ["a", "b", "-h"], ["--port", "99999", "--help"]])
			expect(parse(...argv), argv.join(" ")).toBe("help");
	});

	it("refuses a root named twice, an empty root and a root that is a mistyped option", () => {
		expect(() => parse("a", "--root", "b")).toThrow(/given twice/);
		expect(() => parse("--root", "a", "--root", "b")).toThrow(/more than once/);
		expect(() => parse("--root")).toThrow(/needs a value/);
		expect(() => parse("--root", "")).toThrow(/empty/);
		expect(() => parse("")).toThrow(/empty/);
		for (const argv of [["-x"], ["-p", "80"], ["-"], ["-port"]])
			expect(() => parse(...argv), argv.join(" ")).toThrow(/unknown option/);
	});

	it("accepts a port only as 0 to 65535 written without leading zeros, once", () => {
		for (const bad of [
			"65536",
			"99999",
			"08085",
			"00",
			"-1",
			"+1",
			"1e3",
			"80.5",
			"0x50",
			" 80",
			"",
			"abc",
			"100000",
		])
			expect(() => parse("--port", bad), JSON.stringify(bad)).toThrow(/--port must be a whole number|needs a value/);
		expect(() => parse("--port")).toThrow(/needs a value/);
		expect(() => parse("--port", "--root", "r")).toThrow(/needs a value/);
		expect(() => parse("--port", "1", "--port", "2")).toThrow(/more than once/);
	});

	it("refuses unknown and duplicate options, extra positionals and a missing or empty key file", () => {
		expect(() => parse("--bogus")).toThrow(/unknown option: --bogus/);
		expect(() => parse("--port=80")).toThrow(/unknown option/);
		expect(() => parse("--host", "0.0.0.0")).toThrow(/unknown option: --host/);
		expect(() => parse("--open")).toThrow(/unknown option/);
		expect(() => parse("a", "b")).toThrow(/unexpected argument: b/);
		expect(() => parse("--port", "80", "stray")).toThrow(
			/unexpected argument: stray \(a store is named first, or with --root\)/,
		);
		expect(() => parse("--port", "80", "./rec")).toThrow(/unexpected argument: \.\/rec/); // the root comes first, as for every command
		expect(() => parse("--key-file")).toThrow(/needs a value/);
		expect(() => parse("--key-file", "")).toThrow(/empty/);
		expect(() => parse("--key-file", "a", "--key-file", "b")).toThrow(/more than once/);
		expect(() => parse("--key-file", "--port", "80")).toThrow(/needs a value/);
	});

	it("keeps a value that looks like a flag from being read as the root flag", () => {
		// `--key-file --root` is a missing value, not a key file named "--root" and not a named root.
		expect(() => parse("--key-file", "--root", "r")).toThrow(/needs a value/);
	});

	it("reads no file and creates nothing", () => {
		const before = tree(scratch);
		parse("--root", "x", "--port", "1");
		expect(tree(scratch)).toEqual(before);
	});
});

describe("where the frontend is found", () => {
	it("resolves it from the module location only: the installed layout first, a checkout's build second, nothing otherwise", () => {
		const layout = join(scratch, "layout");
		mkdirSync(join(layout, "dist/cli"), { recursive: true });
		mkdirSync(join(layout, "dist/studio-ui"), { recursive: true });
		const installed = new URL(`file://${join(layout, "dist/cli/studio.js")}`).href;
		expect(endoStudioUiDirectoryV0(installed)).toBeNull(); // the directory exists but holds no build manifest
		writeMarker(join(layout, "dist/studio-ui/studio-ui.manifest.json"));
		expect(endoStudioUiDirectoryV0(installed)).toBe(`${join(layout, "dist/studio-ui")}/`);
		const checkout = join(layout, "checkout");
		mkdirSync(join(checkout, "cli"), { recursive: true });
		mkdirSync(join(checkout, "studio-ui/src"), { recursive: true });
		writeMarker(join(checkout, "studio-ui/index.html")); // the source directory holds the page template, which is not a build
		const dev = new URL(`file://${join(checkout, "cli/studio.ts")}`).href;
		expect(endoStudioUiDirectoryV0(dev)).toBeNull();
		mkdirSync(join(checkout, "studio-ui/dist"), { recursive: true });
		writeMarker(join(checkout, "studio-ui/dist/studio-ui.manifest.json"));
		expect(endoStudioUiDirectoryV0(dev)).toBe(`${join(checkout, "studio-ui/dist")}/`);
	});

	it("this checkout's own command finds the frontend built for the tests", () => {
		expect(endoStudioUiDirectoryV0()).toBe(`${join(repo, "studio-ui/dist")}/`);
	});
});

function writeMarker(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
}

describe("an invalid invocation", () => {
	const cases: string[][] = [
		["--port", "65536"],
		["--port", "08085"],
		["--port", ""],
		["--port"],
		["--port", "1", "--port", "2"],
		["--bogus"],
		["-x"],
		["--host", "0.0.0.0"],
		["a", "b"],
		["a", "--root", "b"],
		["--root", "a", "--root", "b"],
		["--root"],
		["--key-file"],
		["--key-file", "k", "--key-file", "l"],
	];

	it("exits 2 with a usage line on stderr and nothing on stdout, and creates no key, store or directory", () => {
		const box = sandbox("invalid");
		const before = [...tree(box.home), ...tree(box.xdg), ...tree(scratch).filter((p) => !p.startsWith("invalid"))];
		for (const args of cases) {
			const result = run(args, box.env);
			expect(result.status, args.join(" ")).toBe(2);
			expect(result.stdout, args.join(" ")).toBe("");
			expect(result.stderr, args.join(" ")).toMatch(/usage: endo studio/);
		}
		expect([...tree(box.home), ...tree(box.xdg), ...tree(scratch).filter((p) => !p.startsWith("invalid"))]).toEqual(
			before,
		);
		expect(existsSync(join(box.xdg, "endophasia"))).toBe(false);
	});

	it("--help exits 0, prints Studio's help and creates nothing", () => {
		const box = sandbox("help");
		for (const args of [["--help"], ["-h"], ["--port", "bad", "--help"]]) {
			const result = run(args, box.env);
			expect(result.status, args.join(" ")).toBe(0);
			expect(result.stdout).toBe(endoStudioHelpV0());
			expect(result.stderr).toBe("");
		}
		expect(tree(box.xdg)).toEqual([]);
		expect(tree(box.home)).toEqual([]);
	});

	it("is not confused with a failed start: a store that does not exist is a launch, not an invalid invocation", () => {
		// (checked for real below: an absent root starts Studio). Here only the status vocabulary is pinned in the help.
		expect(endoStudioHelpV0()).toMatch(
			/0 stopped that way \(or help\); 1 Studio could not start .*; 2 the\s+invocation was invalid/s,
		);
	});
});

describe("a launch from a checkout", () => {
	async function launch(args: string[], box: ReturnType<typeof sandbox>): Promise<StudioChild> {
		const child = await startStudio([CLI, "studio", ...args], { cwd: scratch, env: box.env });
		started.push(child);
		return child;
	}

	it("prints one address, serves the page and the API behind it, leaves the store byte-for-byte alone, and stops on SIGINT with status 0", async () => {
		const box = sandbox("launch");
		const root = populated();
		const before = tree(root);
		const studio = await launch(["--root", root], box);
		// One address, on stdout, with its own warning on stderr; nothing else carries it.
		expect(studio.stdout().match(/http:\/\//g)).toHaveLength(1);
		expect(studio.stderr()).not.toContain(studio.capability);
		expect(studio.stderr()).toMatch(/private to this launch/);
		expect(studio.address).toBe(`${studio.origin}/${studio.capability}/`);
		const page = await studio.get("/");
		expect(page.status).toBe(200);
		expect(page.body).toContain("<title>Endophasia Studio</title>");
		expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
		expect(page.headers["cache-control"]).toBe("no-store");
		const script = readdirSync(join(repo, "studio-ui/dist")).find((name) => /^main-.*\.js$/.test(name))!;
		const main = await studio.get(`/assets/${script}`);
		expect(main.status).toBe(200);
		expect(main.body).toBe(readFileSync(join(repo, "studio-ui/dist", script), "utf8"));
		const snapshot = await studio.get("/api/v0/snapshot");
		expect(snapshot.status).toBe(200);
		const parsed = JSON.parse(snapshot.body);
		expect(parsed.timeline.source.condition.state).toBe("readable");
		expect(parsed.timeline.entries.length).toBeGreaterThan(0);
		// Refused as before: another capability, a foreign origin, another host.
		expect((await studio.send(`/${"x".repeat(43)}/api/v0/snapshot`)).status).toBe(404);
		expect((await studio.get("/api/v0/snapshot", { Origin: "http://evil.example" })).status).toBe(403);
		expect((await studio.get("/api/v0/snapshot", { Host: "evil.example" })).status).toBe(421);
		expect((await studio.send("/", {})).status).toBe(404);
		expect(tree(root)).toEqual(before);
		// Its own key, and only that, was created: 0600 in a 0700 directory, and no installation key.
		const dir = join(box.xdg, "endophasia");
		expect(readdirSync(dir)).toEqual(["cockpit-digest-key"]);
		expect(statSync(join(dir, "cockpit-digest-key")).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(studio.stderr()).toMatch(/created Studio's own digest key/);
		const port = studio.port;
		expect(await studio.stop("SIGINT")).toEqual({ code: 0, signal: null });
		expect(await listening(port)).toBe(false);
		expect(studio.stderr()).toMatch(/studio: stopped/);
		expect(studio.redact(studio.stdout() + studio.stderr())).not.toContain(studio.capability);
		expect(tree(root)).toEqual(before);
	}, 60_000);

	it("an absent store stays absent: it is shown as absent, not created and not read as empty", async () => {
		const box = sandbox("absent");
		const root = join(scratch, "absent", "no-such-store");
		const studio = await launch(["--root", root], box);
		const parsed = JSON.parse((await studio.get("/api/v0/snapshot")).body);
		expect(parsed.timeline.source.condition.state).toBe("absent");
		expect(existsSync(root)).toBe(false);
		expect(existsSync(join(scratch, "absent", "no-such-store"))).toBe(false);
		expect(await studio.stop("SIGTERM")).toEqual({ code: 0, signal: null });
		expect(existsSync(root)).toBe(false);
	}, 60_000);

	it("keeps its key across launches and takes the default store when none is named, saying which", async () => {
		const box = sandbox("default");
		const store = join(box.xdg, "endophasia", "store");
		const first = await launch([], box);
		expect(first.stderr()).toContain(`using the default store ${store} (XDG_DATA_HOME)`);
		const key = tree(join(box.xdg, "endophasia")).filter((line) => line.startsWith("cockpit-digest-key"));
		expect(key).toHaveLength(1);
		expect(await first.stop("SIGINT")).toEqual({ code: 0, signal: null });
		const second = await launch(["--port", "0"], box);
		expect(second.stderr()).not.toMatch(/created Studio's own digest key/);
		expect(tree(join(box.xdg, "endophasia")).filter((line) => line.startsWith("cockpit-digest-key"))).toEqual(key);
		expect(existsSync(store)).toBe(false);
		await second.stop("SIGINT");
	}, 60_000);

	it("honours --port, and a taken port is a failed start (status 1) that leaves nothing listening and shows no address", async () => {
		const box = sandbox("port");
		const root = populated();
		const one = await launch(["--root", root], box);
		const taken = spawnSync(process.execPath, [CLI, "studio", "--root", root, "--port", String(one.port)], {
			cwd: scratch,
			env: box.env,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(taken.status).toBe(1);
		expect(taken.stdout).toBe("");
		expect(taken.stderr).toContain(`port ${one.port} is already in use`);
		expect(taken.stderr).not.toContain(one.capability);
		await one.stop("SIGINT");
		const again = await launch(["--root", root, "--port", String(one.port)], box);
		expect(again.port).toBe(one.port);
		await again.stop("SIGTERM");
	}, 60_000);

	it("a repeated signal while it closes, and after, neither closes twice nor fails: it still exits 0 by itself", async () => {
		const box = sandbox("signals");
		const studio = await launch(["--root", populated()], box);
		const port = studio.port;
		for (const name of ["SIGINT", "SIGINT", "SIGTERM", "SIGINT"] as const) studio.signal(name);
		expect(await studio.exited).toEqual({ code: 0, signal: null });
		expect(await listening(port)).toBe(false);
		expect(studio.stderr().match(/studio: stopped/g)).toHaveLength(1);
		expect(studio.stderr()).not.toMatch(/error|unhandled/i);
	}, 60_000);

	it("runs with an explicit store and key file where the environment has no HOME or XDG_DATA_HOME, as a container may", async () => {
		const root = populated();
		const keyFile = join(scratch, "bare-env", "studio.key");
		const child = await startStudio([CLI, "studio", "--root", root, "--key-file", keyFile], {
			cwd: scratch,
			env: { PATH: process.env.PATH ?? "" },
		});
		started.push(child);
		expect((await child.get("/api/v0/snapshot")).status).toBe(200);
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		expect(await child.stop("SIGTERM")).toEqual({ code: 0, signal: null });
	}, 60_000);

	it("a key file inside the store is refused as a failed start: the store is not created or written", async () => {
		const box = sandbox("keyinside");
		const root = join(scratch, "keyinside", "recordings");
		const refused = spawnSync(
			process.execPath,
			[CLI, "studio", "--root", root, "--key-file", join(root, "studio.key")],
			{
				cwd: scratch,
				env: box.env,
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(refused.status).toBe(1);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toMatch(/inside the store Studio reads/);
		expect(existsSync(root)).toBe(false);
		expect(existsSync(join(box.xdg, "endophasia"))).toBe(false);
	}, 60_000);

	it("a key file of its own may be chosen, and the installation key may not", async () => {
		const box = sandbox("keyfile");
		const keyFile = join(scratch, "keyfile", "elsewhere", "studio.key");
		const studio = await launch(["--root", populated(), "--key-file", keyFile], box);
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		expect(existsSync(join(box.xdg, "endophasia", "cockpit-digest-key"))).toBe(false);
		await studio.stop("SIGINT");
		const installation = join(box.xdg, "endophasia", "digest-key");
		const refused = spawnSync(process.execPath, [CLI, "studio", "--root", populated(), "--key-file", installation], {
			cwd: scratch,
			env: box.env,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(refused.status).toBe(1);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toMatch(/installation key/);
		expect(existsSync(installation)).toBe(false);
	}, 60_000);
});
