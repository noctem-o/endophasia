import { defineConfig } from "vitest/config";

// Endophasia depends on no Pi package. The Pi attachment talks to a user-installed `pi` over its documented RPC
// mode; the deterministic suites use a fake Pi child process (tests/fixtures/fake-pi) and the opt-in real-runtime
// suite (tests/pi-real-runtime.test.ts) runs only with ENDO_PI_EXECUTABLE set.
export default defineConfig({
	test: {
		// The transport, attachment and Prime ingress suites start real child processes.
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
