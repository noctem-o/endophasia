// Read-only, partial host inspection. This module does not grant dispatch authority.
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	createReadStream,
	fstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { inspectSocketOwnersV0 } from "./linux-ownership.ts";
import {
	type ModelMappingV0,
	parseModelMappingsV0,
	parseProcessStartTicksV0,
	parseTcp6ListeningPortsV0,
	parseTcpListenersV0,
} from "./linux-proc.ts";
import {
	ACCEPTED_SERVER_SHA256_V0,
	EXPLICIT_FIT_OFF_PROFILE_V0,
	LinuxProfileErrorV0,
	validateExplicitServerArgsV0,
} from "./linux-profile.ts";
import { inspectReusePortV0 } from "./linux-reuseport.ts";

export type CheckStateV0 = "MATCH" | "MISMATCH" | "UNAVAILABLE" | "UNSUPPORTED";
export type CheckFieldV0 =
	| "process"
	| "listenerFd"
	| "listenerPort"
	| "ipv6"
	| "visibleOwners"
	| "ownership"
	| "reusePort"
	| "executable"
	| "supportedBinary"
	| "modelMapping"
	| "launchConfiguration"
	| "effectiveRuntimeConfiguration";
export class LinuxInspectionFailureV0 extends Error {
	readonly field: CheckFieldV0;
	readonly classification: CheckStateV0;
	constructor(field: CheckFieldV0, classification: CheckStateV0, message: string) {
		super(message);
		this.field = field;
		this.classification = classification;
	}
}
const fail = (field: CheckFieldV0, classification: CheckStateV0, message: string): never => {
	throw new LinuxInspectionFailureV0(field, classification, message);
};

export interface LinuxInspectionInputV0 {
	pid: number;
	endpoint: string;
	executablePath: string;
	executableSha256: string;
	modelPath: string;
	modelSha256: string;
	modelAlias: string;
	gpuLayers: string;
}
export interface LinuxFileIdentityV0 {
	device: string;
	inode: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}
