// Versioned provenance for a server this process family launched itself. It records what was observed and what is
// merely declared. It never turns unverified socket ownership into a match; see TASK-OWNED-PROVENANCE.md.
import { initialExecutionPrivateFileV0 } from "../../../cli/initial-child-execution.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import {
	type EndoDigestKeyV0,
	type EndoKeyedDigestV0,
	isEndoKeyedDigestV0,
} from "../../../runtime/contracts/keyed-digest.ts";
import type {
	CheckFieldV0,
	CheckStateV0,
	LinuxFileIdentityV0,
	LinuxHostInspectionV0,
} from "./linux-host-inspection.ts";
import { ACCEPTED_SERVER_SHA256_V0, buildExplicitServerArgsV0, EXPLICIT_FIT_OFF_PROFILE_V0 } from "./linux-profile.ts";

export const TASK_OWNED_PROVENANCE_VERSION_V0 = "endo.research.aa.task-owned-provenance.0";
export const TASK_OWNED_PROVENANCE_END_VERSION_V0 = "endo.research.aa.task-owned-provenance-end.0";
export const TASK_OWNED_LAUNCHER_V0 = "endophasia-task-owned-launcher.0";
export const TASK_OWNED_LAUNCH_ENVIRONMENT_V0 = { PATH: "/usr/bin:/bin" } as const;

/** Declared, not observed. A reader reports these verbatim and rejects a record that omits or edits any of them. */
export const TASK_OWNED_TRUST_ASSUMPTIONS_V0 = [
	"trusted-local-host: kernel, procfs and the interpreter are not compromised",
	"no-privileged-or-same-user-adversary: nobody swaps the process, files or listener between sampled observations",
	"no-hidden-namespace: no process in an unobserved PID or network namespace holds or shares the listener",
	"lifecycle-ownership-declared: the launcher spawned this process and is the only intended listener owner; procfs does not prove sole socket ownership",
	"pinned-digests-are-file-identity-not-build-provenance: the executable and model digests do not attest source, build or GPU-resident bytes",
	"initial-argv-and-environment-names-stand-for-effective-configuration: later runtime settings are not queried",
	"gpu-rng-and-kv-state-unobserved: telemetry and cache state are outside this record",
	"observations-are-bounded-samples: per-turn rechecks are not continuous monitoring",
] as const;
/** Always present in a valid record: these host facts cannot be established from procfs. */
export const TASK_OWNED_REQUIRED_UNAVAILABLE_V0 = [
	"sole-socket-ownership",
	"runtime-configuration",
	"server-metadata",
	"gpu-telemetry",
] as const;
export const TASK_OWNED_REQUIRED_BLOCKING_V0 = ["OWNERSHIP_UNVERIFIED", "EFFECTIVE_RUNTIME_UNVERIFIED"] as const;

export interface TaskOwnedProvenanceV0 {
	version: typeof TASK_OWNED_PROVENANCE_VERSION_V0;
	profile: typeof EXPLICIT_FIT_OFF_PROFILE_V0;
	declaredProfile: { endpoint: string; modelPath: string; modelAlias: string; gpuLayers: string };
	executable: { path: string; sha256: string; identity: LinuxFileIdentityV0 };
	supportedBinary: CheckStateV0;
	model: { path: string; sha256: string; identity: LinuxFileIdentityV0 };
	process: { pid: number; startTicks: string; bootId: string; networkNamespace: string };
	listener: { endpoint: string; port: number; socketInode: string; socketFd: string };
	launch: {
		argvDigest: EndoKeyedDigestV0;
		argCount: number;
		environmentNames: string[];
		environmentDigest: EndoKeyedDigestV0;
	};
	lifecycle: {
		owner: typeof TASK_OWNED_LAUNCHER_V0;
		ownership: "declared-task-spawned";
		launcherPid: number;
		processGroup: number;
		spawnedAt: string;
		portFreeAtLaunch: true;
		authorization: { planCommitment: EndoKeyedDigestV0; phraseDigest: EndoKeyedDigestV0; confirmedAt: string };
	};
	observedAt: string;
	checks: Record<CheckFieldV0, CheckStateV0>;
	blockingReasons: string[];
	unavailable: string[];
	trustAssumptions: string[];
	commitment: EndoKeyedDigestV0;
}
export interface TaskOwnedProvenanceEndV0 {
	version: typeof TASK_OWNED_PROVENANCE_END_VERSION_V0;
	startCommitment: EndoKeyedDigestV0;
	stoppedAt: string;
	exit: { code: number | null; signal: string | null };
	processGone: boolean;
	listenerGone: boolean;
	commitment: EndoKeyedDigestV0;
}

