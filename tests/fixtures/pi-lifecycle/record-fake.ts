// Regenerate the committed FAKE lifecycle fixtures (tests/fixtures/pi-lifecycle/fake-pi-1.0.0/): the same recorder
// a maintainer runs against a real Pi (scripts/record-lifecycle-fixture.ts), pointed at the deterministic suite's fake
// Pi. Their provenance says `kind: "fake-pi"`; they prove that the recorder, the lifecycle fold and the overview
// reducer agree with each other, not anything about a real Pi or model.
//
//   node tests/fixtures/pi-lifecycle/record-fake.ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPiLifecycleFixturesV0 } from "../../../scripts/record-lifecycle-fixture.ts";
import { installFakePi } from "../fake-pi/install.ts";

export const FAKE_LIFECYCLE_FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fake-pi-1.0.0");

/** Record the three lifecycle sessions against a fresh fake Pi 1.0.0 install into `out`. */
export async function recordFakeLifecycleFixtures(out: string, force = true) {
	const install = installFakePi("1.0.0");
	try {
		return await recordPiLifecycleFixturesV0({
			pi: install.bin,
			baseUrl: null,
			model: "fake-1",
			providerName: "fake",
			apiKeyEnv: null,
			out,
			authorizeLiveStudy: true,
			timeoutMs: 20_000,
			kind: "fake-pi",
			extraEnv: { FAKE_PI_STEP_MS: "15" },
			force,
			log: () => {},
		});
	} finally {
		install.remove();
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	await recordFakeLifecycleFixtures(FAKE_LIFECYCLE_FIXTURES);
	process.stderr.write(`wrote ${FAKE_LIFECYCLE_FIXTURES}\n`);
}