export interface LinuxHostInspectionV0 {
	version: "endo.research.aa.linux-host-inspection.0";
	observedAt: string;
	endpoint: string;
	pid: number;
	startTicks: string;
	bootId: string;
	networkNamespace: string;
	socketInode: string;
	socketFd: string;
	executablePath: string;
	executable: LinuxFileIdentityV0;
	executableSha256: string;
	model: LinuxFileIdentityV0;
	modelPath: string;
	modelSha256: string;
	modelMappings: ModelMappingV0[];
	profile: typeof EXPLICIT_FIT_OFF_PROFILE_V0;
	declaredProfile: { modelAlias: string; gpuLayers: string };
	checks: Record<CheckFieldV0, CheckStateV0>;
	status: "CRITICAL_UNAVAILABLE" | "UNSUPPORTED_PROFILE" | "IDENTITY_MISMATCH";
	blockingReasons: string[];
	// These cannot be inferred from procfs alone. No caller may turn this into live parity evidence.
	unavailable: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function identity(path: string): LinuxFileIdentityV0 {
	const s = statSync(path, { bigint: true });
	if (!s.isFile()) throw new Error("expected regular file");
	return {
		device: s.dev.toString(),
		inode: s.ino.toString(),
		size: s.size.toString(),
		mtimeNs: s.mtimeNs.toString(),
		ctimeNs: s.ctimeNs.toString(),
	};
}
function procArgv(text: string): string[] {
	if (!text.endsWith("\0")) throw new Error("invalid process argv");
	const entries = text.slice(0, -1).split("\0");
	if (!entries.length || entries.length > 4096 || entries.some((entry) => entry.length > 16384))
		throw new Error("invalid process argv");
	return entries;
}
function procEnvironmentNames(data: Buffer): string[] {
	if (!data.length) return [];
	if (data[data.length - 1] !== 0) throw new Error("invalid environment");
	const names: string[] = [];
	for (let start = 0; start < data.length; ) {
		const end = data.indexOf(0, start),
			equal = data.indexOf(61, start);
		if (end < 0 || equal <= start || equal >= end || end - start > 16384 || names.length >= 4096)
			throw new Error("invalid environment");
		names.push(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start, equal)));
		start = end + 1;
	}
	if (new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
		throw new Error("invalid environment");
	return names;
}
export function selectLoopbackListenerV0(tcp: string, tcp6: string, port: number) {
	const matches = parseTcpListenersV0(tcp).filter((entry) => entry.port === port);
	if (matches.length !== 1 || matches[0]!.address !== "127.0.0.1")
		fail("listenerPort", "MISMATCH", "ambiguous IPv4 listener");
	if (parseTcp6ListeningPortsV0(tcp6).includes(port)) fail("ipv6", "MISMATCH", "IPv6 listener shares selected port");
	return matches;
}
export function assertProcessStartStableV0(pid: number, expected: string, stat: string): void {
	let actual = "";
	try {
		actual = parseProcessStartTicksV0(stat, pid);
	} catch {
		fail("process", "UNAVAILABLE", "process identity unavailable");
	}
	if (actual !== expected) fail("process", "MISMATCH", "process identity changed");
}
function major(dev: bigint): bigint {
	return ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
}
function minor(dev: bigint): bigint {
	return (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
}
function boundedBytes(path: string, max: number): Buffer {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		const data = Buffer.allocUnsafe(max + 1);
		let size = 0;
		while (size < data.length) {
			const count = readSync(fd, data, size, data.length - size, null);
			if (count === 0) break;
			size += count;
		}
		if (size > max) throw new Error("procfs data exceeds limit");
		return data.subarray(0, size);
	} finally {
		closeSync(fd);
	}
}
function boundedText(path: string, max: number): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(boundedBytes(path, max));
}
function fingerprintAndErase(data: Buffer): string {
	try {
		return createHash("sha256").update(data).digest("hex");
	} finally {
		data.fill(0);
	}
}
export async function hashInspectionChunksV0(chunks: AsyncIterable<Uint8Array>, check: () => void): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of chunks) {
		check();
		hash.update(chunk);
	}
	check();
	return hash.digest("hex");
}
async function digestFile(
	path: string,
	expected: LinuxFileIdentityV0,
	signal: AbortSignal,
	check: () => void,
): Promise<string> {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = () => {
			const s = fstatSync(fd, { bigint: true });
			return {
				device: s.dev.toString(),
				inode: s.ino.toString(),
				size: s.size.toString(),
				mtimeNs: s.mtimeNs.toString(),
				ctimeNs: s.ctimeNs.toString(),
			};
		};
		if (!same(stat(), expected)) throw new Error("file changed before hashing");
		const stream = createReadStream(path, { fd, autoClose: false, signal, highWaterMark: 1024 * 1024 });
		const digest = await hashInspectionChunksV0(stream, check);
		if (signal.aborted || !same(stat(), expected)) throw new Error("file changed or inspection cancelled");
		return digest;
	} finally {
		closeSync(fd);
	}
}
function validate(input: LinuxInspectionInputV0): URL {
	if (
		process.platform !== "linux" ||
		!Number.isSafeInteger(input.pid) ||
		input.pid < 1 ||
		![input.executablePath, input.modelPath].every(isAbsolute) ||
		![input.executableSha256, input.modelSha256].every((value) => /^[0-9a-f]{64}$/.test(value))
	)
		fail("process", "UNSUPPORTED", "unsupported inspection input");
	let url: URL;
	try {
		url = new URL(input.endpoint);
	} catch {
		return fail("listenerPort", "UNSUPPORTED", "explicit IPv4 loopback endpoint required");
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.origin !== input.endpoint
	)
		fail("listenerPort", "UNSUPPORTED", "explicit IPv4 loopback endpoint required");
	return url;
}

