import { describe, expect, it } from "vitest";
import {
	parseModelMappingsV0,
	parseProcessStartTicksV0,
	parseTcpListenersV0,
} from "../research/governed-initial-continuation/aa/linux-proc.ts";
import { validateExplicitServerArgsV0 } from "../research/governed-initial-continuation/aa/linux-profile.ts";

describe("bounded Linux observer parsers", () => {
	it("decodes the exact IPv4 address and listener inode", () => {
		const header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
		const row = "0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345";
		expect(parseTcpListenersV0(`${header}\n${row}\n`)).toEqual([
			{ address: "127.0.0.1", port: 8080, inode: "12345" },
		]);
		expect(parseTcpListenersV0(`${header}\n${row.replace(" 0A ", " 0a ")}`)).toHaveLength(1);
		expect(() => parseTcpListenersV0(`${header}\n0: bad`)).toThrow();
		expect(() => parseTcpListenersV0(`${header}\n${row.replace(" 0A ", " ZZ ")}`)).toThrow();
	});
	it("extracts start ticks despite parentheses in the process name", () => {
		const fields = ["S", ...Array(18).fill("0"), "123456", ...Array(5).fill("0")];
		expect(parseProcessStartTicksV0(`42 (a ) b) ${fields.join(" ")}`, 42)).toBe("123456");
		expect(() => parseProcessStartTicksV0("42 (bad) S", 42)).toThrow();
	});
	it("retains deleted GGUF mappings instead of treating them as valid paths", () => {
		const lines =
			"1000-2000 r--p 00000000 08:01 55 /tmp/model.gguf (deleted)\n2000-3000 r-xp 00000000 00:00 0 [vdso]\n";
		expect(parseModelMappingsV0(lines)).toEqual([
			{
				start: "1000",
				end: "2000",
				permissions: "r--p",
				offset: "00000000",
				deviceMajor: "8",
				deviceMinor: "1",
				inode: "55",
				path: "/tmp/model.gguf (deleted)",
			},
		]);
		expect(() => parseModelMappingsV0("not-a-mapping")).toThrow();
		expect(() => parseModelMappingsV0("2000-1000 r--p 00000000 08:01 55 /tmp/model.gguf")).toThrow();
	});
});

describe("explicit llama.cpp configuration profile", () => {
	const profile = {
		endpoint: "http://127.0.0.1:8080",
		modelPath: "/private/model.gguf",
		modelAlias: "test-model",
		gpuLayers: "12",
	};
	const args = [
		"llama-server",
		"--host",
		"127.0.0.1",
		"--port",
		"8080",
		"--model",
		profile.modelPath,
		"--alias",
		profile.modelAlias,
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
		"12",
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
	it("requires every supported value explicitly", () => {
		expect(() => validateExplicitServerArgsV0(args, ["PATH", "HOME"], profile)).not.toThrow();
		expect(() => validateExplicitServerArgsV0(args.slice(0, -1), [], profile)).toThrow();
	});
	it("refuses router, conflicting flags, environment overrides and remote endpoints", () => {
		for (const extra of [
			["--models-dir", "/tmp"],
			["--port", "8081"],
			["--api-key", "secret"],
		])
			expect(() => validateExplicitServerArgsV0([...args, ...extra], [], profile)).toThrow();
		expect(() => validateExplicitServerArgsV0(args, ["LLAMA_ARG_CTX_SIZE"], profile)).toThrow();
		expect(() => validateExplicitServerArgsV0(args, ["LD_PRELOAD"], profile)).toThrow();
		expect(() => validateExplicitServerArgsV0(args, [], { ...profile, endpoint: "http://192.0.2.1:8080" })).toThrow();
	});
});
