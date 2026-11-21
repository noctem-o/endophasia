// DEVELOP-VERIFY-TRUST-004 (ENDO-13): live controls for the corrected reader, as guest root, after the post-read capture. Research only.
//
// Nothing here touches the genuine protected state. Control records are built from the PRE-READ ARCHIVE in a separate, root-made state
// root (/var/lib/trust004-control/state, owned like the real one), and read with the unchanged reader (TRUST-003 guest/reader.ts):
//   F1 false PASS      an incorrect candidate's authentic FAIL, rewritten to PASS and resealed: what a verifier defect would produce.
//                      Required: authentic PASS, binding valid, graded incorrect, reported as a false PASS, never confirmed.
//   F2 missing binding a genuine PASS naming a commit no repository holds. Required: binding unavailable, unconfirmed PASS.
//   F3 no sandbox      a genuine PASS graded with no bubblewrap. Required: grade incomplete, unconfirmed PASS.
//   F4 root-only repo  a genuine PASS whose only repository is root's (0700): Git acquisition runs as the agent, so it must fail to read
//                      it. Required: binding unavailable, unconfirmed PASS. (If Git ran with root's authority it would bind.)
//   F5 positive        a genuine PASS copy read normally. Required: confirmed. Shows the control state itself is readable.
//   G  grader probe    the unchanged gradeFiles on a probe candidate: staged files readable, not writable, grading identity, a detached
//                      descendant and both output budgets. Required: every case launched with confirmed termination and the listed
//                      outcomes; no process of the grading uid left afterwards.
//   node controls.ts <installDir> <pre-read capture dir> <trusted-read.json> <out.json> <agent workspace>...
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { seal } from "../../develop-verify-trust-002/service/verifier.ts";
import { gradeFiles, type Oracle, readRecord } from "../../develop-verify-trust-003/guest/reader.ts";

const [installDir, pre, liveRead, out, ...workspaces] = process.argv.slice(2);
if (installDir === undefined || pre === undefined || liveRead === undefined || out === undefined)
	throw new Error("usage: controls.ts <installDir> <pre dir> <trusted-read.json> <out.json> <workspace>...");
const id = (flag: string, user: string) =>
	Number(spawnSync("/usr/bin/id", [flag, user], { encoding: "utf8" }).stdout.trim());
const verifierUid = id("-u", "endo-verify-002");
const agent = { uid: id("-u", "endoagent"), gid: id("-g", "endoagent") };
if (!(verifierUid > 0 && agent.uid > 0 && agent.gid > 0)) throw new Error("identities unresolved");
const oracle = JSON.parse(readFileSync(join(installDir, "oracle/roman-numerals-cli/manifest.json"), "utf8")) as Oracle;
const repos = workspaces.flatMap((w) => readdirSync(join(w, "repos")).map((r) => join(w, "repos", r)));

// Source records come from the pre-read archive, not from the live state root.
const scratch = mkdtempSync("/root/trust004-controls-");
if (spawnSync("/usr/bin/tar", ["-xf", join(pre, "state.tar"), "-C", scratch, "endo-verify-002/records"]).status !== 0)
	throw new Error("cannot extract the pre-read state archive");
const archived = (inv: string) =>
	JSON.parse(readFileSync(join(scratch, "endo-verify-002/records", `${inv}.json`), "utf8")) as Record<string, any>;
const live = JSON.parse(readFileSync(liveRead, "utf8")) as { rows: Record<string, any>[] };
const incorrect = live.rows.find(
	(r) =>
		r.authenticity.authoritative &&
		r.authenticity.class === "FAIL" &&
		r.binding.status === "valid" &&
		r.grade.status === "graded" &&
		r.grade.correct === false,
);
const correct = live.rows.find((r) => r.confirmedPass === true);
if (incorrect === undefined || correct === undefined) throw new Error("no source records for the controls");

