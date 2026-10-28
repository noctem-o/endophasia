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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	hashInspectionChunksV0,
	inspectLinuxHostOutcomeV0,
	inspectLinuxHostV0,
} from "../research/governed-initial-continuation/aa/linux-host-inspection.ts";
import {
	classifyReusePortResultV0,
	inspectReusePortV0,
} from "../research/governed-initial-continuation/aa/linux-reuseport.ts";
import { publishPrivateInspectionV0 } from "../research/governed-initial-continuation/aa/private-inspection-output.ts";

const source = `#include <sys/types.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <netinet/in.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
int main(int n, char **v) {
 char *model = 0; int port = 0; int layers = 0;
 for (int i = 1; i + 1 < n; i++) { if (!strcmp(v[i], "--model")) model = v[i+1]; if (!strcmp(v[i], "--port")) port = atoi(v[i+1]); if (!strcmp(v[i], "--n-gpu-layers")) layers = atoi(v[i+1]); }
 if (!model || !port) return 2;
 int f = open(model, O_RDONLY); if (f < 0) return 3;
 void *p = mmap(0, 4096, PROT_READ, MAP_PRIVATE, f, 0); if (p == MAP_FAILED) return 4;
 int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) return 5;
 if (layers == 13 || layers == 14) prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0, 0, 0);
 int reuse = layers == 13 ? 1 : 0; if (setsockopt(s, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse))) return 8;
 struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = htons(port) };
 if (bind(s, (void *)&a, sizeof(a)) || listen(s, 1)) return 6;
 socklen_t len = sizeof(a); if (getsockname(s, (void *)&a, &len)) return 7;
 printf("%u\\n", ntohs(a.sin_port)); fflush(stdout); for (;;) pause();
}`;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
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
const serverArgs = (model: string, port: number, layers = "12") => [
	"--host",
	"127.0.0.1",
	"--port",
	String(port),
	"--model",
	model,
	"--alias",
	"test-model",
	"--ctx-size",
	"65536",
	"--parallel",
	"1",
	"--batch-size",
	"512",
	"--ubatch-size",
	"128",
	"--cache-type-k",
	"q4_0",
	"--cache-type-v",
	"q4_0",
	"--flash-attn",
	"on",
	"--n-gpu-layers",
	layers,
	"--fit",
	"off",
	"--cache-ram",
	"0",
	"--ctx-checkpoints",
	"0",
	"--reasoning-format",
	"deepseek",
	"--jinja",
	"--no-context-shift",
	"--no-cache-idle-slots",
];

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
	it("reports unavailable socket-option evidence rather than inferring a default", async () => {
		expect(classifyReusePortResultV0("DISABLED\n", false)).toBe("MATCH");
		expect(classifyReusePortResultV0("ENABLED\n", false)).toBe("MISMATCH");
		expect(classifyReusePortResultV0("CHANGED\n", false)).toBe("MISMATCH");
		expect(classifyReusePortResultV0("DISABLED\n", true)).toBe("UNAVAILABLE");
		expect(classifyReusePortResultV0("unexpected", false)).toBe("UNAVAILABLE");
		expect(await inspectReusePortV0(2147483647, "3", "42", AbortSignal.timeout(3000))).toBe("UNAVAILABLE");
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
	it("classifies actual process arguments and environment without retaining values", async () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-profile-process-"));
		const program = join(dir, "server"),
			model = join(dir, "model.gguf"),
			sourcePath = join(dir, "server.c");
		try {
			writeFileSync(sourcePath, source);
			writeFileSync(model, Buffer.alloc(4096, 42));
			execFileSync("cc", [sourcePath, "-o", program]);
			const variants = [
				{ mode: "empty", expected: "MATCH" },
				{ mode: "fit", expected: "MISMATCH" },
				{ mode: "duplicate", expected: "MISMATCH" },
				{ mode: "router", expected: "UNSUPPORTED" },
				{ mode: "unknown", expected: "UNSUPPORTED" },
				{ mode: "environment", expected: "UNSUPPORTED" },
			] as const;
			for (const variant of variants) {
				const port = await freePort(),
					args = serverArgs(model, port);
				if (variant.mode === "fit") args[args.indexOf("--fit") + 1] = "on";
				if (variant.mode === "duplicate") args.push("--ctx-size", "65536");
				if (variant.mode === "router") args.push("--models-dir", "/synthetic/router");
				if (variant.mode === "unknown") args.push("--unknown-option", "value");
				const env: NodeJS.ProcessEnv = variant.mode === "empty" ? {} : { PATH: process.env.PATH ?? "/usr/bin" };
				if (variant.mode === "environment") env.LLAMA_ARG_CTX_SIZE = "private-synthetic-value";
				const child = spawn(program, args, { stdio: ["ignore", "pipe", "ignore"], env });
				try {
					await Promise.race([
						once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) }),
						once(child, "exit").then(() => {
							throw new Error("fixture exited");
						}),
					]);
					const result = await inspectLinuxHostOutcomeV0(
						{
							pid: child.pid!,
							endpoint: `http://127.0.0.1:${port}`,
							executablePath: program,
							executableSha256: sha(program),
							modelPath: model,
							modelSha256: sha(model),
							modelAlias: "test-model",
							gpuLayers: "12",
						},
						AbortSignal.timeout(5000),
					);
					expect(result.checks.launchConfiguration).toBe(variant.expected);
					expect(JSON.stringify(result)).not.toContain("private-synthetic-value");
					if (variant.mode === "empty") {
						// Descriptor access depends on the host's ptrace policy: MATCH is legitimate, a hidden value is not.
						expect(["MATCH", "UNAVAILABLE"]).toContain(result.checks.reusePort);
						if (result.checks.reusePort === "UNAVAILABLE")
							expect(result.blockingReasons).toContain("REUSEPORT_UNVERIFIED");
					} else expect(result.observation).toBeNull();
				} finally {
					if (child.pid && child.exitCode === null && child.signalCode === null) {
						const exited = once(child, "exit");
						child.kill("SIGTERM");
						await exited;
					}
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
	it("reads SO_REUSEPORT when descriptor access is permitted and otherwise keeps it unverified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-reuseport-process-"));
		const program = join(dir, "server"),
			model = join(dir, "model.gguf"),
			sourcePath = join(dir, "server.c");
		try {
			writeFileSync(sourcePath, source);
			writeFileSync(model, Buffer.alloc(4096, 42));
			execFileSync("cc", [sourcePath, "-o", program]);
			for (const [layers, expected] of [
				["13", "MISMATCH"],
				["14", "MATCH"],
			] as const) {
				const port = await freePort();
				const child = spawn(program, serverArgs(model, port, layers), {
					stdio: ["ignore", "pipe", "ignore"],
					env: { PATH: process.env.PATH ?? "/usr/bin" },
				});
				try {
					await Promise.race([
						once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) }),
						once(child, "exit").then(() => {
							throw new Error("fixture exited");
						}),
					]);
					const result = await inspectLinuxHostOutcomeV0(
						{
							pid: child.pid!,
							endpoint: `http://127.0.0.1:${port}`,
							executablePath: program,
							executableSha256: sha(program),
							modelPath: model,
							modelSha256: sha(model),
							modelAlias: "test-model",
							gpuLayers: layers,
						},
						AbortSignal.timeout(5000),
					);
					expect([expected, "UNAVAILABLE"]).toContain(result.checks.reusePort);
					if (result.checks.reusePort === "UNAVAILABLE")
						expect(result.blockingReasons).toContain("REUSEPORT_UNVERIFIED");
					if (result.checks.reusePort === "MISMATCH") expect(result.status).toBe("IDENTITY_MISMATCH");
				} finally {
					if (child.pid && child.exitCode === null && child.signalCode === null) {
						const exited = once(child, "exit");
						child.kill("SIGTERM");
						await exited;
					}
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
	it("observes a real owned listener, process and mapped file without making a request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-linux-observer-"));
		const program = join(dir, "fake-server");
		const model = join(dir, "fixture.gguf");
		const sourcePath = join(dir, "fake.c");
		let child: ChildProcess | undefined;
		let sentinel: ChildProcess | undefined;
		try {
			writeFileSync(sourcePath, source);
			writeFileSync(model, Buffer.alloc(4096, 42));
			execFileSync("cc", [sourcePath, "-o", program]);
			sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
			const selectedPort = await freePort();
			child = spawn(program, serverArgs(model, selectedPort), {
				stdio: ["ignore", "pipe", "ignore"],
				env: { PATH: process.env.PATH ?? "/usr/bin" },
			});
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
				modelAlias: "test-model",
				gpuLayers: "12",
			};
			const observation = await inspectLinuxHostV0(input, AbortSignal.timeout(5000));
			expect(observation.pid).toBe(child.pid);
			expect(observation.modelMappings.length).toBeGreaterThan(0);
			expect(observation.checks.listenerFd).toBe("MATCH");
			expect(observation.checks.launchConfiguration).toBe("MATCH");
			expect(["MATCH", "UNAVAILABLE"]).toContain(observation.checks.reusePort);
			if (observation.checks.reusePort === "UNAVAILABLE")
				expect(observation.blockingReasons).toContain("REUSEPORT_UNVERIFIED");
			expect(observation.checks.ownership).toBe("UNAVAILABLE");
			expect(observation.blockingReasons).toContain("OWNERSHIP_UNVERIFIED");
			expect(observation.status).toBe("UNSUPPORTED_PROFILE");
			expect(
				(await inspectLinuxHostOutcomeV0({ ...input, modelAlias: "wrong" }, AbortSignal.timeout(5000))).checks
					.launchConfiguration,
			).toBe("MISMATCH");
			const competingPort = await freePort();
			const competingFirst = spawn(program, serverArgs(model, competingPort, "13"), {
				stdio: ["ignore", "pipe", "ignore"],
				env: { PATH: process.env.PATH ?? "/usr/bin" },
			});
			let competing: ChildProcess | undefined;
			try {
				await Promise.race([
					once(competingFirst.stdout!, "data", { signal: AbortSignal.timeout(5000) }),
					once(competingFirst, "exit").then(() => {
						throw new Error("first competing fixture exited");
					}),
				]);
				competing = spawn(program, serverArgs(model, competingPort, "13"), {
					stdio: ["ignore", "pipe", "ignore"],
					env: { PATH: process.env.PATH ?? "/usr/bin" },
				});
				await Promise.race([
					once(competing.stdout!, "data", { signal: AbortSignal.timeout(5000) }),
					once(competing, "exit").then(() => {
						throw new Error("competing fixture exited");
					}),
				]);
				const conflict = await inspectLinuxHostOutcomeV0(
					{ ...input, pid: competingFirst.pid!, endpoint: `http://127.0.0.1:${competingPort}`, gpuLayers: "13" },
					AbortSignal.timeout(5000),
				);
				expect(conflict.status).toBe("IDENTITY_MISMATCH");
				expect(conflict.checks.listenerPort).toBe("MISMATCH");
			} finally {
				for (const target of [competing, competingFirst])
					if (target?.pid && target.exitCode === null && target.signalCode === null) {
						const exited = once(target, "exit");
						target.kill("SIGTERM");
						await exited;
					}
			}
			expect(
				(await inspectLinuxHostOutcomeV0({ ...input, executablePath: "/bin/sh" }, AbortSignal.timeout(5000))).checks
					.executable,
			).toBe("MISMATCH");
			expect(
				(await inspectLinuxHostOutcomeV0({ ...input, executableSha256: "0".repeat(64) }, AbortSignal.timeout(5000)))
					.checks.executable,
			).toBe("MISMATCH");
			const wrongModel = join(dir, "wrong.gguf");
			writeFileSync(wrongModel, Buffer.alloc(4096, 42));
			expect(
				(await inspectLinuxHostOutcomeV0({ ...input, modelPath: wrongModel }, AbortSignal.timeout(5000))).checks
					.launchConfiguration,
			).toBe("MISMATCH");
			const ipv6 = createServer();
			let ipv6Bound = false;
			try {
				try {
					await new Promise<void>((resolve, reject) => {
						ipv6.once("error", reject);
						ipv6.listen({ port, host: "::1", ipv6Only: true }, resolve);
					});
					ipv6Bound = true;
				} catch (error) {
					if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? ""))
						throw error;
				}
				if (ipv6Bound) {
					const conflict = await inspectLinuxHostOutcomeV0(input, AbortSignal.timeout(5000));
					expect(conflict.status).toBe("IDENTITY_MISMATCH");
					expect(conflict.checks.ipv6).toBe("MISMATCH");
				}
			} finally {
				if (ipv6Bound)
					await new Promise<void>((resolve, reject) => ipv6.close((error) => (error ? reject(error) : resolve())));
			}
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
					"--model-alias",
					"test-model",
					"--gpu-layers",
					"12",
					"--output",
					output,
					"--timeout-ms",
					"5000",
				],
				{ encoding: "utf8" },
			);
			expect(command.status).toBe(2);
			expect(command.stdout).toMatch(/^UNSUPPORTED_PROFILE:/);
			expect(command.stdout).not.toContain(dir);
			expect(statSync(output).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(output, "utf8")).observation.socketInode).toBe(observation.socketInode);
			await expect(
				inspectLinuxHostV0({ ...input, modelSha256: "0".repeat(64) }, AbortSignal.timeout(5000)),
			).rejects.toThrow("digest mismatch");
			await expect(
				inspectLinuxHostV0({ ...input, endpoint: "http://example.com:80" }, AbortSignal.timeout(5000)),
			).rejects.toThrow();
			await expect(inspectLinuxHostV0(input, AbortSignal.abort())).rejects.toThrow("cancelled");
			expect((await inspectLinuxHostOutcomeV0(input, AbortSignal.abort())).blockingReasons).toContain("CANCELLED");
			writeFileSync(model, Buffer.alloc(16 * 1024 * 1024, 42));
			await expect(
				inspectLinuxHostV0({ ...input, modelSha256: sha(model) }, new AbortController().signal, 1),
			).rejects.toThrow();
			expect(
				(await inspectLinuxHostOutcomeV0({ ...input, modelSha256: sha(model) }, new AbortController().signal, 1))
					.blockingReasons,
			).toContain("TIMEOUT");
			const replacement = join(dir, "replacement.gguf");
			writeFileSync(replacement, Buffer.alloc(4096, 42));
			renameSync(replacement, model);
			await expect(inspectLinuxHostV0(input, AbortSignal.timeout(5000))).rejects.toThrow("mapping");
			expect((await inspectLinuxHostOutcomeV0(input, AbortSignal.timeout(5000))).checks.modelMapping).toBe(
				"MISMATCH",
			);
			expect(() => process.kill(sentinel!.pid!, 0)).not.toThrow();
		} finally {
			if (child?.pid && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
			if (sentinel?.pid && sentinel.exitCode === null && sentinel.signalCode === null) {
				const exited = once(sentinel, "exit");
				sentinel.kill("SIGTERM");
				await exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});
