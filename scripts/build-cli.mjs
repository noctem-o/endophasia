// Build the distributable CLI: compile the import closure of cli/index.ts to dist/ (tsconfig.cli.json), copy the public synthetic
// fixture keys to where storage/digest-key.js resolves them (dist/research/fixture-keys/), and build the browser page `endo studio`
// serves into dist/cockpit-ui/ with the same builder `npm run cockpit` uses. The page is built last: the first step empties dist/.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCockpitUi } from "./build-cockpit-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(`${root}dist`, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, "-p", `${root}tsconfig.cli.json`], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
cpSync(`${root}research/fixture-keys`, `${root}dist/research/fixture-keys`, { recursive: true, filter: (src) => !src.endsWith(".md") });
buildCockpitUi(`${root}dist/cockpit-ui`);
chmodSync(`${root}dist/cli/index.js`, 0o755);
