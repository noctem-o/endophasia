import { describe, expect, it } from "vitest";
import { socketExcluded } from "../research/develop-verify-trust-002/audit.ts";

describe("IP0: sensitive daemon sockets (fixture, no connection)", () => {
	it.each(["writable", "writable (access)", "EIO", "unknown"])("blocks on %s", (observation) => {
		expect(socketExcluded(observation)).toBe(false);
	});
	it.each(["absent", "EACCES", "not-writable"])("recognizes %s for this pathname only", (observation) => {
		expect(socketExcluded(observation)).toBe(true);
	});
});
