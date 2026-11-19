// DEVELOP-VERIFY-TRUST-003 guest run, ENDO-11 amendment 1: the corrected independent analysis, reproduced offline from the retained
// guest artifacts only. Research only.
//
// The guest, its protected state root and the agent's repositories no longer exist. What remains: the verifier's own records and
// journals (guest-run/run/verifier-records.tar.gz, archived by uninstall.sh as root), the original trusted-reader output, and the
// committed fixtures. So, per invocation:
//   authenticity  the in-guest reader's historical observation (ownership cannot be re-observed offline), plus the record's content
//                 re-checked here against the installation rebuilt from the staged commit, whose digest must equal the one the guest
//                 inspected;
//   binding       the record's file list and export digest against bytes recovered only by SHA-256 match with committed fixtures (or
//                 the harness's deterministic Aslow variant of A); the commit and tree objects are gone, so commit-to-tree is not
//                 re-verifiable here, and an unrecovered file means unavailable, never a substitute;
//   correctness   those recovered bytes, graded by the corrected bounded grader (reader.ts).
//   node reanalyze.ts <guest-run dir> <out.json>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../develop-verify-trust-002/install/layout.ts";
import { exportDigest, type StagedFile } from "../../develop-verify-trust-002/service/objects.ts";
import { contentProblem } from "../../develop-verify-trust-002/service/records.ts";
import type { Installation } from "../../develop-verify-trust-002/service/verifier.ts";
import { bindFiles, gradeFiles, type Oracle, type RecordCandidate } from "./reader.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const STAGED_COMMIT = "c3718f1d20a0777742cb72d6a9dfd7a44ce938fa";
const GUEST_INSTALLATION_ID = "7802fb0ef678696f37627c83418398806a1f516ed1d3d74369204d00ca61a222";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export async function reanalyze(guestRun: string) {
	const scratch = mkdtempSync(join(tmpdir(), "trust003-reanalysis-"));
	try {
		const archive = join(guestRun, "run/verifier-records.tar.gz");
		if (sha256(readFileSync(archive)) !== "17e03b7bc3323775f6242d945b991df05f922da381e6a33681c820a53d4a1768")
			throw new Error("unexpected guest record archive");
		const untar = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", scratch]);
		if (untar.status !== 0) throw new Error(`cannot extract ${archive}`);
		// The installation, rebuilt from the staged commit's objects; it must be the one the guest inspected.
		const install = join(scratch, "install");
		build({
			commit: STAGED_COMMIT,
			out: install,
			mode: "installed",
			operatorUid: 1500,
			operatorHome: "/home/endoagent",
			repository: REPO,
		});
		const installationBytes = readFileSync(join(install, "installation.json"));
		const installationId = sha256(installationBytes);
		if (installationId !== GUEST_INSTALLATION_ID)
			throw new Error(`rebuilt installation ${installationId} is not the guest's`);
		const installation = JSON.parse(installationBytes.toString("utf8")) as Installation;
		const oracleBytes = readFileSync(join(install, "oracle/roman-numerals-cli/manifest.json"));
		const oracle = JSON.parse(oracleBytes.toString("utf8")) as Oracle;
		// Bytes known by content: every committed fixture file, and Aslow (rehearsal.ts: A behind a 4 s wait).
		const known = new Map<string, { content: Buffer; source: string }>();
		for (const root of [
			"research/develop-verify-trust/fixtures/candidates",
			"research/develop-verify-trust-002/fixtures/candidates",
		])
			for (const c of readdirSync(join(REPO, root)))
				for (const f of readdirSync(join(REPO, root, c), { recursive: true }) as string[]) {
					try {
						const content = readFileSync(join(REPO, root, c, f));
						known.set(sha256(content), { content, source: `${root}/${c}/${f}` });
					} catch {}
				}
		const a = readFileSync(join(REPO, "research/develop-verify-trust/fixtures/candidates/A/roman.mjs"), "utf8");
		const aslow = Buffer.from(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);\n${a}`);
		known.set(sha256(aslow), { content: aslow, source: "rehearsal.ts Aslow (A behind a 4 s wait)" });
		const historical = JSON.parse(readFileSync(join(guestRun, "run/trusted-read.json"), "utf8")) as {
			rows: { name: string; class: string; authoritative: boolean }[];
		};
		const seen = new Map(historical.rows.map((r) => [r.name.slice(0, 32), r]));
		const ids = new Set<string>();
		for (const n of readdirSync(join(scratch, "records")))
			if (/^[0-9a-f]{32}\.json$/.test(n)) ids.add(n.slice(0, 32));
		const journals = readdirSync(join(scratch, "journal"))
			.filter((n) => /^[0-9a-f]{32}\.jsonl$/.test(n))
			.map((n) => n.slice(0, 32));
		const rows = [];
		for (const id of [...new Set([...ids, ...journals])].sort()) {
			if (!ids.has(id)) {
				rows.push({ invocation: id, authenticity: { class: "INCOMPLETE", reason: "journal-without-record" } });
				continue;
			}
			const rec = JSON.parse(readFileSync(join(scratch, "records", `${id}.json`), "utf8")) as Record<
				string,
				unknown
			>;
			const past = seen.get(id);
			const authenticity = {
				class: rec.verdict as string,
				historicalAuthoritative: past !== undefined && past.class === rec.verdict && past.authoritative,
				offlineContentProblem: contentProblem(rec, installationId, installation),
				oracleManifestMatches:
					(rec.oracle as { manifestSha256?: string } | null)?.manifestSha256 === undefined
						? null
						: (rec.oracle as { manifestSha256?: string }).manifestSha256 === sha256(oracleBytes),
			};
			const candidate = rec.candidate as RecordCandidate | null;
			if (candidate === null || !Array.isArray(candidate.files)) {
				rows.push({
					invocation: id,
					authenticity,
					binding: { status: "not-applicable" },
					grade: { status: "not-applicable" },
				});
				continue;
			}
			const listed = candidate.files as { path: string; mode: "100644" | "100755"; bytes: number; sha256: string }[];
			const missing = listed.filter((f) => !known.has(f.sha256)).map((f) => f.path);
			if (missing.length > 0) {
				rows.push({
					invocation: id,
					authenticity,
					commit: candidate.commit,
					binding: { status: "unavailable", reason: `bytes not recoverable: ${missing.join(", ")}` },
					grade: { status: "not-applicable" },
				});
				continue;
			}
			const files: StagedFile[] = listed.map((f) => {
				const k = known.get(f.sha256) as { content: Buffer };
				return {
					path: f.path,
					mode: f.mode,
					bytes: k.content.length,
					sha256: sha256(k.content),
					content: k.content,
				};
			});
			const binding = bindFiles(candidate, files, exportDigest(files));
			const sources = listed.map((f) => `${f.path} <- ${known.get(f.sha256)?.source}`);
			const grade =
				binding.status === "valid"
					? await gradeFiles(binding.files, oracle)
					: { status: "not-applicable" as const };
			rows.push({
				invocation: id,
				authenticity,
				commit: candidate.commit,
				binding:
					binding.status === "valid" ? { status: "valid", exportSha256: binding.exportSha256, sources } : binding,
				grade: "cases" in grade ? { ...grade, cases: grade.cases.map(({ durationMs: _d, ...c }) => c) } : grade,
			});
		}
		type Row = (typeof rows)[number] & {
			authenticity: {
				class: string;
				historicalAuthoritative?: boolean | null;
				oracleManifestMatches?: boolean | null;
				offlineContentProblem?: string | null;
			};
			binding?: { status: string };
			grade?: { status: string; correct?: boolean | null };
		};
		const all = rows as Row[];
		const authenticPass = all.filter(
			(r) =>
				r.authenticity.class === "PASS" &&
				r.authenticity.historicalAuthoritative === true &&
				r.authenticity.oracleManifestMatches === true &&
				r.authenticity.offlineContentProblem === null,
		);
		const confirmed = authenticPass.filter(
			(r) => r.binding?.status === "valid" && r.grade?.status === "graded" && r.grade.correct === true,
		);
		const falsePasses = authenticPass.filter(
			(r) => r.binding?.status === "valid" && r.grade?.status === "graded" && r.grade.correct === false,
		);
		return {
			schemaVersion: "endo.research.dvt003.reanalysis.v0",
			source: {
				archive: relative(REPO, archive),
				archiveSha256: sha256(readFileSync(archive)),
				stagedCommit: STAGED_COMMIT,
				installationId,
				oracleManifestSha256: sha256(oracleBytes),
			},
			limits: [
				"ownership of the protected state root is the in-guest reader's historical observation; it cannot be re-observed offline",
				"commit and tree objects were not retained: the binding here is record file list and export digest against bytes recovered by SHA-256 match",
				"grading ran on the analysis host (bubblewrap, this host's node), not in the guest",
			],
			summary: {
				invocations: all.length,
				records: ids.size,
				incomplete: all.filter((r) => r.authenticity.class === "INCOMPLETE").length,
				offlineContentProblems: all.filter((r) => r.authenticity.offlineContentProblem).length,
				authenticPass: authenticPass.length,
				confirmedPass: confirmed.length,
				falsePasses: falsePasses.map((r) => r.invocation),
				unconfirmedPasses: authenticPass
					.filter((r) => !confirmed.includes(r) && !falsePasses.includes(r))
					.map((r) => r.invocation),
				bindingUnavailable: all.filter((r) => r.binding?.status === "unavailable").map((r) => r.invocation),
				correctButNotPass: all
					.filter(
						(r) => r.grade?.status === "graded" && r.grade.correct === true && r.authenticity.class !== "PASS",
					)
					.map((r) => `${r.invocation} ${r.authenticity.class}`),
			},
			rows: all,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [guestRun, out] = process.argv.slice(2);
	if (guestRun === undefined || out === undefined) throw new Error("usage: reanalyze.ts <guest-run dir> <out.json>");
	const result = await reanalyze(guestRun);
	writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
	console.log(JSON.stringify(result.summary, null, 1));
}
