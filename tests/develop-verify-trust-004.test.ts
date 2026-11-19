import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TRACES = "research/develop-verify-trust-004/guest/traces.py";
const dirs: string[] = [];
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), "dvt004-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const traces = (...args: string[]) => {
	const r = spawnSync("/usr/bin/python3", ["-I", TRACES, ...args], { encoding: "utf8" });
	return { status: r.status, out: JSON.parse(r.stdout) as Record<string, any> };
};

const REFUSALS = [
	'1161  chmod("/var/lib/endo-verify-002/work/8f8aee74c2774fce1d9bd3bcf07bb259/candidate", 0755) = -1 EACCES (Permission denied)',
	'1161  openat(AT_FDCWD, "/usr/local/lib/endo-verify-002/research/develop-verify-trust-002/service/verifier.ts", O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC, 0666) = -1 EACCES (Permission denied)',
	'1161  mkdir("/etc/systemd/user/endo-verify-002@.service.d", 0777) = -1 EACCES (Permission denied)',
	'1161  openat(AT_FDCWD, "/var/lib/endo-verify-002/records/74a1e648a8b1be8ae52b2eb722389829.json", O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC, 0666) = -1 EACCES (Permission denied)',
	'1161  symlink("/home/endoagent/x.json", "/var/lib/endo-verify-002/records/131a9a6e5212abecf158e5c3cbb671ad.json") = -1 EACCES (Permission denied)',
	"1161  kill(8273, SIGKILL)               = -1 EPERM (Operation not permitted)",
	'1161  openat(AT_FDCWD, "/usr/local/lib/endo-verify-002/oracle/roman-numerals-cli/manifest.json", O_RDONLY|O_CLOEXEC) = -1 EACCES (Permission denied)',
	'1161  openat(AT_FDCWD, "/proc/17687/environ", O_RDONLY|O_CLOEXEC) = -1 EACCES (Permission denied)',
	"1161  kill(17687, 0)                    = -1 EPERM (Operation not permitted)",
];

describe("TRUST-004 trace reading", () => {
	it("requires every refusal, each with its own errno", () => {
		const d = scratch();
		writeFileSync(join(d, "all"), `${REFUSALS.join("\n")}\n`);
		expect(traces("refusals", join(d, "all")).out.held).toBe(true);
		// ENOENT, a missing line, or an empty trace (attachment that never happened) is never a refusal.
		writeFileSync(
			join(d, "enoent"),
			`${REFUSALS.map((l, i) => (i === 3 ? l.replace("EACCES (Permission denied)", "ENOENT (No such file or directory)") : l)).join("\n")}\n`,
		);
		const enoent = traces("refusals", join(d, "enoent"));
		expect(enoent.status).toBe(1);
		expect(enoent.out.missing).toEqual(["T8 record create"]);
		writeFileSync(join(d, "empty"), "");
		expect(traces("refusals", join(d, "empty")).out.held).toBe(false);
	});

	it("derives Git's and the sandbox's identities from the kernel's return values", () => {
		const d = scratch();
		const drop = (uid: number) => [
			`16:00:00.000001 execve("/usr/bin/setpriv", ["/usr/bin/setpriv", "--reuid=${uid}"], 0x0 /* 0 vars */) = 0`,
			"16:00:00.000002 setgroups(0, NULL) = 0",
			`16:00:00.000003 setregid(${uid}, ${uid}) = 0`,
			`16:00:00.000004 setreuid(${uid}, ${uid}) = 0`,
			"16:00:00.000005 prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) = 0",
		];
		writeFileSync(
			join(d, "t.10"),
			[...drop(1500), '16:00:00.1 execve("/usr/bin/git", ["/usr/bin/git", "-c", "safe.directory=*"], 0x0) = 0'].join(
				"\n",
			),
		);
		writeFileSync(
			join(d, "t.11"),
			[
				...drop(65534),
				'16:00:00.2 execve("/usr/bin/bwrap", ["/usr/bin/bwrap", "--unshare-all", "--clearenv", "--ro-bind", "/tmp/x", "/work"], 0x0) = 0',
			].join("\n"),
		);
		writeFileSync(join(d, "t.12"), '16:00:00.3 execve("/usr/bin/bwrap", ["/usr/bin/bwrap", "--version"], 0x0) = 0\n');
		const ok = traces("identity", d, "1500", "1500");
		expect(ok.out).toMatchObject({
			gitExecs: 1,
			gitAsAgent: 1,
			bwrapExecs: 1,
			bwrapAsGrader: 1,
			bwrapDetectionAsCaller: 1,
			held: true,
		});
		// A failed drop leaves root's credentials: Git then runs as root and the identity check fails.
		writeFileSync(
			join(d, "t.13"),
			[
				drop(1500)[0],
				"16:00:00.4 setreuid(1500, 1500) = -1 EPERM (Operation not permitted)",
				'16:00:00.5 execve("/usr/bin/git", ["/usr/bin/git"], 0x0) = 0',
			].join("\n"),
		);
		const bad = traces("identity", d, "1500", "1500");
		expect(bad.status).toBe(1);
		expect(bad.out.gitOther[0].uid).toEqual([0, 0, 0]);
	});
});
