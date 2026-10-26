// One local, explicitly approved fresh Pi turn derived from a currently pristine prepared child.
// This is not a resume, a sandbox, a remote-human authentication scheme, or an exactly-once service.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { EndoCaptureLogV0, endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { harnessSurfacesOfCaptureV0 } from "../adapters/openai-proxy/harness-surface.ts";
import { endoRequestDigestV0 } from "../adapters/openai-proxy/http.ts";
import { endoUpstreamOriginV0, startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { piProjectConfigurationDigestV0, piUserConfigurationDigestV0 } from "../adapters/pi/configuration.ts";
import { fingerprintPiRuntimeV0 } from "../adapters/pi/identity.ts";
import type { EndoInitialBranchSetV0 } from "../protocol/initial-branch-set.ts";
import {
	ENDO_INITIAL_CHILD_EXECUTION_MAX_BYTES_V0,
	type EndoInitialChildExecutionPlanV0,
	type EndoInitialChildExecutionV0,
	readEndoInitialChildExecutionV0,
} from "../protocol/initial-child-execution.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import {
	archiveEndoWorkspaceV0,
	readEndoWorkspaceArchiveV0,
	restoreEndoWorkspaceV0,
} from "../storage/workspace-snapshot.ts";
import { piCassetteEnvV0 } from "./cassette-session.ts";
import {
	captureGenerationV0,
	completeEvidenceStore,
	readVerifiedCheckpointCandidateV0,
} from "./checkpoint-candidate.ts";
import { checkpointOutputParent } from "./checkpoint-filesystem.ts";
import { readVerifiedInitialBranchSetV0 } from "./initial-branch-set.ts";
import { readEndoStoreEventsV0, trajectoryFromStoreV0 } from "./trajectory.ts";

export interface InitialChildExecutionOptionsV0 {
	source: string;
	replay: string;
	outputParent: string;
	preparation: string;
	childRole: "baseline" | "alternative";
	piExecutable: string;
	upstream: string;
	provider: string;
	model: string;
	prompt: string;
	wallTimeoutMs: number;
	maxTransferredBytes: number;
}
export type InitialChildPreflightV0 =
	| { status: "ready"; plan: EndoInitialChildExecutionPlanV0 }
	| { status: "refused"; reason: string };
export type InitialChildApprovalV0 = {
	attemptId: string;
	planCommitment: EndoKeyedDigestV0;
	confirmedAt: string;
	method: "local-explicit";
};
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
const planDigest = (key: EndoDigestKeyV0, plan: Omit<EndoInitialChildExecutionPlanV0, "commitment">) =>
	key.digest({ purpose: "endo.initial-child-execution.plan.v0", plan });
const receiptDigest = (key: EndoDigestKeyV0, receipt: Omit<EndoInitialChildExecutionV0, "commitment">) =>
	key.digest({ purpose: "endo.initial-child-execution.receipt.v0", receipt });
const promptDigest = (key: EndoDigestKeyV0, prompt: string) =>
	key.digest({ purpose: "endo.initial-child-execution.prompt.v0", prompt });