export const provenancePathV0 = (studyFile: string) => `${studyFile}.provenance.json`;
export const provenanceEndPathV0 = (studyFile: string) => `${studyFile}.provenance-end.json`;
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
export const argvDigestV0 = (key: EndoDigestKeyV0, argv: readonly string[]) =>
	key.digest({ purpose: "endo.research.aa.task-owned.argv.0", argv });
export const environmentDigestV0 = (key: EndoDigestKeyV0, names: readonly string[]) =>
	key.digest({ purpose: "endo.research.aa.task-owned.environment-names.0", names: [...names].sort() });
export const sealProvenanceV0 = (key: EndoDigestKeyV0, body: Omit<TaskOwnedProvenanceV0, "commitment">) => ({
	...body,
	commitment: key.digest({ purpose: TASK_OWNED_PROVENANCE_VERSION_V0, body }),
});
export const sealProvenanceEndV0 = (key: EndoDigestKeyV0, body: Omit<TaskOwnedProvenanceEndV0, "commitment">) => ({
	...body,
	commitment: key.digest({ purpose: TASK_OWNED_PROVENANCE_END_VERSION_V0, body }),
});

/** A sealed record from one successful bounded inspection of the process this launcher spawned. */
export function buildTaskOwnedProvenanceV0(
	key: EndoDigestKeyV0,
	observation: LinuxHostInspectionV0,
	proc: { argv: string[]; environmentNames: string[] },
	lifecycle: Omit<TaskOwnedProvenanceV0["lifecycle"], "owner" | "ownership" | "portFreeAtLaunch">,
): TaskOwnedProvenanceV0 {
	return sealProvenanceV0(key, {
		version: TASK_OWNED_PROVENANCE_VERSION_V0,
		profile: observation.profile,
		declaredProfile: {
			endpoint: observation.endpoint,
			modelPath: observation.modelPath,
			modelAlias: observation.declaredProfile.modelAlias,
			gpuLayers: observation.declaredProfile.gpuLayers,
		},
		executable: {
			path: observation.executablePath,
			sha256: observation.executableSha256,
			identity: observation.executable,
		},
		supportedBinary: observation.checks.supportedBinary,
		model: { path: observation.modelPath, sha256: observation.modelSha256, identity: observation.model },
		process: {
			pid: observation.pid,
			startTicks: observation.startTicks,
			bootId: observation.bootId,
			networkNamespace: observation.networkNamespace,
		},
		listener: {
			endpoint: observation.endpoint,
			port: Number(new URL(observation.endpoint).port),
			socketInode: observation.socketInode,
			socketFd: observation.socketFd,
		},
		launch: {
			argvDigest: argvDigestV0(key, proc.argv),
			argCount: proc.argv.length,
			environmentNames: [...proc.environmentNames].sort(),
			environmentDigest: environmentDigestV0(key, proc.environmentNames),
		},
		lifecycle: {
			owner: TASK_OWNED_LAUNCHER_V0,
			ownership: "declared-task-spawned",
			portFreeAtLaunch: true,
			...lifecycle,
		},
		observedAt: observation.observedAt,
		checks: observation.checks,
		blockingReasons: observation.blockingReasons,
		unavailable: observation.unavailable,
		trustAssumptions: [...TASK_OWNED_TRUST_ASSUMPTIONS_V0],
	}) as TaskOwnedProvenanceV0;
}

const CHECK_FIELDS: CheckFieldV0[] = [
	"process",
	"listenerFd",
	"listenerPort",
	"ipv6",
	"visibleOwners",
	"ownership",
	"reusePort",
	"executable",
	"supportedBinary",
	"modelMapping",
	"launchConfiguration",
	"effectiveRuntimeConfiguration",
];
const iso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,30}$/.test(value);
const identityOk = (value: unknown): value is LinuxFileIdentityV0 =>
	!!value &&
	typeof value === "object" &&
	same(Object.keys(value).sort(), ["ctimeNs", "device", "inode", "mtimeNs", "size"]) &&
	Object.values(value).every(decimal);
const pidOk = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const strings = (value: unknown, max: number): value is string[] =>
	Array.isArray(value) && value.length <= max && value.every((v) => typeof v === "string" && v.length <= 256);

