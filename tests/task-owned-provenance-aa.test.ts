import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareVerifiedInitialBranchPairV0 } from "../cli/initial-branch-set.ts";
import { type CoordinatorHooks, runNextSlot } from "../research/governed-initial-continuation/aa/coordinator.ts";
import { publishExclusiveV0 } from "../research/governed-initial-continuation/aa/exclusive-publish.ts";
import { buildExplicitServerArgsV0 } from "../research/governed-initial-continuation/aa/linux-profile.ts";
import { slotPath } from "../research/governed-initial-continuation/aa/reader.ts";
import { createStudyPlan, type StudyPlan } from "../research/governed-initial-continuation/aa/study-plan.ts";
import {
	procfsTaskOwnedObserverV0,
	sealTaskOwnedAdmission,
	type TaskOwnedAdmissionRecordV0,
	type TaskOwnedObserverV0,
	taskOwnedAdmissionPath,
} from "../research/governed-initial-continuation/aa/task-owned-admission.ts";
import {
	argvDigestV0,
	provenanceEndPathV0,
	provenancePathV0,
	readTaskOwnedProvenanceV0,
	sealProvenanceEndV0,
	sealProvenanceV0,
	TASK_OWNED_TRUST_ASSUMPTIONS_V0,
	type TaskOwnedProvenanceEndV0,
	type TaskOwnedProvenanceV0,
	validateTaskOwnedProvenanceV0,
} from "../research/governed-initial-continuation/aa/task-owned-provenance.ts";
import { readTaskOwnedStudyV0 } from "../research/governed-initial-continuation/aa/task-owned-reader.ts";
import {
	launchTaskOwnedServerV0,
	planTaskOwnedLaunchV0,
	type TaskOwnedLaunchRequestV0,
	type TaskOwnedServerV0,
} from "../research/governed-initial-continuation/aa/task-owned-server.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
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
const portIsFree = (port: number) =>
	new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
/** Processes whose executable is exactly this file: how a test proves that a task-owned server is really gone. */
function runningFrom(executable: string): string[] {
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
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
let backend: FakeOpenAiServer;
let tools: string;
let relay: string;
let crash: string;
let hang: string;
let model: string;
const sentinels: Array<ReturnType<typeof spawn>> = [];
const servers = new Set<TaskOwnedServerV0>();

beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
	backend = await startFakeOpenAiServer({ chunkMs: 2 });
	tools = mkdtempSync(join(fixture.base, "to-tools-"));
	const src = join(process.cwd(), "tests/fixtures/task-owned");
	relay = join(tools, "relay");
	crash = join(tools, "crash");
	hang = join(tools, "hang");
	execFileSync("cc", [`-DBACKEND_PORT=${new URL(backend.baseUrl).port}`, join(src, "relay.c"), "-o", relay]);
	execFileSync("cc", [join(src, "crash.c"), "-o", crash]);
	execFileSync("cc", [join(src, "hang.c"), "-o", hang]);
	model = join(tools, "model.gguf");
	writeFileSync(model, Buffer.alloc(8192, 7), { mode: 0o600 });
}, 180000);
afterAll(async () => {
	for (const server of servers) await server.stop().catch(() => {});
	for (const sentinel of sentinels) if (sentinel.exitCode === null) sentinel.kill("SIGKILL");
	await backend?.close();
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});

