import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hasExecutableV0,
	isolatedHomeEnvV0,
	isWorkstationHomePathV0,
	probeBwrapSandboxV0,
	requireOrSkipCapabilityV0,
	resolveOptionalExecutableV0,
} from "./helpers/host-capabilities.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const dir of cleanup.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-host-cap-"));
	cleanup.push(dir);
	return dir;
}

describe("host-capability test helpers", () => {
	it("detects executable files and rejects missing or non-executable paths", () => {
		const dir = tempDir();
		const nonExec = join(dir, "plain.txt");
		const execFile = join(dir, "tool.sh");
		writeFileSync(nonExec, "hello\n", "utf8");
		writeFileSync(execFile, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(nonExec, 0o644);
		chmodSync(execFile, 0o755);

		expect(hasExecutableV0(execFile)).toBe(true);
		expect(hasExecutableV0(nonExec)).toBe(false);
		expect(hasExecutableV0(join(dir, "missing"))).toBe(false);
		expect(hasExecutableV0("")).toBe(false);
		expect(hasExecutableV0(null)).toBe(false);
	});

	it("resolves optional executables strictly from explicit env vars with no workstation fallback", () => {
		const dir = tempDir();
		const tool = join(dir, "fake-tool");
		writeFileSync(tool, "#!/bin/sh\nexit 0\n", "utf8");
		chmodSync(tool, 0o755);

		expect(resolveOptionalExecutableV0("ENDO_TEST_TOOL", {})).toMatchObject({
			available: false,
			path: null,
		});
		expect(resolveOptionalExecutableV0("ENDO_TEST_TOOL", { ENDO_TEST_TOOL: join(dir, "absent") })).toMatchObject({
			available: false,
			path: join(dir, "absent"),
		});
		expect(resolveOptionalExecutableV0("ENDO_TEST_TOOL", { ENDO_TEST_TOOL: tool })).toEqual({
			available: true,
			path: tool,
		});
	});

	it("fails loudly when a required capability env var is set and skips cleanly otherwise", () => {
		const missing = { available: false, path: null, reason: "/usr/bin/bwrap is not installed" } as const;
		expect(requireOrSkipCapabilityV0("bwrap sandbox", "ENDO_REQUIRE_TEST_BWRAP", missing, {})).toEqual({
			run: false,
			required: false,
			available: false,
			reason: "/usr/bin/bwrap is not installed",
		});
		expect(() =>
			requireOrSkipCapabilityV0("bwrap sandbox", "ENDO_REQUIRE_TEST_BWRAP", missing, {
				ENDO_REQUIRE_TEST_BWRAP: "1",
			}),
		).toThrow(/bwrap sandbox is required \(ENDO_REQUIRE_TEST_BWRAP=1\) but unavailable/);

		const present = { available: true, path: "/usr/bin/bwrap" } as const;
		expect(
			requireOrSkipCapabilityV0("bwrap sandbox", "ENDO_REQUIRE_TEST_BWRAP", present, {
				ENDO_REQUIRE_TEST_BWRAP: "1",
			}),
		).toEqual({ run: true, required: true, available: true });
	});

	it("reports unavailable cleanly when probing a non-existent bwrap path", () => {
		const dir = tempDir();
		const res = probeBwrapSandboxV0({ path: join(dir, "no-bwrap"), checkUserNamespace: true });
		expect(res.available).toBe(false);
		expect(res.path).toBeNull();
	});

	it("constructs an isolated HOME/XDG child environment and clears systemd session vars by default", () => {
		const dir = tempDir();
		const base = {
			PATH: "/usr/bin",
			HOME: "/home/ambient-user",
			XDG_RUNTIME_DIR: "/run/user/1000",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
		};
		const isolated = isolatedHomeEnvV0(dir, { baseEnv: base, extra: { FOO: "bar" } });
		expect(isolated.HOME).toBe(join(dir, "home"));
		expect(isolated.XDG_CONFIG_HOME).toBe(join(dir, "xdg-config"));
		expect(isolated.XDG_DATA_HOME).toBe(join(dir, "xdg-data"));
		expect(isolated.XDG_RUNTIME_DIR).toBe("");
		expect(isolated.DBUS_SESSION_BUS_ADDRESS).toBe("");
		expect(isolated.FOO).toBe("bar");

		const withScopes = isolatedHomeEnvV0(dir, { baseEnv: base, allowRealScopes: true });
		expect(withScopes.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(withScopes.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
	});

	it("flags workstation home paths", () => {
		expect(isWorkstationHomePathV0("/home/developer/.local/bin/openclaw")).toBe(true);
		expect(isWorkstationHomePathV0("/usr/bin/bwrap")).toBe(false);
	});
});
