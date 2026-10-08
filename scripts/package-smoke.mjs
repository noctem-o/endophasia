// Package smoke: build the tarball with `npm pack`, audit its inventory, install it (not a link, not the checkout)
// into a scratch directory with an isolated HOME/XDG, and run the installed `endo` under plain Node with TypeScript
// stripping disabled. Nothing here imports repository sources or calls a model provider. Exit status 1 on any failure.
//
//   node scripts/package-smoke.mjs        (npm run test:package)
//
// Scratch lives under $TMPDIR (or the OS temp directory) and is removed at the end.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node spells "do not strip TypeScript types" differently across versions; use the first spelling this Node accepts.
const noStripFlags =
	["--no-strip-types", "--no-experimental-strip-types"].filter(
		(flag) => spawnSync(process.execPath, [flag, "-e", "0"]).status === 0,
	).slice(0, 1);
console.log(`node ${process.version}; TypeScript stripping disabled with: ${noStripFlags[0] ?? "(no flag accepted; relying on the .ts-free inventory check)"}`);
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
		spawnSync(process.execPath, [...noStripFlags, bin, ...args], { cwd, env, encoding: "utf8" });
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

	// 8. The installed Pi loop, against a prepared (fake, clearly not real) Pi and a local fake model endpoint: no credentials,
	// no provider. Runs after the no-state check above because it creates the default store. The harness helpers are test
	// fixtures read through this script's own Node (type stripping on); the installed endo still runs with stripping off.
	const { installFakePi } = await import("../tests/fixtures/fake-pi/install.ts");
	const { startFakeOpenAiServer } = await import("../tests/fixtures/fake-openai-server.ts");
	const fakePi = installFakePi("1.0.0", join(scratch, "pi-prefix"));
	fakePi.setScenario("model-endpoint");
	const model = await startFakeOpenAiServer({ chunkMs: 2, slowChunkMs: 5 });
	try {
		const agentDir = join(scratch, "pi-agent");
		const work = join(scratch, "pi-work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(work, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { fake: { baseUrl: model.baseUrl, api: "openai-completions", apiKey: "local", models: [{ id: "fake-1" }] } } }),
		);
		const piEnv = { ...env, PI_CODING_AGENT_DIR: agentDir };
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
		check(diagnosis !== null && diagnosis.pi.status === "found" && diagnosis.store.source === "XDG_DATA_HOME", "loop 1: doctor finds the prepared Pi and reports the default store");
		const checked = await loop(["harness", "check", "--pi", fakePi.bin]);
		check(checked.status === 0 && /using the default store/.test(checked.stderr) && existsSync(defaultStore), `loop 2: harness check records local evidence in the default store${checked.status === 0 ? "" : `: ${checked.stderr}`}`);
		const requestsBefore = model.requests.length;
		const attached = await loop(["harness", "attach", "--pi", fakePi.bin, "--cwd", work, "--provider", "fake", "--model", "fake-1", "--prompt", "Say hello", "--wait", "20000"]);
		const session = attached.status === 0 ? JSON.parse(attached.stdout) : null;
		check(session !== null && typeof session.piSessionId === "string" && session.prompt.disposition === "started" && session.prompt.settled === true, `loop 3: attach records a session and reports the prompt accepted and the run settled${attached.status === 0 ? "" : `: ${attached.stderr}`}`);
		check(model.requests.length > requestsBefore, "loop 3: the prepared Pi called the local fake model endpoint (no provider)");
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
	} finally {
		await model.close();
		fakePi.remove();
	}
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