const request = async (overrides: Partial<TaskOwnedLaunchRequestV0> = {}): Promise<TaskOwnedLaunchRequestV0> => {
	const workingDirectory = mkdtempSync(join(fixture.base, "to-work-"));
	return {
		executablePath: relay,
		executableSha256: sha(relay),
		modelPath: model,
		modelSha256: sha(model),
		modelAlias: "task-owned-fake",
		gpuLayers: "12",
		port: await freePort(),
		readinessTimeoutMs: 20000,
		workingDirectory,
		...overrides,
	};
};
const approve = async (_plan: unknown, phrase: string) => phrase;
async function launch(studyFile: string, overrides: Partial<TaskOwnedLaunchRequestV0> = {}) {
	const server = await launchTaskOwnedServerV0(fixture.key, studyFile, await request(overrides), approve);
	servers.add(server);
	return server;
}
const hooks = (extra: Partial<CoordinatorHooks> = {}): CoordinatorHooks => ({
	checkEnvironment: async () => true,
	first: async (_plan, phrase) => phrase,
	second: async (_boundary, phrase) => phrase,
	...extra,
});
interface Study {
	file: string;
	outputParent: string;
	plan: StudyPlan;
}
/** Prepares the sibling pair first, then launches, so the provenance file never exists while lineage is verified. */
async function newStudy(
	seed = 0,
	mutate?: (body: Omit<TaskOwnedProvenanceV0, "commitment">) => void,
): Promise<{ study: Study; server: TaskOwnedServerV0 }> {
	const outputParent = mkdtempSync(join(fixture.base, "to-study-"));
	const prep = prepareVerifiedInitialBranchPairV0(
		fixture.source,
		fixture.replay,
		fixture.key,
		outputParent,
		{ id: "arm-a", description: "matched", settings: { thinkingLevel: "off" } },
		{ id: "arm-b", description: "matched", settings: { thinkingLevel: "off" } },
	);
	if (prep.status !== "prepared") throw new Error(prep.reason);
	const file = join(outputParent, "study.json");
	let server: TaskOwnedServerV0;
	let provenance: TaskOwnedProvenanceV0;
	if (!mutate) {
		server = await launch(file);
		provenance = server.provenance;
	} else {
		// The process is real; the record committed to the study is a re-sealed variant of what was observed.
		const scratch = mkdtempSync(join(fixture.base, "to-forge-"));
		server = await launch(join(scratch, "launch.json"));
		const { commitment: _commitment, ...body } = structuredClone(server.provenance);
		mutate(body);
		provenance = sealProvenanceV0(fixture.key, body);
		validateTaskOwnedProvenanceV0(provenance, fixture.key);
		publishExclusiveV0(provenancePathV0(file), provenance);
	}
	const options = {
		source: fixture.source,
		replay: fixture.replay,
		outputParent,
		preparation: prep.preparation,
		piExecutable: fixture.pi.bin,
		upstream: provenance.listener.endpoint,
		provider: "fake",
		model: "fake-1",
		prompt: "Compute 4 plus 5. Return only the decimal result.",
		continuationPrompt: "Repeat only the token in your immediately preceding answer.",
		wallTimeoutMs: 15000,
		maxApprovalIdleMs: 5000,
		maxTransferredBytes: 1048576,
	};
	const plan = await createStudyPlan(
		file,
		options,
		seed,
		"9",
		"task-owned fake endpoint",
		fixture.key,
		undefined,
		provenance,
	);
	return { study: { file, outputParent, plan }, server };
}
const observer = () => procfsTaskOwnedObserverV0(fixture.key);
const slot = (
	study: Study,
	obs: TaskOwnedObserverV0 = observer(),
	h: CoordinatorHooks = hooks(),
	signal?: AbortSignal,
	maxObservationAgeMs?: number,
) => runNextSlot(study.file, fixture.key, h, signal, undefined, { observer: obs, maxObservationAgeMs });
const fresh = (file: string, ...extra: string[]) =>
	spawnSync(process.execPath, ["tests/fixtures/read-aa-task-owned.ts", file, ...extra], { encoding: "utf8" });
const areaOf = (study: Study, position: number) => {
	const start = JSON.parse(readFileSync(slotPath(study.file, position, "start"), "utf8"));
	return join(study.outputParent, start.plan.initial.attemptId);
};

