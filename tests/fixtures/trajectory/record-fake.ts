// Regenerate the committed FAKE trajectory fixtures (tests/fixtures/trajectory/fake-pi/): hostile sessions recorded
// through the real Pi attachment against the deterministic suite's fake Pi, each differing from `baseline` in one
// controlled way. They prove that the projection and the comparison see each difference, not anything about a real Pi.
//
//   node tests/fixtures/trajectory/record-fake.ts
//
// Every session sends one prompt and runs to agent_settled. The fake's scripted tool calls (FAKE_PI_TOOL_CALLS) run in
// the first turn; nothing is executed. Paths are normalized like the lifecycle recorder's (`<recorder-scratch>`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAttachmentV0 } from "../../../adapters/pi/attachment.ts";
import type { EndoEventV0 } from "../../../protocol/event.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import { type EndoDigestKeyV0, endoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { normalizeScratchRootV0 } from "../../../scripts/record-lifecycle-fixture.ts";
import { createEndoDurableEventStoreV0 } from "../../../storage/event-store.ts";
import { type FakePiInstall, fakePiEnv, installFakePi } from "../fake-pi/install.ts";

/**
 * TEST-ONLY digest keys, derived from public strings so that regenerating the fixtures gives the same digests. They
 * protect nothing: anyone can recompute them. Real recordings use the installation key (storage/digest-key.ts).
 */
export const FAKE_TRAJECTORY_DIGEST_KEYS: Readonly<Record<"a" | "b", EndoDigestKeyV0>> = Object.freeze({
	a: endoDigestKeyV0(
		Buffer.from(sha256HexV0("endophasia fake trajectory fixtures: digest domain a"), "hex"),
		"test-a",
	),
	b: endoDigestKeyV0(
		Buffer.from(sha256HexV0("endophasia fake trajectory fixtures: digest domain b"), "hex"),
		"test-b",
	),
});

export const FAKE_TRAJECTORY_FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fake-pi");

const READ_A = { toolName: "read", args: { path: "a.txt" }, isError: false };
const READ_B = { toolName: "read", args: { path: "b.txt" }, isError: false };
const BASH_LS = { toolName: "bash", args: { command: "ls" }, isError: false };

/** The hostile cases: name, what differs from `baseline`, and how the fake Pi is set up. */
export const FAKE_TRAJECTORY_CASES = [
	{ name: "baseline", differs: "nothing", version: "1.0.0", scenario: "", calls: [READ_A, BASH_LS] },
	{
		name: "baseline-again",
		differs: "nothing: a second recording of baseline (new process, ids and timestamps)",
		version: "1.0.0",
		scenario: "",
		calls: [READ_A, BASH_LS],
	},
	{
		name: "tools-reordered",
		differs: "the two tool calls in reverse order",
		version: "1.0.0",
		scenario: "",
		calls: [BASH_LS, READ_A],
	},
	{
		name: "tool-args-differ",
		differs: "the first tool call reads another path",
		version: "1.0.0",
		scenario: "",
		calls: [READ_B, BASH_LS],
	},
	{
		name: "tool-errors",
		differs: "the second tool call reports isError",
		version: "1.0.0",
		scenario: "",
		calls: [READ_A, { ...BASH_LS, isError: true }],
	},
	{
		name: "no-usage",
		differs: "Pi reports no usage on its assistant messages",
		version: "1.0.0",
		scenario: "no-usage",
		calls: [READ_A, BASH_LS],
	},
	{
		name: "unknown-lifecycle",
		differs: "an undocumented agent_paused record inside the run",
		version: "1.0.0",
		scenario: "unknown-lifecycle",
		calls: [READ_A, BASH_LS],
	},
	{
		name: "other-fingerprint",
		differs: "the fake Pi reports version 1.0.1",
		version: "1.0.1",
		scenario: "",
		calls: [READ_A, BASH_LS],
	},
	{
		name: "other-digest-domain",
		differs: "the same calls, with argument digests made under another digest key",
		version: "1.0.0",
		scenario: "",
		calls: [READ_A, BASH_LS],
		domain: "b",
	},
] as const;

function readEvents(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const events = store.page({ limit: 10_000 }).events;
	store.close();
	return events;
}

/** Record every case into `out`: `<case>.events.jsonl` and a manifest naming each file's sha256. */
export async function recordFakeTrajectoryFixtures(out: string): Promise<void> {
	mkdirSync(out, { recursive: true });
	const manifest: { name: string; differs: string; eventsSha256: string; eventCount: number }[] = [];
	// One installation per version, shared by its cases: the identity digest covers the install path, so a fresh path
	// per case would make every recording look like another Pi.
	const installs = new Map<string, FakePiInstall>();
	const installed = mkdtempSync(join(tmpdir(), "endo-lifecycle-"));
	try {
		for (const entry of FAKE_TRAJECTORY_CASES) {
			let install = installs.get(entry.version);
			if (install === undefined) {
				install = installFakePi(entry.version, join(installed, entry.version));
				installs.set(entry.version, install);
			}
			await recordCase(entry, install, installed, out, manifest);
		}
	} finally {
		rmSync(installed, { recursive: true, force: true });
	}
	writeFileSync(
		join(out, "manifest.json"),
		`${JSON.stringify({ schemaVersion: "endo.trajectory-fixture.v0", kind: "fake-pi", cases: manifest }, null, "\t")}\n`,
	);
}

async function recordCase(
	entry: (typeof FAKE_TRAJECTORY_CASES)[number],
	install: FakePiInstall,
	installed: string,
	out: string,
	manifest: { name: string; differs: string; eventsSha256: string; eventCount: number }[],
): Promise<void> {
	{
		const scratch = mkdtempSync(join(tmpdir(), "endo-lifecycle-"));
		try {
			const root = join(scratch, "root");
			const cwd = join(scratch, "cwd");
			mkdirSync(cwd, { recursive: true });
			const digestKey = FAKE_TRAJECTORY_DIGEST_KEYS["domain" in entry ? entry.domain : "a"];
			const base = { root, cwd, executable: install.bin, requestTimeoutMs: 10_000, digestKey };
			await new PiAttachmentV0({ ...base, env: fakePiEnv({ FAKE_PI_STEP_MS: "5" }) }).checkLocal();
			install.setScenario(entry.scenario);
			const pi = new PiAttachmentV0({
				...base,
				env: fakePiEnv({ FAKE_PI_STEP_MS: "5", FAKE_PI_TOOL_CALLS: JSON.stringify(entry.calls) }),
			});
			const session = await pi.openSession();
			const settled = session.waitForSettled(10_000);
			await session.prompt("hello");
			if (!(await settled)) throw new Error(`${entry.name}: agent_settled was not observed`);
			await session.close();
			const { events } = normalizeScratchRootV0(readEvents(root), [
				scratch,
				realpathSync(scratch),
				installed,
				realpathSync(installed),
			]);
			const lines = `${events.map((event) => JSON.stringify(JSON.parse(canonicalEndoJsonV0(event)))).join("\n")}\n`;
			writeFileSync(join(out, `${entry.name}.events.jsonl`), lines);
			manifest.push({
				name: entry.name,
				differs: entry.differs,
				eventsSha256: sha256HexV0(lines),
				eventCount: events.length,
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	await recordFakeTrajectoryFixtures(FAKE_TRAJECTORY_FIXTURES);
	process.stderr.write(`wrote ${FAKE_TRAJECTORY_FIXTURES}\n`);
}