const base = "/var/lib/trust004-control";
const state = join(base, "state");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { mode: 0o755 });
for (const d of [state, join(state, "records"), join(state, "journal")]) {
	mkdirSync(d, { mode: 0o755 });
	chownSync(d, verifierUid, verifierUid);
}
const plant = (rec: Record<string, any>) => {
	const inv = randomBytes(16).toString("hex");
	rec.invocation = { ...rec.invocation, id: inv };
	delete rec.recordSha256;
	rec.recordSha256 = seal(rec);
	const f = join(state, "records", `${inv}.json`);
	writeFileSync(f, JSON.stringify(rec), { flag: "wx", mode: 0o644 });
	chownSync(f, verifierUid, verifierUid);
	chmodSync(f, 0o644);
	return inv;
};
const forged = archived(incorrect.invocation);
forged.verdict = "PASS";
forged.reason = null;
forged.cases = (forged.cases as Record<string, unknown>[]).map((c) => ({ ...c, matched: true }));
const F1 = plant(forged);
const absent = archived(correct.invocation);
absent.candidate = { ...absent.candidate, commit: "f".repeat(absent.candidate.commit.length) };
const F2 = plant(absent);
const F3 = plant(archived(correct.invocation));
const F4 = plant(archived(correct.invocation));
const F5 = plant(archived(correct.invocation));

const rootOnly = "/root/trust004-rootonly";
rmSync(rootOnly, { recursive: true, force: true });
mkdirSync(rootOnly, { mode: 0o700 });
for (const w of workspaces)
	spawnSync("/usr/bin/cp", ["-a", join(w, "repos"), join(rootOnly, w.split("/").pop() as string)]);
spawnSync("/usr/bin/chown", ["-R", "root:root", rootOnly]);
const rootRepos = readdirSync(rootOnly).flatMap((w) => readdirSync(join(rootOnly, w)).map((r) => join(rootOnly, w, r)));

const read = (invocation: string, extra: { repos?: string[]; bwrapCandidates?: string[] } = {}) =>
	readRecord({
		state,
		installDir,
		verifierUid,
		invocation,
		repos: extra.repos ?? repos,
		agent,
		oracle,
		bwrapCandidates: extra.bwrapCandidates,
	});
const summary = (r: Awaited<ReturnType<typeof read>>) => ({
	invocation: r.invocation,
	authenticity: r.authenticity,
	commit: r.commit,
	binding: { status: r.binding.status, reason: "reason" in r.binding ? r.binding.reason : null },
	grade: {
		status: r.grade.status,
		correct: "correct" in r.grade ? r.grade.correct : null,
		reason: "reason" in r.grade ? r.grade.reason : null,
		failing: "failing" in r.grade ? r.grade.failing : null,
	},
	confirmedPass: r.confirmedPass,
	falsePass: r.falsePass,
	unconfirmedPass: r.unconfirmedPass,
});
const authenticPass = (r: Awaited<ReturnType<typeof read>>) =>
	r.authenticity.authoritative && r.authenticity.class === "PASS";
const rows: Record<string, unknown>[] = [];
const control = async (
	name: string,
	source: string,
	p: Promise<Awaited<ReturnType<typeof read>>>,
	held: (r: Awaited<ReturnType<typeof read>>) => boolean,
) => {
	const r = await p;
	rows.push({ control: name, source, held: held(r), ...summary(r) });
};
await control(
	"F1 false PASS",
	incorrect.invocation,
	read(F1),
	(r) =>
		authenticPass(r) &&
		r.binding.status === "valid" &&
		r.grade.status === "graded" &&
		r.falsePass &&
		!r.confirmedPass &&
		!r.unconfirmedPass,
);
await control(
	"F2 missing binding",
	correct.invocation,
	read(F2),
	(r) =>
		authenticPass(r) && r.binding.status === "unavailable" && r.unconfirmedPass && !r.confirmedPass && !r.falsePass,
);
await control(
	"F3 no sandbox",
	correct.invocation,
	read(F3, { bwrapCandidates: ["/nonexistent/bwrap"] }),
	(r) =>
		authenticPass(r) &&
		r.binding.status === "valid" &&
		r.grade.status === "incomplete" &&
		r.unconfirmedPass &&
		!r.confirmedPass,
);
await control(
	"F4 root-only repository",
	correct.invocation,
	read(F4, { repos: rootRepos }),
	(r) => authenticPass(r) && r.binding.status === "unavailable" && r.unconfirmedPass && !r.confirmedPass,
);
await control("F5 positive", correct.invocation, read(F5), (r) => authenticPass(r) && r.confirmedPass);

