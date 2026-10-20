// The host of the cockpit server (cockpit-http/host.ts): the page's completeness check, the order of a launch, the dedicated key and
// the stop handling, with nothing but explicit inputs: the development launcher and `endo studio` are thin callers of it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type EndoCockpitLaunchedV0,
	launchEndoCockpitV0,
	loadEndoCockpitUiFilesV0,
	serveUntilSignalV0,
} from "../cockpit-http/host.ts";
import { ingestAll, lifecycleEvents, removeTempRoots, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { get, send } from "./cockpit-http-fixtures.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "endo-studio-host-"));
let ui = "";
const launched: EndoCockpitLaunchedV0[] = [];

beforeAll(() => {
	ui = join(scratch, "ui");
	const built = spawnSync(process.execPath, [join(repo, "scripts/build-cockpit-ui.mjs"), ui], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`the UI did not build: ${built.stderr}`);
}, 90_000);
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(launched.splice(0).map((one) => one.server.close()));
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});

const hashes = (dir: string): string[] => {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d).sort()) {
			const path = join(d, name);
			if (statSync(path).isDirectory()) {
				out.push(`${relative(dir, path)}/`);
				walk(path);
			} else out.push(`${relative(dir, path)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(dir);
	return out;
};

/** A copy of the built page in a fresh directory, without the named files. */
function pageWithout(...omit: string[]): string {
	const dir = mkdtempSync(join(scratch, "page-"));
	for (const name of readdirSync(ui))
		if (!omit.includes(name)) writeFileSync(join(dir, name), readFileSync(join(ui, name)));
	return dir;
}

async function start(root: string, keyFile: string, extra: object = {}): Promise<EndoCockpitLaunchedV0> {
	const one = await launchEndoCockpitV0({ root, keyFile, uiDirectory: ui, ...extra });
	launched.push(one);
	return one;
}

function populated(): string {
	const root = tempRoot();
	ingestAll(root, lifecycleEvents("completes"));
	seedRegistry(root);
	return root;
}

describe("the page is read whole, and an incomplete one is refused by name", () => {
	it("loads the built page: the entry, its modules, the style and the icon, as text", () => {
		const files = loadEndoCockpitUiFilesV0(ui);
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining(["index.html", "main.js", "cockpit.css", "icon.svg", "reply.js"]),
		);
		expect(Object.keys(files)).toEqual([...Object.keys(files)].sort());
		for (const [name, text] of Object.entries(files)) {
			expect(typeof text, name).toBe("string");
			expect(text, name).toBe(readFileSync(join(ui, name), "utf8"));
		}
	});

	it("refuses a page missing any one of its files, and says which: the entry, an asset, or a module another imports", () => {
		const names = readdirSync(ui);
		expect(names.length).toBeGreaterThan(10);
		for (const name of names) {
			const dir = pageWithout(name);
			// Every file of the page is needed by index.html or by a module that is, so none can be missing without a refusal.
			expect(() => loadEndoCockpitUiFilesV0(dir), name).toThrow(
				name === "index.html" ? /index\.html is missing/ : new RegExp(`${name.replace(/\./g, "\\.")} is missing`),
			);
		}
	});

	it("refuses a directory that is not there, an empty one and a checkout's source directory (no built entry module)", () => {
		expect(() => loadEndoCockpitUiFilesV0(join(scratch, "no-such-dir"))).toThrow(/was not found/);
		const empty = mkdtempSync(join(scratch, "empty-"));
		expect(() => loadEndoCockpitUiFilesV0(empty)).toThrow(/index\.html is missing/);
		expect(() => loadEndoCockpitUiFilesV0(join(repo, "cockpit-ui"))).toThrow(
			/main\.js is missing \(index\.html needs it\)/,
		);
	});

	it("takes only the files a page is made of: others, and a directory named like a module, are ignored", () => {
		const dir = pageWithout();
		writeFileSync(join(dir, "notes.txt"), "x");
		writeFileSync(join(dir, "main.js.map"), "{}");
		writeFileSync(join(dir, ".hidden.js"), "x");
		mkdirSync(join(dir, "folder.js"));
		writeFileSync(join(dir, "folder.js", "inner.js"), "x");
		expect(Object.keys(loadEndoCockpitUiFilesV0(dir))).toEqual(Object.keys(loadEndoCockpitUiFilesV0(ui)));
	});

	it("follows what the files really say: a reference to a module that is not there fails, however it is spelled", () => {
		for (const [edit, missing] of [
			[(t: string) => `${t}\nimport { x } from "./ghost.js";\n`, "ghost.js"],
			[(t: string) => `${t}\nawait import("./phantom.js");\n`, "phantom.js"],
			[(t: string) => `${t}\nimport "./side-effect.js";\n`, "side-effect.js"],
		] as const) {
			const dir = pageWithout();
			writeFileSync(join(dir, "main.js"), edit(readFileSync(join(ui, "main.js"), "utf8")));
			expect(() => loadEndoCockpitUiFilesV0(dir)).toThrow(
				new RegExp(`${missing.replace(".", "\\.")} is missing \\(main\\.js needs it\\)`),
			);
		}
		const html = pageWithout();
		writeFileSync(
			join(html, "index.html"),
			readFileSync(join(ui, "index.html"), "utf8").replace("./assets/icon.svg", "./assets/other.svg"),
		);
		expect(() => loadEndoCockpitUiFilesV0(html)).toThrow(/other\.svg is missing \(index\.html needs it\)/);
	});
});

describe("a launch, in order", () => {
	it("checks the page before it touches the key: an incomplete page leaves no key and nothing listening", async () => {
		const keyFile = join(scratch, "k-incomplete", "studio.key");
		await expect(
			launchEndoCockpitV0({ root: tempRoot(), keyFile, uiDirectory: pageWithout("main.js") }),
		).rejects.toThrow(/main\.js is missing/);
		expect(existsSync(keyFile)).toBe(false);
		expect(existsSync(join(scratch, "k-incomplete"))).toBe(false);
	});

	it("creates the key on first use, owner-only, reports it before listening, and reuses the same bytes afterwards", async () => {
		const keyFile = join(scratch, "k-first", "nested", "studio.key");
		const seen: { path: string; created: boolean }[] = [];
		const first = await start(populated(), keyFile, {
			onKey: (key: { path: string; created: boolean }) => seen.push(key),
		});
		expect(seen).toEqual([{ path: keyFile, created: true }]);
		expect(first.key).toEqual({ path: keyFile, created: true });
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		expect(statSync(join(scratch, "k-first", "nested")).mode & 0o777).toBe(0o700);
		const bytes = readFileSync(keyFile);
		await first.server.close();
		const again = await start(populated(), keyFile);
		expect(again.key.created).toBe(false);
		expect(readFileSync(keyFile).equals(bytes)).toBe(true);
	});

	it("reports a key it wrote even when the launch then fails to listen (the one write must not be silent)", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const { port } = blocker.address() as { port: number };
		const keyFile = join(scratch, "k-busy", "studio.key");
		const seen: boolean[] = [];
		await expect(
			launchEndoCockpitV0({
				root: tempRoot(),
				keyFile,
				uiDirectory: ui,
				port,
				onKey: (key) => seen.push(key.created),
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
		expect(seen).toEqual([true]);
		expect(existsSync(keyFile)).toBe(true);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
	});

	it("uses the dedicated key beside the installation key by default, and never the installation key itself", async () => {
		const data = join(scratch, "xdg-default");
		vi.stubEnv("XDG_DATA_HOME", data);
		vi.stubEnv("ENDO_DIGEST_KEY_FILE", "");
		const one = await launchEndoCockpitV0({ root: tempRoot(), uiDirectory: ui });
		launched.push(one);
		expect(one.key.path).toBe(join(data, "endophasia", "cockpit-digest-key"));
		expect(readdirSync(join(data, "endophasia"))).toEqual(["cockpit-digest-key"]);
		await one.server.close();
		// The installation key's own path, spelled directly or through a link, is refused, and nothing is created for it.
		const installation = join(data, "endophasia", "digest-key");
		await expect(launchEndoCockpitV0({ root: tempRoot(), keyFile: installation, uiDirectory: ui })).rejects.toThrow(
			/installation key/,
		);
		expect(existsSync(installation)).toBe(false);
		writeFileSync(installation, readFileSync(one.key.path));
		const link = join(scratch, "link-to-installation");
		symlinkSync(installation, link);
		await expect(launchEndoCockpitV0({ root: tempRoot(), keyFile: link, uiDirectory: ui })).rejects.toThrow(
			/installation key/,
		);
		const viaDots = join(data, "endophasia", "..", "endophasia", "digest-key");
		await expect(launchEndoCockpitV0({ root: tempRoot(), keyFile: viaDots, uiDirectory: ui })).rejects.toThrow(
			/installation key/,
		);
	});

	it("refuses the installation key under any other name: through a linked parent directory when it does not exist yet, and as a hard link when it does", async () => {
		const data = join(scratch, "xdg-alias");
		vi.stubEnv("XDG_DATA_HOME", data);
		vi.stubEnv("ENDO_DIGEST_KEY_FILE", "");
		const dir = join(data, "endophasia");
		mkdirSync(dir, { recursive: true });
		const installation = join(dir, "digest-key");
		// Missing: a directory link to the installation directory, the key named through it.
		const alias = join(scratch, "alias-of-installation-dir");
		symlinkSync(dir, alias);
		await expect(
			launchEndoCockpitV0({ root: tempRoot(), keyFile: join(alias, "digest-key"), uiDirectory: ui }),
		).rejects.toThrow(/installation key/);
		const deeper = join(scratch, "alias-of-data");
		symlinkSync(data, deeper);
		await expect(
			launchEndoCockpitV0({ root: tempRoot(), keyFile: join(deeper, "endophasia", "digest-key"), uiDirectory: ui }),
		).rejects.toThrow(/installation key/);
		expect(existsSync(installation)).toBe(false); // refused before anything was created
		// Existing: a second name for the same file, which no spelling of the path shows.
		writeFileSync(installation, '{"schemaVersion":"endo.digest-key.v0"}\n');
		const hard = join(scratch, "hard-link-to-installation");
		linkSync(installation, hard);
		await expect(launchEndoCockpitV0({ root: tempRoot(), keyFile: hard, uiDirectory: ui })).rejects.toThrow(
			/installation key/,
		);
		// A different file in the same directory is fine.
		const own = await start(tempRoot(), join(dir, "cockpit-digest-key"));
		expect(own.key.created).toBe(true);
	});

	it("refuses a key file inside the store it reads, however the two are spelled, before it makes anything", async () => {
		const parent = join(scratch, "store-parent");
		const root = join(parent, "recordings"); // does not exist: the store is absent
		const viaLink = join(scratch, "link-to-store-parent");
		mkdirSync(parent, { recursive: true });
		symlinkSync(parent, viaLink);
		const inside = [
			join(root, "studio.key"),
			join(root, "a", "b", "studio.key"),
			join(root, "..", "recordings", "studio.key"),
			join(viaLink, "recordings", "studio.key"), // the store's parent reached through a link
		];
		for (const keyFile of inside) {
			await expect(launchEndoCockpitV0({ root, keyFile, uiDirectory: ui }), keyFile).rejects.toThrow(
				/inside the store Studio reads/,
			);
			expect(existsSync(root), keyFile).toBe(false);
		}
		// The store named through the link and the key by its real path is the same place.
		await expect(
			launchEndoCockpitV0({ root: join(viaLink, "recordings"), keyFile: join(root, "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		expect(existsSync(root)).toBe(false);
		// The store itself named as the key file is refused too (a key file cannot be the store).
		await expect(launchEndoCockpitV0({ root, keyFile: root, uiDirectory: ui })).rejects.toThrow(/inside the store/);
		// Beside the store, even with a name that shares its prefix, is not inside it.
		const sibling = await start(root, join(parent, "recordings-keys", "studio.key"));
		expect(sibling.key.created).toBe(true);
		expect(existsSync(root)).toBe(false);
	});

	it("follows ENDO_DIGEST_KEY_FILE for the installation key and keeps its own key beside it", async () => {
		const installation = join(scratch, "elsewhere", "inst-key");
		vi.stubEnv("ENDO_DIGEST_KEY_FILE", installation);
		const one = await launchEndoCockpitV0({ root: tempRoot(), uiDirectory: ui });
		launched.push(one);
		expect(one.key.path).toBe(join(scratch, "elsewhere", "cockpit-digest-key"));
		expect(existsSync(installation)).toBe(false);
	});

	it("follows a link whose target is not there yet: a store reached through a dangling link, or an installation key under one, is still refused", async () => {
		const base = join(scratch, "dangling");
		mkdirSync(base, { recursive: true });
		// The store is named through a link to a directory that does not exist; the key is named under the link's target.
		const storeLink = join(base, "store-link");
		const absentStore = join(base, "absent-store");
		symlinkSync(absentStore, storeLink);
		await expect(
			launchEndoCockpitV0({ root: storeLink, keyFile: join(absentStore, "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		await expect(
			launchEndoCockpitV0({ root: absentStore, keyFile: join(storeLink, "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		expect(existsSync(absentStore)).toBe(false); // nothing was created through the link
		// The installation key's directory is a dangling link, and the key is named by the link's target.
		const data = join(base, "xdg");
		const target = join(base, "installation-dir-not-there");
		mkdirSync(data, { recursive: true });
		symlinkSync(target, join(data, "endophasia"));
		vi.stubEnv("XDG_DATA_HOME", data);
		vi.stubEnv("ENDO_DIGEST_KEY_FILE", "");
		await expect(
			launchEndoCockpitV0({ root: tempRoot(), keyFile: join(target, "digest-key"), uiDirectory: ui }),
		).rejects.toThrow(/installation key/);
		expect(existsSync(target)).toBe(false);
	});

	it("resolves a link before it applies `..`, as the file system does: a link, then `..`, then a name reaches the link target's parent", async () => {
		const base = join(scratch, "dotdot");
		mkdirSync(join(base, "target", "nested"), { recursive: true });
		symlinkSync(join(base, "target", "nested"), join(base, "link")); // link -> target/nested
		const storeLink = join(base, "store-link");
		symlinkSync("link/../store", storeLink); // the literal text (join would collapse it): store-link -> link/../store, which is target/store, not base/store
		const realStore = join(base, "target", "store");
		await expect(
			launchEndoCockpitV0({ root: storeLink, keyFile: join(realStore, "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		expect(existsSync(realStore)).toBe(false);
		expect(existsSync(join(base, "store"))).toBe(false);
		// A key that is truly beside that store, not inside it, is fine.
		const beside = await start(storeLink, join(base, "target", "keys", "studio.key"));
		expect(beside.key.created).toBe(true);
		expect(existsSync(realStore)).toBe(false);
		// `..` over directories that exist and over ones that do not.
		const lexical = join(base, "target", "x", "..", "store", "studio.key");
		await expect(launchEndoCockpitV0({ root: realStore, keyFile: lexical, uiDirectory: ui })).rejects.toThrow(
			/inside the store/,
		);
		const absentThenBack = join(base, "ghost", "..", "target", "store", "studio.key");
		await expect(launchEndoCockpitV0({ root: realStore, keyFile: absentThenBack, uiDirectory: ui })).rejects.toThrow(
			/inside the store/,
		);
	});

	it("gives the server the path itself, `..` collapsed as written like every command does, and checks the key against that same path", async () => {
		const base = join(scratch, "one-place");
		mkdirSync(join(base, "target", "nested"), { recursive: true });
		symlinkSync(join(base, "target", "nested"), join(base, "link")); // link -> target/nested
		const beside = join(base, "target", "store"); // where the file system alone would put `link/../store`
		const written = join(base, "store"); // where the root as written, `..` collapsed, puts it
		ingestAll(beside, lifecycleEvents("completes"));
		ingestAll(written, [lifecycleEvents("completes")[0]!]);
		const literal = `${base}/link/../store`; // a string, not join(): the `..` stays until Studio collapses it
		await expect(
			launchEndoCockpitV0({ root: literal, keyFile: join(written, "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		const one = await start(literal, join(base, "keys", "studio.key"));
		const entries = JSON.parse((await get(one.server, "/api/v0/snapshot")).body).timeline.entries.length;
		expect(entries).toBe(1); // the store as written, not the one beside it
		expect(existsSync(join(written, "studio.key"))).toBe(false);
	});

	it("leaves a store that is a dangling link to the reader as it is: unopenable, not absent, and no key goes through the link", async () => {
		const base = join(scratch, "dangling-root");
		mkdirSync(base, { recursive: true });
		const link = join(base, "store-link");
		symlinkSync(join(base, "missing-store"), link);
		const one = await start(link, join(base, "keys", "studio.key"));
		const timeline = JSON.parse((await get(one.server, "/api/v0/snapshot")).body).timeline;
		expect(timeline.source.condition.state).toBe("unopenable"); // the reader's own verdict, kept
		expect(existsSync(join(base, "missing-store"))).toBe(false);
		await one.server.close();
		await expect(
			launchEndoCockpitV0({ root: link, keyFile: join(base, "missing-store", "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/inside the store Studio reads/);
		expect(existsSync(join(base, "missing-store"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"treats a backslash as part of a name on POSIX, where it separates nothing",
		async () => {
			const base = join(scratch, "backslash");
			const store = join(base, "store");
			mkdirSync(store, { recursive: true });
			symlinkSync(store, join(base, "alias\\name")); // one file name, with a backslash in it
			await expect(
				launchEndoCockpitV0({ root: store, keyFile: `${base}/alias\\name/studio.key`, uiDirectory: ui }),
			).rejects.toThrow(/inside the store Studio reads/);
			expect(readdirSync(store)).toEqual([]);
		},
	);

	it("refuses a path whose place it cannot establish, instead of guessing: a link that loops", async () => {
		const base = join(scratch, "loop");
		mkdirSync(base, { recursive: true });
		symlinkSync(join(base, "b"), join(base, "a"));
		symlinkSync(join(base, "a"), join(base, "b"));
		await expect(
			launchEndoCockpitV0({ root: tempRoot(), keyFile: join(base, "a", "studio.key"), uiDirectory: ui }),
		).rejects.toThrow(/cannot tell where the cockpit key file lies/);
		await expect(
			launchEndoCockpitV0({
				root: join(base, "a"),
				keyFile: join(scratch, "k-loop", "studio.key"),
				uiDirectory: ui,
			}),
		).rejects.toThrow(/cannot tell where the store lies/);
		expect(existsSync(join(scratch, "k-loop"))).toBe(false);
	});

	it("takes a key file given by name where the environment names no home at all, and says what is missing where it needs one", async () => {
		for (const name of ["HOME", "XDG_DATA_HOME", "ENDO_DIGEST_KEY_FILE"]) vi.stubEnv(name, "");
		const keyFile = join(scratch, "k-bare", "studio.key");
		const one = await launchEndoCockpitV0({ root: populated(), keyFile, uiDirectory: ui });
		launched.push(one);
		expect(one.key).toEqual({ path: keyFile, created: true });
		// The default key lives beside the installation key, which this environment does not place: that is said, not guessed.
		await expect(launchEndoCockpitV0({ root: populated(), uiDirectory: ui })).rejects.toThrow(
			/no digest key location/,
		);
	});

	it("serves the page behind the capability only, over the unchanged server, and never writes the store it reads", async () => {
		const root = populated();
		const before = hashes(root);
		const one = await start(root, join(scratch, "k-serve", "studio.key"));
		const page = await get(one.server, "/");
		expect(page.status).toBe(200);
		expect(page.body).toBe(readFileSync(join(ui, "index.html"), "utf8"));
		expect(page.headers["content-security-policy"]).toMatch(/require-trusted-types-for 'script'/);
		const asset = await get(one.server, "/assets/main.js");
		expect(asset.body).toBe(readFileSync(join(ui, "main.js"), "utf8"));
		expect(JSON.parse((await get(one.server, "/api/v0/snapshot")).body).timeline.entries.length).toBeGreaterThan(0);
		expect((await send(one.server, "/")).status).toBe(404);
		expect((await send(one.server, `/${"y".repeat(43)}/`)).status).toBe(404);
		expect(hashes(root)).toEqual(before);
	});

	it("makes a relative root absolute at launch, so a later change of directory cannot move it", async () => {
		const root = populated();
		const relativeRoot = relative(process.cwd(), root);
		const one = await start(relativeRoot, join(scratch, "k-rel", "studio.key"));
		expect(JSON.parse((await get(one.server, "/api/v0/snapshot")).body).timeline.entries.length).toBeGreaterThan(0);
	});

	it("shows an absent store as absent and does not create it or its parent", async () => {
		const parent = join(scratch, "absent-parent");
		const root = join(parent, "no-store");
		const one = await start(root, join(scratch, "k-absent", "studio.key"));
		expect(JSON.parse((await get(one.server, "/api/v0/snapshot")).body).timeline.source.condition.state).toBe(
			"absent",
		);
		expect(existsSync(root)).toBe(false);
		expect(existsSync(parent)).toBe(false);
	});

	it("holds no listener after it is closed, and the port can be taken again at once", async () => {
		const one = await start(populated(), join(scratch, "k-close", "studio.key"));
		const { port } = one.server;
		await one.server.close();
		const again = await start(populated(), join(scratch, "k-close", "studio.key"), { port });
		expect(again.server.port).toBe(port);
	});
});

describe("stopping on a signal", () => {
	/** A signal source and a server whose close can be held open, to see what a repeated signal does while it runs. */
	function rig() {
		const handlers = new Map<string, (() => void)[]>();
		const source = {
			on: (name: string, handler: () => void) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		};
		const closes: { resolve: () => void; reject: (error: Error) => void }[] = [];
		const server = {
			close: () =>
				new Promise<void>((resolve, reject) => {
					closes.push({ resolve, reject });
				}),
		};
		const emit = (name: string) => {
			for (const handler of handlers.get(name) ?? []) handler();
		};
		return { source, server, emit, closes, handlers };
	}

	it("attaches its handlers when called, so they exist before anything is shown", () => {
		const r = rig();
		void serveUntilSignalV0(r.server, r.source);
		expect([...r.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
		expect(r.closes).toHaveLength(0);
	});

	it("closes once however many signals arrive, settles only after the close has finished, and absorbs later ones", async () => {
		const r = rig();
		let settled = false;
		const stopped = serveUntilSignalV0(r.server, r.source).then(() => {
			settled = true;
		});
		r.emit("SIGINT");
		r.emit("SIGTERM");
		r.emit("SIGINT");
		expect(r.closes).toHaveLength(1);
		await Promise.resolve();
		expect(settled).toBe(false); // the port is not released yet
		r.closes[0]!.resolve();
		await stopped;
		expect(settled).toBe(true);
		r.emit("SIGINT"); // after the close: still absorbed
		expect(r.closes).toHaveLength(1);
	});

	it("passes a failed close to the caller, once", async () => {
		const r = rig();
		const stopped = serveUntilSignalV0(r.server, r.source);
		r.emit("SIGTERM");
		r.emit("SIGTERM");
		r.closes[0]!.reject(new Error("could not close"));
		await expect(stopped).rejects.toThrow("could not close");
		expect(r.closes).toHaveLength(1);
	});

	it("watches the signals it is told to and no others", () => {
		const r = rig();
		void serveUntilSignalV0(r.server, r.source, ["SIGUSR2"]);
		expect([...r.handlers.keys()]).toEqual(["SIGUSR2"]);
	});
});
