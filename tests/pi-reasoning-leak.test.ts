// Model-provided reasoning, end to end through the attached process: a model endpoint that streams `reasoning_content` (as llama.cpp's
// server does), a Pi that turns it into structured thinking blocks, the attachment, and the workbench broker. Reasoning must reach the
// broker's private transcript and nothing durable Endophasia writes: not the event store, not the runtime-text side store, not the
// harness or artifact records. Pi keeps its own session file, as it always does (that is Pi's retention, not Endophasia's evidence), so
// the scan below leaves Pi's session directory out and says so.
//
// The first suite runs always, against the fake Pi (tests/fixtures/fake-pi) in its model-endpoint mode. The second runs only when
// ENDO_PI_EXECUTABLE names an installed Pi; it is the same check with the real Pi's own openai-completions provider.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { installFakePi } from "./fixtures/fake-pi/install.ts";
import { Approval } from "./workbench-fixtures.ts";

const SENTINEL = "REASONING-SENTINEL-c41e-never-durable";
const cleanup: (() => void)[] = [];
afterAll(() => {
	for (const step of cleanup.splice(0)) step();
});

/** Every file under `directory` except Pi's own session directory, read as bytes. */
function filesOutsidePi(directory: string): { path: string; bytes: Buffer }[] {
	const out: { path: string; bytes: Buffer }[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				if (full === join(directory, "pi-sessions")) continue;
				walk(full);
			} else if (entry.isFile()) out.push({ path: full, bytes: readFileSync(full) });
		}
	};
	walk(directory);
	return out;
}

async function run(executable: string, extraEnv: Record<string, string>) {
	const server = await startFakeOpenAiServer({ reasoningContent: `${SENTINEL}: first read the failing test.` });
	const scratch = mkdtempSync(join(tmpdir(), "endo-reasoning-"));
	cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
	const agentDir = join(scratch, "agent");
	const home = join(scratch, "home");
	const cwd = join(scratch, "work");
	const root = join(scratch, "endo");
	for (const dir of [agentDir, home, cwd]) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				endofake: {
					baseUrl: server.baseUrl,
					api: "openai-completions",
					apiKey: "local",
					models: [{ id: "fake-1", reasoning: true }],
				},
			},
		}),
	);
	const pi = new PiAttachmentV0({
		root,
		cwd,
		executable,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			...extraEnv,
		},
		provider: "endofake",
		model: "fake-1",
		requestTimeoutMs: 60_000,
	});
	try {
		await pi.identify();
		const session = await pi.openSession();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: new Approval().approver,
		});
		expect(await session.prompt("Say something short.")).toBe("started");
		expect(await session.waitForSettled(60_000)).toBe(true);
		const view = broker.transcript.view();
		await session.close();
		broker.endSession();
		return { root, view, cleared: JSON.stringify(broker.transcript.view()) };
	} finally {
		await server.close();
	}
}

function expectNothingDurable(root: string) {
	const files = filesOutsidePi(root);
	expect(files.length).toBeGreaterThan(0);
	for (const { path, bytes } of files) expect(bytes.includes(SENTINEL), path).toBe(false);
}

describe("reasoning through the attachment (fake Pi, model endpoint mode)", () => {
	it("reaches the broker's transcript as a structured reasoning part, and nothing durable", async () => {
		const install = installFakePi("0.80.0");
		cleanup.push(() => install.remove());
		const { root, view, cleared } = await run(install.bin, { FAKE_PI_SCENARIO: "model-endpoint" });
		const assistant = view.items.find((item) => item.kind === "message" && item.role === "assistant");
		expect(assistant?.kind === "message" && assistant.parts[0]).toMatchObject({
			kind: "reasoning",
			state: "supplied",
			text: expect.stringContaining(SENTINEL),
		});
		expect(view.open).toBeNull();
		expectNothingDurable(root);
		expect(cleared).not.toContain(SENTINEL);
	}, 60_000);
});

const executable = process.env.ENDO_PI_EXECUTABLE;
describe.runIf(executable !== undefined && executable.length > 0)(
	"reasoning through the attachment (real Pi, opt-in)",
	() => {
		it("reaches the broker's transcript as a structured reasoning part, and nothing durable", async () => {
			const { root, view, cleared } = await run(executable!, {});
			const assistant = view.items.find((item) => item.kind === "message" && item.role === "assistant");
			expect(assistant?.kind).toBe("message");
			const parts = assistant?.kind === "message" ? assistant.parts : [];
			const reasoning = parts.find((part) => part.kind === "reasoning");
			expect(reasoning).toMatchObject({
				kind: "reasoning",
				state: "supplied",
				text: expect.stringContaining(SENTINEL),
			});
			// The order Pi gave: the reasoning comes before the answer it preceded.
			expect(parts.findIndex((p) => p.kind === "reasoning")).toBeLessThan(parts.findIndex((p) => p.kind === "text"));
			expectNothingDurable(root);
			expect(cleared).not.toContain(SENTINEL);
		}, 120_000);
	},
);
