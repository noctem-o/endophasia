// Lifecycle for a llama.cpp server this process starts, observes and stops itself.
//
// This module is a building block for the interactive operator (aa/operator.ts), its only caller. It deliberately exports no CLI entry
// point and accepts no pre-supplied approval: every launch needs the exact phrase from `approve`, a trusted caller
// callback exactly like CoordinatorHooks. It sends no HTTP request and performs no inference.
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { type ProcessExitV0, ProcessGroupV0 } from "../../../adapters/rpc-jsonl/process-group.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { publishExclusiveV0 } from "./exclusive-publish.ts";
import {
	hashInspectionChunksV0,
	inspectLinuxHostOutcomeV0,
	type LinuxFileIdentityV0,
	linuxProcFactsV0,
} from "./linux-host-inspection.ts";
import { parseTcpListenersV0 } from "./linux-proc.ts";
import { buildExplicitServerArgsV0, validateExplicitServerArgsV0 } from "./linux-profile.ts";
import {
	buildTaskOwnedProvenanceV0,
	provenanceEndPathV0,
	provenancePathV0,
	readTaskOwnedProvenanceEndV0,
	sealProvenanceEndV0,
	TASK_OWNED_LAUNCH_ENVIRONMENT_V0,
	type TaskOwnedProvenanceEndV0,
	type TaskOwnedProvenanceV0,
	validateTaskOwnedProvenanceV0,
} from "./task-owned-provenance.ts";

export interface TaskOwnedLaunchRequestV0 {
	executablePath: string;
	executableSha256: string;
	modelPath: string;
	modelSha256: string;
	modelAlias: string;
	gpuLayers: string;
	port: number;
	/** Spawn to listening, plus the bounded inspection that follows. */
	readinessTimeoutMs: number;
	/** Where the server runs. It must exist and be owner-only. */
	workingDirectory: string;
}
export interface TaskOwnedLaunchPlanV0 {
	version: "endo.research.aa.task-owned-launch-plan.0";
	request: TaskOwnedLaunchRequestV0;
	endpoint: string;
	argv: string[];
	commitment: EndoKeyedDigestV0;
}
export interface TaskOwnedServerV0 {
	readonly provenance: TaskOwnedProvenanceV0;
	/** Idempotent. Stops only the process group this launcher created, then records what was confirmed gone. */
	stop(): Promise<TaskOwnedProvenanceEndV0>;
}
export const TASK_OWNED_APPROVAL_WINDOW_MS_V0 = 300000;
export const taskOwnedLaunchPhraseV0 = (plan: TaskOwnedLaunchPlanV0) =>
	`APPROVE TASK-OWNED SERVER ${plan.commitment.value.slice(0, 16)}`;

export function planTaskOwnedLaunchV0(key: EndoDigestKeyV0, request: TaskOwnedLaunchRequestV0): TaskOwnedLaunchPlanV0 {
	if (
		process.platform !== "linux" ||
		![request.executablePath, request.modelPath, request.workingDirectory].every(isAbsolute) ||
		![request.executableSha256, request.modelSha256].every((v) => /^[0-9a-f]{64}$/.test(v)) ||
		!Number.isSafeInteger(request.port) ||
		request.port < 1024 ||
		request.port > 65535 ||
		!Number.isSafeInteger(request.readinessTimeoutMs) ||
		request.readinessTimeoutMs < 1000 ||
		request.readinessTimeoutMs > 600000
	)
		throw new Error("unsupported launch request");
	const endpoint = `http://127.0.0.1:${request.port}`;
	// Throws on anything outside the accepted profile, so launch and inspection share one definition.
	const args = buildExplicitServerArgsV0({
		endpoint,
		modelPath: request.modelPath,
		modelAlias: request.modelAlias,
		gpuLayers: request.gpuLayers,
	});
	const body = {
		version: "endo.research.aa.task-owned-launch-plan.0" as const,
		request: { ...request },
		endpoint,
		argv: [request.executablePath, ...args],
	};
	return { ...body, commitment: key.digest({ purpose: "endo.research.aa.task-owned-launch-plan.0", body }) };
}