describe.runIf(process.platform === "linux")("task-owned launch refusals", () => {
	const expectNothingStarted = async (r: TaskOwnedLaunchRequestV0, exe = relay) => {
		expect(await portIsFree(r.port)).toBe(true);
		expect(runningFrom(exe)).toEqual([]);
	};
	it("refuses a wrong executable or model digest before anything is started", async () => {
		for (const wrong of ["executableSha256", "modelSha256"] as const) {
			const r = await request({ [wrong]: "0".repeat(64) });
			const file = join(mkdtempSync(join(fixture.base, "to-refuse-")), "study.json");
			await expect(launchTaskOwnedServerV0(fixture.key, file, r, approve)).rejects.toThrow("pinned digest mismatch");
			await expectNothingStarted(r);
		}
	});
	it("needs the exact phrase: declined, wrong, cancelled and expired approvals start nothing", async () => {
		const file = () => join(mkdtempSync(join(fixture.base, "to-refuse-")), "study.json");
		for (const answer of [null, "approve", "APPROVE TASK-OWNED SERVER 0000000000000000"]) {
			const r = await request();
			await expect(launchTaskOwnedServerV0(fixture.key, file(), r, async () => answer)).rejects.toThrow(
				"not approved",
			);
			await expectNothingStarted(r);
		}
		const r = await request();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		await expect(
			launchTaskOwnedServerV0(fixture.key, file(), r, () => new Promise<string>(() => {}), controller.signal),
		).rejects.toThrow("not approved");
		await expectNothingStarted(r);
		const pre = new AbortController();
		pre.abort();
		await expect(launchTaskOwnedServerV0(fixture.key, file(), await request(), approve, pre.signal)).rejects.toThrow(
			"cancelled",
		);
	});
	it("refuses unsupported profiles, an occupied port and a non-private working directory", async () => {
		const base = await request();
		expect(() => planTaskOwnedLaunchV0(fixture.key, { ...base, modelAlias: "bad alias" })).toThrow();
		expect(() => planTaskOwnedLaunchV0(fixture.key, { ...base, gpuLayers: "01" })).toThrow();
		expect(() => planTaskOwnedLaunchV0(fixture.key, { ...base, port: 80 })).toThrow();
		const file = join(mkdtempSync(join(fixture.base, "to-refuse-")), "study.json");
		const taken = createServer();
		await new Promise<void>((resolve) => taken.listen(base.port, "127.0.0.1", resolve));
		try {
			await expect(launchTaskOwnedServerV0(fixture.key, file, base, approve)).rejects.toThrow("port");
		} finally {
			await new Promise((resolve) => taken.close(resolve));
		}
		const open = mkdtempSync(join(fixture.base, "to-open-"));
		execFileSync("chmod", ["755", open]);
		await expect(
			launchTaskOwnedServerV0(fixture.key, file, await request({ workingDirectory: open }), approve),
		).rejects.toThrow("owner-only");
	});
	it("terminates a server that exits, never listens, or is cancelled during readiness", async () => {
		const file = () => join(mkdtempSync(join(fixture.base, "to-refuse-")), "study.json");
		const crashing = await request({ executablePath: crash, executableSha256: sha(crash) });
		await expect(launchTaskOwnedServerV0(fixture.key, file(), crashing, approve)).rejects.toThrow("exited");
		await expectNothingStarted(crashing, crash);
		const hanging = await request({ executablePath: hang, executableSha256: sha(hang), readinessTimeoutMs: 1000 });
		await expect(launchTaskOwnedServerV0(fixture.key, file(), hanging, approve)).rejects.toThrow("timed out");
		await expectNothingStarted(hanging, hang);
		const controller = new AbortController();
		const cancelled = await request({ executablePath: hang, executableSha256: sha(hang) });
		setTimeout(() => controller.abort(), 300);
		await expect(launchTaskOwnedServerV0(fixture.key, file(), cancelled, approve, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		await expectNothingStarted(cancelled, hang);
	}, 60000);
	it.each(["SIGKILL", "SIGTERM"] as const)(
		"ends the owned server and its listener when the launcher itself dies by %s",
		async (killSignal) => {
			const r = await request();
			const study = join(mkdtempSync(join(fixture.base, "to-death-")), "study.json");
			const launcher = spawn(
				process.execPath,
				["tests/fixtures/task-owned/launch-and-wait.ts", study, relay, model, String(r.port), r.workingDirectory],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			let out = "";
			launcher.stdout.on("data", (chunk) => {
				out += chunk;
			});
			for (let i = 0; i < 400 && !out.includes("ready"); i++) await sleep(50);
			expect(out).toMatch(/^ready [0-9]+/);
			expect(runningFrom(relay)).toHaveLength(1);
			launcher.kill(killSignal);
			for (let i = 0; i < 200 && (runningFrom(relay).length > 0 || !(await portIsFree(r.port))); i++)
				await sleep(50);
			expect(runningFrom(relay)).toEqual([]);
			expect(await portIsFree(r.port)).toBe(true);
		},
		60000,
	);
	it("has no unattended entry point: nothing in the CLI, scripts or package imports the launcher", () => {
		const text = (path: string) => readFileSync(path, "utf8");
		const roots = ["package.json", ...["cli", "scripts"].flatMap((d) => readdirSync(d).map((f) => join(d, f)))];
		for (const path of roots.filter((p) => /\.(json|ts|mjs|js)$/.test(p)))
			expect(text(path), path).not.toMatch(/task-owned-server/);
		const source = text("research/governed-initial-continuation/aa/task-owned-server.ts");
		expect(source).not.toMatch(/process\.argv|process\.stdin|\.catch\(\(\) => \{\}\)\s*$/m);
		expect(source).not.toMatch(/\bfetch\(|node:http|node:https/);
	});
});

describe.runIf(process.platform === "linux")("provenance record validation", () => {
	let provenance: TaskOwnedProvenanceV0;
	beforeAll(async () => {
		const file = join(mkdtempSync(join(fixture.base, "to-record-")), "study.json");
		const server = await launch(file);
		provenance = readTaskOwnedProvenanceV0(provenancePathV0(file), fixture.key);
		expect(same(provenance, server.provenance)).toBe(true);
		await server.stop();
	}, 60000);
	const resealed = (mutate: (body: Omit<TaskOwnedProvenanceV0, "commitment">) => void) => {
		const { commitment: _commitment, ...body } = structuredClone(provenance);
		mutate(body);
		return sealProvenanceV0(fixture.key, body);
	};
	it("commits to digests, profile, process, listener, launch and lifecycle, and keeps unavailable facts explicit", () => {
		expect(provenance.executable.sha256).toBe(sha(relay));
		expect(provenance.model.sha256).toBe(sha(model));
		expect(provenance.process.pid).toBeGreaterThan(0);
		// The keeper, not the server, leads the group; the launcher verified the server is in it.
		expect(provenance.lifecycle.processGroup).not.toBe(provenance.process.pid);
		expect(provenance.lifecycle.ownership).toBe("declared-task-spawned");
		expect(provenance.listener.endpoint).toBe(provenance.declaredProfile.endpoint);
		expect(provenance.checks.ownership).toBe("UNAVAILABLE");
		expect(provenance.checks.effectiveRuntimeConfiguration).toBe("UNAVAILABLE");
		// A test double is not the pinned llama.cpp build: that is reported, not hidden or forced.
		expect(provenance.checks.supportedBinary).toBe("UNSUPPORTED");
		expect(provenance.blockingReasons).toContain("OWNERSHIP_UNVERIFIED");
		expect(provenance.unavailable).toContain("sole-socket-ownership");
		expect(provenance.trustAssumptions).toEqual([...TASK_OWNED_TRUST_ASSUMPTIONS_V0]);
		expect(JSON.stringify(provenance)).not.toContain("--ctx-size");
		expect(Object.keys(provenance.launch)).not.toContain("argv");
	});
	it.each([
		[
			"ownership upgraded to MATCH",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.checks.ownership = "MATCH";
			},
		],
		[
			"effective runtime upgraded",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.checks.effectiveRuntimeConfiguration = "MATCH";
			},
		],
		[
			"process check not matched",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.checks.process = "MISMATCH";
			},
		],
		[
			"a second visible socket owner",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.checks.visibleOwners = "MISMATCH";
			},
		],
		[
			"reuse-port enabled",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.checks.reusePort = "MISMATCH";
			},
		],
		[
			"ownership blocking reason removed",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.blockingReasons = b.blockingReasons.filter((r) => r !== "OWNERSHIP_UNVERIFIED");
			},
		],
		[
			"unavailable facts removed",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.unavailable = [];
			},
		],
		[
			"trust assumption dropped",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.trustAssumptions = b.trustAssumptions.slice(1);
			},
		],
		[
			"supported binary overstated",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.supportedBinary = "MATCH";
				b.checks.supportedBinary = "MATCH";
			},
		],
		[
			"launch flags changed without the declared profile",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.launch.argvDigest = argvDigestV0(fixture.key, [b.executable.path, "--other"]);
			},
		],
		[
			"declared profile changed without its launch digest",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.declaredProfile.gpuLayers = "13";
			},
		],
		[
			"listener differs from the declared endpoint",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.listener.endpoint = "http://127.0.0.1:1999";
			},
		],
		[
			"spawn after observation",
			(b: Omit<TaskOwnedProvenanceV0, "commitment">) => {
				b.lifecycle.spawnedAt = new Date(Date.parse(b.observedAt) + 1000).toISOString();
			},
		],
	])("rejects a re-sealed record with %s", (_name, mutate) => {
		expect(() => validateTaskOwnedProvenanceV0(resealed(mutate), fixture.key)).toThrow();
	});
	it("rejects an unsealed edit and an extra field", () => {
		const edited = structuredClone(provenance);
		edited.process.pid += 1;
		expect(() => validateTaskOwnedProvenanceV0(edited, fixture.key)).toThrow("commitment");
		expect(() => validateTaskOwnedProvenanceV0({ ...provenance, extra: 1 }, fixture.key)).toThrow();
	});
	it("builds launch and inspection from one argument definition", () => {
		const declared = provenance.declaredProfile;
		const args = buildExplicitServerArgsV0(declared);
		expect(args).toContain("--fit");
		expect(args[args.indexOf("--fit") + 1]).toBe("off");
		expect(same(provenance.launch.argvDigest, argvDigestV0(fixture.key, [provenance.executable.path, ...args]))).toBe(
			true,
		);
	});
});

