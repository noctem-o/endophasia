import { describe, expect, it } from "vitest";
import type { EndoSandboxRunV0 } from "../adapters/sandbox/bubblewrap.ts";
import { completedOfflineRun } from "../research/develop-isolate-001/diagnostic.ts";
import {
	failedOfflineChecks,
	LIVE_PROBE_PREFIX,
	OFFLINE_EXPECTED,
	readOfflineProbe,
} from "../research/develop-isolate-001/probe.ts";

const challenge = "fresh-for-this-launch";
const encode = (checks: Record<string, unknown>) => `${LIVE_PROBE_PREFIX}${JSON.stringify({ challenge, ...checks })}\n`;

describe("offline observations (simulated, no host launch)", () => {
	it("accepts one complete observation from this launch", () => {
		const checks = readOfflineProbe(encode(OFFLINE_EXPECTED), challenge);
		expect(checks).toEqual(OFFLINE_EXPECTED);
		expect(failedOfflineChecks(checks!)).toEqual([]);
	});

	it("rejects stale, substituted, duplicate, missing or malformed reports", () => {
		const complete = encode(OFFLINE_EXPECTED);
		expect(readOfflineProbe(complete, "current-launch-after-restart")).toBeNull();
		const { "fs-canary-read": _, ...missing } = OFFLINE_EXPECTED;
		for (const line of [
			complete + complete,
			complete.replace('"ENOENT"', '"ENOENT","fs-canary-read":"ok"'),
			encode(missing),
			encode({ ...missing, unknown: "ENOENT" }),
			encode({ ...OFFLINE_EXPECTED, "fs-canary-read": null }),
			encode({ ...OFFLINE_EXPECTED, "fs-canary-read": "secret/raw output" }),
			`${LIVE_PROBE_PREFIX}null\n`,
			`${LIVE_PROBE_PREFIX}{\n`,
			complete.slice(0, -1),
		]) {
			expect(readOfflineProbe(line, challenge)).toBeNull();
		}
	});

	it("rejects surprising observations and requires a negative control's exact effect", () => {
		const exposed = { ...OFFLINE_EXPECTED, "fs-canary-read": "ok", "workspace-identity": "different" };
		expect(failedOfflineChecks(exposed)).toEqual(["fs-canary-read", "workspace-identity"]);
		expect(failedOfflineChecks(exposed, { "fs-canary-read": "ok" })).toEqual(["workspace-identity"]);
		expect(failedOfflineChecks(OFFLINE_EXPECTED, { "fs-canary-read": "ok" })).toEqual(["fs-canary-read"]);
		expect(failedOfflineChecks({ ...OFFLINE_EXPECTED, "nested-userns": "inconclusive" })).toEqual(["nested-userns"]);
	});
});

describe("offline process completion (simulated, no host launch)", () => {
	const complete: EndoSandboxRunV0 = {
		started: true,
		exitCode: 0,
		signal: null,
		timedOut: false,
		durationMs: 1,
		stdout: Buffer.from(encode(OFFLINE_EXPECTED)),
		stderr: Buffer.alloc(0),
		truncated: { stdout: 0, stderr: 0 },
		init: { pid: 42, startTime: "1" },
		initGone: true,
		scope: { unit: "disposable", established: true, ended: "confirmed" },
		termination: "confirmed",
	};

	it("accepts only a released, identified and cleanly ended run", () => {
		expect(completedOfflineRun(complete)).toBe(true);
		for (const failed of [
			{ started: false },
			{ init: null },
			{ initGone: false },
			{ scope: { ...complete.scope, established: false } },
			{ scope: { ...complete.scope, ended: "unconfirmed" } as const },
			{ termination: "unconfirmed" } as const,
			{ truncated: { stdout: 1, stderr: 0 } },
			{ timedOut: true },
			{ signal: "SIGKILL" },
			{ exitCode: 1 },
		]) {
			expect(completedOfflineRun({ ...complete, ...failed })).toBe(false);
		}
	});
});
