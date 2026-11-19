import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// OPERATOR.md's host command blocks, run as written against stand-ins for host.sh, qemu-img and ss. No guest is started.
const T = "research/develop-verify-trust-004";
const doc = readFileSync(join(T, "OPERATOR.md"), "utf8");
const blocks = (section: string) => {
	const start = doc.indexOf(`\n## ${section}`);
	const end = doc.indexOf("\n## ", start + 1);
	return [...doc.slice(start, end).matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] as string);
};
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const SIZE = "10";
const DIGEST = "d".repeat(64);

let root: string;
let W: string;
let W2: string;
let E: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dvt004-operator-test-"));
	W = join(root, "endo18");
	W2 = join(root, "endo18-analysis");
	E = join(root, "evidence");
	mkdirSync(join(W, "vm"), { recursive: true });
	mkdirSync(join(W, "src", T, "qemu"), { recursive: true });
	for (const f of ["vm/console.log", "vm/qemu-argv.log", "vm/qemu-offline.stderr", "listeners-before.txt"])
		writeFileSync(join(W, f), `${f}\n`);
});
afterEach(() => {
	spawnSync("chmod", ["-R", "u+rwX", root]);
	rmSync(root, { recursive: true, force: true });
});

// collect stand-in: COLLECT=fail refuses; PRE=missing|bad and POST=missing|bad shape the extracted export.
const HOST = `#!/bin/bash
set -u
[ "$1" = collect ] || { echo "host.sh $*"; exit 0; }
dest=$2
[ "\${COLLECT:-ok}" = fail ] && { echo "export digest x, guest said $4" >&2; exit 65; }
mkdir -p "$dest"; echo tar > "$dest/export.tar"
cap() { mkdir -p "$dest/out/evidence/$1"; echo a > "$dest/out/evidence/$1/a"; (cd "$dest/out/evidence/$1" && sha256sum a > SHA256SUMS); }
[ "\${PRE:-good}" = missing ] || cap pre
[ "\${PRE:-good}" = bad ] && echo tampered > "$dest/out/evidence/pre/a"
[ -d "$dest/out/evidence/pre" ] && cp "$dest/out/evidence/pre/SHA256SUMS" "$dest/out/evidence/pre.SHA256SUMS"
[ "\${POST:-good}" = missing ] || cap post
[ "\${POST:-good}" = bad ] && echo tampered > "$dest/out/evidence/post/a"
exit 0
`;

function custody(env: Record<string, string>) {
	writeFileSync(join(W, "src", T, "qemu/host.sh"), HOST);
	const [block] = blocks("4. Evidence custody");
	return spawnSync("/usr/bin/bash", ["-c", block as string], {
		env: { PATH: "/usr/bin:/bin", HOME: root, E, W, T, SIZE, DIGEST, ...env },
		encoding: "utf8",
	});
}
const exitOf = (r: { stdout: string }) => /custody exit=(\d+)/.exec(r.stdout)?.[1];

describe("TRUST-004 OPERATOR.md evidence custody", () => {
	it("seals verified evidence read-only and leaves $E writable for the analysis collect", () => {
		const r = custody({});
		expect(exitOf(r), r.stdout + r.stderr).toBe("0");
		expect(r.stdout).toContain("post-read capture present and verified");
		expect(readFileSync(join(E, "HOST-SHA256SUMS"), "utf8")).toContain(`${sha("tar\n")}  export.tar`);
		for (const f of [
			"export.tar",
			"HOST-SHA256SUMS",
			"console.log",
			"out/evidence/pre/a",
			"out/evidence/pre/SHA256SUMS",
		])
			expect(statSync(join(E, f)).mode & 0o222, f).toBe(0);
		expect(statSync(join(E, "out")).mode & 0o222).toBe(0);
		expect(statSync(E).mode & 0o200).toBe(0o200);
		expect(statSync(join(E, "analysis")).isDirectory()).toBe(true);
		const collect = spawnSync("/usr/bin/bash", [
			"-c",
			'mkdir -p "$1/analysis" && echo r > "$1/analysis/reanalysis.json"',
			"_",
			E,
		]);
		expect(collect.status).toBe(0);
	});

	it.each([
		["collect fails", { COLLECT: "fail" }, "2", "STOP: collect failed"],
		["the pre-read capture is missing", { PRE: "missing" }, "3", "STOP: pre-read capture MISSING"],
		["the pre-read capture fails its checksums", { PRE: "bad" }, "3", "STOP: pre-read capture FAILS its checksums"],
		["the post-read capture fails its checksums", { POST: "bad" }, "4", "STOP: post-read capture present but FAILS"],
	])("stops without sealing when %s", (_, env, code, message) => {
		const r = custody(env);
		expect(exitOf(r), r.stdout + r.stderr).toBe(code);
		expect(r.stderr).toContain(message);
		expect(existsSync(join(E, "HOST-SHA256SUMS"))).toBe(false);
		expect(existsSync(join(E, "console.log"))).toBe(false);
	});

	it("reports a missing post-read capture separately and still seals", () => {
		const r = custody({ POST: "missing" });
		expect(exitOf(r), r.stdout + r.stderr).toBe("0");
		expect(r.stdout).toContain("post-read capture MISSING: list it as missing evidence");
		expect(r.stderr).not.toContain("FAILS");
		expect(existsSync(join(E, "HOST-SHA256SUMS"))).toBe(true);
	});

	it("refuses an existing evidence directory", () => {
		mkdirSync(E);
		const r = custody({});
		expect(exitOf(r)).toBe("2");
		expect(r.stderr).toContain("already exists");
	});
});

