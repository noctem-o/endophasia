// Build the Studio frontend foundation: bundle studio-ui/src (React, TypeScript) with esbuild into one flat directory of
// content-hashed files that the launcher serves from memory, write the page that references them, and write a manifest that lists
// every file with its size and sha256. The host (cockpit-http/host.ts) refuses a directory that does not match its manifest, so a
// damaged, partial or tampered install fails before anything listens.
//
// Why esbuild and not Vite: the production server serves a flat, closed set of files at /<capability>/assets/<name>, and checks the
// page's own references. esbuild gives exactly that with one dependency: flat output names, no HTML transform, no generated preload
// or CSS-injection helper, no absolute base, and a metafile that names every output. Nothing here runs at install time: the
// published package carries only the output.
//
//   node scripts/build-studio-ui.mjs [outDir]       (default studio-ui/dist)
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

export const STUDIO_UI_MANIFEST_NAME = "studio-ui.manifest.json";
export const STUDIO_UI_MANIFEST_FORMAT = "endo.studio-ui-manifest/v0";

/**
 * Build into `outDir` (replacing it). Returns the directory, the manifest and the packages whose code or font is in the output,
 * for the licence notices. The output is a function of the sources and of the pinned dependencies only: no timestamp, no absolute
 * path, no source map.
 */
export async function buildStudioUi(outDir = join(root, "studio-ui", "dist")) {
	const scratch = mkdtempSync(join(tmpdir(), "endo-studio-ui-"));
	try {
		const result = await build({
			absWorkingDir: root,
			entryPoints: { main: "studio-ui/src/main.tsx" },
			outdir: scratch,
			bundle: true,
			splitting: true,
			format: "esm",
			platform: "browser",
			target: "es2022",
			minify: true,
			sourcemap: false,
			legalComments: "none",
			jsx: "automatic",
			tsconfig: "studio-ui/tsconfig.json",
			entryNames: "[name]-[hash]",
			chunkNames: "[name]-[hash]",
			assetNames: "[name]-[hash]",
			loader: { ".woff2": "file" },
			// React reads this at run time; without it the browser would see `process` or get the development build.
			define: { "process.env.NODE_ENV": '"production"' },
			metafile: true,
			logLevel: "silent",
		});
		if (result.errors.length > 0) throw new Error("the Studio frontend did not compile");
		const outputs = Object.entries(result.metafile.outputs);
		const entry = outputs.find(([, meta]) => meta.entryPoint === "studio-ui/src/main.tsx");
		const style = entry?.[1].cssBundle;
		if (entry === undefined || style === undefined) throw new Error("the Studio frontend produced no entry script or style sheet");
		const page = readFileSync(join(root, "studio-ui", "index.html"), "utf8")
			.replace("{{SCRIPT}}", basename(entry[0]))
			.replace("{{STYLE}}", basename(style));
		writeFileSync(join(scratch, "index.html"), page);
		copyFileSync(join(root, "studio-ui", "icon.svg"), join(scratch, "icon.svg"));
		const files = readdirSync(scratch)
			.sort()
			.map((name) => {
				const bytes = readFileSync(join(scratch, name));
				return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
			});
		const manifest = { format: STUDIO_UI_MANIFEST_FORMAT, entry: "index.html", files };
		const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
		writeFileSync(join(scratch, STUDIO_UI_MANIFEST_NAME), manifestText);
		const target = resolve(outDir);
		const alreadyIdentical = (() => {
			try {
				if (!existsSync(join(target, STUDIO_UI_MANIFEST_NAME))) return false;
				if (readFileSync(join(target, STUDIO_UI_MANIFEST_NAME), "utf8") !== manifestText) return false;
				const expectedNames = [...files.map((f) => f.name), STUDIO_UI_MANIFEST_NAME].sort();
				if (readdirSync(target).sort().join("\0") !== expectedNames.join("\0")) return false;
				return files.every((f) => {
					const bytes = readFileSync(join(target, f.name));
					return bytes.length === f.bytes && createHash("sha256").update(bytes).digest("hex") === f.sha256;
				});
			} catch {
				return false;
			}
		})();
		if (!alreadyIdentical) {
			const parent = dirname(target);
			mkdirSync(parent, { recursive: true });
			const tag = `${process.pid}-${randomBytes(6).toString("hex")}`;
			const stage = join(parent, `.${basename(target)}.stage-${tag}`);
			const stale = join(parent, `.${basename(target)}.old-${tag}`);
			mkdirSync(stage, { recursive: true });
			try {
				for (const name of readdirSync(scratch)) copyFileSync(join(scratch, name), join(stage, name));
				if (existsSync(target)) {
					try {
						renameSync(target, stale);
					} catch {
						rmSync(target, { recursive: true, force: true });
					}
				}
				renameSync(stage, target);
			} catch (error) {
				rmSync(stage, { recursive: true, force: true });
				if (!existsSync(target) && existsSync(stale)) {
					try {
						renameSync(stale, target);
					} catch {}
				}
				throw error;
			} finally {
				rmSync(stale, { recursive: true, force: true });
			}
		}
		const packages = new Set();
		for (const [, meta] of outputs)
			for (const input of Object.keys(meta.inputs)) {
				const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
				if (match) packages.add(match[1]);
			}
		return { outDir, manifest, packages: [...packages].sort() };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The licence notices of the third-party code and font in the output, as one text: each package's name, version and licence file as
 * published. The bundle drops the licence comments of the code it includes, so this file is what carries them.
 */
export function studioUiNotices(packages) {
	const parts = [
		"Third-party code and fonts included in the Studio frontend (dist/studio-ui).\n" +
			"Each section is the package's licence as published with it.\n",
	];
	for (const name of packages) {
		const directory = join(root, "node_modules", name);
		const { version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		const licenceFile = readdirSync(directory).find((file) => /^licen[sc]e(\.|$)/i.test(file));
		if (licenceFile === undefined) throw new Error(`${name} has no licence file to carry`);
		parts.push(`\n----\n${name}@${version}\n----\n${readFileSync(join(directory, licenceFile), "utf8").trim()}\n`);
	}
	return parts.join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = process.argv[2];
	const built = await buildStudioUi(out);
	console.log(`built ${built.manifest.files.length} files into ${relative(process.cwd(), built.outDir) || "."}`);
}
