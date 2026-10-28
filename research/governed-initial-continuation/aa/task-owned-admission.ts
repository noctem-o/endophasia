// Real-observation admission: the same one-shot hook point as the synthetic fixture, but the identity comes from
// bounded procfs reads of the process the task-owned launcher spawned. Not an attestation: see TASK-OWNED-PROVENANCE.md.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContinuationAdmissionHookV0 } from "../../../cli/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { linuxProcFactsV0 } from "./linux-host-inspection.ts";
import { inspectSocketOwnersV0 } from "./linux-ownership.ts";
import { parseProcessStartTicksV0, parseTcp6ListeningPortsV0, parseTcpListenersV0 } from "./linux-proc.ts";
import type { SlotStart } from "./reader.ts";
import { argvDigestV0, environmentDigestV0, type TaskOwnedProvenanceV0 } from "./task-owned-provenance.ts";

export const TASK_OWNED_ADMISSION_VERSION_V0 = "endo.research.aa.task-owned-admission.0";
/** A turn is admitted only if its observation is at most this old. The reader enforces the same ceiling offline. */
export const TASK_OWNED_MAX_OBSERVATION_AGE_MS_V0 = 10000;

/** The process facts a turn's sidecar commits to; every sidecar of one study must agree with the provenance. */
export interface TaskOwnedObservationV0 {
	pid: number;
	startTicks: string;
	socketInode: string;
	socketFd: string;
	argvDigest: EndoKeyedDigestV0;
	environmentDigest: EndoKeyedDigestV0;
	observationId: string;
	observedAt: string;
}
export interface TaskOwnedObserverV0 {
	/** The thorough, asynchronous per-turn observation. Throws when anything differs or cannot be read. */
	observe(provenance: TaskOwnedProvenanceV0, turn: 1 | 2, signal: AbortSignal): Promise<TaskOwnedObservationV0>;
	/** The cheap synchronous check at the admission boundary; it cannot hash files. */
	recheck(provenance: TaskOwnedProvenanceV0, observation: TaskOwnedObservationV0, turn: 1 | 2): boolean;
}
export interface TaskOwnedAdmissionRecordV0 {
	version: typeof TASK_OWNED_ADMISSION_VERSION_V0;
	studyCommitment: EndoKeyedDigestV0;
	startCommitment: EndoKeyedDigestV0;
	provenanceCommitment: EndoKeyedDigestV0;
	position: number;
	attemptId: string;
	turn: 1 | 2;
	upstream: string;
	requestDigest: EndoKeyedDigestV0;
	dispatchCommitment: EndoKeyedDigestV0;
	approvalCommitment: EndoKeyedDigestV0;
	observation: TaskOwnedObservationV0;
	result: "admitted";
	refusalReason: null;
	preparedAt: string;
	admittedAt: string;
	commitment: EndoKeyedDigestV0;
}
export const taskOwnedAdmissionPath = (area: string, turn: 1 | 2) => join(area, `task-owned-admission-${turn}.json`);
export const sealTaskOwnedAdmission = (key: EndoDigestKeyV0, body: Omit<TaskOwnedAdmissionRecordV0, "commitment">) => ({
	...body,
	commitment: key.digest({ purpose: TASK_OWNED_ADMISSION_VERSION_V0, body }),
});
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
/** Whatever an observer returns, every committed process fact must equal the provenance before it can be admitted. */
const matchesProvenance = (o: TaskOwnedObservationV0, p: TaskOwnedProvenanceV0) =>
	o.pid === p.process.pid &&
	o.startTicks === p.process.startTicks &&
	o.socketInode === p.listener.socketInode &&
	o.socketFd === p.listener.socketFd &&
	same(o.argvDigest, p.launch.argvDigest) &&
	same(o.environmentDigest, p.launch.environmentDigest);

