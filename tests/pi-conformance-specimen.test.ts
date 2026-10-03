// The Pi 1.0.0 attachment recording (research/pi-conformance/1.0.0/) is an immutable historical specimen of the
// pi-rpc-adapter.2 / pi-rpc-mapping.1 / pi-rpc-suite.2 attachment. Later mappings never rewrite it: a newer recording
// goes beside it. Each file is pinned by digest here, so an edit fails this test instead of silently re-dating the
// evidence. Its evidence names mapping.1, which the current adapter no longer is, so by evidence rule 4 none of it
// applies to a current attachment: it records what was observed, nothing more.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_MAPPING_VERSION } from "../adapters/pi/version.ts";

const SPECIMEN = fileURLToPath(new URL("../research/pi-conformance/1.0.0/", import.meta.url));

/** The specimen as recorded (sha256 of each file's bytes). `lifecycle/` is a later, separate recording. */
const PINNED: Readonly<Record<string, string>> = {
	"README.md": "cf1247b514649edf462b6636632c99ed4bb2b8cf4b80241325246c740c5a5fda",
	"capability-state.json": "cd4622d7af70bd73637b99160ec4aa19948e6f7299c9f99f1f61df67bcb8b057",
	"evidence.json": "20f0404515e09213cd367f0bc119123a8840c56e2cf2e11e8f3cae5e056548c5",
	"fingerprint.json": "7a87c07cb03cd21a6fd8f1a80edea823ad49e2b42f4af15bf37d51305b9d65b5",
	"inconclusive.json": "5239a7754876b9a70871c45e41f1bd9abbd91ed2de67af926c1cfcc9c9377d51",
	"session-summary.json": "2594609c916a77f67b2f15e5531553407f02b08dba7a6dc6a287b6e66484385a",
};

describe("the Pi 1.0.0 mapping.1 specimen is immutable", () => {
	it("holds exactly the pinned files, byte for byte", () => {
		const files = readdirSync(SPECIMEN, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
		expect(files).toEqual(Object.keys(PINNED).sort());
		for (const [name, digest] of Object.entries(PINNED)) {
			expect(
				createHash("sha256")
					.update(readFileSync(`${SPECIMEN}${name}`))
					.digest("hex"),
				name,
			).toBe(digest);
		}
	});

	it("is historical: its evidence names mapping.1, which the current adapter is not", () => {
		const evidence = JSON.parse(readFileSync(`${SPECIMEN}evidence.json`, "utf8")) as {
			dependencies: { mappingVersion: string };
		}[];
		expect(evidence.length).toBeGreaterThan(0);
		expect(new Set(evidence.map((record) => record.dependencies.mappingVersion))).toEqual(
			new Set(["pi-rpc-mapping.1"]),
		);
		expect(PI_MAPPING_VERSION).not.toBe("pi-rpc-mapping.1");
	});
});
