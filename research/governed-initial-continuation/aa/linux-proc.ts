// Bounded Linux procfs parsing helpers. They do not establish a server match by themselves.
import { endianness } from "node:os";
export interface TcpListenerV0 {
	address: string;
	port: number;
	inode: string;
}

/** Linux prints IPv4 addresses in host byte order. Reject malformed relevant rows rather than guessing. */
export function parseTcpListenersV0(text: string): TcpListenerV0[] {
	if (endianness() !== "LE") throw new Error("unsupported host byte order");
	if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("tcp table exceeds limit");
	const lines = text.trim().split("\n");
	if (!lines.shift()?.includes("local_address")) throw new Error("invalid tcp table header");
	const result: TcpListenerV0[] = [];
	for (const line of lines) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10 || !/^[0-9]+:$/.test(fields[0]!)) throw new Error("invalid tcp row");
		const local = /^([0-9A-Fa-f]{8}):([0-9A-Fa-f]{4})$/.exec(fields[1]!);
		if (!local || !/^[0-9a-f]{2}$/i.test(fields[3]!) || !/^[0-9]+$/.test(fields[9]!))
			throw new Error("invalid tcp socket");
		if (fields[3]!.toUpperCase() !== "0A") continue;
		const bytes = local[1]!.match(/../g)!;
		result.push({
			address: bytes
				.reverse()
				.map((x) => Number.parseInt(x, 16))
				.join("."),
			port: Number.parseInt(local[2]!, 16),
			inode: fields[9]!,
		});
	}
	return result;
}

/** The comm field may itself contain spaces and parentheses. Linux field 22 is process start ticks. */
export function parseProcessStartTicksV0(text: string, pid: number): string {
	if (Buffer.byteLength(text) > 16384 || !text.startsWith(`${pid} (`)) throw new Error("invalid process stat");
	const close = text.lastIndexOf(") ");
	if (close < 0) throw new Error("invalid process stat");
	const fields = text
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	const ticks = fields[19];
	if (!ticks || !/^[0-9]+$/.test(ticks)) throw new Error("invalid process start time");
	return ticks;
}

export interface ModelMappingV0 {
	start: string;
	end: string;
	permissions: string;
	offset: string;
	deviceMajor: string;
	deviceMinor: string;
	inode: string;
	path: string;
}
export function parseModelMappingsV0(text: string): ModelMappingV0[] {
	if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("maps exceeds limit");
	const mappings: ModelMappingV0[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		const match =
			/^([0-9a-f]+)-([0-9a-f]+)\s+([r-][w-][x-][ps])\s+([0-9a-f]+)\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)\s*(.*)$/i.exec(
				line,
			);
		if (!match) throw new Error("invalid maps row");
		if (BigInt(`0x${match[1]}`) >= BigInt(`0x${match[2]}`)) throw new Error("invalid mapping range");
		const path = match[8]!;
		if (/\.gguf(?: \(deleted\))?$/i.test(path))
			mappings.push({
				start: match[1]!,
				end: match[2]!,
				permissions: match[3]!,
				offset: match[4]!,
				deviceMajor: BigInt(`0x${match[5]}`).toString(),
				deviceMinor: BigInt(`0x${match[6]}`).toString(),
				inode: match[7]!,
				path,
			});
	}
	return mappings;
}