function readFacts(key: EndoDigestKeyV0, provenance: TaskOwnedProvenanceV0) {
	const { pid } = provenance.process;
	const proc = `/proc/${pid}`;
	const facts = linuxProcFactsV0;
	if (facts.boundedText("/proc/sys/kernel/random/boot_id", 128).trim() !== provenance.process.bootId)
		throw new Error("boot identity changed");
	if (parseProcessStartTicksV0(facts.boundedText(`${proc}/stat`, 16384), pid) !== provenance.process.startTicks)
		throw new Error("process identity changed");
	if (readlinkSync(`${proc}/ns/net`) !== provenance.process.networkNamespace)
		throw new Error("network namespace changed");
	if (readlinkSync(`${proc}/exe`) !== provenance.executable.path) throw new Error("executable changed or deleted");
	if (
		!same(facts.identity(`${proc}/exe`), provenance.executable.identity) ||
		!same(facts.identity(provenance.executable.path), provenance.executable.identity) ||
		!same(facts.identity(provenance.model.path), provenance.model.identity)
	)
		throw new Error("file identity changed");
	const argv = facts.procArgv(facts.boundedText(`${proc}/cmdline`, 128 * 1024));
	const environmentNames = facts.procEnvironmentNames(facts.boundedBytes(`${proc}/environ`, 1024 * 1024));
	const argvDigest = argvDigestV0(key, argv);
	const environmentDigest = environmentDigestV0(key, environmentNames);
	if (!same(argvDigest, provenance.launch.argvDigest) || !same(environmentDigest, provenance.launch.environmentDigest))
		throw new Error("launch arguments or environment changed");
	if (readlinkSync(`${proc}/fd/${provenance.listener.socketFd}`) !== `socket:[${provenance.listener.socketInode}]`)
		throw new Error("listener descriptor changed");
	const port = provenance.listener.port;
	const listeners = parseTcpListenersV0(facts.boundedText(`${proc}/net/tcp`, 4 * 1024 * 1024)).filter(
		(entry) => entry.port === port,
	);
	if (
		listeners.length !== 1 ||
		listeners[0]!.address !== "127.0.0.1" ||
		listeners[0]!.inode !== provenance.listener.socketInode ||
		parseTcp6ListeningPortsV0(facts.boundedText(`${proc}/net/tcp6`, 4 * 1024 * 1024)).includes(port)
	)
		throw new Error("listener identity changed");
	return { argvDigest, environmentDigest };
}

/** Bounded procfs observer. File digests are not recomputed per turn; a changed inode, size or timestamp is refused. */
export function procfsTaskOwnedObserverV0(key: EndoDigestKeyV0): TaskOwnedObserverV0 {
	return {
		async observe(provenance, _turn, signal) {
			const check = () => {
				if (signal.aborted) throw new Error("observation cancelled");
			};
			check();
			const { pid } = provenance.process;
			const observed = readFacts(key, provenance);
			check();
			if ((await inspectSocketOwnersV0("/proc", provenance.listener.socketInode, pid, check)) === "MISMATCH")
				throw new Error("another visible process holds the listener");
			check();
			readFacts(key, provenance); // Second sample: the first must still hold after the awaited scan.
			return {
				pid,
				startTicks: provenance.process.startTicks,
				socketInode: provenance.listener.socketInode,
				socketFd: provenance.listener.socketFd,
				...observed,
				observationId: randomBytes(16).toString("hex"),
				observedAt: new Date().toISOString(),
			};
		},
		recheck(provenance, observation) {
			try {
				const now = readFacts(key, provenance);
				return (
					observation.pid === provenance.process.pid &&
					observation.startTicks === provenance.process.startTicks &&
					same(now.argvDigest, observation.argvDigest) &&
					same(now.environmentDigest, observation.environmentDigest)
				);
			} catch {
				return false;
			}
		},
	};
}

/**
 * The only mutation is an exclusive private sidecar, written before the proxy opens its upstream hop.
 * `maxObservationAgeMs` can only tighten the ceiling that the offline reader enforces.
 */
