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
import {
	type ModelMappingV0,
	parseModelMappingsV0,
	parseProcessStartTicksV0,
	parseTcpListenersV0,
} from "./linux-proc.ts";

export interface LinuxInspectionInputV0 {
	pid: number;
	endpoint: string;
	executablePath: string;
	executableSha256: string;
	modelPath: string;
	modelSha256: string;
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
	// These cannot be inferred from procfs alone. No caller may turn this into live parity evidence.
	unavailable: readonly [
		"sole-socket-ownership",
		"reuseport",
		"ipv6-listener-ambiguity",
		"runtime-configuration",
		"server-metadata",
		"gpu-telemetry",
	];
}

const unavailable = [
	"sole-socket-ownership",
	"reuseport",
	"ipv6-listener-ambiguity",
	"runtime-configuration",
	"server-metadata",
	"gpu-telemetry",
] as const;
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
function major(dev: bigint): bigint {
	return ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
}
function minor(dev: bigint): bigint {
	return (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
}
function boundedText(path: string, max: number): string {
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
		return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
	} finally {
		closeSync(fd);
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
		throw new Error("unsupported inspection input");
	const url = new URL(input.endpoint);
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
		throw new Error("explicit IPv4 loopback endpoint required");
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
	if (readlinkSync(`${proc}/exe`) !== executablePath) throw new Error("executable changed or deleted");
	const executable = identity(executablePath);
	if (!same(identity(`${proc}/exe`), executable)) throw new Error("running executable identity mismatch");
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
		throw new Error("model mapping unavailable or changed");
	const listeners = parseTcpListenersV0(boundedText(`${proc}/net/tcp`, 4 * 1024 * 1024)).filter(
		(entry) => entry.port === Number(url.port),
	);
	if (listeners.length !== 1 || listeners[0]!.address !== "127.0.0.1") throw new Error("ambiguous IPv4 listener");
	// This partial probe cannot establish sole ownership or IPv6/reuseport exclusion.
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
	if (matching.length !== 1) throw new Error("listener owner unavailable or ambiguous");
	const executableSha256 = await digestFile(executablePath, executable, deadlineSignal, check);
	check();
	const modelSha256 = await digestFile(modelPath, model, deadlineSignal, check);
	check();
	if (executableSha256 !== input.executableSha256 || modelSha256 !== input.modelSha256)
		throw new Error("file digest mismatch");
	if (
		signal.aborted ||
		parseProcessStartTicksV0(boundedText(`${proc}/stat`, 16384), input.pid) !== startTicks ||
		readlinkSync(`${proc}/exe`) !== executablePath ||
		!same(identity(`${proc}/exe`), executable) ||
		readlinkSync(`${proc}/ns/net`) !== networkNamespace ||
		readlinkSync(`${proc}/fd/${matching[0]}`) !== `socket:[${socketInode}]` ||
		!same(identity(executablePath), executable) ||
		!same(identity(modelPath), model) ||
		!same(parseModelMappingsV0(boundedText(`${proc}/maps`, 16 * 1024 * 1024)), mappings) ||
		!same(
			parseTcpListenersV0(boundedText(`${proc}/net/tcp`, 4 * 1024 * 1024)).filter(
				(entry) => entry.port === Number(url.port),
			),
			listeners,
		)
	)
		throw new Error("identity changed during inspection");
	check();
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
		unavailable,
	};
}