describe.runIf(process.platform === "linux")("task-owned study admission", () => {
	let study: Study;
	let server: TaskOwnedServerV0;
	let before = 0;
	const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
	sentinels.push(sentinel);

	beforeAll(async () => {
		({ study, server } = await newStudy(0));
		before = backend.requests.length;
		for (let index = 0; index < 4; index++) expect(await slot(study)).toBe("completed");
	}, 240000);

	it("admits four governed fake sessions with real observations and exactly eight upstream requests", async () => {
		expect(backend.requests.length - before).toBe(8);
		const report = await readTaskOwnedStudyV0(study.file, fixture.key);
		expect(report).toMatchObject({
			studyStatus: "four-receipts",
			records: "valid",
			admissionSidecars: 8,
			observedProcessIdentity: "consistent",
			studyAdmission: "complete",
			lifecycle: "open",
			hostFacts: { ownership: "OWNERSHIP_UNVERIFIED", checks: { ownership: "UNAVAILABLE" } },
		});
		expect(report.declaredTrustAssumptions).toEqual([...TASK_OWNED_TRUST_ASSUMPTIONS_V0]);
		expect(report.hostFacts.unavailable).toContain("sole-socket-ownership");
		expect(new Set(report.observationIds).size).toBe(8);
		const out = fresh(study.file, "--require-complete");
		expect(out.status).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			studyAdmission: "complete",
			observedProcessIdentity: "consistent",
		});
		// The synthetic reader does not take a task-owned plan's evidence for synthetic evidence.
		const sidecar = JSON.parse(
			readFileSync(taskOwnedAdmissionPath(areaOf(study, 1), 1), "utf8"),
		) as TaskOwnedAdmissionRecordV0;
		expect(sidecar.observation.pid).toBe(server.provenance.process.pid);
		expect(sidecar.upstream).toBe(server.provenance.listener.endpoint);
	});
	it("stops only the owned process group and records confirmed cleanup", async () => {
		const pid = server.provenance.process.pid;
		const end = await server.stop();
		expect(await server.stop()).toBe(end);
		expect(end).toMatchObject({ processGone: true, listenerGone: true });
		expect(runningFrom(relay)).toEqual([]);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(await portIsFree(server.provenance.listener.port)).toBe(true);
		expect(sentinel.exitCode).toBeNull();
		expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
		const report = await readTaskOwnedStudyV0(study.file, fixture.key);
		expect(report).toMatchObject({ lifecycle: "cleaned", studyAdmission: "complete" });
		expect(fresh(study.file, "--require-complete").status).toBe(0);
		await expect(slot(study)).rejects.toThrow();
	});

	describe("tampering", () => {
		/** A syntactically valid edit whose commitment is left stale. */
		const unsealed = (text: string, change: (record: Record<string, unknown>) => void) => {
			const record = JSON.parse(text) as Record<string, unknown>;
			change(record);
			return canonicalEndoJsonV0(record);
		};
		const sidecar = (position: number, turn: 1 | 2) => taskOwnedAdmissionPath(areaOf(study, position), turn);
		const withFile = async (path: string, content: string | Buffer | null, run: () => Promise<void>) => {
			const original = readFileSync(path);
			try {
				if (content === null) rmSync(path);
				else writeFileSync(path, content, { mode: 0o600 });
				await run();
			} finally {
				writeFileSync(path, original, { mode: 0o600 });
			}
		};
		const resealedSidecar = (path: string, change: (record: Record<string, unknown>) => void) => {
			const { commitment: _commitment, ...body } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			change(body);
			return canonicalEndoJsonV0(sealTaskOwnedAdmission(fixture.key, body as never));
		};
		it("refuses byte edits, deletion, extra and mixed sidecars", async () => {
			const path = sidecar(1, 1);
			const original = readFileSync(path, "utf8");
			await withFile(
				path,
				unsealed(original, (r) => {
					r.turn = 2;
				}),
				async () => {
					await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
					expect(fresh(study.file).status).not.toBe(0);
				},
			);
			await withFile(path, "{}", async () => {
				await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
			});
			await withFile(path, null, async () => {
				await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow("missing");
			});
			for (const extra of ["task-owned-admission-3.json", "synthetic-admission-1.json"]) {
				const file = join(areaOf(study, 1), extra);
				writeFileSync(file, "{}", { mode: 0o600 });
				try {
					await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
				} finally {
					rmSync(file);
				}
			}
			expect((await readTaskOwnedStudyV0(study.file, fixture.key)).studyAdmission).toBe("complete");
		});
		it.each([
			[
				"turn",
				(r: Record<string, unknown>) => {
					r.turn = 2;
				},
			],
			[
				"position",
				(r: Record<string, unknown>) => {
					r.position = 2;
				},
			],
			[
				"attempt",
				(r: Record<string, unknown>) => {
					r.attemptId = "other";
				},
			],
			[
				"request body",
				(r: Record<string, unknown>) => {
					r.requestDigest = fixture.key.digest("another body");
				},
			],
			[
				"dispatch marker",
				(r: Record<string, unknown>) => {
					r.dispatchCommitment = fixture.key.digest("marker");
				},
			],
			[
				"approval",
				(r: Record<string, unknown>) => {
					r.approvalCommitment = fixture.key.digest("approval");
				},
			],
			[
				"study",
				(r: Record<string, unknown>) => {
					r.studyCommitment = fixture.key.digest("study");
				},
			],
			[
				"slot",
				(r: Record<string, unknown>) => {
					r.startCommitment = fixture.key.digest("slot");
				},
			],
			[
				"provenance",
				(r: Record<string, unknown>) => {
					r.provenanceCommitment = fixture.key.digest("provenance");
				},
			],
			[
				"upstream",
				(r: Record<string, unknown>) => {
					r.upstream = "http://127.0.0.1:9";
				},
			],
			[
				"refusal state",
				(r: Record<string, unknown>) => {
					r.refusalReason = "none";
				},
			],
			[
				"reused observation",
				(r: Record<string, unknown>) => {
					r.observation = {
						...(r.observation as object),
						observationId: JSON.parse(readFileSync(sidecar(1, 2), "utf8")).observation.observationId,
					};
				},
			],
			[
				"stale observation",
				(r: Record<string, unknown>) => {
					r.observation = {
						...(r.observation as object),
						observedAt: new Date(Date.parse(r.admittedAt as string) - 11000).toISOString(),
					};
				},
			],
			[
				"observation after admission",
				(r: Record<string, unknown>) => {
					r.observation = {
						...(r.observation as object),
						observedAt: new Date(Date.parse(r.admittedAt as string) + 1).toISOString(),
					};
				},
			],
		])("refuses a re-sealed sidecar with a changed %s", async (_name, change) => {
			const path = sidecar(1, 1);
			await withFile(path, resealedSidecar(path, change), async () => {
				await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
				expect(fresh(study.file, "--require-complete").status).not.toBe(0);
			});
		});
		it.each([
			["pid", () => ({ pid: 1 })],
			["startTicks", () => ({ startTicks: "1" })],
			["socketInode", () => ({ socketInode: "1" })],
			["argvDigest", () => ({ argvDigest: fixture.key.digest("other flags") })],
			["environmentDigest", () => ({ environmentDigest: fixture.key.digest("other environment") })],
		])(
			"reports an observed %s that differs from the provenance as inconsistent, not admitted",
			async (field, patch) => {
				const path = sidecar(2, 2);
				await withFile(
					path,
					resealedSidecar(path, (r) => {
						r.observation = { ...(r.observation as object), ...patch() };
					}),
					async () => {
						const report = await readTaskOwnedStudyV0(study.file, fixture.key);
						expect(report).toMatchObject({
							records: "valid",
							observedProcessIdentity: "inconsistent",
							studyAdmission: "refused",
						});
						expect(report.identityDifferences).toEqual([field]);
						const out = fresh(study.file, "--require-complete");
						expect(out.status).toBe(3);
						expect(JSON.parse(out.stdout).studyAdmission).toBe("refused");
					},
				);
			},
		);
		it("refuses a swapped, edited or upgraded provenance file and a plan that no longer matches it", async () => {
			const path = provenancePathV0(study.file);
			const original = JSON.parse(readFileSync(path, "utf8")) as TaskOwnedProvenanceV0;
			const { commitment: _commitment, ...body } = original;
			const variants = [
				unsealed(readFileSync(path, "utf8"), (r) => {
					(r.process as { pid: number }).pid += 1;
				}),
				canonicalEndoJsonV0(
					sealProvenanceV0(fixture.key, {
						...body,
						observedAt: new Date(Date.parse(body.observedAt) - 1).toISOString(),
					}),
				),
				canonicalEndoJsonV0(
					sealProvenanceV0(fixture.key, { ...body, checks: { ...body.checks, ownership: "MATCH" } }),
				),
				"{}",
			];
			for (const variant of variants)
				await withFile(path, variant, async () => {
					await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
				});
			await withFile(path, null, async () => {
				await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
			});
		});
		it("validates the end record: wrong start, early stop and unconfirmed cleanup", async () => {
			const path = provenanceEndPathV0(study.file);
			const original = JSON.parse(readFileSync(path, "utf8")) as TaskOwnedProvenanceEndV0;
			const { commitment: _commitment, ...body } = original;
			const seal = (b: object) => canonicalEndoJsonV0(sealProvenanceEndV0(fixture.key, b as never));
			await withFile(path, seal({ ...body, startCommitment: fixture.key.digest("elsewhere") }), async () => {
				await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
			});
			await withFile(
				path,
				seal({ ...body, stoppedAt: new Date(Date.parse(body.stoppedAt) - 3600000).toISOString() }),
				async () => {
					await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
				},
			);
			await withFile(path, seal({ ...body, listenerGone: false }), async () => {
				expect((await readTaskOwnedStudyV0(study.file, fixture.key)).lifecycle).toBe("cleanup-unconfirmed");
			});
			await withFile(
				path,
				unsealed(readFileSync(path, "utf8"), (r) => {
					r.processGone = false;
				}),
				async () => {
					await expect(readTaskOwnedStudyV0(study.file, fixture.key)).rejects.toThrow();
				},
			);
		});
	});
});