export function taskOwnedAdmissionHook(
	key: EndoDigestKeyV0,
	start: SlotStart,
	provenance: TaskOwnedProvenanceV0,
	observer: TaskOwnedObserverV0,
	priorObservationIds: readonly string[],
	maxObservationAgeMs = TASK_OWNED_MAX_OBSERVATION_AGE_MS_V0,
): ContinuationAdmissionHookV0 {
	if (
		!Number.isSafeInteger(maxObservationAgeMs) ||
		maxObservationAgeMs < 1 ||
		maxObservationAgeMs > TASK_OWNED_MAX_OBSERVATION_AGE_MS_V0
	)
		throw new Error("invalid observation age bound");
	let next: 1 | 2 | 3 = 1;
	const used = new Set(priorObservationIds);
	return {
		binding: { studyCommitment: start.studyCommitment, slotCommitment: start.commitment, position: start.position },
		async prepare({ turn, marker }, signal) {
			if (signal.aborted || turn !== next || marker.attemptId !== start.plan.initial.attemptId)
				throw new Error("admission order");
			const observation = await observer.observe(provenance, turn, signal);
			const observedAt = Date.parse(observation?.observedAt);
			if (
				signal.aborted ||
				!observation ||
				!matchesProvenance(observation, provenance) ||
				typeof observation.observationId !== "string" ||
				!/^[a-f0-9]{32}$/.test(observation.observationId) ||
				used.has(observation.observationId) ||
				!Number.isFinite(observedAt) ||
				new Date(observedAt).toISOString() !== observation.observedAt
			)
				throw new Error("task-owned observation unavailable");
			used.add(observation.observationId);
			return {
				observation: structuredClone(observation),
				preparedAt: new Date().toISOString(),
				turn,
				marker: marker.commitment,
			};
		},
		admit({ turn, marker, area, upstream, requestDigest, prepared, signal }) {
			const p = prepared as {
				observation?: TaskOwnedObservationV0;
				preparedAt?: unknown;
				turn?: unknown;
				marker?: unknown;
			} | null;
			const observedAtMs = Date.parse(p?.observation?.observedAt ?? "");
			if (
				!p ||
				!p.observation ||
				turn !== next ||
				p.turn !== turn ||
				typeof p.preparedAt !== "string" ||
				!used.has(p.observation.observationId) ||
				!matchesProvenance(p.observation, provenance) ||
				canonicalEndoJsonV0(p.marker) !== canonicalEndoJsonV0(marker.commitment) ||
				marker.attemptId !== start.plan.initial.attemptId ||
				upstream !== start.plan.initial.upstream ||
				upstream !== provenance.listener.endpoint ||
				!Number.isFinite(observedAtMs) ||
				Date.now() - observedAtMs > maxObservationAgeMs ||
				Date.now() < observedAtMs ||
				signal.aborted ||
				observer.recheck(provenance, p.observation, turn) !== true ||
				signal.aborted
			)
				return {
					accepted: false,
					reason: "task-owned identity, order, binding, staleness or cancellation refused",
				};
			const body = {
				version: TASK_OWNED_ADMISSION_VERSION_V0 as typeof TASK_OWNED_ADMISSION_VERSION_V0,
				studyCommitment: start.studyCommitment,
				startCommitment: start.commitment,
				provenanceCommitment: provenance.commitment,
				position: start.position,
				attemptId: marker.attemptId,
				turn,
				upstream,
				requestDigest,
				dispatchCommitment: marker.commitment,
				approvalCommitment: marker.approvalCommitment,
				observation: p.observation,
				result: "admitted" as const,
				refusalReason: null,
				preparedAt: p.preparedAt,
				admittedAt: new Date().toISOString(),
			};
			const fd = openSync(
				taskOwnedAdmissionPath(area, turn),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeFileSync(fd, canonicalEndoJsonV0(sealTaskOwnedAdmission(key, body)));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			const dir = openSync(area, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
			next++;
			return { accepted: true, reason: null };
		},
	};
}