const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function fileIdentity(fd: number): LinuxFileIdentityV0 {
	const s = fstatSync(fd, { bigint: true });
	if (!s.isFile()) throw new Error("expected regular file");
	return {
		device: s.dev.toString(),
		inode: s.ino.toString(),
		size: s.size.toString(),
		mtimeNs: s.mtimeNs.toString(),
		ctimeNs: s.ctimeNs.toString(),
	};
}
/** Hash through one descriptor and require the file to be unchanged around the read. */
async function pinnedFile(path: string, expected: string, signal: AbortSignal): Promise<LinuxFileIdentityV0> {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fileIdentity(fd);
		const digest = await hashInspectionChunksV0(
			createReadStream(path, { fd, autoClose: false, signal, highWaterMark: 1024 * 1024 }),
			() => {
				if (signal.aborted) throw new Error("cancelled");
			},
		);
		if (!same(before, fileIdentity(fd))) throw new Error("file changed while hashing");
		if (digest !== expected) throw new Error("pinned digest mismatch");
		return before;
	} finally {
		closeSync(fd);
	}
}
/** True when a loopback bind on `port` succeeds right now. */
export function portIsFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}
const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => {
			if (signal.aborted) resolve(null);
			else signal.addEventListener("abort", () => resolve(null), { once: true });
		}),
	]);
}

/**
 * Starts the server only after the exact approval phrase is returned inside the approval window.
 * Any failure after the spawn terminates the owned process group before the error is raised. On success the
 * returned handle owns the process and the caller must call `stop()`.
 */