describe.runIf(process.platform === "linux")("live admission refusals", () => {
	const turnOneRefusals: Array<[string, (b: Omit<TaskOwnedProvenanceV0, "commitment">) => void]> = [
		[
			"wrong executable identity",
			(b) => {
				b.executable.identity.inode = String(BigInt(b.executable.identity.inode) + 1n);
			},
		],
		[
			"wrong model identity",
			(b) => {
				b.model.identity.size = String(BigInt(b.model.identity.size) + 1n);
			},
		],
		[
			"changed process identity",
			(b) => {
				b.process.startTicks = String(BigInt(b.process.startTicks) + 1n);
			},
		],
		[
			"wrong listener inode",
			(b) => {
				b.listener.socketInode = "1";
			},
		],
		[
			"wrong listener descriptor",
			(b) => {
				b.listener.socketFd = String(Number(b.listener.socketFd) + 40);
			},
		],
		[
			"changed launch flags",
			(b) => {
				b.declaredProfile.gpuLayers = "13";
				b.launch.argvDigest = argvDigestV0(fixture.key, [
					b.executable.path,
					...buildExplicitServerArgsV0(b.declaredProfile),
				]);
			},
		],
	];
	it("names the changed fact, so each refusal is for its own reason and a healthy process is not refused", async () => {
		const file = join(mkdtempSync(join(fixture.base, "to-reason-")), "study.json");
		const server = await launch(file);
		try {
			const real = observer();
			const signal = new AbortController().signal;
			const healthy = await real.observe(server.provenance, 1, signal);
			expect(real.recheck(server.provenance, healthy, 1)).toBe(true);
			const reasons = [
				/file identity changed/,
				/file identity changed/,
				/process identity changed/,
				/listener/,
				/ENOENT/,
				/launch arguments/,
			];
			for (const [index, [name, mutate]] of turnOneRefusals.entries()) {
				const { commitment: _commitment, ...body } = structuredClone(server.provenance);
				mutate(body);
				const forged = sealProvenanceV0(fixture.key, body);
				await expect(real.observe(forged, 1, signal), name).rejects.toThrow(reasons[index]!);
				expect(real.recheck(forged, healthy, 1), name).toBe(false);
			}
			const aborted = new AbortController();
			aborted.abort();
			await expect(real.observe(server.provenance, 1, aborted.signal)).rejects.toThrow("cancelled");
		} finally {
			await server.stop();
		}
	}, 60000);
	it.each(turnOneRefusals)(
		"sends no upstream request when the process shows a %s",
		async (_name, mutate) => {
			const { study, server } = await newStudy(0, mutate);
			const before = backend.requests.length;
			try {
				await slot(study);
				expect(backend.requests.length - before).toBe(0);
				expect(() => readFileSync(taskOwnedAdmissionPath(areaOf(study, 1), 1))).toThrow();
				// The slot is spent: it is not retried, and no other request is made.
				await expect(slot(study)).rejects.toThrow();
				expect(backend.requests.length - before).toBe(0);
			} finally {
				await server.stop();
			}
			expect(runningFrom(relay)).toEqual([]);
		},
		90000,
	);

	it("refuses a crashed server before dispatch, and a server killed between the turns after exactly one request", async () => {
		const first = await newStudy(0);
		const countBefore = backend.requests.length;
		process.kill(-first.server.provenance.lifecycle.processGroup, "SIGKILL");
		await sleep(100);
		await slot(first.study);
		expect(backend.requests.length - countBefore).toBe(0);
		const end = await first.server.stop();
		expect(end.processGone).toBe(true);

		const second = await newStudy(0);
		const mid = backend.requests.length;
		await slot(
			second.study,
			observer(),
			hooks({
				second: async (_boundary, phrase) => {
					process.kill(-second.server.provenance.lifecycle.processGroup, "SIGKILL");
					await sleep(100);
					return phrase;
				},
			}),
		);
		expect(backend.requests.length - mid).toBe(1);
		await expect(slot(second.study)).rejects.toThrow();
		expect(backend.requests.length - mid).toBe(1);
		await second.server.stop();
	}, 120000);

	it("refuses a different process that took over the same listener port", async () => {
		const original = await newStudy(0);
		const port = original.server.provenance.listener.port;
		process.kill(-original.server.provenance.lifecycle.processGroup, "SIGKILL");
		await sleep(100);
		const scratch = join(mkdtempSync(join(fixture.base, "to-replacement-")), "other.json");
		const replacement = await launch(scratch, { port });
		expect(replacement.provenance.process.pid).not.toBe(original.server.provenance.process.pid);
		const before = backend.requests.length;
		await slot(original.study);
		expect(backend.requests.length - before).toBe(0);
		await replacement.stop();
		await original.server.stop();
	}, 120000);

	it("refuses stale observations at the admission boundary", async () => {
		const { study, server } = await newStudy(0);
		const real = observer();
		const before = backend.requests.length;
		await slot(study, {
			observe: async (p, turn, signal) => {
				const o = await real.observe(p, turn, signal);
				return { ...o, observedAt: new Date(Date.now() - 60000).toISOString() };
			},
			recheck: real.recheck,
		});
		expect(backend.requests.length - before).toBe(0);
		await server.stop();
		const second = await newStudy(0);
		const mid = backend.requests.length;
		await slot(
			second.study,
			{
				observe: async (p, turn, signal) => {
					const o = await real.observe(p, turn, signal);
					await sleep(60); // the observation ages before the boundary
					return o;
				},
				recheck: real.recheck,
			},
			hooks(),
			undefined,
			5,
		);
		expect(backend.requests.length - mid).toBe(0);
		await second.server.stop();
	}, 120000);

	it("honours cancellation during observation and at the boundary, with no sidecar and no request", async () => {
		for (const point of ["observe", "boundary"] as const) {
			const { study, server } = await newStudy(0);
			const real = observer();
			const controller = new AbortController();
			const before = backend.requests.length;
			await slot(
				study,
				{
					observe: async (p, turn, signal) => {
						if (point === "observe") {
							setTimeout(() => controller.abort(), 20);
							await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						}
						return real.observe(p, turn, signal);
					},
					recheck: (p, o, turn) => {
						if (point === "boundary") controller.abort();
						return real.recheck(p, o, turn);
					},
				},
				hooks(),
				controller.signal,
			).catch(() => "cancelled");
			expect(backend.requests.length - before).toBe(0);
			expect(() => readFileSync(taskOwnedAdmissionPath(areaOf(study, 1), 1))).toThrow();
			await server.stop();
			expect(runningFrom(relay)).toEqual([]);
		}
	}, 120000);

	it("refuses a repeated observation id and a failed boundary recheck, without retrying", async () => {
		const real = observer();
		const repeated = await newStudy(0);
		const first = await real.observe(repeated.server.provenance, 1, new AbortController().signal);
		const before = backend.requests.length;
		await slot(repeated.study, {
			observe: async (p, turn, signal) =>
				turn === 1
					? { ...(await real.observe(p, turn, signal)), observationId: first.observationId }
					: { ...first },
			recheck: real.recheck,
		});
		// The first observation is new to this study; the second reuses its id and is refused after one request.
		expect(backend.requests.length - before).toBe(1);
		await repeated.server.stop();

		const drift = await newStudy(0);
		const mid = backend.requests.length;
		await slot(drift.study, { observe: real.observe, recheck: () => false });
		expect(backend.requests.length - mid).toBe(0);
		await drift.server.stop();
	}, 120000);

	it("refuses an observer whose reported facts differ from the provenance, even with a matching pid", async () => {
		const { study, server } = await newStudy(0);
		const real = observer();
		const before = backend.requests.length;
		await slot(study, {
			observe: async (p, turn, signal) => ({ ...(await real.observe(p, turn, signal)), socketInode: "1" }),
			recheck: () => true,
		});
		expect(backend.requests.length - before).toBe(0);
		expect(() => readFileSync(taskOwnedAdmissionPath(areaOf(study, 1), 1))).toThrow();
		await server.stop();
	}, 90000);
	it("lets a failed stop be retried and adopts an end record a first attempt already wrote", async () => {
		const file = join(mkdtempSync(join(fixture.base, "to-stop-")), "study.json");
		const server = await launch(file);
		writeFileSync(provenanceEndPathV0(file), "occupied", { mode: 0o600 });
		await expect(server.stop()).rejects.toThrow();
		rmSync(provenanceEndPathV0(file));
		const end = await server.stop();
		expect(end).toMatchObject({ processGone: true, listenerGone: true });
		expect(runningFrom(relay)).toEqual([]);
	}, 60000);
	it("refuses mixed admission modes and a stopped server", async () => {
		const { study, server } = await newStudy(0);
		const before = backend.requests.length;
		await expect(runNextSlot(study.file, fixture.key, hooks())).rejects.toThrow("mode mismatch");
		await expect(
			runNextSlot(study.file, fixture.key, hooks(), undefined, {
				prepare: async () => ({ identity: "x", observationId: "0".repeat(32) }),
				recheck: () => true,
			}),
		).rejects.toThrow("mode mismatch");
		await server.stop();
		await expect(slot(study)).rejects.toThrow("already stopped");
		expect(backend.requests.length - before).toBe(0);
		const outputParent = mkdtempSync(join(fixture.base, "to-mixed-"));
		await expect(
			createStudyPlan(
				join(outputParent, "s.json"),
				study.plan.options,
				0,
				"9",
				"x",
				fixture.key,
				"synthetic",
				server.provenance,
			),
		).rejects.toThrow();
	}, 90000);
});
