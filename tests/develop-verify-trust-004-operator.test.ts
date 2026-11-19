import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const raw = "opaque, not a tar";
const SIZE = String(Buffer.byteLength(raw));
const DIGEST = sha(raw);

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

const HOST = `#!/bin/bash
set -eu
[ "$1" = collect ] || { echo "host.sh $*"; exit 0; }
exec bash "${resolve(T, "qemu/host.sh")}" "$@"
`;
function custody(env: Record<string, string>) {
	writeFileSync(join(W, "src", T, "qemu/host.sh"), HOST);
	writeFileSync(join(W, "vm/out.img"), raw);
	const [block] = blocks("4. Evidence custody");
	return spawnSync("/usr/bin/bash", ["-c", block as string], {
		env: { PATH: "/usr/bin:/bin", HOME: root, E, W, T, SIZE, DIGEST, ...env },
		encoding: "utf8",
	});
}
const exitOf = (r: { stdout: string }) => /custody exit=(\d+)/.exec(r.stdout)?.[1];

it("aborts before staging when any selected path is occupied", () => {
	const preflight = blocks("1. Preconditions").find((b) => b.includes("for p in"));
	const check = preflight?.slice(preflight.indexOf("for p in"));
	expect(check).toBeDefined();
	for (const key of ["W", "W2", "E"]) {
		const env = { W: join(root, "fresh1"), W2: join(root, "fresh2"), E: join(root, "fresh3"), [key]: W };
		const r = shell(`${check}\necho STAGING`, env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`STOP: retained or occupied path: ${W}`);
		expect(r.stdout).not.toContain("STAGING");
	}
});

describe("TRUST-004 OPERATOR.md evidence custody", () => {
	it("seals only the opaque raw bytes and host logs", () => {
		const r = custody({});
		expect(exitOf(r), r.stderr).toBe("0");
		expect(readdirSync(E).sort()).toEqual(
			[
				"HOST-SHA256SUMS",
				"export.tar",
				"console.log",
				"qemu-argv.log",
				"qemu-offline.stderr",
				"listeners-before.txt",
			].sort(),
		);
		expect(readFileSync(join(E, "HOST-SHA256SUMS"), "utf8")).toContain(`${DIGEST}  export.tar`);
		for (const f of readdirSync(E)) expect(statSync(join(E, f)).mode & 0o222, f).toBe(0);
	});

	it("stops without sealing when collect refuses", () => {
		const r = custody({ DIGEST: "0".repeat(64) });
		expect(exitOf(r)).toBe("2");
		expect(r.stderr).toContain("STOP: collect failed");
		expect(existsSync(join(E, "HOST-SHA256SUMS"))).toBe(false);
	});

	it("refuses an existing evidence directory", () => {
		mkdirSync(E);
		const r = custody({});
		expect(exitOf(r)).toBe("2");
		expect(r.stderr).toContain("already exists");
	});
});

