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

describe("TRUST-004 OPERATOR.md frozen source check", () => {
	it.each(["matching", "moved", "missing", "short"])(
		"stages only the exact handoff commit: %s tag case",
		(scenario) => {
			const repo = join(root, "fixture.git");
			expect(shell('git init -q --bare "$REPO"', { REPO: repo }).status).toBe(0);
			const git = (args: string[], input?: string) => {
				const r = spawnSync("git", ["--git-dir", repo, ...args], { input, encoding: "utf8" });
				expect(r.status, r.stderr).toBe(0);
				return r.stdout.trim();
			};
			const fixtureCommit = (text: string) => {
				const blob = git(["hash-object", "-w", "--stdin"], text);
				const manifest = git(["hash-object", "-w", "--stdin"], `${sha(text)}  content\n`);
				const sub = git(["mktree"], `100644 blob ${manifest}\tFROZEN.sha256\n`);
				const tree = git(["mktree"], `100644 blob ${blob}\tcontent\n040000 tree ${sub}\tpins\n`);
				return git(
					["hash-object", "-w", "-t", "commit", "--stdin"],
					`tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
				);
			};
			const expected = fixtureCommit("reviewed");
			const tagged = scenario === "moved" ? fixtureCommit("different but self-consistent") : expected;
			const ref = "refs/tags/disposable-freeze";
			git(["update-ref", ref, tagged]);
			const source = blocks("1. Preconditions").find((b) => b.includes("git clone"));
			expect(source).toBeDefined();
			const w = join(root, "new-stage");
			const r = shell(`${source}\nprintf 'STAGING %s\\n' "$F"`, {
				W: w,
				T: "pins",
				ENDO_REPO: repo,
				FREEZE_REF: ref,
				F: ref,
				EXPECTED_FREEZE_COMMIT:
					scenario === "missing" ? "" : scenario === "short" ? expected.slice(0, 12) : expected,
			});
			if (scenario === "matching") {
				expect(r.status, r.stderr).toBe(0);
				expect(r.stdout).toContain(`STAGING ${expected}`);
			} else {
				expect(r.status, r.stdout + r.stderr).toBe(1);
				expect(r.stdout).not.toContain("STAGING");
				expect(r.stderr).toContain(
					scenario === "moved"
						? `tag resolves to ${tagged}, handoff requires ${expected}`
						: "full 40-hex commit ID",
				);
			}
		},
	);

	const line = () => {
		const source = blocks("1. Preconditions").find((b) => b.includes("git clone"));
		const found = source?.split("\n").find((l) => l.includes("FROZEN.sha256") && l.includes("sha256sum"));
		expect(found).toBeDefined();
		return found as string;
	};
	const tree = (files: Record<string, string>, manifest: string | null) => {
		const src = join(W, "src");
		mkdirSync(join(src, T), { recursive: true });
		for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
		if (manifest !== null) writeFileSync(join(src, T, "FROZEN.sha256"), manifest);
	};
	it.each([
		["every frozen file matches", { a: "a" }, `${sha("a")}  a\n`, 0],
		["a frozen file differs", { a: "changed" }, `${sha("a")}  a\n`, 1],
		["a frozen file is missing", {}, `${sha("a")}  a\n`, 1],
		["the manifest is missing", { a: "a" }, null, 1],
		["the manifest has a malformed line", { a: "a" }, `${sha("a")}  a\nnot a checksum line\n`, 1],
	])("continues only when every frozen file verifies: %s", (_, files, manifest, rc) => {
		tree(files, manifest);
		const r = shell(`${line()}\necho CONTINUED`, { W, T });
		expect(r.status, r.stderr).toBe(rc);
		expect(r.stdout.includes("CONTINUED")).toBe(rc === 0);
	});

	it("compares the plan's entry count with the staged manifest instead of quoting a number", () => {
		expect(doc).not.toMatch(/frozen-check all \d+ entries/);
		expect(line()).toBeDefined();
		const source = blocks("1. Preconditions").find((b) => b.includes("git clone")) as string;
		expect(source).toContain('wc -l < "$W/src/$T/FROZEN.sha256"');
		expect(doc).toContain(
			"`frozen-check all N entries match` with N equal to the count `wc -l` printed in section 1",
		);
	});
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
	it.each(["install", "truncate"])("stops preparation if %s fails", (command) => {
		const [setup] = blocks("5. Independent reanalysis");
		mkdirSync(E);
		writeFileSync(join(E, "export.tar"), raw);
		writeFileSync(join(W, "vm/stage.img"), "stage");
		const r = shell(`qemu-img() { :; }; ss() { :; }; ${command}() { return 42; }\n${setup}`, {
			W,
			W2,
			E,
			OLD: root,
		});
		expect(r.status).toBe(42);
		expect(existsSync(join(W2, "vm/con.in"))).toBe(false);
	});
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
		["unverified export", 0, 0, 0, false, 1, ["verified outer export MISSING"]],
		["extraction refusal", 2, 0, 0, false, 2, ["outer export INVALID"]],
		["nested input refusal", 0, 4, 0, false, 4, ["post-read capture MISSING", "pre-read archive intake INVALID"]],
		["failed analysis", 0, 0, 3, true, 3, ["post-read capture MISSING"]],
		[
			"analyzer produces no report",
			0,
			0,
			3,
			true,
			3,
			["post-read capture MISSING", "reanalyzer did not write a report"],
		],
		["successful analysis", 0, 0, 0, true, 0, []],
		["successful analysis without a post-read capture", 0, 0, 0, true, 1, ["post-read capture MISSING"]],
		["bad pre checksum", 0, 0, 0, false, 1, ["post-read capture MISSING", "pre-read capture INVALID"]],
		["bad post checksum", 0, 0, 0, true, 1, ["post-read capture INVALID"]],
		["partial post capture", 0, 0, 0, true, 1, ["post-read capture INVALID"]],
		["missing post manifest copy", 0, 0, 0, true, 1, ["post-read capture INVALID"]],
		["mismatching post manifest copy", 0, 0, 0, true, 1, ["post-read capture INVALID"]],
		["missing pre capture", 0, 0, 0, false, 1, ["post-read capture MISSING", "pre-read capture MISSING"]],
		["partial pre capture", 0, 0, 0, false, 1, ["post-read capture MISSING", "pre-read capture INVALID"]],
	] as const)("%s", (scenario, extract, preflight, analysis, runsAnalyzer, rc, issues) => {
		const source = join(root, "opt/trust004-source");
		const input = join(root, "analyst/input");
		mkdirSync(source, { recursive: true });
		mkdirSync(join(root, "opt/trust004-result"));
		const report = join(root, "opt/trust004-result/analysis.json");
		if (scenario !== "unverified export") writeFileSync(join(root, "opt/trust004-export.tar"), "dummy");
		const cap = join(input, "out/evidence/pre");
		mkdirSync(cap, { recursive: true });
		const manifest = `${sha("sample")}  sample\n`;
		writeFileSync(join(cap, "sample"), "sample");
		writeFileSync(join(cap, "SHA256SUMS"), manifest);
		writeFileSync(join(cap, "../pre.SHA256SUMS"), manifest);
		if (scenario === "bad pre checksum") writeFileSync(join(cap, "sample"), "wrong");
		if (scenario === "missing pre capture") {
			rmSync(cap, { recursive: true });
			rmSync(join(cap, "../pre.SHA256SUMS"));
		}
		if (scenario === "partial pre capture") rmSync(join(cap, "SHA256SUMS"));
		if (scenario === "partial post capture") mkdirSync(join(cap, "../post"));
		if (
			scenario === "successful analysis" ||
			scenario === "bad post checksum" ||
			scenario === "missing post manifest copy" ||
			scenario === "mismatching post manifest copy"
		) {
			mkdirSync(join(cap, "../post"));
			writeFileSync(join(cap, "../post/sample"), scenario === "bad post checksum" ? "wrong" : "sample");
			writeFileSync(join(cap, "../post/SHA256SUMS"), manifest);
			if (scenario !== "missing post manifest copy")
				writeFileSync(
					join(cap, "../post.SHA256SUMS"),
					scenario === "mismatching post manifest copy" ? "different" : manifest,
				);
		}
		const execution = guestBlock("runuser -u analyst");
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
		  echo ANALYZING
		  test "$#" = ${4 + issues.length - (scenario === "analyzer produces no report" ? 1 : 0)} || return 95
		  ${issues
				.slice(0, scenario === "analyzer produces no report" ? -1 : undefined)
				.map((issue, index) => `test "$${5 + index}" = "${issue}" || return 96`)
				.join("\n")}
		  ${scenario === "analyzer produces no report" ? "" : `printf '%s\\n' '${JSON.stringify({ evidenceIssues: issues, analysisRetained: true })}' > "$4"`}
		  return ${analysis}
		}
		`;
		const r = shell(`${stubs}
export -f python3 node
runuser() { /usr/bin/bash -euc "${"$"}{10}"; }
${execution}`);
		expect(r.status, r.stdout + r.stderr).toBe(rc);
		expect(r.stdout).toContain(`analyst command exit=${rc}`);
		expect(r.stdout.includes("PREFLIGHT")).toBe(runsAnalyzer || scenario === "nested input refusal");
		expect(r.stdout.includes("ANALYZING")).toBe(runsAnalyzer);
		if (runsAnalyzer) expect(r.stdout).toContain(`reanalyze exit=${analysis}`);
		const retained = JSON.parse(readFileSync(report, "utf8"));
		expect(retained.evidenceIssues).toEqual(issues);
		if (!runsAnalyzer || scenario === "analyzer produces no report") expect(retained.status).toBe("INCOMPLETE");
		else expect(retained.analysisRetained).toBe(true);
		if (scenario === "bad pre checksum" || scenario === "bad post checksum")
			expect(r.stdout).toContain("sample: FAILED");
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
