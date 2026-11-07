// Writing a whole buffer to a descriptor. writeSync may write fewer bytes than asked (a full filesystem, a file-size limit, a pipe): a
// caller that ignores its return value records bytes that were never written. This writes until every byte is written, or throws.

import { writeSync } from "node:fs";

export function writeAllSyncV0(
	fd: number,
	data: string | Uint8Array,
	write: (fd: number, buffer: Uint8Array, offset: number, length: number) => number = writeSync,
): void {
	const bytes =
		typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;
	while (offset < bytes.length) {
		const n = write(fd, bytes, offset, bytes.length - offset);
		if (n <= 0) throw new Error("a write made no progress");
		offset += n;
	}
}