/** OpenAI text content as observed from Pi: preserve every text byte and refuse other content. */
function promptText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || content.length === 0) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (
			part === null ||
			typeof part !== "object" ||
			Array.isArray(part) ||
			Object.keys(part).some((key) => key !== "type" && key !== "text") ||
			part.type !== "text" ||
			typeof part.text !== "string"
		)
			return null;
		parts.push(part.text);
	}
	return parts.join("");
}
const ATTEMPT_PREFIX = "endo.initial-child-attempt.";
const REQUIRED_FLAGS = [
	"--no-tools",
	"--no-extensions",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-approve",
	"--offline",
	"--provider",
	"--model",
	"--session-dir",
	"--session-id",
];
async function withinDeadline<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), Math.max(0, deadline - Date.now()));
				if (signal) {
					onAbort = () => reject(new Error("cancelled"));
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

function privateFile(path: string, max: number): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > max)
			throw new Error("private file unavailable");
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
	} finally {
		closeSync(fd);
	}
}
function manifestOf(
	plan: Pick<EndoInitialChildExecutionPlanV0, "outputParent" | "preparation">,
): EndoInitialBranchSetV0 {
	return JSON.parse(privateFile(join(plan.outputParent, plan.preparation, "branch-set.json"), 256 * 1024));
}
function supportedArchive(bytes: Uint8Array, provider: string, model: string): string | null {
	const parsed = readEndoWorkspaceArchiveV0(bytes);
	if (!parsed.ok || parsed.schemaVersion !== "endo.workspace-archive.v1") return "unsupported archive";
	const entries = parsed.value.entries;
	const files = entries.filter((e) => e.type === "file");
	if (entries.some((e) => e.type === "symlink" || (e.type === "file" && e.executable)))
		return "symlink or executable archive entry";
	if (
		entries.some(
			(e) =>
				e.path !== "home" &&
				e.path !== "agent" &&
				e.path !== "work" &&
				!e.path.startsWith("work/") &&
				e.path !== "agent/models.json" &&
				e.path !== "agent/settings.json",
		)
	)
		return "unsupported archived path or startup configuration";
	if (
		entries.some(
			(e) =>
				e.path.startsWith("work/") &&
				/(^|\/)(?:AGENTS\.md|\.pi|\.codex|\.agents|\.env|\.mcp\.json|package\.json)(\/|$)/.test(e.path),
		)
	)
		return "unresolved workspace startup or secret path";
	if (
		files.some(
			(e) => e.path !== "agent/models.json" && e.path !== "agent/settings.json" && !e.path.startsWith("work/"),
		)
	)
		return "unsupported agent file";
	const config = files.find((e) => e.path === "agent/models.json");
	if (!config || config.type !== "file") return "models.json missing";
	try {
		const parsedConfig = JSON.parse(Buffer.from(config.base64, "base64").toString("utf8"));
		if (!same(Object.keys(parsedConfig), ["providers"]) || !same(Object.keys(parsedConfig.providers), [provider]))
			return "unsupported models.json provider configuration";
		const entry = parsedConfig.providers[provider];
		if (
			!same(Object.keys(entry).sort(), ["api", "apiKey", "baseUrl", "models"]) ||
			entry.api !== "openai-completions" ||
			entry.apiKey !== "local" ||
			!Array.isArray(entry.models) ||
			entry.models.length !== 1 ||
			!same(entry.models[0], { id: model }) ||
			typeof entry.baseUrl !== "string" ||
			!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(entry.baseUrl)
		)
			return "unsupported or unresolved models.json configuration";
		const settings = files.find((e) => e.path === "agent/settings.json");
		if (
			settings?.type === "file" &&
			!same(JSON.parse(Buffer.from(settings.base64, "base64").toString("utf8")), { thinkingLevel: "off" })
		)
			return "unsupported historical settings";
	} catch {
		return "malformed models.json or settings.json";
	}
	return null;
}
function supportedCondition(manifest: EndoInitialBranchSetV0, role: "baseline" | "alternative"): string | null {
	const condition = manifest.children[role].condition.specification;
	if (condition.modelEntry || condition.extensions || condition.environment || condition.interventions)
		return "unsupported condition manipulation";
	if (condition.settings !== undefined && !same(condition.settings, { thinkingLevel: "off" }))
		return "unsupported condition settings";
	return null;
}
function helpFlags(executable: string, outputParent: string): Promise<boolean> {
	return new Promise((resolve) =>
		execFile(
			executable,
			["--help"],
			{
				cwd: outputParent,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: outputParent,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					PI_TELEMETRY: "0",
				},
				timeout: 5000,
				maxBuffer: 64 * 1024,
				shell: false,
			},
			(error, stdout) =>
				resolve(
					error === null &&
						REQUIRED_FLAGS.every((flag) => new RegExp(`(^|\\s)${flag}(\\s|$)`).test(String(stdout))),
				),
		),
	);
}

