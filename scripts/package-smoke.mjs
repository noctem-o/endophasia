// Package smoke: build the tarball with `npm pack`, audit its inventory, install it (not a link, not the checkout)
// into a scratch directory with an isolated HOME/XDG, and run the installed `endo` under plain Node with TypeScript
// stripping disabled, including `endo studio` as a long-running child (started, fetched from, signalled and checked for what it
// leaves). The installed code never reads this checkout; the test helpers imported below only drive and observe it. Nothing here
// calls a model provider. Exit status 1 on any failure.
//
//   node scripts/package-smoke.mjs        (npm run test:package)
//   node scripts/package-smoke.mjs --package ./endophasia-<version>.tgz [--expect-integrity sha512-...]
//   node scripts/package-smoke.mjs --package endophasia@<version>      (the published artifact, after publication)
//
// By default the subject is the tarball `npm pack` makes from this checkout. With --package it is exactly that tarball file, or exactly
// what the registry serves for that spec, so the file an owner publishes can be the file this ran against; --expect-integrity pins the
// sha512 the owner recorded (or read from CI). ENDO_REQUIRE_BROWSER=1 turns a missing Chromium from a skip into a failure: the CI jobs
// that gate a release set it.
//
// Scratch lives under $TMPDIR (or the OS temp directory) and is removed at the end.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node spells "do not strip TypeScript types" differently across versions; use the first spelling this Node accepts.
const noStripFlags =
	["--no-strip-types", "--no-experimental-strip-types"].filter(
		(flag) => spawnSync(process.execPath, [flag, "-e", "0"]).status === 0,
	).slice(0, 1);
console.log(`node ${process.version}; TypeScript stripping disabled with: ${noStripFlags[0] ?? "(no flag accepted; relying on the .ts-free inventory check)"}`);
// --real-pi: the loop runs against a real Pi installed by the caller (ENDO_ACCEPT_PI = its executable) instead of the fake,
// and must be exactly ENDO_ACCEPT_PI_VERSION. Endophasia never installs Pi; the CI job does, from a pinned version.
// Strict arguments: the two options that choose and pin the artifact must never be silently dropped, or the run would test something else
// and still report success. `--flag value` and `--flag=value` are accepted; anything unrecognised, repeated or valueless is an error.
const usage = () => {
	console.error("usage: node scripts/package-smoke.mjs [--real-pi] [--package <tarball file | endophasia@<version or tag>>] [--expect-integrity <sha512-...>]");
	process.exit(1);
};
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const [flag, inline] = process.argv[i].split(/=(.*)/s, 2);
	if (flag === "--real-pi" && inline === undefined) {
		options.set(flag, true);
	} else if (flag === "--package" || flag === "--expect-integrity") {
		const value = inline ?? process.argv[++i];
		if (value === undefined || value === "" || value.startsWith("--")) {
			console.error(`${flag} needs a value`);
			usage();
		}
		if (options.has(flag)) {
			console.error(`${flag} was given twice`);
			usage();
		}
		options.set(flag, value);
	} else {
		console.error(`unrecognised argument: ${process.argv[i]}`);
		usage();
	}
}
const realPi = options.has("--real-pi");
if (realPi && (!process.env.ENDO_ACCEPT_PI || !process.env.ENDO_ACCEPT_PI_VERSION)) {
	console.error("--real-pi needs ENDO_ACCEPT_PI (the Pi executable) and ENDO_ACCEPT_PI_VERSION (the exact version expected)");
	process.exit(1);
}
const valueOf = (flag) => options.get(flag) ?? null;
const packageSpec = valueOf("--package");
const expectedIntegrity = valueOf("--expect-integrity");
if (expectedIntegrity !== null && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expectedIntegrity)) {
	console.error("--expect-integrity takes the sha512 integrity (sha512-<88 base64 characters>) that npm pack reports");
	process.exit(1);
}
const requireBrowser = process.env.ENDO_REQUIRE_BROWSER === "1";
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

/** Every entry under a directory with the sha256 of each file: what "byte-for-byte unchanged" is compared on. Empty if absent. */
const fingerprint = (dir) =>
	existsSync(dir)
		? tree(dir).map((p) => (statSync(p).isDirectory() ? `${relative(dir, p)}/` : `${relative(dir, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`))
		: [];
const studios = []; // every Studio child started below: ended in the finally, whatever happens, before the scratch directory goes

