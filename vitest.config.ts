import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Endophasia depends on no Pi package. The Pi attachment talks to a user-installed `pi` over its documented RPC
// mode; the deterministic suites use a fake Pi child process (tests/fixtures/fake-pi) and the opt-in real-runtime
// suite (tests/pi-real-runtime.test.ts) runs only with ENDO_PI_EXECUTABLE set.
//
// Every test run digests tool arguments under a scratch comparison-domain key (storage/digest-key.ts), never the
// installation key in the operator's home; tests/global-setup.ts removes it afterwards.
const digestKeyDirectory = mkdtempSync(join(tmpdir(), "endo-vitest-digest-key-"));

export default defineConfig({
	test: {
		// The transport, attachment and Prime ingress suites start real child processes.
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
		env: { ENDO_DIGEST_KEY_FILE: join(digestKeyDirectory, "digest-key") },
		globalSetup: ["tests/global-setup.ts"],
		provide: { digestKeyDirectory },
	},
});
