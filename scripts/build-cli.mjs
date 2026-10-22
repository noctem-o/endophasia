// Build the distributable CLI: compile the import closure of cli/index.ts to dist/ (tsconfig.cli.json), copy the public synthetic
// fixture keys to where storage/digest-key.js resolves them (dist/research/fixture-keys/), and build the browser page `endo studio`
// serves into dist/cockpit-ui/ with the same builder `npm run cockpit` uses. The page is built last: the first step empties dist/.
// The bundled React frontend (not served by `endo studio` yet; see docs/studio-ui-architecture.md) is built into dist/studio-ui/, with
// the licence notices of what it bundles beside it in dist/licenses/, outside the directory the server reads.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCockpitUi } from "./build-cockpit-ui.mjs";
import { buildStudioUi, studioUiNotices } from "./build-studio-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(`${root}dist`, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [`${root}node_modules/typescript/bin/tsc`, "-p", `${root}tsconfig.cli.json`], { stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
cpSync(`${root}research/fixture-keys`, `${root}dist/research/fixture-keys`, { recursive: true, filter: (src) => !src.endsWith(".md") });
buildCockpitUi(`${root}dist/cockpit-ui`);
const studioUi = await buildStudioUi(`${root}dist/studio-ui`);
mkdirSync(`${root}dist/licenses`, { recursive: true });
writeFileSync(`${root}dist/licenses/studio-ui-third-party.txt`, studioUiNotices(studioUi.packages));
chmodSync(`${root}dist/cli/index.js`, 0o755);