it("stops at either invalid custody manifest and retains both work directories", () => {
	const [verify] = blocks("6. Teardown");
	mkdirSync(join(E, "analysis"), { recursive: true });
	mkdirSync(W2);
	for (const directory of [E, join(E, "analysis")]) {
		writeFileSync(join(directory, "export.tar"), "raw");
		writeFileSync(join(directory, "HOST-SHA256SUMS"), `${sha("raw")}  export.tar\n`);
	}
	for (const directory of [E, join(E, "analysis")]) {
		writeFileSync(join(directory, "export.tar"), "changed");
		const r = spawnSync("/bin/bash", ["-c", verify], { env: { E, W, W2, PATH: "/usr/bin" }, encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("export.tar: FAILED");
		expect(existsSync(W) && existsSync(W2)).toBe(true);
		writeFileSync(join(directory, "export.tar"), "raw");
	}
	expect(verify).not.toMatch(/\b(?:teardown|rm)\b/);
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
		mkdirSync(E);
		writeFileSync(join(E, "export.tar"), raw);
		chmodSync(join(E, "export.tar"), 0o400);
		writeFileSync(join(W, "vm/qemu-argv.log"), "first guest argv\n");
		const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, W, W2, T, E, OLD: join(root, "endo13") };
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

function guestBlock(marker: string) {
	const block = blocks("5. Independent reanalysis").find((b) => b.includes(marker));
	if (!block) throw new Error(`missing operator block: ${marker}`);
	return block
		.replaceAll("/root/", `${root}/root/`)
		.replaceAll("/opt/", `${root}/opt/`)
		.replaceAll("/dev/vdc", `${root}/vdc`)
		.replaceAll("/home/analyst", `${root}/analyst`);
}

function shell(script: string, env: Record<string, string> = {}) {
	return spawnSync("/usr/bin/bash", ["-c", script], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
}

describe("TRUST-004 analysis guest intake", () => {
	it.each([
		["the exact prefix", "12", sha("export bytes"), true],
		["a short read with matching digest", "20", sha("export bytes!"), false],
		["a prefix of the wrong length", "11", sha("export bytes"), false],
		["a wrong digest", "12", "0".repeat(64), false],
		["an unset size", "", sha("export bytes"), false],
		["a non-decimal size", "12K", sha("export bytes"), false],
	])("accepts only verified bytes: %s", (_, size, digest, ok) => {
		mkdirSync(join(root, "root"));
		mkdirSync(join(root, "opt"));
		writeFileSync(join(root, "vdc"), "export bytes!");
		const r = shell(guestBlock('head -c "$SIZE"'), { SIZE: size, DIGEST: digest });
		expect(r.status === 0, r.stderr).toBe(ok);
		expect(existsSync(join(root, "opt/trust004-export.tar"))).toBe(ok);
		if (ok) expect(readFileSync(join(root, "opt/trust004-export.tar"), "utf8")).toBe("export bytes");
	});
});

describe("TRUST-004 analysis guest executes only the trusted checkout", () => {
	it.each([
		["extraction refusal", 2, 0, 0, false, 2],
		["nested input refusal", 0, 4, 0, false, 4],
		["failed analysis", 0, 0, 3, true, 3],
		["successful analysis", 0, 0, 0, true, 0],
		["bad pre checksum", 0, 0, 0, false, 1],
		["bad post checksum", 0, 0, 0, false, 1],
		["missing pre capture", 0, 0, 0, false, 1],
	])("%s", (scenario, extract, preflight, analysis, runsAnalyzer, rc) => {
		const source = join(root, "opt/trust004-source");
		const input = join(root, "analyst/input");
		mkdirSync(source, { recursive: true });
		const cap = join(input, "out/evidence/pre");
		mkdirSync(cap, { recursive: true });
		const manifest = `${sha("sample")}  sample\n`;
		writeFileSync(join(cap, "sample"), "sample");
		writeFileSync(join(cap, "SHA256SUMS"), manifest);
		writeFileSync(join(cap, "../pre.SHA256SUMS"), manifest);
		if (scenario === "bad pre checksum") writeFileSync(join(cap, "sample"), "wrong");
		if (scenario === "missing pre capture") rmSync(cap, { recursive: true });
		if (scenario === "bad post checksum") {
			mkdirSync(join(cap, "../post"));
			writeFileSync(join(cap, "../post/sample"), "wrong");
			writeFileSync(join(cap, "../post/SHA256SUMS"), manifest);
			writeFileSync(join(cap, "../post.SHA256SUMS"), manifest);
		}
		const execution = guestBlock("runuser -u analyst");
		const analysisScript = execution.split("bash -euc '")[1]?.split("'\necho")[0];
		expect(analysisScript).toBeDefined();
		const stubs = `python3() {
		  test "$PWD" = "${source}" && test "$1" = -I || return 90
		  case "$2" in
		    "${source}/${T}/guest/extract.py") test "$3" = "${root}/opt/trust004-export.tar" && test "$4" = "${input}" || return 91; return ${extract};;
		    "${source}/${T}/guest/check-input.py") test "$3" = "${cap}" || return 92; echo PREFLIGHT; return ${preflight};;
		    *) return 93;;
		  esac
		}
		node() {
		  test "$PWD" = "${source}" && test "$1" = "${source}/${T}/reanalyze.ts" && test "$2" = "${input}/out/evidence" &&
		  test "$3" = "${input}/out/run/trusted-read.json" && test "$4" = "${root}/opt/trust004-result/analysis.json" || return 94
		  echo ANALYZING; return ${analysis}
		}
		`;
		const r = shell(`set -eu\n${stubs}\n${analysisScript}`);
		expect(r.status, r.stderr).toBe(rc);
		expect(r.stdout.includes("PREFLIGHT")).toBe(extract === 0);
		expect(r.stdout.includes("ANALYZING")).toBe(runsAnalyzer);
		if (runsAnalyzer) {
			expect(r.stdout).toContain(`reanalyze exit=${rc}`);
			expect(r.stdout).toContain("post-read capture MISSING");
		}
		if (scenario === "bad pre checksum" || scenario === "bad post checksum")
			expect(r.stdout).toContain("sample: FAILED");
		if (scenario === "missing pre capture") expect(r.stderr).toContain("No such file or directory");
	});
});

describe("TRUST-004 raw analysis return", () => {
	it.each([
		["successful write", 'command dd "$@"', true],
		["failed write", "return 1", false],
		["read-back mismatch", 'command dd "$@" && printf X > "$VDC"', false],
	])("%s", (_, dd, ok) => {
		const bytes = '{"example":true}\n';
		mkdirSync(join(root, "root"));
		mkdirSync(join(root, "opt/trust004-result"), { recursive: true });
		writeFileSync(join(root, "opt/trust004-result/analysis.json"), bytes);
		const r = shell(`dd() { ${dd}; }; systemctl() { echo "POWEROFF $*"; }\n${guestBlock("if=/root/analysis.json")}`, {
			VDC: join(root, "vdc"),
		});
		expect(r.status === 0, r.stderr).toBe(ok);
		expect(r.stdout.includes("POWEROFF poweroff")).toBe(ok);
		if (!ok) return;
		expect(r.stdout).toContain(
			`analysis size=${bytes.length} sha256=${sha(bytes)} device-prefix-sha256=${sha(bytes)}`,
		);
		mkdirSync(join(W2, "vm"), { recursive: true });
		mkdirSync(E);
		writeFileSync(join(W2, "vm/out.img"), readFileSync(join(root, "vdc")));
		writeFileSync(join(W, "src", T, "qemu/host.sh"), HOST);
		const collect = blocks("5. Independent reanalysis").find((b) => b.includes("ANALYSIS_SIZE"));
		const host = shell(collect as string, {
			W,
			W2,
			E,
			T,
			ANALYSIS_SIZE: String(bytes.length),
			ANALYSIS_DIGEST: sha(bytes),
		});
		expect(host.status, host.stderr).toBe(0);
		expect(readdirSync(join(E, "analysis")).sort()).toEqual(["HOST-SHA256SUMS", "export.tar"]);
		expect(readFileSync(join(E, "analysis/export.tar"), "utf8")).toBe(bytes);
	});
});
