// Builds disposable "installations" of the fake Pi, shaped like an npm global install of Pi 1.0.0:
//   <prefix>/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
// with the package's package.json beside it. Tests "change the runtime" the way a user's package manager would: by
// rewriting the installed files. Endophasia's code under test never does any of this.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_PI_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");

export interface FakePiInstall {
	readonly prefix: string;
	readonly bin: string;
	readonly entrypoint: string;
	readonly packageJson: string;
	/** Rewrite the package version (what `--version` reports), keeping the entrypoint bytes. */
	setVersion(version: string): void;
	/** Change the entrypoint bytes, keeping the version (a local rebuild). */
	rebuild(marker: string): void;
	/** Set the installation's fault scenario (comma-separated, see cli.mjs); "" clears it. */
	setScenario(scenario: string): void;
	/** Make every start append the pinned-environment variables it saw to `path` (one JSON line). */
	setEnvLog(path: string): void;
	remove(): void;
}

export function installFakePi(
	version: string,
	prefix = mkdtempSync(join(tmpdir(), "fake-pi-install-")),
): FakePiInstall {
	const packageRoot = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	const entrypoint = join(packageRoot, "dist", "bundle", "cli.js");
	const packageJson = join(packageRoot, "package.json");
	const bin = join(prefix, "bin", "pi");
	mkdirSync(dirname(entrypoint), { recursive: true });
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(entrypoint, readFileSync(FAKE_PI_SOURCE));
	chmodSync(entrypoint, 0o755);
	const writeManifest = (v: string) =>
		writeFileSync(
			packageJson,
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: v, type: "module" }),
		);
	writeManifest(version);
	symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", bin);
	return {
		prefix,
		bin,
		entrypoint,
		packageJson,
		setVersion: writeManifest,
		rebuild(marker) {
			writeFileSync(entrypoint, `${readFileSync(FAKE_PI_SOURCE, "utf8")}\n// rebuilt: ${marker}\n`);
			chmodSync(entrypoint, 0o755);
		},
		setScenario: (scenario) => writeFileSync(join(packageRoot, "scenario"), scenario),
		setEnvLog: (path) => writeFileSync(join(packageRoot, "env-log"), path),
		remove: () => rmSync(prefix, { recursive: true, force: true }),
	};
}

/** The environment the fake Pi runs with in tests: PATH with node, plus the scenario. */
export function fakePiEnv(extra: Record<string, string> = {}): Record<string, string> {
	return { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...extra };
}
