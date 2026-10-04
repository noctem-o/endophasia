// The Pi 1.0.1 sampling-control conformance finding (research/pi-conformance/1.0.1/sampling-control/): the suite is a
// valid endo.conformance-study.v0 suite, and the committed cassette fixtures' requests (bodies under the public
// fixture key) carry no sampling field, as the default-request study says. With ENDO_PI_EXECUTABLE set, the doc digests
// the studies cite are re-checked against the installed Pi's docs.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateEndoConformanceSuiteV0 } from "../protocol/evaluation.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SUITE = join(REPO, "research/pi-conformance/1.0.1/sampling-control/suite.json");
const CASSETTES = join(REPO, "research/pi-conformance/1.0.1/cassettes");
const SAMPLING = [
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"typical_p",
	"seed",
	"presence_penalty",
	"frequency_penalty",
	"repeat_penalty",
];

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

describe("Pi 1.0.1 sampling control (conformance finding)", () => {
	const suite = JSON.parse(readFileSync(SUITE, "utf8"));

	it("is a valid conformance suite: default fields EXACT, configuration UNAVAILABLE, extension QUALIFIED", () => {
		expect(validateEndoConformanceSuiteV0(suite)).not.toBeNull();
		expect(
			suite.studies.map((study: { scenario: string; classification: string }) => [
				study.scenario,
				study.classification,
			]),
		).toEqual([
			["sampling-fields-sent-by-default", "EXACT"],
			["sampling-control-by-configuration", "UNAVAILABLE"],
			["sampling-control-by-extension", "QUALIFIED"],
		]);
	});

	it("the committed cassette requests carry no sampling field, and exactly the default parameters the study digests", () => {
		const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
		const seen = new Set<string>();
		let requests = 0;
		for (const session of readdirSync(CASSETTES).filter((name) =>
			existsSync(join(CASSETTES, name, "capture.events.jsonl")),
		)) {
			const blobs = createEndoBlobStoreV0(join(CASSETTES, session), key, { readOnly: true });
			for (const line of readFileSync(join(CASSETTES, session, "capture.events.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)) {
				const event = JSON.parse(line);
				if (event.kind !== "capture.request" || event.producer !== "capture:record") continue;
				requests += 1;
				const {
					messages: _messages,
					tools: _tools,
					...rest
				} = JSON.parse(Buffer.from(blobs.get(event.payload.body.digest)).toString("utf8"));
				for (const field of SAMPLING) expect(rest, `${session}: ${field}`).not.toHaveProperty(field);
				seen.add(JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)))));
			}
		}
		expect(requests).toBe(8);
		expect([...seen].map((text) => sha256(text))).toEqual([suite.studies[0].evidence[0]]);
	});

	const pi = process.env.ENDO_PI_EXECUTABLE;
	it.runIf(pi !== undefined && pi.length > 0)(
		"(opt-in) the doc digests the studies cite match the installed Pi's docs",
		() => {
			const root = dirname(dirname(dirname(realpathSync(pi!))));
			const files = [
				"docs/models.md",
				"docs/settings.md",
				"docs/custom-provider.md",
				"docs/extensions.md",
				"docs/llama-cpp.md",
				"examples/extensions/provider-payload.ts",
			];
			const digests = new Set(files.map((file) => sha256(readFileSync(join(root, file)))));
			const cited = new Set<string>(suite.studies.flatMap((study: { evidence: string[] }) => study.evidence));
			for (const digest of digests) expect(cited.has(digest), digest).toBe(true);
		},
	);
});
