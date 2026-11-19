import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	audit,
	type PathView,
	recordDirectoryOk,
	socketExcluded,
	sudoRefused,
	writable,
} from "../research/develop-verify-trust-002/audit.ts";

// A fixture account: uid 1500, its own primary group only, no supplementary groups, and this process's access(2) answers for it.
const account = {
	uid: 1500,
	passwd: "endoagent:x:1500:1500::/home/endoagent:/bin/sh\n",
	group: "endoagent:x:1500:\nlibvirt:x:954:\ndocker:x:962:\n",
	status: "Groups:\t1500\n",
	effective: true,
};
const stat = (o: { uid?: number; gid?: number; mode: number; dir?: boolean }) =>
	({ uid: o.uid ?? 0, gid: o.gid ?? 0, mode: o.mode, isDirectory: () => o.dir === true }) as unknown as Stats;
const denied = (code: string) => () => {
	throw Object.assign(new Error(code), { code });
};
const view = (sockets: Record<string, Stats | string>, access: (p: string) => void): PathView => ({
	look: (p) => sockets[p] ?? "absent",
	access,
});
const socketRows = (v: PathView) =>
	Object.fromEntries(
		audit(false, account, v)
			.checks.filter((c) => c.id === "h0-socket")
			.map((c) => [c.path, { observed: c.observed, ok: c.ok }]),
	);
const DOCKER = "/run/docker.sock";
const LIBVIRT = "/run/libvirt/libvirt-sock";

describe("IP0: sensitive daemon sockets (fixture, no connection)", () => {
	it.each(["writable", "writable (access)", "EIO", "unknown"])("blocks on %s", (observation) => {
		expect(socketExcluded(observation)).toBe(false);
	});
	it.each(["absent", "EACCES", "not-writable"])("recognizes %s for this pathname only", (observation) => {
		expect(socketExcluded(observation)).toBe(true);
	});
});

describe("IP0: the audit's socket rows, through injected path observations", () => {
	it("refuses a socket writable only through an ACL (mode bits deny, access(2) allows)", () => {
		const v = view({ [DOCKER]: stat({ gid: 962, mode: 0o660 }) }, () => undefined);
		expect(writable(DOCKER, account, v)).toBe("writable (access)");
		expect(socketRows(v)[DOCKER]).toEqual({ observed: "writable (access)", ok: false });
	});
	it("refuses an unrecognised access(2) error instead of reading it as not writable", () => {
		const v = view({ [DOCKER]: stat({ gid: 962, mode: 0o660 }) }, denied("EIO"));
		expect(socketRows(v)[DOCKER]).toEqual({ observed: "EIO", ok: false });
	});
	it("accepts a socket that mode bits and access(2) both deny", () => {
		const v = view({ [DOCKER]: stat({ gid: 962, mode: 0o660 }) }, denied("EACCES"));
		expect(socketRows(v)[DOCKER]).toEqual({ observed: "not-writable", ok: true });
	});
	it("refuses a world-writable libvirt socket: no pathname is exempt (PROTOCOL.md amendment A1)", () => {
		const v = view({ [LIBVIRT]: stat({ mode: 0o666 }) }, denied("EACCES"));
		expect(socketRows(v)[LIBVIRT]).toEqual({ observed: "writable", ok: false });
		expect(audit(false, account, v).h0).toBe(false);
	});
});

describe("IP0: a sudo policy refusal is distinguished from an error", () => {
	it.each([
		[1, "sudo: a password is required\n"],
		[1, "Sorry, user endoagent is not allowed to execute '/usr/bin/true' as root on guest.\n"],
		[1, "endoagent is not in the sudoers file.\n"],
	])("recognises status %s, %j", (status, stderr) => {
		expect(sudoRefused(status, stderr)).toBe(true);
	});
	it.each([
		[0, ""],
		[null, ""],
		[1, "sudo: unable to execute /usr/bin/true: Permission denied\n"],
		[127, "sudo: a password is required\n"],
		[1, "sudo: interactive authentication is required\n"],
	])("does not qualify status %s, %j", (status, stderr) => {
		expect(sudoRefused(status as number | null, stderr)).toBe(false);
	});
});

describe("installed gate: the records directory", () => {
	const uid = 977;
	it.each([
		["absent before the first request", true, "absent", true],
		["the verifier's, 0755", true, stat({ uid, mode: 0o755, dir: true }), true],
		["absent under an unverified state root", false, "absent", false],
		["the verifier's under an unverified state root", false, stat({ uid, mode: 0o755, dir: true }), false],
		["another uid's", true, stat({ uid: 1500, mode: 0o755, dir: true }), false],
		["writable by others", true, stat({ uid, mode: 0o777, dir: true }), false],
		["group-writable", true, stat({ uid, mode: 0o775, dir: true }), false],
		["not a directory", true, stat({ uid, mode: 0o644 }), false],
		["unreadable", true, "EACCES", false],
	] as const)("%s", (_name, stateOk, records, ok) => {
		expect(recordDirectoryOk(stateOk, records as Stats | string, uid)).toBe(ok);
	});
});