/** Local process/file checks only; missing socket ownership and configuration checks remain explicit. */
export async function inspectLinuxHostV0(
	input: LinuxInspectionInputV0,
	signal: AbortSignal,
	budgetMs = 600000,
): Promise<LinuxHostInspectionV0> {
	if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 600000)
		throw new Error("invalid inspection budget");
	const deadline = performance.now() + budgetMs;
	const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
	const check = () => {
		if (deadlineSignal.aborted || performance.now() >= deadline) throw new Error("inspection cancelled or expired");
	};
	const url = validate(input);
	check();
	const proc = `/proc/${input.pid}`;
	const startTicks = parseProcessStartTicksV0(boundedText(`${proc}/stat`, 16384), input.pid);
	const bootId = boundedText("/proc/sys/kernel/random/boot_id", 128).trim();
	if (!/^[0-9a-f-]{36}$/.test(bootId)) throw new Error("invalid boot identity");
	const networkNamespace = readlinkSync(`${proc}/ns/net`);
	if (networkNamespace !== readlinkSync("/proc/self/ns/net")) throw new Error("different network namespace");
	const executablePath = realpathSync(input.executablePath);
	const modelPath = realpathSync(input.modelPath);
	if (readlinkSync(`${proc}/exe`) !== executablePath) fail("executable", "MISMATCH", "executable changed or deleted");
	const executable = identity(executablePath);
	if (!same(identity(`${proc}/exe`), executable))
		fail("executable", "MISMATCH", "running executable identity mismatch");
	const cmdline = boundedBytes(`${proc}/cmdline`, 128 * 1024);
	let environment: Buffer | undefined;
	let cmdlineFingerprint = "",
		environmentFingerprint = "";
	try {
		environment = boundedBytes(`${proc}/environ`, 1024 * 1024);
		validateExplicitServerArgsV0(
			procArgv(new TextDecoder("utf-8", { fatal: true }).decode(cmdline)),
			procEnvironmentNames(environment),
			{
				endpoint: input.endpoint,
				modelPath,
				modelAlias: input.modelAlias,
				gpuLayers: input.gpuLayers,
			},
		);
	} catch (error) {
		if (error instanceof LinuxProfileErrorV0) fail("launchConfiguration", error.classification, error.message);
		throw error;
	} finally {
		cmdlineFingerprint = fingerprintAndErase(cmdline);
		if (environment) environmentFingerprint = fingerprintAndErase(environment);
	}
	const model = identity(modelPath);
	if (
		BigInt(executable.size) > 1024n * 1024n * 1024n ||
		BigInt(model.size) > 64n * 1024n * 1024n * 1024n ||
		BigInt(model.size) === 0n
	)
		throw new Error("file exceeds inspection resource limit");
	const mappings = parseModelMappingsV0(boundedText(`${proc}/maps`, 16 * 1024 * 1024));
	const dev = BigInt(model.device);
	if (
		mappings.length === 0 ||
		mappings.some(
			(m) =>
				m.path !== modelPath ||
				m.inode !== model.inode ||
				m.deviceMajor !== major(dev).toString() ||
				m.deviceMinor !== minor(dev).toString() ||
				BigInt(`0x${m.offset}`) >= BigInt(model.size),
		)
	)
		fail("modelMapping", "MISMATCH", "model mapping unavailable or changed");
	const listeners = selectLoopbackListenerV0(
		boundedText(`${proc}/net/tcp`, 4 * 1024 * 1024),
		boundedText(`${proc}/net/tcp6`, 4 * 1024 * 1024),
		Number(url.port),
	);
	const socketInode = listeners[0]!.inode;
	const names: string[] = [];
	const fds = await (await import("node:fs/promises")).opendir(`${proc}/fd`);
	for await (const entry of fds) {
		check();
		if (names.length >= 4096) throw new Error("file descriptor limit exceeded");
		names.push(entry.name);
	}
	check();
	const matching: string[] = [];
	for (const name of names) {
		check();
		if (readlinkSync(`${proc}/fd/${name}`) === `socket:[${socketInode}]`) matching.push(name);
	}
	if (matching.length !== 1) fail("listenerFd", "UNAVAILABLE", "listener owner unavailable or ambiguous");
	const executableSha256 = await digestFile(executablePath, executable, deadlineSignal, check);
	check();
	const modelSha256 = await digestFile(modelPath, model, deadlineSignal, check);
	check();
	if (executableSha256 !== input.executableSha256) fail("executable", "MISMATCH", "executable digest mismatch");
	if (modelSha256 !== input.modelSha256) fail("modelMapping", "MISMATCH", "model digest mismatch");
	const visibleOwners = await inspectSocketOwnersV0("/proc", socketInode, input.pid, check);
	if (visibleOwners === "MISMATCH") fail("ownership", "MISMATCH", "multiple or changed socket owners");
	const reusePort = await inspectReusePortV0(input.pid, matching[0]!, socketInode, deadlineSignal);
	check();
	if (reusePort === "MISMATCH") fail("reusePort", "MISMATCH", "reuse-port enabled or socket identity changed");
	assertProcessStartStableV0(input.pid, startTicks, boundedText(`${proc}/stat`, 16384));
	if (
		signal.aborted ||
		readlinkSync(`${proc}/exe`) !== executablePath ||
		!same(identity(`${proc}/exe`), executable) ||
		readlinkSync(`${proc}/ns/net`) !== networkNamespace ||
		fingerprintAndErase(boundedBytes(`${proc}/cmdline`, 128 * 1024)) !== cmdlineFingerprint ||
		fingerprintAndErase(boundedBytes(`${proc}/environ`, 1024 * 1024)) !== environmentFingerprint ||
		readlinkSync(`${proc}/fd/${matching[0]}`) !== `socket:[${socketInode}]` ||
		!same(identity(executablePath), executable) ||
		!same(identity(modelPath), model) ||
		!same(parseModelMappingsV0(boundedText(`${proc}/maps`, 16 * 1024 * 1024)), mappings) ||
		parseTcp6ListeningPortsV0(boundedText(`${proc}/net/tcp6`, 4 * 1024 * 1024)).includes(Number(url.port)) ||
		!same(
			parseTcpListenersV0(boundedText(`${proc}/net/tcp`, 4 * 1024 * 1024)).filter(
				(entry) => entry.port === Number(url.port),
			),
			listeners,
		)
	)
		fail("process", "MISMATCH", "identity changed during inspection");
	check();
	const supportedBinary: CheckStateV0 = executableSha256 === ACCEPTED_SERVER_SHA256_V0 ? "MATCH" : "UNSUPPORTED";
	const checks: Record<CheckFieldV0, CheckStateV0> = {
		process: "MATCH",
		listenerFd: "MATCH",
		listenerPort: "MATCH",
		ipv6: "MATCH",
		visibleOwners,
		ownership: "UNAVAILABLE",
		reusePort,
		executable: "MATCH",
		supportedBinary,
		modelMapping: "MATCH",
		launchConfiguration: "MATCH",
		effectiveRuntimeConfiguration: "UNAVAILABLE",
	};
	return {
		version: "endo.research.aa.linux-host-inspection.0",
		observedAt: new Date().toISOString(),
		endpoint: input.endpoint,
		pid: input.pid,
		startTicks,
		bootId,
		networkNamespace,
		socketInode,
		socketFd: matching[0]!,
		executablePath,
		executable,
		executableSha256,
		model,
		modelPath,
		modelSha256,
		modelMappings: mappings,
		profile: EXPLICIT_FIT_OFF_PROFILE_V0,
		declaredProfile: { modelAlias: input.modelAlias, gpuLayers: input.gpuLayers },
		checks,
		status: supportedBinary === "UNSUPPORTED" ? "UNSUPPORTED_PROFILE" : "CRITICAL_UNAVAILABLE",
		blockingReasons: [
			...(reusePort === "UNAVAILABLE" ? ["REUSEPORT_UNVERIFIED"] : []),
			"OWNERSHIP_UNVERIFIED",
			"EFFECTIVE_RUNTIME_UNVERIFIED",
			...(supportedBinary === "UNSUPPORTED" ? ["UNSUPPORTED_BINARY"] : []),
		],
		unavailable: [
			"sole-socket-ownership",
			...(reusePort === "UNAVAILABLE" ? ["reuseport"] : []),
			"runtime-configuration",
			"server-metadata",
			"gpu-telemetry",
		],
	};
}