// ---- G: the grader on a probe candidate ----
const probe =
	Buffer.from(`// TRUST-004 G probe. Each write mode prints the outcome and exits with its code (Amendment 13), so the export records which errno
// came back without the grader's stdout: 10 EROFS, 11 EACCES, 12 EPERM, 1 the write succeeded (prints WROTE), 2 any other errno.
import fs from "node:fs";
import { spawn } from "node:child_process";
const mode = process.argv[2];
const denied = (f) => { try { f(); console.log("WROTE"); process.exit(1); } catch (e) { console.log(e.code); process.exit({ EROFS: 10, EACCES: 11, EPERM: 12 }[e.code] ?? 2); } };
if (mode === "write-new") denied(() => fs.writeFileSync("/work/new.txt", "x"));
else if (mode === "write-existing") denied(() => fs.closeSync(fs.openSync("/work/probe.mjs", "r+")));
else if (mode === "chmod") denied(() => fs.chmodSync("/work/probe.mjs", 0o777));
else if (mode === "mkdir") denied(() => fs.mkdirSync("/work/d"));
else if (mode === "read-list") { fs.readFileSync("/work/probe.mjs"); console.log(fs.readdirSync("/work").join(",")); }
else if (mode === "identity") console.log(process.getuid(), process.getgid());
else if (mode === "descendant") { spawn("/usr/bin/sleep", ["300"], { detached: true, stdio: "ignore" }).unref(); for (;;) {} }
else if (mode === "stdout-flood") process.stdout.write("x".repeat(70000));
else if (mode === "stderr-flood") process.stderr.write("x".repeat(70000));
`);
const pf = [{ path: "probe.mjs", mode: "100644" as const, bytes: probe.length, sha256: "", content: probe }];
const k = (name: string, stdout: string, exitCode = 0) => ({
	name,
	argv: ["node", "probe.mjs", name],
	expect: { exitCode, stdout },
});
const probeOracle: Oracle = {
	timeoutMs: oracle.timeoutMs,
	maxOutputBytes: oracle.maxOutputBytes,
	cases: [
		k("write-new", "EROFS\n", 10),
		// stageFiles leaves probe.mjs 0444 and root-owned, and the grader runs as uid 65534. An O_RDWR open is refused by DAC (EACCES)
		// before the kernel reaches the read-only-mount check, so EROFS is unreachable here. chmod below still shows the read-only mount.
		k("write-existing", "EACCES\n", 11),
		k("chmod", "EROFS\n", 10),
		k("mkdir", "EROFS\n", 10),
		k("read-list", "probe.mjs\n"),
		k("identity", "65534 65534\n"),
		k("descendant", ""),
		k("stdout-flood", ""),
		k("stderr-flood", ""),
	],
};
const g = await gradeFiles(pf, probeOracle);
const census = spawnSync("/usr/bin/pgrep", ["-a", "-u", "65534"], { encoding: "utf8" });
const by = Object.fromEntries((g.cases ?? []).map((c) => [c.name, c]));
const want: Record<string, string> = {
	"write-new": "exited",
	"write-existing": "exited",
	chmod: "exited",
	mkdir: "exited",
	"read-list": "exited",
	identity: "exited",
	descendant: "timeout",
	"stdout-flood": "output-limit",
	"stderr-flood": "output-limit",
};
const grader = {
	status: g.status,
	reason: "reason" in g ? g.reason : null,
	// Each case's measured exit code and match beside its expectation: for a write mode the code names the errno (probe header).
	cases: g.cases.map((c) => ({ ...c, expect: probeOracle.cases.find((p) => p.name === c.name)?.expect ?? null })),
	leftover65534: census.stdout.trim(),
	held:
		g.cases.length === probeOracle.cases.length &&
		g.cases.every(
			(c) =>
				c.launched &&
				c.terminationConfirmed &&
				c.outcome === want[c.name] &&
				(want[c.name] !== "exited" || c.matched) &&
				(want[c.name] === "exited" || !c.matched),
		) &&
		census.status === 1,
	expectedOutcomes: want,
	matchedCases: Object.keys(by).filter((n) => by[n]?.matched),
};
rmSync(scratch, { recursive: true, force: true });
const result = {
	schemaVersion: "endo.research.dvt004.controls.v0",
	controlState: state,
	rootOnlyRepositories: rootOnly,
	rows,
	grader,
	allHeld: rows.every((r) => r.held === true) && grader.held,
};
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(
	JSON.stringify({ allHeld: result.allHeld, rows: rows.map((r) => [r.control, r.held]), grader: grader.held }),
);
process.exitCode = result.allHeld ? 0 : 1;
