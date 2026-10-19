// Build the cockpit page: compile cockpit-ui/src with tsc to ordinary ES modules, and put them with the page, the style sheet and
// the icon in one flat directory (default cockpit-ui/dist) that the launcher serves from memory. Nothing is bundled and no
// dependency is added; the browser loads the modules as written. tsc also emits the protocol modules the page imports only as
// types; they are dropped here (a type import leaves nothing in the JavaScript).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Build into `outDir` (replacing it). Returns the directory. */
export function buildCockpitUi(outDir = join(root, "cockpit-ui", "dist")) {
	const scratch = mkdtempSync(join(tmpdir(), "endo-cockpit-ui-"));
	try {
		const tsc = spawnSync(
			process.execPath,
			[join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "cockpit-ui/tsconfig.build.json"), "--outDir", scratch],
			{ stdio: "inherit" },
		);
		if (tsc.status !== 0) throw new Error("the cockpit UI did not compile");
		rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir, { recursive: true });
		const compiled = join(scratch, "cockpit-ui", "src");
		for (const name of readdirSync(compiled)) if (name.endsWith(".js")) copyFileSync(join(compiled, name), join(outDir, name));
		for (const name of ["index.html", "cockpit.css", "icon.svg"]) copyFileSync(join(root, "cockpit-ui", name), join(outDir, name));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = process.argv[2];
	buildCockpitUi(out);
}