export interface LinuxInspectionOutcomeV0 {
	status: "CRITICAL_UNAVAILABLE" | "UNSUPPORTED_PROFILE" | "IDENTITY_MISMATCH";
	checks: Record<CheckFieldV0, CheckStateV0>;
	blockingReasons: string[];
	observation: LinuxHostInspectionV0 | null;
}

/** No result can assert observable parity: reuse-port and effective runtime state remain unknown. */
export async function inspectLinuxHostOutcomeV0(
	input: LinuxInspectionInputV0,
	signal: AbortSignal,
	budgetMs = 600000,
): Promise<LinuxInspectionOutcomeV0> {
	const deadline = performance.now() + budgetMs;
	try {
		const observation = await inspectLinuxHostV0(input, signal, budgetMs);
		return {
			status: observation.status,
			checks: observation.checks,
			blockingReasons: observation.blockingReasons,
			observation,
		};
	} catch (error) {
		const fields: CheckFieldV0[] = [
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
		const checks = Object.fromEntries(fields.map((field) => [field, "UNAVAILABLE"])) as Record<
			CheckFieldV0,
			CheckStateV0
		>;
		if (error instanceof LinuxInspectionFailureV0) {
			checks[error.field] = error.classification;
			return {
				status:
					error.classification === "MISMATCH"
						? "IDENTITY_MISMATCH"
						: error.classification === "UNSUPPORTED"
							? "UNSUPPORTED_PROFILE"
							: "CRITICAL_UNAVAILABLE",
				checks,
				blockingReasons: [
					error.message,
					...(error.field !== "ownership" || error.classification === "UNAVAILABLE"
						? ["OWNERSHIP_UNVERIFIED"]
						: []),
					"REUSEPORT_UNVERIFIED",
				],
				observation: null,
			};
		}
		const code = (error as NodeJS.ErrnoException | null)?.code;
		const reason = signal.aborted
			? "CANCELLED"
			: performance.now() >= deadline
				? "TIMEOUT"
				: code === "EACCES" || code === "EPERM"
					? "INSUFFICIENT_PROCFS_OR_FILE_PERMISSIONS"
					: code === "ENOENT" || code === "ESRCH"
						? "PROCESS_OR_FILE_UNAVAILABLE"
						: "CRITICAL_HOST_FACT_UNAVAILABLE";
		return {
			status: "CRITICAL_UNAVAILABLE",
			checks,
			blockingReasons: [reason, "OWNERSHIP_UNVERIFIED", "REUSEPORT_UNVERIFIED"],
			observation: null,
		};
	}
}

/** Bounded procfs readers shared with task-owned rechecks, so one definition decides what a fact is. */
export const linuxProcFactsV0 = { identity, procArgv, procEnvironmentNames, boundedBytes, boundedText, major, minor };
