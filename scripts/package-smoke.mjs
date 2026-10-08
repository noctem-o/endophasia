// Package smoke: build the tarball with `npm pack`, audit its inventory, install it (not a link, not the checkout)
// into a scratch directory with an isolated HOME/XDG, and run the installed `endo` under plain Node with TypeScript
// stripping disabled. Nothing here imports repository sources or calls a model provider. Exit status 1 on any failure.
//
//   node scripts/package-smoke.mjs        (npm run test:package)
//
// Scratch lives under $TMPDIR (or the OS temp directory) and is removed at the end.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "endo-package-smoke-"));
const failures = [];
const check = (ok, what) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failures.push(what);
};
const tree = (dir) => {
	const out = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			out.push(p);
			if (statSync(p).isDirectory()) walk(p);
		}
	};
	walk(dir);
	return out.sort();
};

try {
	const home = join(scratch, "home");
	const xdgData = join(scratch, "xdg-data");
	const xdgConfig = join(scratch, "xdg-config");
	const cwdA = join(scratch, "cwd-a");
	const cwdB = join(scratch, "cwd-b");
	const emptyStore = join(scratch, "empty-store");
	for (const d of [home, xdgData, xdgConfig, cwdA, cwdB, emptyStore, join(scratch, "pack"), join(scratch, "install")])
		mkdirSync(d, { recursive: true });
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		npm_config_cache: join(scratch, "npm-cache"),
		npm_config_update_notifier: "false",
	};

	// 1. Pack.
	const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", join(scratch, "pack")], {
		cwd: repo,
		env: { ...env, HOME: process.env.HOME },
		encoding: "utf8",
	});
	if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`);
	// npm prints an array of packages; newer npm keys the same records by package name.
	const parsed = JSON.parse(pack.stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	const tarball = join(scratch, "pack", packed.filename);
	const paths = packed.files.map((f) => f.path);
	console.log(`tarball ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} unpacked`);
	console.log(`sha512 ${packed.integrity}`);

	// 2. Inventory.
	const allowedTop = new Set(["package.json", "README.md", "LICENSE"]);
	check(paths.every((p) => p.startsWith("dist/") || allowedTop.has(p)), "only dist/, package.json, README.md and LICENSE are packed");
	check(!paths.some((p) => /\.(ts|mts|cts|tsx)$/.test(p)), "no TypeScript source or declaration files in the tarball");
	check(!paths.some((p) => p.includes("node_modules") || p.includes("tests/") || p.includes(".map")), "no node_modules, tests or source maps");
	check(
		paths.filter((p) => p.startsWith("dist/") && !p.endsWith(".js")).sort().join() ===
			"dist/research/fixture-keys/fixture-public-alt.json,dist/research/fixture-keys/fixture-public.json",
		"the only non-JavaScript runtime assets are the two public synthetic fixture keys",
	);
	check(!paths.some((p) => /digest-key$|capture|cassette\.json/.test(p) && !p.endsWith(".js")), "no private keys or captures");

	// 3. Install the tarball only: no dev dependencies, no install scripts.
	const install = spawnSync(
		"npm",
		["install", "--prefix", join(scratch, "install"), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball],
		{ cwd: scratch, env, encoding: "utf8" },
	);
	check(install.status === 0, `npm install of the tarball succeeds${install.status === 0 ? "" : `: ${install.stderr}`}`);
	const pkgDir = join(scratch, "install", "node_modules", "endophasia");
	const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const bin = join(scratch, "install", "node_modules", ".bin", "endo");
	check(existsSync(join(pkgDir, manifest.bin.endo)), "the manifest's bin target exists in the installed package");
	check(existsSync(bin), "the endo executable is linked into node_modules/.bin");
	check(!Object.keys(manifest.dependencies ?? {}).length, "the package declares no runtime dependencies");
	check(!existsSync(join(pkgDir, "node_modules")), "no nested node_modules in the installed package");

	// 4. Every relative import in the installed JavaScript resolves to an installed file.
	const jsFiles = tree(join(pkgDir, "dist")).filter((p) => p.endsWith(".js"));
	const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
	const unresolved = [];
	for (const file of jsFiles) {
		for (const [, spec] of readFileSync(file, "utf8").matchAll(importPattern)) {
			if (spec.endsWith(".ts") || !existsSync(resolve(dirname(file), spec))) unresolved.push(`${file}: ${spec}`);
		}
	}
	check(unresolved.length === 0, `all ${jsFiles.length} installed modules' relative imports resolve to packaged .js files${unresolved.length ? `: ${unresolved.join("; ")}` : ""}`);

	// 5. Run the installed binary. Plain Node, TypeScript stripping off, outside the repository.
	const run = (args, cwd = cwdA) =>
		spawnSync(process.execPath, ["--no-strip-types", bin, ...args], { cwd, env, encoding: "utf8" });
	const before = tree(scratch).filter((p) => !p.startsWith(join(scratch, "install")) && !p.startsWith(join(scratch, "pack")) && !p.startsWith(join(scratch, "npm-cache")));

	const help = run(["--help"]);
	check(help.status === 0 && /experimental research instrument/.test(help.stdout) && /Pi is installed and managed separately/.test(help.stdout), "endo --help exits 0 and describes the instrument");
	check(/live-study|authorize-live-study/.test(help.stdout) && /incur cost/.test(help.stdout), "help warns about live studies and provider cost");
	const version = run(["--version"], cwdB);
	check(version.status === 0 && version.stdout === `${manifest.version}\n`, `endo --version prints the package version (${manifest.version})`);
	const status = run(["harness", "status", emptyStore]);
	check(status.status === 0 && JSON.parse(status.stdout).capabilityState === null, "endo harness status <empty store> reports no capability state");
	const overview = run(["harness", "overview", emptyStore], cwdB);
	check(overview.status === 0 && JSON.parse(overview.stdout).overview.session.status === "UNAVAILABLE", "endo harness overview <empty store> reports the session UNAVAILABLE");
	const missingStore = run(["harness", "status", join(scratch, "no-such-store")]);
	check(missingStore.status === 0 && !existsSync(join(scratch, "no-such-store")), "inspecting a nonexistent store creates nothing");
	const bogus = run(["no-such-command"]);
	check(bogus.status === 2 && /unknown command/.test(bogus.stderr) && bogus.stdout === "", "an unknown command exits 2 with a usage error on stderr");
	const bare = run([]);
	check(bare.status === 2 && /missing command/.test(bare.stderr), "no command exits 2");
	const misuse = run(["harness", "nonsense"]);
	check(misuse.status === 1 && /usage: endo harness/.test(misuse.stderr), "a family-level usage error keeps its existing exit 1");
	const keyId = run(["digest-key", "id"]);
	check(keyId.status === 1 && !existsSync(join(xdgData, "endophasia")), "digest-key id does not create a key when none exists");

	// 6. The packaged public fixture keys resolve from the installed layout (the file-relative lookup in storage/digest-key).
	const probe = spawnSync(
		process.execPath,
		[
			"--no-strip-types",
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(join(pkgDir, "dist/storage/digest-key.js"))}); const k = m.loadEndoFixtureDigestKeyV0(m.endoFixtureDigestKeyPathV0()); process.stdout.write(k.keyId);`,
		],
		{ cwd: cwdB, env, encoding: "utf8" },
	);
	check(probe.status === 0 && probe.stdout.length > 0, `the packaged fixture key loads from the installed layout${probe.status === 0 ? "" : `: ${probe.stderr}`}`);

	// 7. Nothing durable appeared in HOME, XDG, or the working directories.
	const after = tree(scratch).filter((p) => !p.startsWith(join(scratch, "install")) && !p.startsWith(join(scratch, "pack")) && !p.startsWith(join(scratch, "npm-cache")));
	check(JSON.stringify(before) === JSON.stringify(after), "no state was created in HOME, XDG, the stores or the working directories");
} catch (error) {
	check(false, `smoke aborted: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\npackage smoke passed");