describe("TRUST-004 OPERATOR.md analysis guest isolation audit", () => {
	it("captures the analysis guest's own baseline before launch and audits it against $W2", () => {
		const [setup, audit] = blocks("5. Independent reanalysis");
		const section = doc.slice(doc.indexOf("\n## 5."), doc.indexOf("\n## 6."));
		expect(section.indexOf('ss -ltunH | sort > "$W2/listeners-before.txt"')).toBeGreaterThan(0);
		expect(section.indexOf('ss -ltunH | sort > "$W2/listeners-before.txt"')).toBeLessThan(section.indexOf("boot.sh"));
		expect(audit).toContain('host.sh" audit');
		expect(audit).not.toMatch(/\$W\/(listeners-before|vm\/)/);
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "qemu-img"), '#!/bin/sh\nfor a; do last=$a; done; : > "$last"\n');
		writeFileSync(join(bin, "ss"), "#!/bin/sh\necho 'tcp LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*'\n");
		chmodSync(join(bin, "qemu-img"), 0o755);
		chmodSync(join(bin, "ss"), 0o755);
		writeFileSync(join(W, "src", T, "qemu/host.sh"), HOST);
		writeFileSync(join(W, "vm/stage.img"), "stage");
		writeFileSync(join(W, "vm/out.img"), "out");
		writeFileSync(join(W, "vm/qemu-argv.log"), "first guest argv\n");
		const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, W, W2, T, OLD: join(root, "endo13") };
		const s = spawnSync("/usr/bin/bash", ["-euc", setup as string], { env, encoding: "utf8" });
		expect(s.status, s.stderr).toBe(0);
		expect(existsSync(join(W2, "listeners-before.txt"))).toBe(true);
		writeFileSync(join(W2, "vm/qemu-argv.log"), "analysis guest argv\n");
		const a = spawnSync("/usr/bin/bash", ["-c", audit as string], { env, encoding: "utf8" });
		expect(a.stdout, a.stderr).toContain("no new host listener");
		expect(a.stdout).toContain("analysis guest argv");
		expect(a.stdout).not.toContain("first guest argv");
	});
});

describe("TRUST-004 OPERATOR.md analysis result write-back", () => {
	const block = () => {
		const b = blocks("5. Independent reanalysis").find((s) => s.includes("analysis.tar"));
		expect(b).toBeDefined();
		return (b as string)
			.replaceAll("/root/", "$G/root/")
			.replaceAll("/dev/vdc", "$G/vdc")
			.replaceAll("/home/analyst", "$G/home/analyst");
	};
	const write = (dd: string) => {
		const G = join(root, "guest");
		mkdirSync(join(G, "root"), { recursive: true });
		mkdirSync(join(G, "home/analyst"), { recursive: true });
		writeFileSync(join(G, "home/analyst/reanalysis.json"), "{}\n");
		writeFileSync(join(G, "vdc"), Buffer.alloc(1 << 16));
		const stubs = `systemctl() { echo "POWEROFF $*"; }\ndd() { ${dd}; }\n`;
		return spawnSync("/usr/bin/bash", ["-c", stubs + block()], {
			env: { PATH: "/usr/bin:/bin", G },
			encoding: "utf8",
		});
	};

	it("powers off only after the result is on the disk with a matching digest", () => {
		const r = write('command dd "$@"');
		expect(r.stdout, r.stderr).toMatch(/analysis size=\d+ sha256=([0-9a-f]{64}) device-prefix-sha256=\1/);
		expect(r.stdout).toContain("POWEROFF poweroff");
	});

	it.each([
		["the write fails", "return 1"],
		[
			"the device prefix does not read back",
			'command dd "$@" && printf X | command dd of="$G/vdc" conv=notrunc status=none',
		],
	])("stays up when %s", (_, dd) => {
		const r = write(dd);
		expect(r.stdout, r.stderr).toContain("ANALYSIS NOT WRITTEN");
		expect(r.stdout).not.toContain("POWEROFF");
		expect(r.stdout).not.toContain("analysis size=");
	});
});

describe("TRUST-004 OPERATOR.md status-8 custody text", () => {
	it("says a run without a verified pre-read capture stops at exit 3 unsealed", () => {
		const text = doc.slice(doc.indexOf("\n## 4."), doc.indexOf("\n## 5.")).replace(/\s+/g, " ");
		expect(text).toContain("which includes every run.sh status 8");
		expect(text).toContain("stops at exit 3 and is not sealed");
		expect(text).not.toMatch(/status 8[^.]*is reported and sealed/);
	});
});
