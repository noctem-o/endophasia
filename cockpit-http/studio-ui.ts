// The check the host makes of the bundled Studio frontend (scripts/build-studio-ui.mjs) before it is served: the directory must be
// exactly its manifest, file for file and byte for byte, and every reference its files make must be to a file beside them. Pure
// with respect to the environment: it reads one directory, writes nothing, touches no key and no store. It is separate from
// host.ts so that the host's own imports stay the short list the lifecycle tests pin (it alone reaches the key files).

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The manifest the Studio frontend build writes beside its output (scripts/build-studio-ui.mjs): the one list of what may be served. */
export const ENDO_STUDIO_UI_MANIFEST_NAME_V0 = "studio-ui.manifest.json";
const STUDIO_UI_MANIFEST_FORMAT = "endo.studio-ui-manifest/v0";
/** The file types the frontend may contain. A font is `.woff2` only; no `.woff`, `.ttf`, source map or data file is admitted. */
const STUDIO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|js|css|svg|woff2)$/;
const STUDIO_MAX_FILES = 64;
const STUDIO_MAX_FILE_BYTES = 4 * 1024 * 1024;
const STUDIO_MAX_MANIFEST_BYTES = 64 * 1024;
/** Every reference the frontend's own files may make is `./<name>`, one of the listed files. */
const LOCAL_REFERENCE = /^\.\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const HTML_REFERENCE = /\b(?:src|href|action|data|poster|srcset|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\b/i;
const JS_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']*)\1/g;

const incomplete = (what: string): never => {
	throw new TypeError(`the Studio frontend is incomplete or damaged: ${what}`);
};

/**
 * Read the bundled Studio frontend from `directory` into memory and check it against its manifest before anything is served. The
 * directory must hold exactly the manifest and the files it lists: a file that is missing, extra, not a regular file, of another
 * size or sha256, or of a type the server does not serve is refused, and so is a page, style sheet or module that refers to
 * anything but one of those files by `./<name>`. The rest of the policy (no inline script, no remote request) is the browser's, under
 * the page policy; this check makes a broken or substituted build fail at start instead of in the operator's browser.
 */
export function loadEndoStudioUiFilesV0(directory: string): Record<string, Uint8Array> {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		throw new TypeError(`the Studio frontend was not found in ${directory}`);
	}
	const regular = (name: string): boolean => {
		try {
			return lstatSync(join(directory, name)).isFile();
		} catch {
			return false;
		}
	};
	if (!names.includes(ENDO_STUDIO_UI_MANIFEST_NAME_V0) || !regular(ENDO_STUDIO_UI_MANIFEST_NAME_V0))
		return incomplete(`${ENDO_STUDIO_UI_MANIFEST_NAME_V0} is missing`);
	const manifestBytes = readFileSync(join(directory, ENDO_STUDIO_UI_MANIFEST_NAME_V0));
	if (manifestBytes.length > STUDIO_MAX_MANIFEST_BYTES) return incomplete("the manifest is too large");
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch {
		return incomplete("the manifest is not JSON");
	}
	const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return incomplete("the manifest is malformed");
		const found = Object.keys(value).sort();
		if (found.length !== keys.length || found.some((key, index) => key !== keys[index]))
			return incomplete("the manifest is malformed");
		return value as Record<string, unknown>;
	};
	const top = record(manifest, ["entry", "files", "format"]);
	if (top.format !== STUDIO_UI_MANIFEST_FORMAT || top.entry !== "index.html")
		return incomplete("the manifest is of another format");
	const listed = top.files;
	if (!Array.isArray(listed) || listed.length === 0 || listed.length > STUDIO_MAX_FILES)
		return incomplete("the manifest lists no files or too many");
	const expected = new Map<string, { bytes: number; sha256: string }>();
	for (const item of listed) {
		const entry = record(item, ["bytes", "name", "sha256"]);
		const { name, bytes, sha256 } = entry;
		if (
			typeof name !== "string" ||
			// The server admits at most 64 characters for the whole name, extension included.
			name.length > 64 ||
			!STUDIO_FILE.test(name) ||
			typeof bytes !== "number" ||
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			bytes > STUDIO_MAX_FILE_BYTES ||
			typeof sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(sha256) ||
			expected.has(name)
		)
			return incomplete("the manifest lists a file it may not");
		expected.set(name, { bytes, sha256 });
	}
	if (!expected.has("index.html")) return incomplete("index.html is not listed");
	const present = names.filter((name) => name !== ENDO_STUDIO_UI_MANIFEST_NAME_V0);
	for (const name of present) if (!expected.has(name)) return incomplete(`${name} is present but not listed`);
	const files: Record<string, Uint8Array> = {};
	for (const [name, { bytes, sha256 }] of [...expected].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (!present.includes(name) || !regular(name)) return incomplete(`${name} is missing or not a regular file`);
		const content = readFileSync(join(directory, name));
		if (content.length !== bytes || createHash("sha256").update(content).digest("hex") !== sha256)
			return incomplete(`${name} does not match its manifest entry`);
		files[name] = content;
	}
	const text = (name: string): string => Buffer.from(files[name]!).toString("utf8");
	const check = (reference: string, from: string): void => {
		const name = LOCAL_REFERENCE.exec(reference)?.[1];
		if (name === undefined) incomplete(`${from} refers to something other than a file beside it`);
		else if (files[name] === undefined) incomplete(`${name} is missing (${from} needs it)`);
	};
	for (const name of Object.keys(files)) {
		if (name === "index.html") {
			const html = text(name);
			for (const [, ...captured] of html.matchAll(HTML_REFERENCE)) {
				const value = captured.find((part) => part !== undefined) ?? "";
				const asset = /^\.\/assets\/([^"/?#]+)$/.exec(value)?.[1];
				if (asset === undefined) incomplete("index.html refers to something other than ./assets/<name>");
				else check(`./${asset}`, "index.html");
			}
		} else if (name.endsWith(".css")) {
			const css = text(name);
			if (CSS_IMPORT.test(css)) incomplete(`${name} imports another style sheet`);
			for (const [, ...captured] of css.matchAll(CSS_URL))
				check(captured.find((part) => part !== undefined) ?? "", name);
		} else if (name.endsWith(".js")) {
			for (const [, , specifier] of text(name).matchAll(JS_SPECIFIER)) check(specifier!, name);
		}
	}
	return files;
}