/** No endpoint probe, proxy, Pi RPC session, prompt or model request. Runs local --version and --help only. */
export async function preflightInitialChildExecutionV0(
	options: InitialChildExecutionOptionsV0,
	key: EndoDigestKeyV0,
): Promise<InitialChildPreflightV0> {
	try {
		if (
			!isAbsolute(options.piExecutable) ||
			!/^[-a-zA-Z0-9_.]{1,128}$/.test(options.provider) ||
			!/^[-a-zA-Z0-9_./:]{1,256}$/.test(options.model) ||
			!Number.isSafeInteger(options.wallTimeoutMs) ||
			options.wallTimeoutMs < 1000 ||
			options.wallTimeoutMs > 120000 ||
			!Number.isSafeInteger(options.maxTransferredBytes) ||
			options.maxTransferredBytes < 1024 ||
			options.maxTransferredBytes > 16 * 1024 * 1024 ||
			Buffer.byteLength(options.prompt) < 1 ||
			Buffer.byteLength(options.prompt) > 4096
		)
			throw new Error("invalid execution bounds or selection");
		const endpoint = endoUpstreamOriginV0(options.upstream);
		if (!["127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname))
			throw new Error("only a local loopback upstream is supported");
		const parent = checkpointOutputParent(options.source, options.replay, options.outputParent);
		if (!parent.ok) throw new Error(parent.reason);
		const checked = readVerifiedInitialBranchSetV0(
			options.source,
			options.replay,
			key,
			options.outputParent,
			options.preparation,
		);
		if (checked.status !== "verified-pristine") throw new Error("branch set or a prepared child is not pristine");
		const manifest = manifestOf(options);
		if (supportedCondition(manifest, options.childRole))
			throw new Error(supportedCondition(manifest, options.childRole)!);
		const candidate = readVerifiedCheckpointCandidateV0(options.source, options.replay, key);
		if (candidate.status !== "qualified" || !same(candidate.candidate, manifest.parent))
			throw new Error("parent checkpoint changed");
		const archive = createEndoBlobStoreV0(endoCaptureRootV0(options.source), key, { readOnly: true }).get(
			candidate.candidate.archive.digest,
		);
		if (archive.length > 16 * 1024 * 1024) throw new Error("source archive exceeds execution artifact bound");
		const archiveProblem = supportedArchive(archive, options.provider, options.model);
		if (archiveProblem) throw new Error(archiveProblem);
		const fingerprint = await fingerprintPiRuntimeV0({
			attachment: "pi.initial-child",
			executable: options.piExecutable,
			cwd: options.outputParent,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: options.outputParent,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		});
		if (
			!fingerprint.reported.version ||
			!fingerprint.local.realPath ||
			!fingerprint.local.entrypoint ||
			!(await helpFlags(options.piExecutable, options.outputParent))
		)
			throw new Error("Pi executable or required resource-disabling flags unverified");
		const body: Omit<EndoInitialChildExecutionPlanV0, "commitment"> = {
			attemptId: `${ATTEMPT_PREFIX}${randomUUID()}`,
			source: options.source,
			replay: options.replay,
			outputParent: options.outputParent,
			preparation: options.preparation,
			branchId: manifest.id,
			branchCommitment: manifest.commitment,
			parentReference: manifest.parentReference,
			childRole: options.childRole,
			childId: manifest.children[options.childRole].id,
			conditionCommitment: manifest.children[options.childRole].condition.commitment,
			archiveDigest: candidate.candidate.archive.digest,
			piExecutable: options.piExecutable,
			piIdentity: fingerprint.identity.digest,
			piVersion: fingerprint.reported.version,
			provider: options.provider,
			model: options.model,
			upstream: endpoint.origin,
			promptCommitment: promptDigest(key, options.prompt),
			toolPolicy: "none",
			wallTimeoutMs: options.wallTimeoutMs,
			maxTransferredBytes: options.maxTransferredBytes,
		};
		return { status: "ready", plan: { ...body, commitment: planDigest(key, body) } };
	} catch (error) {
		return { status: "refused", reason: (error as Error).message.slice(0, 128) };
	}
}

/** The caller must show the plan and explicitly pass its exact commitment. This is local confirmation only. */
export function approveInitialChildExecutionV0(
	plan: EndoInitialChildExecutionPlanV0,
	exactCommitment: EndoKeyedDigestV0,
	confirmation: "approve one tool-free turn",
): InitialChildApprovalV0 {
	if (confirmation !== "approve one tool-free turn" || !same(plan.commitment, exactCommitment))
		throw new TypeError("exact plan approval required");
	return {
		attemptId: plan.attemptId,
		planCommitment: structuredClone(plan.commitment),
		confirmedAt: new Date().toISOString(),
		method: "local-explicit",
	};
}

/** Optional durable record of a no-inference refusal, only under a verified private output parent. */
export function recordInitialChildPreflightRefusalV0(
	options: Pick<InitialChildExecutionOptionsV0, "source" | "replay" | "outputParent">,
	key: EndoDigestKeyV0,
	reason: string,
): { status: "recorded"; receipt: string } | { status: "refused"; reason: string } {
	const parent = checkpointOutputParent(options.source, options.replay, options.outputParent);
	if (!parent.ok) return { status: "refused", reason: parent.reason };
	if (reason.length === 0 || reason.length > 128) return { status: "refused", reason: "invalid refusal reason" };
	const attemptId = `${ATTEMPT_PREFIX}${randomUUID()}`;
	const area = join(options.outputParent, attemptId);
	try {
		mkdirSync(area, { mode: 0o700 });
		const owned = lstatSync(area, { bigint: true });
		const body = {
			schemaVersion: "endo.initial-child-execution.v0" as const,
			attemptId,
			plan: null,
			approval: null,
			status: "preflight-refused" as const,
			runtime: null,
			observed: null,
			reason,
		};
		publish(area, { ...body, commitment: receiptDigest(key, body) }, owned);
		return { status: "recorded", receipt: join(area, "receipt.json") };
	} catch {
		return { status: "refused", reason: "preflight refusal could not be recorded" };
	}
}

function seal(
	receipt: Omit<EndoInitialChildExecutionV0, "commitment">,
	key: EndoDigestKeyV0,
): EndoInitialChildExecutionV0 {
	const { commitment: _old, ...body } = receipt as EndoInitialChildExecutionV0;
	return { ...body, commitment: receiptDigest(key, body) };
}
function publish(
	area: string,
	receipt: EndoInitialChildExecutionV0,
	owned: { dev: bigint; ino: bigint; birthtimeNs: bigint },
): void {
	const current = lstatSync(area, { bigint: true });
	if (
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== owned.dev ||
		current.ino !== owned.ino ||
		current.birthtimeNs !== owned.birthtimeNs
	)
		throw new Error("attempt area substituted");
	const content = canonicalEndoJsonV0(receipt);
	if (Buffer.byteLength(content) > ENDO_INITIAL_CHILD_EXECUTION_MAX_BYTES_V0) throw new Error("receipt exceeds bound");
	const temporary = join(area, `receipt-${randomUUID()}.tmp`);
	const file = join(area, "receipt.json");
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const again = lstatSync(area, { bigint: true });
	if (again.dev !== owned.dev || again.ino !== owned.ino || again.birthtimeNs !== owned.birthtimeNs)
		throw new Error("attempt area substituted during publication");
	renameSync(temporary, file);
	const dir = openSync(area, "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

export type InitialChildExecutionResultV0 =
	| { status: EndoInitialChildExecutionV0["status"]; area: string; reason: string | null }
	| { status: "refused"; reason: string };

/** Consumes one approval and attempt id. A retained attempt area prevents silent replay after any interruption. */
export async function executeInitialChildV0(
	plan: EndoInitialChildExecutionPlanV0,
	approval: InitialChildApprovalV0 | null,
	prompt: string,
	key: EndoDigestKeyV0,
	signal?: AbortSignal,
): Promise<InitialChildExecutionResultV0> {
	try {
		if (
			approval === null ||
			approval.method !== "local-explicit" ||
			approval.attemptId !== plan.attemptId ||
			!same(approval.planCommitment, plan.commitment) ||
			!same(promptDigest(key, prompt), plan.promptCommitment)
		)
			throw new Error("missing or mismatched exact-scope approval");
		const age = Date.now() - Date.parse(approval.confirmedAt);
		if (!Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000)
			throw new Error("operator approval is stale or invalid");
		const { commitment: _, ...body } = plan;
		if (!same(planDigest(key, body), plan.commitment)) throw new Error("execution plan changed after approval");
		const refreshed = await preflightInitialChildExecutionV0({ ...plan, prompt }, key);
		if (refreshed.status !== "ready") throw new Error(refreshed.reason);
		const fresh = refreshed.plan;
		if (!same({ ...fresh, attemptId: plan.attemptId, commitment: plan.commitment }, plan))
			throw new Error("execution plan or evidence changed");
		if (signal?.aborted) throw new Error("cancelled before dispatch");
	} catch (error) {
		return { status: "refused", reason: (error as Error).message.slice(0, 128) };
	}
	const area = join(plan.outputParent, plan.attemptId);
	try {
		mkdirSync(area, { mode: 0o700 });
	} catch {
		return { status: "refused", reason: "attempt already exists or output unavailable" };
	}
	const owned = lstatSync(area, { bigint: true });
	const deadline = Date.now() + plan.wallTimeoutMs;
	let receipt = seal(
		{
			schemaVersion: "endo.initial-child-execution.v0",
			plan,
			approval: approval!,
			status: "approved-not-dispatched",
			runtime: null,
			observed: null,
			reason: null,
		},
		key,
	);
	let session: Awaited<ReturnType<PiAttachmentV0["openSession"]>> | null = null;
	let proxy: Awaited<ReturnType<typeof startEndoRecordingProxyV0>> | null = null;
	let log: EndoCaptureLogV0 | null = null;
	let dispatched = false;
	try {
		publish(area, receipt, owned);
		const runtime = join(area, "runtime");
		mkdirSync(runtime, { mode: 0o700 });
		const sourceArchive = createEndoBlobStoreV0(endoCaptureRootV0(plan.source), key, { readOnly: true }).get(
			plan.archiveDigest,
		);
		restoreEndoWorkspaceV0(sourceArchive, runtime);
		if (!Buffer.from(archiveEndoWorkspaceV0(runtime).bytes).equals(Buffer.from(sourceArchive)))
			throw new Error("runtime source reconstruction mismatch");
		const store = join(area, "evidence");
		mkdirSync(store, { mode: 0o700 });
		log = new EndoCaptureLogV0(store, key, "record", { async: true });
		proxy = await startEndoRecordingProxyV0({
			upstream: plan.upstream,
			log,
			maxTransferredBytes: plan.maxTransferredBytes,
		});
		const modelFile = join(runtime, "agent", "models.json");
		writeFileSync(
			modelFile,
			JSON.stringify({
				providers: {
					[plan.provider]: {
						baseUrl: `${proxy.origin}/v1`,
						api: "openai-completions",
						apiKey: "local",
						models: [{ id: plan.model }],
					},
				},
			}),
		);
		const manifest = manifestOf(plan);
		const condition = manifest.children[plan.childRole].condition.specification;
		if (condition.settings)
			writeFileSync(join(runtime, "agent", "settings.json"), JSON.stringify(condition.settings));
		const adaptedBytes = archiveEndoWorkspaceV0(runtime).bytes;
		const adapted = createEndoBlobStoreV0(store, key).put(adaptedBytes);
		const sessionId = `endo-initial-${randomUUID()}`;
		const sessionDir = join(store, "pi-sessions", "pi.initial-child");
		const harnessDir = join(store, "harness", "pi.initial-child");
		mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(harnessDir, "pi-session.json"), JSON.stringify({ sessionDir, sessionId }), {
			flag: "wx",
			mode: 0o600,
		});
		receipt = seal(
			{
				...receipt,
				runtime: {
					root: runtime,
					workingDirectory: join(runtime, "work"),
					preExecutionArchive: plan.archiveDigest,
					adaptedArchive: adapted.digest,
					postExecutionArchive: null,
					adaptations: [
						"fresh-home-and-agent-directory",
						"recording-proxy-models-json",
						...(condition.settings ? ["condition-thinking-off"] : []),
					],
					proxyOrigin: proxy.origin,
					store,
					sessionId,
				},
			},
			key,
		);
		publish(area, receipt, owned);
		const attachment = new PiAttachmentV0({
			root: store,
			cwd: join(runtime, "work"),
			executable: plan.piExecutable,
			env: piCassetteEnvV0(runtime),
			provider: plan.provider,
			model: plan.model,
			tools: "none",
			governedToolFree: true,
			requestTimeoutMs: Math.min(plan.wallTimeoutMs, 30000),
			digestKey: key,
			digestDomain: key.public ? "fixture" : "private",
			maxRpcOutputBytes: 2 * 1024 * 1024,
			attachment: "pi.initial-child",
			sessionDir,
		});
		session = await attachment.openSession();
		if (
			session.fingerprint.identity.digest !== plan.piIdentity ||
			session.fingerprint.reported.version !== plan.piVersion
		)
			throw new Error("Pi runtime changed before dispatch");
		const state = await session.rpcState();
		if (
			state.model?.provider !== plan.provider ||
			state.model.id !== plan.model ||
			state.messageCount !== 0 ||
			state.thinkingLevel !== "off"
		)
			throw new Error("Pi startup model or state mismatch");
		if (
			session.piSessionId !== sessionId ||
			readEndoStoreEventsV0(store).some((e) => e.kind === "harness.session-mismatch")
		)
			throw new Error("Pi did not open the requested fresh session");
		const current = readVerifiedInitialBranchSetV0(
			plan.source,
			plan.replay,
			key,
			plan.outputParent,
			plan.preparation,
		);
		if (current.status !== "verified-pristine") throw new Error("prepared child changed before dispatch");
		if (!Buffer.from(archiveEndoWorkspaceV0(runtime).bytes).equals(Buffer.from(adaptedBytes)))
			throw new Error("adapted runtime changed before dispatch");
		if (signal?.aborted) throw new Error("cancelled before dispatch");
		if (Date.now() >= deadline) throw new Error("timeout before dispatch");
		receipt = seal({ ...receipt, status: "dispatched" }, key);
		publish(area, receipt, owned);
		dispatched = true;
		const disposition = await withinDeadline(session.prompt(prompt), deadline, signal);
		if (disposition !== "started") throw new Error("Pi did not start one prompt");
		if (!(await withinDeadline(session.waitForSettled(Math.max(1, deadline - Date.now())), deadline, signal)))
			throw new Error("timeout");
		await session.close();
		if (session.outputLimitExceeded) throw new Error("runtime stdout limit exceeded");
		session = null;
		await proxy.flush();
		if (proxy.recordingFailures > 0 || proxy.transferLimitExceeded)
			throw new Error("capture incomplete or transfer bound exceeded");
		await proxy.close();
		proxy = null;
		log.close();
		log = null;
		const postBytes = archiveEndoWorkspaceV0(runtime).bytes;
		if (postBytes.length > 16 * 1024 * 1024) throw new Error("post-execution archive exceeds artifact bound");
		const post = createEndoBlobStoreV0(store, key).put(postBytes);
		receipt = seal({ ...receipt, runtime: { ...receipt.runtime!, postExecutionArchive: post.digest } }, key);
		const observed = observedEvidence(store, key, receipt.runtime!.sessionId);
		receipt = seal({ ...receipt, status: "completed", observed, reason: null }, key);
		const checked = verifyCandidate(plan.source, plan.replay, key, receipt);
		if (checked.status !== "verified") throw new Error(`final evidence ${checked.reason}`);
		publish(area, receipt, owned);
		return { status: "completed", area, reason: null };
	} catch (error) {
		const reason = (error as Error).message.slice(0, 128);
		let stopped = true;
		try {
			await session?.close();
		} catch {
			stopped = false;
		}
		try {
			await proxy?.close();
		} catch {
			stopped = false;
		}
		try {
			log?.close();
		} catch {
			stopped = false;
		}
		const status = !dispatched ? "failed" : reason === "cancelled" && stopped ? "cancelled" : "outcome-unknown";
		try {
			publish(area, seal({ ...receipt, status, observed: null, reason }, key), owned);
		} catch {
			/* Last durable state remains conservative. */
		}
		return { status, area, reason };
	}
}

function observedEvidence(
	store: string,
	key: EndoDigestKeyV0,
	sessionId: string,
): NonNullable<EndoInitialChildExecutionV0["observed"]> {
	const events = readEndoCaptureEventsV0(store);
	const requests = events.filter((event) => event.kind === "capture.request" && event.producer === "capture:record");
	if (requests.length !== 1) throw new Error("expected one captured model request");
	const request = requests[0]!;
	const payload = request.payload as unknown as { requestDigest: EndoKeyedDigestV0 };
	const surface = harnessSurfacesOfCaptureV0(store, key);
	if (surface.length !== 1 || surface[0]!.components.status !== "reported")
		throw new Error("model request surface unavailable");
	const trajectory = trajectoryFromStoreV0(store, `endo.session.pi.${sessionId}`);
	return {
		requestEventId: request.id,
		requestDigest: payload.requestDigest,
		surfaceIdentity: surface[0]!.components.value.identity,
		trajectoryIdentity: trajectory.digest,
		captureGeneration: captureGenerationV0(events, key),
	};
}

export type InitialChildEvidenceReadV0 =
	| { status: "verified"; attemptId: string }
	| { status: "unverified"; reason: string; outcome: EndoInitialChildExecutionV0["status"] | "unreadable" };
/** Independently re-read parent, siblings, adapted pre-state, captured exchange and trajectory. */
function verifyCandidate(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	input: EndoInitialChildExecutionV0,
): InitialChildEvidenceReadV0 {
	let outcome: EndoInitialChildExecutionV0["status"] | "unreadable" = "unreadable";
	try {
		const receipt: unknown = input;
		const read = readEndoInitialChildExecutionV0(receipt);
		if (!read.ok) throw new Error("receipt schema invalid");
		const r = read.value;
		outcome = r.status;
		if (r.status !== "completed" || !r.runtime || !r.observed) throw new Error("attempt not completed");
		const age = Date.now() - Date.parse(r.approval.confirmedAt);
		if (!Number.isFinite(age) || age < 0) throw new Error("approval time invalid");
		const { commitment: _, ...body } = r;
		if (!same(receiptDigest(key, body), r.commitment)) throw new Error("receipt commitment mismatch");
		const { commitment: __, ...planBody } = r.plan;
		if (!same(planDigest(key, planBody), r.plan.commitment) || !same(r.approval.planCommitment, r.plan.commitment))
			throw new Error("plan or approval mismatch");
		if (r.plan.source !== source || r.plan.replay !== replay) throw new Error("wrong source or replay");
		if (
			join(r.plan.outputParent, r.plan.attemptId, "runtime") !== r.runtime.root ||
			join(r.runtime.root, "work") !== r.runtime.workingDirectory ||
			join(r.plan.outputParent, r.plan.attemptId, "evidence") !== r.runtime.store
		)
			throw new Error("attempt area mismatch");
		const lineage = readVerifiedInitialBranchSetV0(source, replay, key, r.plan.outputParent, r.plan.preparation);
		if (lineage.status !== "verified-pristine") throw new Error("parent or siblings no longer pristine");
		const m = manifestOf(r.plan);
		const child = m.children[r.plan.childRole];
		if (
			m.id !== r.plan.branchId ||
			!same(m.commitment, r.plan.branchCommitment) ||
			!same(m.parentReference, r.plan.parentReference) ||
			child.id !== r.plan.childId ||
			!same(child.condition.commitment, r.plan.conditionCommitment) ||
			!same(m.parent.archive.digest, r.plan.archiveDigest)
		)
			throw new Error("parent or child binding mismatch");
		if (supportedCondition(m, r.plan.childRole)) throw new Error("unsupported condition");
		const before = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
			r.plan.archiveDigest,
		);
		if (before.length > 16 * 1024 * 1024 || !same(r.runtime.preExecutionArchive, r.plan.archiveDigest))
			throw new Error("source archive bound or identity mismatch");
		if (supportedArchive(before, r.plan.provider, r.plan.model)) throw new Error("source archive unsupported");
		const adapted = createEndoBlobStoreV0(r.runtime.store, key, { readOnly: true }).get(r.runtime.adaptedArchive);
		if (adapted.length > 16 * 1024 * 1024 || r.runtime.postExecutionArchive === null)
			throw new Error("adapted or post-execution archive unavailable");
		const post = createEndoBlobStoreV0(r.runtime.store, key, { readOnly: true }).get(r.runtime.postExecutionArchive);
		if (
			post.length > 16 * 1024 * 1024 ||
			!Buffer.from(archiveEndoWorkspaceV0(r.runtime.root).bytes).equals(Buffer.from(post))
		)
			throw new Error("post-execution tree changed or exceeds bound");
		const parsed = readEndoWorkspaceArchiveV0(adapted);
		if (!parsed.ok) throw new Error("adapted archive invalid");
		const config = parsed.value.entries.find((e) => e.path === "agent/models.json");
		if (config?.type !== "file") throw new Error("adapted model configuration missing");
		const effective = JSON.parse(Buffer.from(config.base64, "base64").toString("utf8"));
		if (
			!same(effective, {
				providers: {
					[r.plan.provider]: {
						baseUrl: `${r.runtime.proxyOrigin}/v1`,
						api: "openai-completions",
						apiKey: "local",
						models: [{ id: r.plan.model }],
					},
				},
			})
		)
			throw new Error("adapted model configuration mismatch");
		const original = readEndoWorkspaceArchiveV0(before);
		if (!original.ok) throw new Error("source archive unreadable");
		const nonAdapted = (entries: typeof parsed.value.entries) =>
			entries
				.filter((e) => e.path !== "agent/models.json" && e.path !== "agent/settings.json")
				.map((e) => ({
					path: e.path,
					type: e.type,
					...(e.type === "file" ? { base64: e.base64, executable: e.executable } : {}),
				}));
		if (!same(nonAdapted(parsed.value.entries), nonAdapted(original.value.entries)))
			throw new Error("partial or unexpected runtime transformation");
		const conditionSettings = m.children[r.plan.childRole].condition.specification.settings;
		const settings = parsed.value.entries.find((e) => e.path === "agent/settings.json");
		if (
			conditionSettings &&
			(settings?.type !== "file" ||
				!same(JSON.parse(Buffer.from(settings.base64, "base64").toString("utf8")), conditionSettings))
		)
			throw new Error("condition was not applied");
		if (
			!same(r.runtime.adaptations, [
				"fresh-home-and-agent-directory",
				"recording-proxy-models-json",
				...(conditionSettings ? ["condition-thinking-off"] : []),
			])
		)
			throw new Error("runtime adaptations mismatch");
		const events = readEndoCaptureEventsV0(r.runtime.store);
		if (readEndoStoreEventsV0(r.runtime.store).some((event) => event.kind === "harness.output-limit-exceeded"))
			throw new Error("runtime stdout limit exceeded");
		if (!completeEvidenceStore(endoCaptureRootV0(r.runtime.store)) || !completeEvidenceStore(r.runtime.store))
			throw new Error("capture or Pi evidence log damaged");
		if (!same(captureGenerationV0(events, key), r.observed.captureGeneration))
			throw new Error("capture generation stale");
		const started = events.filter((e) => e.kind === "capture.started" && e.producer === "capture:record");
		if (
			started.length !== 1 ||
			(started[0]!.payload as { upstream?: string; listen?: string }).upstream !== r.plan.upstream ||
			(started[0]!.payload as { listen?: string }).listen !== r.runtime.proxyOrigin
		)
			throw new Error("wrong proxy or upstream endpoint");
		const cassette = loadEndoCassetteV0(r.runtime.store, key);
		if (
			cassette.exchanges.length !== 1 ||
			cassette.exchanges[0]?.truncated ||
			cassette.exchanges[0]?.response?.outcome !== "complete" ||
			cassette.exchanges[0]?.response?.status !== 200
		)
			throw new Error("captured exchange incomplete");
		const requests = events.filter((e) => e.kind === "capture.request" && e.producer === "capture:record");
		if (
			requests.length !== 1 ||
			requests[0]!.id !== r.observed.requestEventId ||
			!same(
				(requests[0]!.payload as unknown as { requestDigest: EndoKeyedDigestV0 }).requestDigest,
				r.observed.requestDigest,
			)
		)
			throw new Error("request mismatch");
		const surface = harnessSurfacesOfCaptureV0(r.runtime.store, key);
		if (surface.length !== 1 || surface[0]!.components.status !== "reported")
			throw new Error("model surface unavailable");
		const observed = surface[0]!.components.value;
		if (
			observed.identity !== r.observed.surfaceIdentity ||
			observed.model.status !== "reported" ||
			observed.model.value !== r.plan.model ||
			observed.tools.count !== 0 ||
			surface[0]!.source.target.path !== "/v1/chat/completions" ||
			surface[0]!.source.target.query !== "absent"
		)
			throw new Error("model or tool policy mismatch");
		const bodyBytes = createEndoBlobStoreV0(endoCaptureRootV0(r.runtime.store), key, { readOnly: true }).get(
			cassette.exchanges[0]!.requestBody.digest,
		);
		const captured = requests[0]!.payload as unknown as {
			method: string;
			path: string;
			requestDigest: EndoKeyedDigestV0;
		};
		if (
			!same(endoRequestDigestV0(key, captured.method, captured.path, bodyBytes), captured.requestDigest) ||
			captured.method !== "POST" ||
			captured.path !== "/v1/chat/completions"
		)
			throw new Error("captured request digest or route mismatch");
		const requestBody = JSON.parse(Buffer.from(bodyBytes).toString("utf8"));
		if (
			!Array.isArray(requestBody.messages) ||
			requestBody.messages.filter((message: { role?: string }) => message.role === "user").length !== 1 ||
			requestBody.messages.some(
				(message: { role?: string }) => !["system", "developer", "user"].includes(message.role ?? ""),
			) ||
			!requestBody.messages.some((message: { role?: string; content?: unknown }) => {
				const text = promptText(message.content);
				return message.role === "user" && text !== null && same(promptDigest(key, text), r.plan.promptCommitment);
			})
		)
			throw new Error("single approved prompt not observed in model request");
		const trajectory = trajectoryFromStoreV0(r.runtime.store, `endo.session.pi.${r.runtime.sessionId}`);
		const attached = readEndoStoreEventsV0(r.runtime.store).filter((e) => e.kind === "harness.attached");
		if (attached.length !== 1) throw new Error("Pi attachment count mismatch");
		const attachment = attached[0]!.payload as unknown as {
			identityDigest?: string;
			version?: string;
			piSessionId?: string;
			args?: string[];
			userConfigurationDigest?: string;
			projectConfigurationDigest?: string;
		};
		if (
			attachment.identityDigest !== r.plan.piIdentity ||
			attachment.version !== r.plan.piVersion ||
			attachment.piSessionId !== r.runtime.sessionId ||
			!Array.isArray(attachment.args) ||
			!REQUIRED_FLAGS.every((flag) => attachment.args!.includes(flag)) ||
			attachment.args.indexOf("--provider") === -1 ||
			attachment.args[attachment.args.indexOf("--provider") + 1] !== r.plan.provider ||
			attachment.args[attachment.args.indexOf("--model") + 1] !== r.plan.model ||
			attachment.args[attachment.args.indexOf("--session-id") + 1] !== r.runtime.sessionId ||
			attachment.args[attachment.args.indexOf("--session-dir") + 1] !==
				join(r.runtime.store, "pi-sessions", "pi.initial-child")
		)
			throw new Error("Pi runtime, model selection or disabling flags mismatch");
		if (
			attachment.userConfigurationDigest !== piUserConfigurationDigestV0(piCassetteEnvV0(r.runtime.root)) ||
			attachment.projectConfigurationDigest !== piProjectConfigurationDigestV0(join(r.runtime.root, "work"))
		)
			throw new Error("Pi configuration changed from recorded startup");
		if (!trajectory.environment.reportedModels.includes(`${r.plan.provider}/${r.plan.model}`))
			throw new Error("Pi reported model mismatch or unavailable");
		if (
			trajectory.digest !== r.observed.trajectoryIdentity ||
			trajectory.layers.toolCalls.status !== "reported" ||
			trajectory.layers.toolCalls.entries.length !== 0 ||
			trajectory.layers.toolResults.status !== "reported" ||
			trajectory.layers.toolResults.entries.length !== 0 ||
			trajectory.layers.outcome.status !== "reported" ||
			trajectory.layers.outcome.entries.length !== 1 ||
			trajectory.layers.outcome.entries[0]?.outcome !== "completed"
		)
			throw new Error("trajectory incomplete or tool call observed");
		if (readEndoStoreEventsV0(r.runtime.store).some((e) => e.kind === "tool.started" || e.kind === "tool.finished"))
			throw new Error("tool call observed");
		return { status: "verified", attemptId: r.plan.attemptId };
	} catch (error) {
		return { status: "unverified", reason: (error as Error).message.slice(0, 128), outcome };
	}
}

/** Public durable reader: an unpublished in-memory candidate cannot receive a verified result. */
export function verifyInitialChildExecutionEvidenceV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	receiptFile: string,
): InitialChildEvidenceReadV0 {
	try {
		const text = privateFile(receiptFile, ENDO_INITIAL_CHILD_EXECUTION_MAX_BYTES_V0);
		const parsed: unknown = JSON.parse(text);
		if (text !== canonicalEndoJsonV0(parsed)) throw new Error("receipt encoding is not canonical");
		const read = readEndoInitialChildExecutionV0(parsed);
		if (!read.ok) throw new Error("receipt schema invalid");
		if (read.value.status === "preflight-refused") {
			const { commitment: _, ...body } = read.value;
			if (
				!same(receiptDigest(key, body), read.value.commitment) ||
				basename(receiptFile) !== "receipt.json" ||
				basename(dirname(receiptFile)) !== read.value.attemptId ||
				!checkpointOutputParent(source, replay, dirname(dirname(receiptFile))).ok
			)
				throw new Error("preflight refusal commitment or path invalid");
			return { status: "unverified", reason: "preflight refused before approval", outcome: "preflight-refused" };
		}
		if (receiptFile !== join(read.value.plan.outputParent, read.value.plan.attemptId, "receipt.json"))
			throw new Error("receipt path invalid");
		return verifyCandidate(source, replay, key, read.value);
	} catch (error) {
		return { status: "unverified", reason: (error as Error).message.slice(0, 128), outcome: "unreadable" };
	}
}