try {
	const home = join(scratch, "home");
	const xdgData = join(scratch, "xdg-data");
	const xdgConfig = join(scratch, "xdg-config");
	const cwdA = join(scratch, "cwd-a");
	const cwdB = join(scratch, "cwd-b");
	const emptyStore = join(scratch, "empty-store");
	for (const d of [home, xdgData, xdgConfig, cwdA, cwdB, emptyStore, join(scratch, "pack"), join(scratch, "pack-again"), join(scratch, "install")])
		mkdirSync(d, { recursive: true });
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_DATA_HOME: xdgData,
		XDG_CONFIG_HOME: xdgConfig,
		npm_config_cache: join(scratch, "npm-cache"),
		npm_config_update_notifier: "false",
	};

	// 1. Pack: this checkout's tarball, or (--package) exactly the file or registry spec named. `npm pack` also fetches and re-reports a
	// tarball, so the same inventory and integrity come from the artifact itself in every mode.
	const subject = packageSpec === null ? null : existsSync(resolve(packageSpec)) ? resolve(packageSpec) : packageSpec;
	// Only a tarball file or this package's own registry spec reaches npm. A directory, a Git URL or shorthand, a `file:`/`npm:` alias or
	// another package would let `npm pack` run lifecycle scripts (prepare, prepack) or fetch something else before the integrity pin is checked.
	if (subject !== null) {
		const name = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).name;
		const registrySpec = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}@[A-Za-z0-9][A-Za-z0-9._+-]*$`);
		const isFile = existsSync(subject) && statSync(subject).isFile() && /\.(tgz|tar\.gz)$/.test(subject);
		if (!isFile && !registrySpec.test(subject)) throw new Error(`--package takes an existing .tgz file or ${name}@<version or tag>; refusing "${packageSpec}"`);
	}
	const npmPack = (destination) => {
		// prepack (the build) must run for a checkout, whatever the user's npm configuration says about scripts.
		const pack = spawnSync("npm", ["pack", subject ?? ".", "--json", "--pack-destination", destination, ...(subject === null ? ["--ignore-scripts=false"] : [])], {
			cwd: subject === null ? repo : scratch,
			env: { ...env, HOME: process.env.HOME },
			encoding: "utf8",
		});
		if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`);
		// npm prints an array of packages; newer npm keys the same records by package name.
		const parsed = JSON.parse(pack.stdout);
		return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	};
	// A file `dist/` should never keep: the build empties it first, so one left behind would mean a stale output could be packed.
	const staleMarker = join(repo, "dist", "zz-stale-output.js");
	if (subject === null) {
		mkdirSync(join(repo, "dist"), { recursive: true });
		writeFileSync(staleMarker, "// left by package-smoke to prove the build empties dist/\n");
	}
	const packed = npmPack(join(scratch, "pack"));
	const tarball = join(scratch, "pack", packed.filename);
	const paths = packed.files.map((f) => f.path);
	const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
	console.log(`subject: ${subject === null ? "the tarball packed from this checkout" : existsSync(subject) ? `the tarball file ${subject}` : `the registry package ${subject}`}`);
	console.log(`tarball ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} unpacked`);
	console.log(`sha512 ${packed.integrity}`);
	console.log(`sha1   ${packed.shasum}`);
	// The pin is a safety boundary: an artifact that is not the recorded one is never installed, and none of its code runs. (`npm pack` of a
	// file or a registry spec only fetches and re-reports it.)
	const mustMatch = (ok, name) => {
		check(ok, name);
		if (!ok) throw new Error(`stopped before installing or running anything from the artifact: ${name}`);
	};
	mustMatch(integrity === packed.integrity, "the integrity npm reports is the sha512 of the tarball file");
	if (expectedIntegrity !== null) mustMatch(packed.integrity === expectedIntegrity, `the tarball has the integrity that was recorded for it (${expectedIntegrity})`);
	if (subject === null) {
		check(!paths.includes("dist/zz-stale-output.js") && !existsSync(staleMarker), "the build empties dist/ first: a file left there before packing is not in the tarball");
		const again = npmPack(join(scratch, "pack-again"));
		check(again.integrity === packed.integrity, "a second pack of the same checkout (a second build) gives the identical tarball");
	} else if (!existsSync(subject)) {
		const view = spawnSync("npm", ["view", subject, "dist.integrity"], { cwd: scratch, env: { ...env, HOME: process.env.HOME }, encoding: "utf8" });
		mustMatch(view.status === 0 && view.stdout.trim() === packed.integrity, `the registry's recorded dist.integrity for ${subject} is the integrity of what was fetched`);
	}

	// 2. Inventory.
	const allowedTop = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE"]);
	check(paths.every((p) => p.startsWith("dist/") || allowedTop.has(p)), "only dist/, package.json, README.md, CHANGELOG.md and LICENSE are packed");
	check(!paths.some((p) => /\.(ts|mts|cts|tsx)$/.test(p)), "no TypeScript source or declaration files in the tarball");
	check(!paths.some((p) => p.includes("node_modules") || p.includes("tests/") || p.includes(".map")), "no node_modules, tests or source maps");
	// The bundled Studio frontend (dist/studio-ui, with its licence notices in dist/licenses) is checked by itself below, against its own
	// manifest. A package published before it existed has neither: that is stated, not failed, for a named artifact; a build from this
	// checkout must have it.
	const hasStudioUi = paths.some((p) => p.startsWith("dist/studio-ui/"));
	if (subject === null) check(hasStudioUi, "the build from this checkout packs the Studio frontend (dist/studio-ui)");
	else if (!hasStudioUi) console.log("skip  the Studio frontend checks: this package predates dist/studio-ui");
	// A package published before this frontend (0.1.0-alpha.2 and earlier) carries the page it replaced in dist/cockpit-ui: that is stated
	// and held to its own three files, for a named artifact. A build from this checkout carries no such page.
	const legacyPage = paths.some((p) => p.startsWith("dist/cockpit-ui/"));
	if (subject === null) check(!legacyPage, "the build from this checkout carries no earlier page (dist/cockpit-ui): the Studio frontend replaced it");
	else if (legacyPage) console.log("note  this package carries the earlier page (dist/cockpit-ui), which the Studio frontend replaced");
	const outsideFrontend = paths.filter((p) => !(hasStudioUi && (p.startsWith("dist/studio-ui/") || p.startsWith("dist/licenses/"))));
	check(
		outsideFrontend.filter((p) => p.startsWith("dist/") && !p.endsWith(".js")).sort().join() ===
			[
				...(legacyPage ? ["dist/cockpit-ui/cockpit.css", "dist/cockpit-ui/icon.svg", "dist/cockpit-ui/index.html"] : []),
				"dist/research/fixture-keys/fixture-public-alt.json",
				"dist/research/fixture-keys/fixture-public.json",
			].join(),
		legacyPage
			? "the only non-JavaScript runtime assets are the earlier page's index.html, style sheet and icon and the two public synthetic fixture keys"
			: "the only non-JavaScript runtime assets outside the Studio frontend and its licence notices are the two public synthetic fixture keys",
	);
	check(
		["dist/cli/studio.js", "dist/cockpit-http/host.js", "dist/cockpit-http/server.js", "dist/cockpit/index.js", ...(hasStudioUi ? ["dist/studio-ui/index.html", "dist/studio-ui/studio-ui.manifest.json"] : ["dist/cockpit-ui/main.js", "dist/cockpit-ui/index.html"])].every((p) => paths.includes(p)),
		"the Studio command, the shared host, the server, the cockpit library and the frontend's entry files are packed",
	);
	check(!paths.some((p) => /digest-key$|capture|cassette\.json/.test(p) && !p.endsWith(".js")), "no private keys or captures");
	check(paths.includes("dist/cli/cassette-child.js"), "the second compiled entry point, which replay starts as a child process, is packed beside the first");

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
	check(manifest.engines?.node === ">=22.19.0" && Object.keys(manifest.bin).join() === "endo", "the manifest keeps the endo binary and the Node >=22.19.0 floor");
	check(manifest.publishConfig?.tag === "alpha", "the manifest publishes under the alpha dist-tag by default, never silently under latest");
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

	// Nothing the builder's machine or the repository's secrets could leave in the files: a private key block, or the absolute path of
	// the checkout or the builder's home (a compiler or bundler setting can embed one).
	const builderPaths = [repo.replace(/\/+$/, ""), process.env.HOME].filter((path) => typeof path === "string" && path.length > 1);
	// The path must end there: HOME=/root must not match "./root-args.js".
	const mentions = (text, path) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.-])`).test(text);
	const leaks = tree(pkgDir)
		.filter((path) => statSync(path).isFile())
		.flatMap((path) => {
			const text = readFileSync(path, "utf8");
			return [
				...(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ? [`${relative(pkgDir, path)}: a private key block`] : []),
				...builderPaths.filter((builder) => mentions(text, builder)).map((builder) => `${relative(pkgDir, path)}: the builder path ${builder}`),
			];
		});
	check(leaks.length === 0, `no installed file holds a private key block or the builder's checkout or home path${leaks.length ? `: ${leaks.join("; ")}` : ""}`);

	const mapped = jsFiles.filter((file) => /sourceMappingURL/.test(readFileSync(file, "utf8")));
	check(mapped.length === 0, `no installed JavaScript points at a source map${mapped.length ? `: ${mapped.map((f) => relative(pkgDir, f)).join(", ")}` : ""}`);
	const uiDir = join(pkgDir, "dist", hasStudioUi ? "studio-ui" : "cockpit-ui");
	const entry = readFileSync(join(uiDir, "index.html"), "utf8");
	const referenced = [...entry.matchAll(/(?:src|href)="\.\/assets\/([^"/?#]+)"/g)].map((m) => m[1]);
	check(referenced.length >= 3 && referenced.every((name) => existsSync(join(uiDir, name))), `the installed page's index.html finds all ${referenced.length} files it references beside it`);

	if (hasStudioUi) {
		// The frontend, from the installed package alone: the installed directory is exactly its manifest, file for file and byte for byte.
		// (Checked before anything below edits the installed copy.) The package has no React, no bundler and no source here: it declares no
		// dependency and holds no node_modules; the build's output is all there is.
		const studioManifest = JSON.parse(readFileSync(join(uiDir, "studio-ui.manifest.json"), "utf8"));
		const listed = studioManifest.files.map((f) => f.name).sort();
		check(
			readdirSync(uiDir).sort().join() === [...listed, "studio-ui.manifest.json"].sort().join() &&
				studioManifest.files.every((f) => createHash("sha256").update(readFileSync(join(uiDir, f.name))).digest("hex") === f.sha256),
			`dist/studio-ui holds exactly the ${listed.length} files its manifest lists, each with the recorded sha256`,
		);
		check(
			paths.filter((p) => p.startsWith("dist/studio-ui/") || p.startsWith("dist/licenses/")).every((p) => /^dist\/(studio-ui\/[A-Za-z0-9][A-Za-z0-9._-]*\.(html|js|css|svg|woff2|json)|licenses\/studio-ui-third-party\.txt)$/.test(p)),
			"the tarball holds there only the manifest, the page, scripts, style sheet, icon, fonts and licence notices: no source map and no source",
		);
		const notices = readFileSync(join(pkgDir, "dist", "licenses", "studio-ui-third-party.txt"), "utf8");
		check(
			/\nreact@18\.3\.1\n/.test(notices) && /\nreact-dom@18\.3\.1\n/.test(notices) && /@fontsource\/ibm-plex-sans@/.test(notices) && /@fontsource\/ibm-plex-mono@/.test(notices) && /SIL OPEN FONT LICENSE/i.test(notices),
			"the licence notices of the bundled React and both fonts (IBM Plex Sans and Mono) are packed",
		);
		check(!existsSync(join(scratch, "install", "node_modules", "react")) && !existsSync(join(scratch, "install", "node_modules", "esbuild")), "the install holds no React and no bundler: the frontend runs from its built files only");
	}

	// 5. Run the installed binary. Plain Node, TypeScript stripping off, outside the repository.
	// A bounded wait: a command that should have refused and started a server instead must fail here, not hang the job.
	const run = (args, cwd = cwdA) =>
		spawnSync(process.execPath, [...noStripFlags, bin, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
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
	// replay and proxy are separate branches of the command table; their usage errors prove their module graphs load from the install.
	const replayUsage = run(["replay"]);
	const proxyUsage = run(["proxy"]);
	check(replayUsage.status === 1 && /usage: endo replay/.test(replayUsage.stderr) && proxyUsage.status === 1 && /usage: endo proxy/.test(proxyUsage.stderr), "endo replay and endo proxy report their usage from the install (their round trip is covered from source only)");
	const doctor = run(["doctor", "--json"]);
	const doctored = doctor.status === 0 ? JSON.parse(doctor.stdout) : null;
	check(
		doctored !== null && doctored.schemaVersion === "endo.doctor.v0" && doctored.endophasia.version === manifest.version,
		"endo doctor --json runs from the installed package on an empty home",
	);
	check(
		doctored !== null && doctored.store.source === "XDG_DATA_HOME" && doctored.store.presence === "absent" && doctored.digestKey.presence === "absent",
		"doctor reports the default store and key locations as absent and creates neither",
	);
	check(run(["doctor"]).stdout.includes("doctor (read-only"), "endo doctor prints a human report by default");
	const keyId = run(["digest-key", "id"]);
	check(keyId.status === 1 && !existsSync(join(xdgData, "endophasia")), "digest-key id does not create a key when none exists");
	check(/\bstudio\b/.test(help.stdout) && /Interactive, read-only with respect to the store/.test(help.stdout) && /human line, not a JSON document/.test(help.stdout), "endo --help lists Studio as an interactive command with its output exception");
	const studioHelp = run(["studio", "--help"]);
	const studioShort = run(["studio", "-h"]);
	check(
		studioHelp.status === 0 && studioHelp.stderr === "" && /Endophasia Studio/.test(studioHelp.stdout) && /127\.0\.0\.1 only/.test(studioHelp.stdout) && studioShort.stdout === studioHelp.stdout,
		"endo studio --help (and -h) exits 0, prints the loopback-only description and creates nothing",
	);
	const invalid = [
		["--port", "65536"], ["--port", "08085"], ["--port", ""], ["--port"], ["--port", "1", "--port", "2"], ["--bogus"], ["-x"], ["--host", "0.0.0.0"], ["--open"],
		["a", "b"], ["a", "--root", "b"], ["--root", "a", "--root", "b"], ["--root"], ["--key-file"], ["--key-file", "k", "--key-file", "l"],
	];
	const accepted = invalid.filter((args) => {
		const result = run(["studio", ...args]);
		return !(result.status === 2 && result.stdout === "" && /usage: endo studio/.test(result.stderr));
	});
	check(accepted.length === 0, `${invalid.length} invalid studio invocations are each refused (exit 2, nothing on stdout, a usage line)${accepted.length ? `; not refused: ${accepted.map((a) => a.join(" ")).join(" | ")}` : ""}`);

	// 6. The packaged public fixture keys resolve from the installed layout (the file-relative lookup in storage/digest-key).
	const probe = spawnSync(
		process.execPath,
		[
			...noStripFlags,
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

	// 7b. Studio, from the installed package. The first launch uses an explicit root that does not exist (nor does its parent), before
	// anything has recorded a store, so it shows what Studio alone does: it creates its own key and nothing else.
	const { startStudio, listening } = await import("../tests/studio-child.ts");
	const launch = async (args, cwd = cwdA, environment = env) => {
		const child = await startStudio([...noStripFlags, bin, "studio", ...args], { cwd, env: environment });
		studios.push(child);
		return child;
	};
	const studioKey = join(xdgData, "endophasia", "cockpit-digest-key");
	const installKey = join(xdgData, "endophasia", "digest-key");
	const permissions = (path) => statSync(path).mode & 0o777;
	const absentRoot = join(scratch, "studio-absent", "store");
	// The files the server serves (the manifest of the Studio frontend vouches for them and is not one of them), and which of them is the
	// entry script and the style sheet: a package from before the Studio frontend (see above) names them differently.
	const uiFiles = readdirSync(uiDir).filter((name) => name !== "studio-ui.manifest.json");
	const scriptName = hasStudioUi ? uiFiles.find((name) => /^main-.*\.js$/.test(name)) : "reply.js";
	const styleName = hasStudioUi ? uiFiles.find((name) => /^main-.*\.css$/.test(name)) : "cockpit.css";

	// A damaged install fails at startup, plainly, before a key or a listener exists.
	const brokenEnv = { ...env, XDG_DATA_HOME: join(scratch, "xdg-broken") };
	const attempt = () =>
		spawnSync(process.execPath, [...noStripFlags, bin, "studio", "--root", absentRoot], { cwd: cwdA, env: brokenEnv, encoding: "utf8", timeout: 30_000 });
	// (Moved out of the directory, not renamed within it: a stray file beside the page is refused too, by another sentence.)
	renameSync(join(uiDir, scriptName), join(scratch, "moved-script"));
	const noModule = attempt();
	renameSync(join(scratch, "moved-script"), join(uiDir, scriptName));
	renameSync(uiDir, `${uiDir}.moved`);
	const noPage = attempt();
	renameSync(`${uiDir}.moved`, uiDir);
	check(noModule.status === 1 && noModule.stdout === "" && /is missing/.test(noModule.stderr) && noModule.stderr.includes(scriptName), "a frontend missing its script fails at startup: exit 1, the missing file named, nothing printed to stdout");
	check(noPage.status === 1 && noPage.stdout === "" && /files were not found/.test(noPage.stderr), "a missing frontend directory fails at startup: exit 1 and a plain sentence");
	check(!existsSync(join(scratch, "xdg-broken")) && !existsSync(dirname(absentRoot)), "neither failure created a key, a store or a directory");

	// Proof that the page comes from the install and not from a checkout: the installed style sheet carries a marker only it has. (The
	// Studio frontend's manifest vouches for each file's bytes, so the copy's manifest entry is brought into line with the marker: what
	// is being proved is where the served bytes come from, and the edit that is not vouched for is refused above.)
	appendFileSync(join(uiDir, styleName), "\n/* installed-copy marker */\n");
	if (hasStudioUi) {
		const manifestPath = join(uiDir, "studio-ui.manifest.json");
		const manifestCopy = JSON.parse(readFileSync(manifestPath, "utf8"));
		const marked = readFileSync(join(uiDir, styleName));
		const entryOfStyle = manifestCopy.files.find((file) => file.name === styleName);
		entryOfStyle.bytes = marked.length;
		entryOfStyle.sha256 = createHash("sha256").update(marked).digest("hex");
		writeFileSync(manifestPath, `${JSON.stringify(manifestCopy, null, "\t")}\n`);
	}
	check(!existsSync(studioKey) && !existsSync(installKey), "before the first launch, neither Studio's key nor the installation key exists");
	const one = await launch(["--root", absentRoot]);
	check(
		/^Endophasia Studio \(read-only, loopback only\): http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/$/m.test(one.stdout()) && one.stdout().match(/http:\/\//g)?.length === 1,
		"startup prints exactly one capability-protected address on stdout",
	);
	check(!one.stderr().includes(one.capability) && /private to this launch/.test(one.stderr()) && /created Studio's own digest key/.test(one.stderr()), "stderr says the address is private and that Studio's own key was created, and does not repeat the address");
	const installed = (name) => readFileSync(join(uiDir, name), "utf8");
	const binaryFile = (name) => name.endsWith(".woff2");
	const page = await one.get("/");
	check(page.status === 200 && page.body === installed("index.html") && /require-trusted-types-for 'script'/.test(String(page.headers["content-security-policy"])), "the page is served behind the capability, byte-for-byte as installed, under its policy");
	const assets = await Promise.all(uiFiles.filter((name) => name !== "index.html").map(async (name) => [name, await one.get(`/assets/${name}`)]));
	check(
		assets.length >= (hasStudioUi ? 5 : 15) &&
			assets.every(([name, reply]) => reply.status === 200 && (binaryFile(name) ? Number(reply.headers["content-length"]) === statSync(join(uiDir, name)).size : reply.body === installed(name))),
		`all ${assets.length} browser assets are served byte-for-byte from the installed package (a font by its length)`,
	);
	check(assets.find(([name]) => name === styleName)?.[1].body.includes("installed-copy marker") === true, "the assets served are the installed copy's (a marker only the installed style sheet has), not a checkout's");
	const absentSnapshot = await one.get("/api/v0/snapshot");
	check(absentSnapshot.status === 200 && JSON.parse(absentSnapshot.body).timeline.source.condition.state === "absent", "the snapshot API answers, and reports the absent store as absent");
	const refusals = [
		["another capability", await one.send(`/${"x".repeat(43)}/api/v0/snapshot`), 404],
		["no capability", await one.send("/api/v0/snapshot"), 404],
		["a foreign Origin", await one.get("/api/v0/snapshot", { Origin: "http://evil.example" }), 403],
		["a cross-site fetch", await one.get("/api/v0/snapshot", { "Sec-Fetch-Site": "cross-site" }), 403],
		["another Host", await one.get("/api/v0/snapshot", { Host: "evil.example" }), 421],
		["a POST", await one.send(`/${one.capability}/api/v0/snapshot`, { method: "POST" }), 405],
	];
	const unrefused = refusals.filter(([, reply, status]) => reply.status !== status).map(([what, reply]) => `${what}: ${reply.status}`);
	check(unrefused.length === 0, `wrong capability, no capability, foreign origin, cross-site fetch, wrong host and wrong method are refused as before${unrefused.length ? ` (${unrefused.join("; ")})` : ""}`);
	check(
		existsSync(studioKey) && permissions(studioKey) === 0o600 && permissions(dirname(studioKey)) === 0o700 && !existsSync(installKey),
		"Studio created its own key, owner-only in an owner-only directory, and not the installation key",
	);
	check(!existsSync(absentRoot) && !existsSync(dirname(absentRoot)), "the absent store is still absent, and so is its parent");
	const studioKeyBytes = readFileSync(studioKey);
	const stopped = await one.stop("SIGTERM");
	check(stopped.code === 0 && stopped.signal === null, "SIGTERM stops Studio by itself with exit status 0");
	check(!(await listening(one.port)), "the port is released when Studio exits");
	check(one.stdout().split(one.capability).length === 2 && !one.stderr().includes(one.capability), "the capability appears once in everything Studio printed, and only on stdout");

	// A taken port is a failed start: exit 1, no address, no key rewritten, and the store still absent.
	const holder = createServer();
	await new Promise((ready) => holder.listen(0, "127.0.0.1", ready));
	const takenPort = holder.address().port;
	const clash = spawnSync(process.execPath, [...noStripFlags, bin, "studio", "--root", absentRoot, "--port", String(takenPort)], { cwd: cwdA, env, encoding: "utf8", timeout: 30_000 });
	await new Promise((closed) => holder.close(closed));
	check(
		clash.status === 1 && clash.stdout === "" && clash.stderr.includes(`port ${takenPort} is already in use`) && !/[A-Za-z0-9_-]{43}/.test(clash.stderr),
		"a taken port is a failed start: exit 1, nothing on stdout, a plain sentence, no address",
	);
	check(readFileSync(studioKey).equals(studioKeyBytes) && !existsSync(absentRoot) && !existsSync(dirname(absentRoot)), "the failed start left Studio's key as it was and the absent store absent");

	// 8. The installed Pi loop, against a prepared (fake, clearly not real) Pi and a local fake model endpoint: no credentials,
	// no provider. Runs after the no-state check above because it creates the default store. The harness helpers are test
	// fixtures read through this script's own Node (type stripping on); the installed endo still runs with stripping off.
	const { installFakePi } = await import("../tests/fixtures/fake-pi/install.ts");
	const { startFakeOpenAiServer } = await import("../tests/fixtures/fake-openai-server.ts");
	const fakePi = realPi
		? { bin: process.env.ENDO_ACCEPT_PI, remove() {} }
		: installFakePi("1.0.0", join(scratch, "pi-prefix"));
	if (!realPi) fakePi.setScenario("model-endpoint");
	const provider = realPi ? "endofake" : "fake";
	console.log(realPi ? `loop subject: REAL Pi at ${fakePi.bin}, expected version ${process.env.ENDO_ACCEPT_PI_VERSION}` : "loop subject: the fake Pi fixture (not Pi)");
	const model = await startFakeOpenAiServer({ chunkMs: 2, slowChunkMs: 5 });
	try {
		const agentDir = join(scratch, "pi-agent");
		const work = join(scratch, "pi-work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(work, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { [provider]: { baseUrl: model.baseUrl, api: "openai-completions", apiKey: "local", models: [{ id: "fake-1" }] } } }),
		);
		const piEnv = {
			...env,
			PI_CODING_AGENT_DIR: agentDir,
			...(realPi ? { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } : {}),
		};
		// Asynchronous: the fake model endpoint lives in this process and must keep serving while endo runs.
		const loop = (args) =>
			new Promise((done) => {
				const child = spawn(process.execPath, [...noStripFlags, bin, ...args], { cwd: cwdB, env: piEnv });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.stderr.on("data", (chunk) => (stderr += chunk));
				child.on("close", (status) => done({ status, stdout, stderr }));
			});
		const defaultStore = join(xdgData, "endophasia", "store");

		const diagnosed = await loop(["doctor", "--pi", fakePi.bin, "--json"]);
		const diagnosis = diagnosed.status === 0 ? JSON.parse(diagnosed.stdout) : null;
		check(diagnosis !== null && diagnosis.pi.status === "found" && diagnosis.store.source === "XDG_DATA_HOME", "loop 1: doctor finds the Pi and reports the default store");
		if (realPi) {
			const expected = process.env.ENDO_ACCEPT_PI_VERSION;
			check(
				diagnosis !== null && diagnosis.pi.reportedVersion === expected,
				`the real Pi reports exactly the pinned version ${expected} (got ${diagnosis?.pi.reportedVersion ?? "nothing"}); a drift fails the acceptance`,
			);
			check(diagnosis !== null && diagnosis.pi.identityConfidence === "strong", "the real Pi's identity is a strong fingerprint");
			console.log(`     version standing reported by doctor: ${diagnosis?.pi.versionStanding}`);
		}
		const checked = await loop(["harness", "check", "--pi", fakePi.bin]);
		check(checked.status === 0 && /using the default store/.test(checked.stderr) && existsSync(defaultStore), `loop 2: harness check records local evidence in the default store${checked.status === 0 ? "" : `: ${checked.stderr}`}`);
		const requestsBefore = model.requests.length;
		const attached = await loop(["harness", "attach", "--pi", fakePi.bin, "--cwd", work, "--provider", provider, "--model", "fake-1", "--prompt", "Say hello", "--wait", realPi ? "90000" : "20000"]);
		const session = attached.status === 0 ? JSON.parse(attached.stdout) : null;
		check(session !== null && typeof session.piSessionId === "string" && session.prompt.disposition === "started" && session.prompt.settled === true, `loop 3: attach records a session and reports the prompt accepted and the run settled${attached.status === 0 ? "" : `: ${attached.stderr}`}`);
		check(model.requests.length > requestsBefore, "loop 3: the Pi under test called the local fake model endpoint (no provider)");
		check(/note: a prompted agent session can call the model provider/.test(attached.stderr), "loop 3: attach states the provider-cost notice before prompting");
		check(session !== null && attached.stderr.includes(`Pi session id: ${session.piSessionId}`) && /endo trajectory show --root \S+ \S+/.test(attached.stderr), "loop 3: attach prints the session id and the next commands on stderr");
		const status8 = await loop(["harness", "status"]);
		check(status8.status === 0 && JSON.parse(status8.stdout).capabilityState !== null, "loop 4: harness status (default store) shows recorded capability state");
		const explicit = await loop(["harness", "status", "--root", defaultStore]);
		check(explicit.status === 0 && explicit.stdout === status8.stdout, "loop 4: --root on the default store gives the identical report");
		const both = await loop(["harness", "status", defaultStore, "--root", defaultStore]);
		check(both.status === 1 && /given twice/.test(both.stderr), "a root named twice is a usage error");
		const overview8 = await loop(["harness", "overview"]);
		const sessionStatus = overview8.status === 0 ? JSON.parse(overview8.stdout).overview.session.status : null;
		check(sessionStatus !== null && sessionStatus !== "UNAVAILABLE", `loop 5: harness overview shows the recorded session (${sessionStatus})`);
		const trajectory = session === null ? null : await loop(["trajectory", "show", session.piSessionId]);
		const projected = trajectory?.status === 0 ? JSON.parse(trajectory.stdout) : null;
		check(projected !== null, `loop 6: trajectory show projects the recorded session from the default store${trajectory?.status === 0 ? "" : `: ${trajectory?.stderr}`}`);
		check(projected !== null && JSON.stringify(projected).includes(session.piSessionId), "loop 6: the trajectory names the Pi session id attach reported");
		const compared = session === null ? null : await loop(["trajectory", "diff", defaultStore, session.piSessionId, defaultStore, session.piSessionId]);
		const diff = compared?.status === 0 ? JSON.parse(compared.stdout) : null;
		const verdicts = diff === null ? null : Object.fromEntries(["lifecycle", "toolCalls", "toolResults", "outcome"].map((layer) => [layer, diff.layers?.[layer]?.status]));
		// A layer the recording does not carry is UNAVAILABLE on both sides; what it must never say against itself is DIVERGED.
		check(
			verdicts !== null && verdicts.lifecycle === "EXACT" && !Object.values(verdicts).includes("DIVERGED") && !Object.values(verdicts).includes(undefined),
			`loop 7: trajectory diff of the recorded session against itself: lifecycle EXACT, nothing diverged (${verdicts === null ? compared?.stderr : JSON.stringify(verdicts)})`,
		);

		// 9. Studio over the store that loop just recorded, with no root named: the default store, and its own key reused.
		const storeBefore = fingerprint(defaultStore);
		const keyBefore = readFileSync(studioKey);
		// An abrupt end (SIGKILL: no handler runs) must leave the store and the key as they were and the port free.
		const killed = await launch([], cwdB, piEnv);
		check((await killed.get("/api/v0/snapshot")).status === 200, "the Studio about to be killed has just read the store");
		// A burst of reads, and the kill as soon as the first of them has been answered, so that the process ends while it is serving. There
		// is no way to see inside a read from outside the process (and the server has no test hook), so how many requests were still
		// unanswered is reported, not asserted: it depends on timing.
		const burst = Array.from({ length: 24 }, () => killed.get("/api/v0/snapshot").then((r) => r.status, () => null));
		await Promise.race([...burst.map((request) => request.then((status) => (status === null ? new Promise(() => {}) : status))), Promise.all(burst)]);
		killed.kill();
		const outcomes = await Promise.all(burst);
		console.log(`info SIGKILL landed after the first of ${burst.length} concurrent reads was answered: ${outcomes.filter((o) => o === 200).length} answered, ${outcomes.filter((o) => o === null).length} cut off`);
		const killedExit = await killed.exited;
		check(killedExit.signal === "SIGKILL" && !(await listening(killed.port)), "a Studio killed outright (SIGKILL) releases its port");
		check(fingerprint(defaultStore).join("\n") === storeBefore.join("\n") && readFileSync(studioKey).equals(keyBefore), "and leaves the recorded store and Studio's key byte-for-byte as they were");
		const two = await launch([], cwdB, piEnv);
		check(storeBefore.length > 0, "the default store holds the recorded session Studio will read");
		check(two.stderr().includes(`using the default store ${defaultStore} (XDG_DATA_HOME)`), "with no root named, Studio reads the default store and says which on stderr");
		check(readFileSync(studioKey).equals(studioKeyBytes) && !/created Studio's own digest key/.test(two.stderr()), "Studio's key is reused as it was, byte for byte");
		const recorded = JSON.parse((await two.get("/api/v0/snapshot")).body);
		check(
			recorded.timeline.source.condition.state === "readable" && recorded.timeline.entries.length > 0 && recorded.runtimes.length >= 1,
			`the snapshot API serves the recorded observations (${recorded.timeline.entries.length} events, ${recorded.runtimes.length} attachment${recorded.runtimes.length === 1 ? "" : "s"})`,
		);
		// A real browser, when this machine has one: the installed page loads, reads, and draws what was recorded, requesting nothing
		// outside the server that served it.
		const { Browser, findBrowser } = await import("../tests/cockpit-browser.ts");
		const chrome = findBrowser();
		if (chrome === null && requireBrowser) check(false, "the installed page in a real browser: ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
		else if (chrome === null) console.log("skip  the installed page in a real browser: no Chromium found (set CHROME_BIN to run it)");
		else {
			console.log(`browser: ${chrome} ${spawnSync(chrome, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout.trim()}`);
			const browser = await Browser.launch(chrome);
			try {
				const tab = await browser.open(1440, 900);
				await tab.goto(two.address);
				await tab.waitFor("document.body.dataset.state === 'ready'", 30_000);
				const rows = await tab.eval(`document.querySelectorAll("#timeline tr[data-seq]").length`);
				const title = await tab.eval("document.title");
				const outside = tab.seen.requests.filter((url) => !url.startsWith(two.origin) && !url.startsWith("about:") && !url.startsWith("data:"));
				check(title === "Endophasia Studio" && rows > 0, `the installed page, in a real browser, reads the store and draws its ${rows} recorded events`);
				check(tab.seen.problems.length === 0 && outside.length === 0, `no console error, policy violation or request outside the server (${tab.seen.problems.length} problems, ${outside.length} outside requests)`);
				await tab.close();
			} finally {
				await browser.close();
			}
		}
		for (const name of ["SIGINT", "SIGINT"]) two.signal(name); // a repeat while it closes is absorbed
		const second = await two.exited;
		check(second.code === 0 && second.signal === null && !(await listening(two.port)), "SIGINT (sent twice) stops Studio with exit status 0 and releases the port");
		check(fingerprint(defaultStore).join("\n") === storeBefore.join("\n"), "the recorded store is byte-for-byte unchanged after Studio read it");
		check(two.stdout().split(two.capability).length === 2 && !two.stderr().includes(two.capability), "the second launch printed its address once, on stdout only");

	// 6b. The Studio frontend through the installed `endo studio`, in a real browser, over stores seeded for it (the helpers that seed them
	// are this checkout's test fixtures; the installed command only reads what they wrote): a populated store, an absent one, and one
	// whose log has a torn tail, which is what the narrow-width dialog must carry a warning about. Each is held to the same questions as
	// the checkout's own browser suite (tests/studio-ui-acceptance.ts).
	if (hasStudioUi) {
		const { Browser, findBrowser } = await import("../tests/cockpit-browser.ts");
		const { exerciseStudioUi, exerciseStudioUiNarrow } = await import("../tests/studio-ui-acceptance.ts");
		const { ingestAll, lifecycleEvents, seedRegistry } = await import("../tests/cockpit-fixtures.ts");
		const { endoFrameBytesV0 } = await import("../storage/log.ts");
		const seeded = (name, { torn = false } = {}) => {
			const root = join(scratch, name);
			ingestAll(root, lifecycleEvents("completes"));
			seedRegistry(root);
			if (torn) appendFileSync(join(root, "events", "events.log"), endoFrameBytesV0(new TextEncoder().encode(JSON.stringify({ kind: "tool.started" }))).subarray(0, 21));
			return root;
		};
		const events = lifecycleEvents("completes");
		const chromeForUi = findBrowser();
		if (chromeForUi === null && requireBrowser) check(false, "the installed frontend in a real browser: ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
		else if (chromeForUi === null) console.log("skip  the installed frontend in a real browser: no Chromium found (set CHROME_BIN to run it)");
		else {
			const browser = await Browser.launch(chromeForUi);
			try {
				const populated = await launch(["--root", seeded("studio-populated")]);
				const results = await exerciseStudioUi(browser, populated.address, populated.origin, { store: "populated", events: events.length, firstKind: "harness.store-opened" });
				check(results.failures.length === 0, `the installed frontend, over a populated store, in a real browser: renders the shell, the overview, the table, the runtime and the inspector from the recorded events, loads its script, style sheet, lazy module and fonts, requests nothing outside the server and breaks no policy (${results.facts.requests.length} requests)${results.failures.length ? `: ${results.failures.join("; ")}` : ""}`);
				const gone = await populated.stop("SIGINT");
				check(gone.code === 0 && !populated.stderr().includes(populated.capability), "SIGINT stops the populated launch with exit 0, and its stderr never carries the capability");

				const absent = await launch(["--root", join(scratch, "studio-absent-browser", "store")]);
				const absence = await exerciseStudioUi(browser, absent.address, absent.origin, { store: "absent" });
				check(absence.failures.length === 0, `the installed frontend, over an absent store, shows absence as absence${absence.failures.length ? `: ${absence.failures.join("; ")}` : ""}`);
				await absent.stop("SIGINT");

				const torn = await launch(["--root", seeded("studio-torn", { torn: true })]);
				const narrow = await exerciseStudioUiNarrow(browser, torn.address);
				check(narrow.length === 0, `at 420px the installed frontend carries a degraded source into its inspector dialog, closes it on Escape and returns focus${narrow.length ? `: ${narrow.join("; ")}` : ""}`);
				await torn.stop("SIGINT");
			} finally {
				await browser.close();
			}
		}
	}
	} finally {
		await model.close();
		fakePi.remove();
	}
} catch (error) {
	// A failure after a launch can carry what a child printed, and a failed CI log is a test artifact: the address is removed first.
	const raw = error instanceof Error ? error.message : String(error);
	check(false, `smoke aborted: ${studios.reduce((text, child) => child.redact(text), raw)}`);
} finally {
	for (const child of studios) child.kill(); // nothing outlives the run, and nothing holds the scratch directory open
	if (packageSpec === null) rmSync(join(repo, "dist", "zz-stale-output.js"), { force: true }); // the marker of the stale-output check, if the run ended before the build removed it; an artifact run never wrote it, so it never touches the checkout
	rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\npackage smoke passed");