/** Structure and internal consistency only. Nothing here touches procfs: the server may be long gone. */
export function validateTaskOwnedProvenanceV0(
	value: unknown,
	key: EndoDigestKeyV0,
): asserts value is TaskOwnedProvenanceV0 {
	const record = value as TaskOwnedProvenanceV0;
	if (!record || typeof record !== "object") throw new Error("invalid provenance");
	const { commitment, ...body } = record;
	const keys = [
		"version",
		"profile",
		"declaredProfile",
		"executable",
		"supportedBinary",
		"model",
		"process",
		"listener",
		"launch",
		"lifecycle",
		"observedAt",
		"checks",
		"blockingReasons",
		"unavailable",
		"trustAssumptions",
		"commitment",
	];
	if (
		!same(Object.keys(record).sort(), keys.sort()) ||
		!isEndoKeyedDigestV0(commitment) ||
		!same(commitment, sealProvenanceV0(key, body).commitment)
	)
		throw new Error("provenance commitment invalid");
	const { declaredProfile: dp, executable: ex, model: md, process: pr, listener: ls, launch, lifecycle: lc } = record;
	if (
		record.version !== TASK_OWNED_PROVENANCE_VERSION_V0 ||
		record.profile !== EXPLICIT_FIT_OFF_PROFILE_V0 ||
		!dp ||
		!same(Object.keys(dp).sort(), ["endpoint", "gpuLayers", "modelAlias", "modelPath"]) ||
		!ex ||
		!same(Object.keys(ex).sort(), ["identity", "path", "sha256"]) ||
		!md ||
		!same(Object.keys(md).sort(), ["identity", "path", "sha256"]) ||
		!pr ||
		!same(Object.keys(pr).sort(), ["bootId", "networkNamespace", "pid", "startTicks"]) ||
		!ls ||
		!same(Object.keys(ls).sort(), ["endpoint", "port", "socketFd", "socketInode"]) ||
		!launch ||
		!same(Object.keys(launch).sort(), ["argCount", "argvDigest", "environmentDigest", "environmentNames"]) ||
		!lc ||
		!same(Object.keys(lc).sort(), [
			"authorization",
			"launcherPid",
			"owner",
			"ownership",
			"portFreeAtLaunch",
			"processGroup",
			"spawnedAt",
		]) ||
		!lc.authorization ||
		!same(Object.keys(lc.authorization).sort(), ["confirmedAt", "phraseDigest", "planCommitment"])
	)
		throw new Error("provenance shape invalid");
	if (
		!sha(ex.sha256) ||
		!sha(md.sha256) ||
		!identityOk(ex.identity) ||
		!identityOk(md.identity) ||
		typeof ex.path !== "string" ||
		!ex.path.startsWith("/") ||
		typeof md.path !== "string" ||
		!md.path.startsWith("/") ||
		md.path !== dp.modelPath ||
		!pidOk(pr.pid) ||
		!decimal(pr.startTicks) ||
		!/^[0-9a-f-]{36}$/.test(pr.bootId) ||
		typeof pr.networkNamespace !== "string" ||
		!/^net:\[[0-9]+\]$/.test(pr.networkNamespace) ||
		!decimal(ls.socketInode) ||
		!decimal(ls.socketFd) ||
		ls.endpoint !== dp.endpoint ||
		ls.port !== Number(new URL(dp.endpoint).port) ||
		!Number.isSafeInteger(ls.port) ||
		!isEndoKeyedDigestV0(launch.argvDigest) ||
		!isEndoKeyedDigestV0(launch.environmentDigest) ||
		!strings(launch.environmentNames, 64) ||
		!Number.isSafeInteger(launch.argCount) ||
		lc.owner !== TASK_OWNED_LAUNCHER_V0 ||
		lc.ownership !== "declared-task-spawned" ||
		lc.portFreeAtLaunch !== true ||
		!pidOk(lc.launcherPid) ||
		!pidOk(lc.processGroup) ||
		!iso(lc.spawnedAt) ||
		!iso(lc.authorization.confirmedAt) ||
		!isEndoKeyedDigestV0(lc.authorization.planCommitment) ||
		!isEndoKeyedDigestV0(lc.authorization.phraseDigest) ||
		!iso(record.observedAt) ||
		Date.parse(lc.authorization.confirmedAt) > Date.parse(lc.spawnedAt) ||
		Date.parse(lc.spawnedAt) > Date.parse(record.observedAt)
	)
		throw new Error("provenance field invalid");
	// The expected launch is a pure function of the declared profile; the digests must equal it.
	const expectedArgv = [
		ex.path,
		...buildExplicitServerArgsV0({
			endpoint: dp.endpoint,
			modelPath: dp.modelPath,
			modelAlias: dp.modelAlias,
			gpuLayers: dp.gpuLayers,
		}),
	];
	const expectedEnvironment = Object.keys(TASK_OWNED_LAUNCH_ENVIRONMENT_V0).sort();
	if (
		!same(launch.argvDigest, argvDigestV0(key, expectedArgv)) ||
		launch.argCount !== expectedArgv.length ||
		!same(launch.environmentNames, expectedEnvironment) ||
		!same(launch.environmentDigest, environmentDigestV0(key, expectedEnvironment))
	)
		throw new Error("provenance launch arguments do not match the declared profile");
	const checks = record.checks as Record<string, unknown> | undefined;
	if (!checks || !same(Object.keys(checks).sort(), [...CHECK_FIELDS].sort()))
		throw new Error("provenance checks invalid");
	for (const field of [
		"process",
		"listenerFd",
		"listenerPort",
		"ipv6",
		"executable",
		"modelMapping",
		"launchConfiguration",
	] as const)
		if (checks[field] !== "MATCH") throw new Error(`provenance requires ${field} MATCH`);
	// Ownership can be declared by lifecycle, never observed from procfs. A record claiming otherwise is refused.
	if (checks.ownership !== "UNAVAILABLE" || checks.effectiveRuntimeConfiguration !== "UNAVAILABLE")
		throw new Error("provenance overstates unverifiable host facts");
	if (checks.reusePort !== "MATCH" && checks.reusePort !== "UNAVAILABLE")
		throw new Error("provenance reuse-port refused");
	const expectedSupported: CheckStateV0 = ex.sha256 === ACCEPTED_SERVER_SHA256_V0 ? "MATCH" : "UNSUPPORTED";
	if (record.supportedBinary !== expectedSupported || checks.supportedBinary !== expectedSupported)
		throw new Error("provenance supported-binary state invalid");
	if (
		!strings(record.blockingReasons, 16) ||
		!strings(record.unavailable, 16) ||
		TASK_OWNED_REQUIRED_BLOCKING_V0.some((reason) => !record.blockingReasons.includes(reason)) ||
		TASK_OWNED_REQUIRED_UNAVAILABLE_V0.some((fact) => !record.unavailable.includes(fact)) ||
		(checks.reusePort === "UNAVAILABLE" &&
			(!record.blockingReasons.includes("REUSEPORT_UNVERIFIED") || !record.unavailable.includes("reuseport"))) ||
		!same(record.trustAssumptions, [...TASK_OWNED_TRUST_ASSUMPTIONS_V0])
	)
		throw new Error("provenance omits unavailable facts or declared assumptions");
}