export async function launchTaskOwnedServerV0(
	key: EndoDigestKeyV0,
	studyFile: string,
	request: TaskOwnedLaunchRequestV0,
	approve: (plan: TaskOwnedLaunchPlanV0, phrase: string) => Promise<string | null>,
	signal?: AbortSignal,
): Promise<TaskOwnedServerV0> {
	if (!isAbsolute(studyFile)) throw new Error("absolute study path required");
	if (signal?.aborted) throw new Error("cancelled");
	const plan = planTaskOwnedLaunchV0(key, request);
	const workdir = lstatSync(request.workingDirectory);
	if (
		!workdir.isDirectory() ||
		workdir.isSymbolicLink() ||
		workdir.uid !== process.getuid?.() ||
		(workdir.mode & 0o077) !== 0
	)
		throw new Error("working directory must be owner-only");
	const hashSignal = signal ?? new AbortController().signal; // Hashing is bounded by the caller, not the approval window.
	// Identity first: a wrong binary or model is refused before anything is started.
	const executableIdentity = await pinnedFile(request.executablePath, request.executableSha256, hashSignal);
	const modelIdentity = await pinnedFile(request.modelPath, request.modelSha256, hashSignal);
	if (!(await portIsFree(request.port))) throw new Error("port is not free");
	const phrase = taskOwnedLaunchPhraseV0(plan);
	const approvalSignal = AbortSignal.any([
		AbortSignal.timeout(TASK_OWNED_APPROVAL_WINDOW_MS_V0),
		...(signal ? [signal] : []),
	]);
	const answer = await abortable(approve(plan, phrase), approvalSignal);
	if (answer !== phrase || approvalSignal.aborted) throw new Error("launch not approved");
	const confirmedAt = new Date().toISOString();
	// Nothing else may have replaced either file, or taken the port, while the operator was deciding.
	for (const [path, expected] of [
		[request.executablePath, executableIdentity],
		[request.modelPath, modelIdentity],
	] as const) {
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			if (!same(fileIdentity(fd), expected)) throw new Error("file changed during approval");
		} finally {
			closeSync(fd);
		}
	}
	if (!(await portIsFree(request.port))) throw new Error("port taken during approval");

	const deadline = performance.now() + request.readinessTimeoutMs;
	const stopSignal = AbortSignal.any([AbortSignal.timeout(request.readinessTimeoutMs), ...(signal ? [signal] : [])]);
	const spawnedAt = new Date().toISOString();
	// The runtime's keeper owns the group: it ends it if this process dies, and no id is signalled after it is reusable.
	const group = new ProcessGroupV0(plan.argv[0]!, plan.argv.slice(1), {
		cwd: request.workingDirectory,
		env: { ...TASK_OWNED_LAUNCH_ENVIRONMENT_V0 },
		stderr: "ignore",
	});
	group.stdin?.end();
	group.stdout?.resume(); // Never let a chatty server block on a full pipe.
	let exit: ProcessExitV0 | undefined;
	void group.exited.then((value) => {
		exit = value;
	});
	let finished: Promise<TaskOwnedProvenanceEndV0 | null> | undefined;
	let pid: number | undefined;
	const terminate = async () => {
		group.signalGroup("SIGTERM");
		await Promise.race([group.exited, sleep(3000)]);
		await group.release(); // SIGKILLs whatever is left, keeper included, and waits for it.
		const listenerGone = await portIsFree(request.port);
		const processGone = exit !== undefined && (pid === undefined || !pidAlive(pid)) && group.liveMembers() !== true;
		return {
			exit: { code: exit?.code ?? null, signal: exit?.signal ?? null },
			processGone,
			listenerGone,
		};
	};
	try {
		for (;;) {
			if (stopSignal.aborted || performance.now() >= deadline)
				throw new Error(signal?.aborted ? "cancelled" : "launch timed out");
			if (exit !== undefined)
				throw new Error(exit.spawnFailed ? "server did not start" : "server exited before listening");
			pid = group.pid;
			if (pid !== undefined) {
				try {
					const tcp = readFileSync(`/proc/${pid}/net/tcp`, "utf8");
					if (parseTcpListenersV0(tcp).some((entry) => entry.port === request.port)) break;
				} catch {}
			}
			await sleep(25);
		}
		const serverPid: number = pid;
		const outcome = await inspectLinuxHostOutcomeV0(
			{
				pid: serverPid,
				endpoint: plan.endpoint,
				executablePath: request.executablePath,
				executableSha256: request.executableSha256,
				modelPath: request.modelPath,
				modelSha256: request.modelSha256,
				modelAlias: request.modelAlias,
				gpuLayers: request.gpuLayers,
			},
			stopSignal,
			Math.max(1000, Math.min(600000, Math.floor(deadline - performance.now()))),
		);
		if (!outcome.observation) throw new Error(`inspection ${outcome.status}: ${outcome.blockingReasons.join(", ")}`);
		const observation = outcome.observation;
		const groupId = group.groupId;
		const stat = linuxProcFactsV0.boundedText(`/proc/${serverPid}/stat`, 16384);
		const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
		if (groupId === undefined || pgrp !== groupId) throw new Error("server is not in the owned process group");
		// What the kernel reports must be exactly what this launcher asked for: no more, no less.
		const argv = linuxProcFactsV0.procArgv(linuxProcFactsV0.boundedText(`/proc/${serverPid}/cmdline`, 128 * 1024));
		const environmentNames = linuxProcFactsV0.procEnvironmentNames(
			linuxProcFactsV0.boundedBytes(`/proc/${serverPid}/environ`, 1024 * 1024),
		);
		validateExplicitServerArgsV0(argv, environmentNames, {
			endpoint: plan.endpoint,
			modelPath: observation.modelPath,
			modelAlias: request.modelAlias,
			gpuLayers: request.gpuLayers,
		});
		if (
			!same(argv, plan.argv) ||
			!same([...environmentNames].sort(), Object.keys(TASK_OWNED_LAUNCH_ENVIRONMENT_V0).sort())
		)
			throw new Error("process arguments differ from the approved launch");
		if (observation.pid !== serverPid || stopSignal.aborted)
			throw new Error("observed process differs from the spawned process");
		const provenance = buildTaskOwnedProvenanceV0(
			key,
			observation,
			{ argv, environmentNames },
			{
				launcherPid: process.pid,
				processGroup: groupId,
				spawnedAt,
				authorization: {
					planCommitment: plan.commitment,
					phraseDigest: key.digest({ purpose: "endo.research.aa.task-owned-launch-phrase.0", phrase }),
					confirmedAt,
				},
			},
		);
		validateTaskOwnedProvenanceV0(provenance, key);
		publishExclusiveV0(provenancePathV0(studyFile), provenance);
		return {
			provenance,
			stop: () => {
				finished ??= (async () => {
					const result = await terminate();
					const record = sealProvenanceEndV0(key, {
						version: "endo.research.aa.task-owned-provenance-end.0",
						startCommitment: provenance.commitment,
						stoppedAt: new Date().toISOString(),
						...result,
					}) as TaskOwnedProvenanceEndV0;
					try {
						publishExclusiveV0(provenanceEndPathV0(studyFile), record);
					} catch (error) {
						// A first attempt may have created the record before failing; that record is authoritative.
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						return readTaskOwnedProvenanceEndV0(provenanceEndPathV0(studyFile), key, provenance);
					}
					return record;
				})();
				// A failed stop is not cached: the caller may retry, and termination is idempotent.
				finished.catch(() => {
					finished = undefined;
				});
				return finished as Promise<TaskOwnedProvenanceEndV0>;
			},
		};
	} catch (error) {
		await terminate();
		throw error;
	}
}
