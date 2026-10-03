/**
 * Real-runtime acceptance, opt-in: ENDO_PI_EXECUTABLE=/path/to/an/installed/pi.
 *
 * Runs the attachment against a Pi the operator installed (this suite never installs one). Pi's model provider is the
 * local fake OpenAI-compatible endpoint (tests/fixtures/fake-openai-server.ts), configured through an isolated
 * PI_CODING_AGENT_DIR/models.json, so the live study here costs nothing and needs no credentials; that is why this
 * suite authorizes it. HOME and the agent directory are scratch directories: the operator's Pi configuration and
 * sessions are never read or written.
 *
 * With ENDO_PI_RECORD_DIR set, the identity, the capability state and the evidence records are written there (the
 * repository keeps one such recording per tested version under research/pi-conformance/).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

const executable = process.env.ENDO_PI_EXECUTABLE;

describe.runIf(executable !== undefined && executable.length > 0)("real Pi acceptance (opt-in)", () => {
	let server: FakeOpenAiServer;
	let scratch: string;
	let env: Record<string, string>;
	let root: string;
	let cwd: string;

	beforeAll(async () => {
		server = await startFakeOpenAiServer({ slowChunkMs: 80 });
		scratch = mkdtempSync(join(tmpdir(), "endo-real-pi-"));
		const agentDir = join(scratch, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					endofake: {
						baseUrl: server.baseUrl,
						api: "openai-completions",
						apiKey: "local",
						models: [{ id: "fake-1" }],
					},
				},
			}),
		);
		env = {
			PATH: process.env.PATH ?? "",
			HOME: join(scratch, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
		};
		mkdirSync(env.HOME!, { recursive: true });
		root = join(scratch, "endo");
		cwd = join(scratch, "work");
		mkdirSync(cwd, { recursive: true });
	});

	afterAll(async () => {
		await server?.close();
		if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
	});

	const attach = () =>
		new PiAttachmentV0({
			root,
			cwd,
			executable: executable!,
			env,
			provider: "endofake",
			model: "fake-1",
			requestTimeoutMs: 60_000,
		});

	it("identifies, checks locally, studies live, records a session, recovers from a crash and replays", async () => {
		const pi = attach();
		const { fingerprint, change, notification } = await pi.identify();
		expect(fingerprint).not.toBeNull();
		expect(change.kind).toBe("first-observation");
		expect(notification?.kind).toBe("runtime-first-observed");

		const local = await pi.checkLocal();
		expect(local.ran).toBe(true);
		const studied = await pi.studyLive({ authorized: true, stepTimeoutMs: 60_000 });
		const state = studied.state;
		const byId = Object.fromEntries(state.capabilities.map((entry) => [entry.capability, entry]));

		// Nothing is admitted without evidence, and the documented absences stay absent.
		expect(byId["control.active-tools"]?.status).toBe("unavailable");
		expect(byId["session.entries-cursor"]?.classification).toBe("EXACT");
		expect(byId["lifecycle.trace"]?.status).not.toBe("admitted");

		const again = attach();
		expect((await again.identify()).change.kind).toBe("unchanged");
		const session = await again.openSession();
		expect(await session.prompt("Hello from the Endophasia acceptance run.")).toBe("started");
		expect(await session.waitForSettled(60_000)).toBe(true);
		const pid = session.pid!;
		process.kill(pid, "SIGKILL");
		expect((await session.exited())?.signal).toBe("SIGKILL");
		await session.reconnect();
		expect(await session.prompt("A second prompt after reconnecting.")).toBe("started");
		expect(await session.waitForSettled(60_000)).toBe(true);
		await session.close();

		const store = createEndoDurableEventStoreV0(root);
		const events = store.page({ limit: 10_000 }).events;
		const record = store.record("endo.evidence.real-pi-acceptance");
		store.close();
		const entries = events.filter((event) => event.kind === "session.entry-observed");
		expect(new Set(entries.map((event) => event.id)).size).toBe(entries.length);
		expect(entries.length).toBeGreaterThanOrEqual(4);
		expect(events.some((event) => event.kind === "harness.process-exited")).toBe(true);
		expect(events.filter((event) => event.kind === "harness.attached")).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain("Hello from the Endophasia acceptance run.");

		const output = process.env.ENDO_PI_RECORD_DIR;
		if (output !== undefined && output.length > 0) {
			mkdirSync(output, { recursive: true });
			const write = (name: string, value: unknown) =>
				writeFileSync(join(output, name), `${canonicalEndoJsonV0(JSON.parse(JSON.stringify(value)))}\n`);
			write("fingerprint.json", {
				...fingerprint,
				// Paths are of the recording machine; kept for the record, not for comparison.
			});
			write("capability-state.json", state);
			write("evidence.json", pi.registry.list("evidence"));
			write("inconclusive.json", studied.inconclusive);
			write("session-summary.json", {
				eventCount: events.length,
				eventKinds: [...new Set(events.map((event) => event.kind))].sort(),
				entryEvents: entries.length,
				recordDigest: record.digest,
				counters: session.counters,
			});
		}
	}, 600_000);
});
