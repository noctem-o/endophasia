// Read-only observer filesystem guards and HTTP route tests for Representation Explorer (OBSERVE-GEOMETRY-001).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ObserveRepresentationObserverV0 } from "../adapters/observe-representation/observer.ts";
import { parseEndoStudioArgsV0 } from "../cli/studio.ts";
import { readEndoCockpitRecordV0 } from "../protocol/cockpit.ts";
import { ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0 } from "../protocol/observe-representation.ts";
import { removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "endo-rep-observer-"));

afterEach(stopServers);
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dirHashes(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.map((name) => {
			const full = join(dir, name);
			try {
				return `${name}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
			} catch {
				return `${name}:nonfile`;
			}
		});
}

describe("ObserveRepresentationObserverV0 filesystem & selector invariants", () => {
	it("reads valid captures, refuses malformed/unsupported files, skips symlinks/dirs, leaks no paths and invalidates stale selectors", () => {
		const dir = mkdtempSync(join(scratch, "caps-"));
		const realCapturePath = join(repo, "research/observe-geometry/examples/smollm2-135m-resid-post.json");
		const realBytes = readFileSync(realCapturePath);
		writeFileSync(join(dir, "01-real.json"), realBytes);
		writeFileSync(join(dir, "02-bad-json.json"), "{not-json");
		writeFileSync(join(dir, "03-wrong-schema.json"), JSON.stringify({ schemaVersion: "endo.other.v99" }));
		writeFileSync(
			join(dir, "04-invalid-contract.json"),
			JSON.stringify({ schemaVersion: ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0 }),
		);
		symlinkSync(join(dir, "01-real.json"), join(dir, "05-link.json"));
		mkdirSync(join(dir, "06-subdir.json"));

		const before = dirHashes(dir);
		const observer = new ObserveRepresentationObserverV0({ root: dir, key: OTHER_KEY });
		const index = observer.list();
		expect(readEndoCockpitRecordV0(index).ok).toBe(true);
		expect(index.available).toBe(true);
		expect(index.skipped.links).toBe(1);
		expect(index.skipped.notRegular).toBe(1);
		expect(index.artifacts.map((a) => a.state)).toEqual(["readable", "invalid", "unsupported-schema", "invalid"]);

		// Never leaks local paths in serialized output.
		const rawIndex = JSON.stringify(index);
		expect(rawIndex).not.toContain(dir);
		expect(rawIndex).not.toContain("01-real.json");

		const readable = index.artifacts[0]!;
		const scene = observer.scene(readable.selector, { layer: 9 });
		expect(scene).not.toBeNull();
		expect(readEndoCockpitRecordV0(scene).ok).toBe(true);
		expect(scene!.selectedLayer).toBe(9);
		expect(scene!.points.length).toBe(17);
		expect(JSON.stringify(scene)).not.toContain(dir);

		// Directory is byte-for-byte unchanged after reads.
		expect(dirHashes(dir)).toEqual(before);

		// Modifying the file invalidates the previously issued opaque selector.
		const modified = JSON.parse(realBytes.toString("utf8"));
		modified.artifact.promptId = "changed-prompt";
		writeFileSync(join(dir, "01-real.json"), JSON.stringify(modified));
		expect(observer.scene(readable.selector)).toBeNull();
	});
});

describe("cockpit HTTP representation routes & CLI flags", () => {
	it("returns { available: false } when no observer is attached and refuses scene requests with 404", async () => {
		const server = await serve(tempRoot());
		const list = await get(server, "/api/v0/observe/representations");
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)).toEqual({
			schemaVersion: "endo.observe-representations.v0",
			available: false,
		});
		const missing = await get(server, `/api/v0/observe/representation/r1-${"0".repeat(32)}`);
		expect(missing.status).toBe(404);
	});

	it("serves validated index and layer-projected scenes under all existing security guards", async () => {
		const examplesDir = join(repo, "research/observe-geometry/examples");
		const observer = new ObserveRepresentationObserverV0({ root: examplesDir, key: OTHER_KEY });
		const server = await serve(tempRoot(), { representations: observer });

		const list = await get(server, "/api/v0/observe/representations");
		expect(list.status).toBe(200);
		const parsedList = JSON.parse(list.body);
		expect(parsedList.available).toBe(true);
		expect(parsedList.artifacts.length).toBeGreaterThanOrEqual(1);
		const selector = parsedList.artifacts[0].selector as string;

		const defaultScene = await get(server, `/api/v0/observe/representation/${selector}`);
		expect(defaultScene.status).toBe(200);
		expect(JSON.parse(defaultScene.body).selectedLayer).toBe(29);

		const layer0 = await get(server, `/api/v0/observe/representation/${selector}?layer=0`);
		expect(layer0.status).toBe(200);
		expect(JSON.parse(layer0.body).selectedLayer).toBe(0);

		const allLayers = await get(server, `/api/v0/observe/representation/${selector}?layer=all`);
		expect(allLayers.status).toBe(200);
		expect(JSON.parse(allLayers.body).points.length).toBe(68);

		// Invalid layer index or grammar refused with 400.
		expect((await get(server, `/api/v0/observe/representation/${selector}?layer=999`)).status).toBe(400);
		expect((await get(server, `/api/v0/observe/representation/${selector}?layer=abc`)).status).toBe(400);
		expect((await get(server, `/api/v0/observe/representation/${selector}?other=1`)).status).toBe(400);

		// Invalid selector refused with 404.
		expect((await get(server, "/api/v0/observe/representation/not-a-selector")).status).toBe(404);

		// Foreign origin refused with 403; POST refused with 405.
		const foreign = await get(server, "/api/v0/observe/representations", { Origin: "https://evil.example" });
		expect(foreign.status).toBe(403);
		const post = await send(server, `${capabilityOf(server)}/api/v0/observe/representations`, { method: "POST" });
		expect(post.status).toBe(405);
	});

	it("parses --representations cleanly and refuses missing or duplicate flags", () => {
		const env = { XDG_DATA_HOME: "/data" };
		expect(parseEndoStudioArgsV0(["./rec", "--representations", "./reps"], env)).toMatchObject({
			root: "./rec",
			representations: "./reps",
		});
		expect(() => parseEndoStudioArgsV0(["--representations"], env)).toThrow(TypeError);
		expect(() => parseEndoStudioArgsV0(["--representations", "a", "--representations", "b"], env)).toThrow(TypeError);
	});
});
