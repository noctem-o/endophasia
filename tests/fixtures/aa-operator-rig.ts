// Shared rig for the A/A operator suites: a checkpoint recorded under an installation key, the task-owned C relay
// compiled against an in-process fake OpenAI endpoint, a fake Pi, and helpers to prepare a sibling pair per test.
// Nothing here starts a real model server or sends a real model request.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { prepareVerifiedInitialBranchPairV0 } from "../../cli/initial-branch-set.ts";
import type { AaOperatorConfigV0, AaTerminalV0 } from "../../research/governed-initial-continuation/aa/operator.ts";
import { type FakeOpenAiOptions, type FakeOpenAiServer, startFakeOpenAiServer } from "./fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./verified-initial-checkpoint.ts";

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function freePort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((resolve, reject) => {
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", resolve);
	});
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("reservation failed");
	await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}
export const portIsFree = (port: number) =>
	new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
/** Processes whose executable is exactly this file: how a test proves that a task-owned server is really gone. */
export function runningFrom(executable: string): string[] {
	return readdirSync("/proc")
		.filter((name) => /^[0-9]+$/.test(name))
		.filter((name) => {
			try {
				return readlinkSync(`/proc/${name}/exe`).replace(" (deleted)", "") === executable;
			} catch {
				return false;
			}
		});
}

export interface AaRig {
	fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
	backend: FakeOpenAiServer;
	tools: string;
	relay: string;
	crash: string;
	hang: string;
	model: string;
	keyFile: string;
	/** A fresh sibling pair, port and working directory; order is chosen by `seed` (even: ABBA, odd: BAAB). */
	newConfig(
		overrides?: Partial<AaOperatorConfigV0>,
		server?: Partial<AaOperatorConfigV0["server"]>,
	): Promise<AaOperatorConfigV0>;
	/** Writes `config` as the private owner-only file the command reads. */
	writeConfig(config: unknown, mode?: number): string;
	close(): Promise<void>;
}

export async function createAaRig(backendOptions: FakeOpenAiOptions = { chunkMs: 2 }): Promise<AaRig> {
	const keyFile = process.env.ENDO_DIGEST_KEY_FILE;
	if (!keyFile) throw new Error("the vitest installation key location is not set");
	const fixture = await verifiedInitialCheckpointFixtureV0({ installationKeyFile: keyFile });
	const backend = await startFakeOpenAiServer(backendOptions);
	const tools = mkdtempSync(join(fixture.base, "aa-tools-"));
	const source = join(process.cwd(), "tests/fixtures/task-owned");
	const relay = join(tools, "relay");
	const crash = join(tools, "crash");
	const hang = join(tools, "hang");
	execFileSync("cc", [`-DBACKEND_PORT=${new URL(backend.baseUrl).port}`, join(source, "relay.c"), "-o", relay]);
	execFileSync("cc", [join(source, "crash.c"), "-o", crash]);
	execFileSync("cc", [join(source, "hang.c"), "-o", hang]);
	const model = join(tools, "model.gguf");
	writeFileSync(model, Buffer.alloc(8192, 7), { mode: 0o600 });
	let counter = 0;
	return {
		fixture,
		backend,
		tools,
		relay,
		crash,
		hang,
		model,
		keyFile,
		async newConfig(overrides = {}, server = {}) {
			const id = ++counter;
			const outputParent = mkdtempSync(join(fixture.base, `aa-study-${id}-`));
			const prep = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				outputParent,
				{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
				{ id: "arm-b", description: "matched", settings: { thinkingLevel: "off" } },
			);
			if (prep.status !== "prepared") throw new Error(prep.reason);
			const workingDirectory = mkdtempSync(join(fixture.base, `aa-work-${id}-`));
			return {
				keyFile,
				studyFile: join(outputParent, "study.json"),
				seed: 0,
				expectedAnswer: "9",
				serverDeclaration: "task-owned fake endpoint",
				source: fixture.source,
				replay: fixture.replay,
				outputParent,
				preparation: prep.preparation,
				piExecutable: fixture.pi.bin,
				provider: "fake",
				model: "fake-1",
				prompt: "Compute 4 plus 5. Return only the decimal result.",
				continuationPrompt: "Repeat only the token in your immediately preceding answer.",
				wallTimeoutMs: 15000,
				maxApprovalIdleMs: 5000,
				maxTransferredBytes: 1048576,
				...overrides,
				server: {
					executablePath: relay,
					executableSha256: sha256File(relay),
					modelPath: model,
					modelSha256: sha256File(model),
					modelAlias: "task-owned-fake",
					gpuLayers: "12",
					port: await freePort(),
					startupTimeoutMs: 20000,
					modelReadyTimeoutMs: 20000,
					workingDirectory,
					...server,
				},
			};
		},
		writeConfig(config, mode = 0o600) {
			const directory = mkdtempSync(join(fixture.base, "aa-config-"));
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, "config.json");
			writeFileSync(path, JSON.stringify(config), { mode });
			return path;
		},
		async close() {
			await backend.close();
			fixture.pi.remove();
			rmSync(fixture.base, { recursive: true, force: true });
		},
	};
}

export type Kind = "launch" | "first" | "second";
export const HANG = Symbol("hang");
export type Decision = string | null | typeof HANG;
const phraseOf = (prompt: string) => /Type (APPROVE .*?) to (?:start|approve)/.exec(prompt)?.[1] ?? "";
const kindOf = (prompt: string): Kind =>
	prompt.includes("TASK-OWNED SERVER") ? "launch" : prompt.includes("APPROVE FIRST") ? "first" : "second";

/** Stands in for the controlling terminal: it records every prompt and answers only what the test's policy decides. */
export class ScriptedTerminal implements AaTerminalV0 {
	readonly writes: string[] = [];
	readonly asked: Array<{ kind: Kind; phrase: string; timeoutMs: number }> = [];
	private readonly decide: (kind: Kind, phrase: string, index: number) => Decision;
	constructor(decide: (kind: Kind, phrase: string, index: number) => Decision = (_k, phrase) => phrase) {
		this.decide = decide;
	}
	write(text: string) {
		this.writes.push(text);
	}
	async ask(prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
		const phrase = phraseOf(prompt);
		const kind = kindOf(prompt);
		this.asked.push({ kind, phrase, timeoutMs });
		const decision = this.decide(kind, phrase, this.asked.length - 1);
		if (decision !== HANG) return signal.aborted ? null : decision;
		return new Promise((resolve) => {
			const done = () => resolve(null);
			const timer = setTimeout(done, timeoutMs);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					done();
				},
				{ once: true },
			);
		});
	}
	get transcript() {
		return this.writes.join("");
	}
	count(kind: Kind) {
		return this.asked.filter((a) => a.kind === kind).length;
	}
}
