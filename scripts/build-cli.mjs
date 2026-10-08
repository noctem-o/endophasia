// Build the distributable CLI: compile the import closure of cli/index.ts to dist/ (tsconfig.cli.json), then copy the
// public synthetic fixture keys to where storage/digest-key.js resolves them (dist/research/fixture-keys/).
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(`${root}dist`, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, "-p", `${root}tsconfig.cli.json`], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
cpSync(`${root}research/fixture-keys`, `${root}dist/research/fixture-keys`, { recursive: true, filter: (src) => !src.endsWith(".md") });
chmodSync(`${root}dist/cli/index.js`, 0o755);
