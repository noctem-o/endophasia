// Synthetic Pi session + fresh cassette process; shared by the sibling preparation and fault-injection suites.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEndoRecordingProxyV0 } from "../../adapters/openai-proxy/record.ts";
import { recordPiCassetteSessionV0, replayPiCassetteSessionV0 } from "../../cli/cassette-session.ts";
import {
	endoFixtureDigestKeyPathV0,
	loadEndoFixtureDigestKeyV0,
	loadOrCreateEndoDigestKeyV0,
} from "../../storage/digest-key.ts";
import { startFakeOpenAiServer } from "./fake-openai-server.ts";
import { installFakePi } from "./fake-pi/install.ts";

/**
 * With `installationKeyFile` the checkpoint is recorded and verified under that (non-public) installation key, which is
 * what the operator command and the private evidence reader require. The caller must keep ENDO_DIGEST_KEY_FILE pointing
 * at it for as long as the fixture is used.
 */
export async function verifiedInitialCheckpointFixtureV0(options: { installationKeyFile?: string } = {}) {
	const base = mkdtempSync(join(tmpdir(), "endo-siblings-test-"));
	const pi = installFakePi("1.0.0");
	pi.setScenario("model-endpoint");
	const starts = join(base, "pi-starts.jsonl");
	pi.setEnvLog(starts);
	const keyPath = endoFixtureDigestKeyPathV0();
	const key = options.installationKeyFile
		? loadOrCreateEndoDigestKeyV0(options.installationKeyFile)
		: loadEndoFixtureDigestKeyV0(keyPath);
	const keySource = options.installationKeyFile
		? { kind: "installation" as const }
		: { kind: "fixture" as const, path: keyPath };
	const source = join(base, "source");
	const replay = join(base, "replay");
	const scratch = join(base, "scratch");
	const upstream = await startFakeOpenAiServer({ chunkMs: 2 });
	const proxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
	try {
		await recordPiCassetteSessionV0({
			scenario: {
				name: "tool",
				purpose: "read initial input",
				workspace: { "endophasia-study.txt": "initial scratch content\n" },
				steps: [{ op: "prompt", text: "Use the read tool, then answer" }],
			},
			pi: pi.bin,
			provider: "fake",
			model: "fake-1",
			proxy,
			store: source,
			scratchRoot: scratch,
			keySource,
			evidenceFrom: null,
			timeoutMs: 20_000,
		});
		await proxy.close();
		const report = await replayPiCassetteSessionV0({
			store: source,
			out: replay,
			pi: pi.bin,
			timing: "immediate",
			keySource,
			timeoutMs: 20_000,
		});
		return { base, pi, starts, source, replay, scratch, key, report };
	} finally {
		await proxy.close();
		await upstream.close();
	}
}
