// Capture-version compatibility for the transport closeout: endo-capture.1 recordings (one upstream connection per client
// connection) keep their historical reading; endo-capture.2 recordings (one per exchange) carry no such special case.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENDO_CAPTURE_VERSION_V0, EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { responsesOf } from "../research/completion-cap/1.0.1/analyze.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STALE = "the upstream had closed the connection before this request arrived";

/** A capture store whose single exchange failed without a response, recorded under `version` with `error`. */
function failedStore(version: string | null, error: string, transport?: { phase: string; forwarded: boolean }): string {
	const store = mkdtempSync(join(tmpdir(), "endo-compat-"));
	dirs.push(store);
	const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
	const log = new EndoCaptureLogV0(store, key, "record");
	if (version !== null)
		log.record("capture.started", {
			role: "record",
			capture: version,
			listen: "http://127.0.0.1:1",
			upstream: "http://127.0.0.1:2",
			digestKey: { keyId: key.keyId, domain: key.domain },
		});
	log.record("capture.exchange-ended", {
		exchange: 1,
		outcome: "upstream-error",
		status: null,
		chunks: [],
		wire: null,
		wireBytes: 0,
		headBytes: null,
		headScrubbed: [],
		offsetMs: 0,
		error,
		...(transport === undefined ? {} : { transport }),
	});
	log.close();
	return store;
}

describe("transport classification across capture versions", () => {
	it("this build records endo-capture.2", () => {
		expect(ENDO_CAPTURE_VERSION_V0).toBe("endo-capture.2");
	});

	it("a historical endo-capture.1 stale-connection exchange is still a transport retry, not a failure", () => {
		expect(responsesOf(failedStore("endo-capture.1", STALE)).failedExchanges).toBe(0);
		// A recording that predates the version marker is read the same way.
		expect(responsesOf(failedStore(null, STALE)).failedExchanges).toBe(0);
	});

	it("an endo-capture.1 upstream failure that was not that message is still a failure", () => {
		expect(responsesOf(failedStore("endo-capture.1", "ECONNREFUSED")).failedExchanges).toBe(1);
	});

	it("in endo-capture.2 no message is a retry: every upstream failure counts, and says what kind it was", () => {
		const transport = { phase: "connect", forwarded: false };
		expect(responsesOf(failedStore("endo-capture.2", "ECONNREFUSED", transport)).failedExchanges).toBe(1);
		// Even the old words: they no longer mean anything.
		expect(responsesOf(failedStore("endo-capture.2", STALE, transport)).failedExchanges).toBe(1);
	});
});
