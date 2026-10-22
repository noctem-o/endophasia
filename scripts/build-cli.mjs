// Build the distributable CLI: compile the import closure of cli/index.ts to dist/ (tsconfig.cli.json), copy the public synthetic
// fixture keys to where storage/digest-key.js resolves them (dist/research/fixture-keys/), and build the bundled React frontend `endo studio`
// serves (docs/studio-ui-architecture.md) into dist/studio-ui/ with the same builder `npm run cockpit` uses, with the licence notices of
// what it bundles beside it in dist/licenses/, outside the directory the server reads. The frontend is built last: the first step
// empties dist/.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStudioUi, studioUiNotices } from "./build-studio-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(`${root}dist`, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, "-p", `${root}tsconfig.cli.json`], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
cpSync(`${root}research/fixture-keys`, `${root}dist/research/fixture-keys`, { recursive: true, filter: (src) => !src.endsWith(".md") });
const studioUi = await buildStudioUi(`${root}dist/studio-ui`);
mkdirSync(`${root}dist/licenses`, { recursive: true });
writeFileSync(`${root}dist/licenses/studio-ui-third-party.txt`, studioUiNotices(studioUi.packages));
chmodSync(`${root}dist/cli/index.js`, 0o755);