export function readTaskOwnedProvenanceV0(file: string, key: EndoDigestKeyV0): TaskOwnedProvenanceV0 {
	const text = initialExecutionPrivateFileV0(file, 64 * 1024);
	const value = JSON.parse(text) as unknown;
	if (!value || text !== canonicalEndoJsonV0(value)) throw new Error("invalid provenance encoding");
	validateTaskOwnedProvenanceV0(value, key);
	return value;
}

export function readTaskOwnedProvenanceEndV0(
	file: string,
	key: EndoDigestKeyV0,
	provenance: TaskOwnedProvenanceV0,
): TaskOwnedProvenanceEndV0 {
	const text = initialExecutionPrivateFileV0(file, 16 * 1024);
	const record = JSON.parse(text) as TaskOwnedProvenanceEndV0;
	if (!record || typeof record !== "object" || text !== canonicalEndoJsonV0(record))
		throw new Error("invalid provenance end encoding");
	const { commitment, ...body } = record;
	if (
		!same(Object.keys(record).sort(), [
			"commitment",
			"exit",
			"listenerGone",
			"processGone",
			"startCommitment",
			"stoppedAt",
			"version",
		]) ||
		!isEndoKeyedDigestV0(commitment) ||
		!same(commitment, sealProvenanceEndV0(key, body).commitment) ||
		record.version !== TASK_OWNED_PROVENANCE_END_VERSION_V0 ||
		!same(record.startCommitment, provenance.commitment) ||
		!iso(record.stoppedAt) ||
		Date.parse(record.stoppedAt) < Date.parse(provenance.observedAt) ||
		typeof record.processGone !== "boolean" ||
		typeof record.listenerGone !== "boolean" ||
		!record.exit ||
		!same(Object.keys(record.exit).sort(), ["code", "signal"]) ||
		(record.exit.code !== null && !Number.isSafeInteger(record.exit.code)) ||
		(record.exit.signal !== null && !/^SIG[A-Z0-9]{1,12}$/.test(record.exit.signal))
	)
		throw new Error("provenance end invalid");
	return record;
}
