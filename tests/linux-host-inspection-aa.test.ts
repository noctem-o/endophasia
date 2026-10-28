import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	hashInspectionChunksV0,
	inspectLinuxHostV0,
} from "../research/governed-initial-continuation/aa/linux-host-inspection.ts";
import { publishPrivateInspectionV0 } from "../research/governed-initial-continuation/aa/private-inspection-output.ts";

const source = `#include <sys/types.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int n, char **v) {
 if (n != 2) return 2;
 int f = open(v[1], O_RDONLY); if (f < 0) return 3;
 void *p = mmap(0, 4096, PROT_READ, MAP_PRIVATE, f, 0); if (p == MAP_FAILED) return 4;
 int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) return 5;
 struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = 0 };
 if (bind(s, (void *)&a, sizeof(a)) || listen(s, 1)) return 6;
 socklen_t len = sizeof(a); if (getsockname(s, (void *)&a, &len)) return 7;
 printf("%u\\n", ntohs(a.sin_port)); fflush(stdout); for (;;) pause();
}`;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.runIf(process.platform === "linux")("partial Linux host inspection", () => {
	it("checks a deadline for each hash chunk", async () => {
		let checks = 0;
		async function* chunks() {
			yield Buffer.from("a");
			yield Buffer.from("b");
		}
		await expect(
			hashInspectionChunksV0(chunks(), () => {
				if (++checks === 2) throw new Error("expired");
			}),
		).rejects.toThrow("expired");
		expect(checks).toBe(2);
	});
	it("publishes into the pinned private directory after its pathname is replaced", () => {
		const root = mkdtempSync(join(tmpdir(), "endo-inspection-output-"));
		const original = join(root, "original"),
			moved = join(root, "moved"),
			other = join(root, "other");
		mkdirSync(original, { mode: 0o700 });
		mkdirSync(other, { mode: 0o700 });
		const fd = openSync(original, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			renameSync(original, moved);
			symlinkSync(other, original);
			publishPrivateInspectionV0(fd, join(original, "evidence.json"), { status: "partial" });
			expect(existsSync(join(moved, "evidence.json"))).toBe(true);
			expect(existsSync(join(other, "evidence.json"))).toBe(false);
			expect(() => publishPrivateInspectionV0(fd, join(original, "evidence.json"), {})).toThrow();
		} finally {
			closeSync(fd);
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("observes a real owned listener, process and mapped file without making a request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-linux-observer-"));
		const program = join(dir, "fake-server");
		const model = join(dir, "fixture.gguf");
		const sourcePath = join(dir, "fake.c");
		let child: ChildProcess | undefined;
		try {
			writeFileSync(sourcePath, source);
			writeFileSync(model, Buffer.alloc(4096, 42));
			execFileSync("cc", [sourcePath, "-o", program]);
			child = spawn(program, [model], { stdio: ["ignore", "pipe", "ignore"] });
			const [chunk] = await Promise.race([
				once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) }),
				once(child, "exit").then(() => {
					throw new Error("fixture exited before listening");
				}),
			]);
			const port = Number(String(chunk).trim());
			const input = {
				pid: child.pid!,
				endpoint: `http://127.0.0.1:${port}`,
				executablePath: program,
				executableSha256: sha(program),
				modelPath: model,
				modelSha256: sha(model),
			};
			const observation = await inspectLinuxHostV0(input, AbortSignal.timeout(5000));
			expect(observation.pid).toBe(child.pid);
			expect(observation.modelMappings.length).toBeGreaterThan(0);
			expect(observation.unavailable).toContain("sole-socket-ownership");
			const output = join(dir, "observation.json");
			const command = spawnSync(
				process.execPath,
				[
					"research/governed-initial-continuation/aa/inspect-linux.ts",
					"--pid",
					String(input.pid),
					"--endpoint",
					input.endpoint,
					"--executable",
					program,
					"--executable-sha256",
					input.executableSha256,
					"--model",
					model,
					"--model-sha256",
					input.modelSha256,
					"--output",
					output,
					"--timeout-ms",
					"5000",
				],
				{ encoding: "utf8" },
			);
			expect(command.status).toBe(2);
			expect(command.stdout).toMatch(/^CRITICAL_UNAVAILABLE:/);
			expect(command.stdout).not.toContain(dir);
			expect(statSync(output).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(output, "utf8")).socketInode).toBe(observation.socketInode);
			await expect(
				inspectLinuxHostV0({ ...input, modelSha256: "0".repeat(64) }, AbortSignal.timeout(5000)),
			).rejects.toThrow("digest mismatch");
			await expect(
				inspectLinuxHostV0({ ...input, endpoint: "http://example.com:80" }, AbortSignal.timeout(5000)),
			).rejects.toThrow();
			await expect(inspectLinuxHostV0(input, AbortSignal.abort())).rejects.toThrow("cancelled");
			writeFileSync(model, Buffer.alloc(16 * 1024 * 1024, 42));
			await expect(
				inspectLinuxHostV0({ ...input, modelSha256: sha(model) }, new AbortController().signal, 1),
			).rejects.toThrow();
			const replacement = join(dir, "replacement.gguf");
			writeFileSync(replacement, Buffer.alloc(4096, 42));
			renameSync(replacement, model);
			await expect(inspectLinuxHostV0(input, AbortSignal.timeout(5000))).rejects.toThrow("mapping");
		} finally {
			if (child?.pid && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});
