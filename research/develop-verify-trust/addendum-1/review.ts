// DEVELOP-VERIFY-TRUST-001, addendum 1: the adversarial review's reproducers (ADDENDUM.md). Exploratory and post hoc: none of this is
// preregistered, and none of it changes a recorded row. Each probe runs against the verifier as frozen for the recorded runs (5d508223f,
// identical to 9c8b6ff79 for verify.ts and run.sh) and, where a correction exists, against the corrected verifier of this revision.
//
//   node research/develop-verify-trust/addendum-1/review.ts run <new-empty-directory outside the repository>
//
// No model, no network, no privileged operation. Every candidate repository, marker and record is created inside the workspace.

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Oracle, readRecord } from "../verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY = resolve(HERE, "..");
const REPO = resolve(STUDY, "../..");
const FROZEN_COMMIT = "5d508223f839a083c2d6af27a17eae57a47be4c1";
const PIN = "3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31";
const UID = process.getuid?.() ?? 0;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function exec(
	command: string,
	args: readonly string[],
	env: Record<string, string>,
	cwd: string,
	timeoutMs = 120_000,
): SpawnSyncReturns<string> {
	return spawnSync(command, args, { env, cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 << 20 });
}

async function review(W: string): Promise<void> {
	if (existsSync(W) && readdirSync(W).length > 0) throw new Error(`${W} is not empty`);
	if (W === REPO || W.startsWith(`${REPO}/`)) throw new Error("the workspace must be outside the repository");
	for (let d = W; ; d = dirname(d)) {
		if (existsSync(join(d, "oracle", "manifest.json"))) throw new Error(`an oracle is reachable above ${W} at ${d}`);
		if (d === "/") break;
	}
	for (const d of ["home", "repos", "verifier", "out/records", "markers", "runs"])
		mkdirSync(join(W, d), { recursive: true });
	const out = join(W, "out");
	const sanitize = (s: string) =>
		s.split(W).join("<workspace>").split(REPO).join("<repository>").split(homedir()).join("<home>");
	const log = (line: string) => process.stdout.write(`${sanitize(line)}\n`);
	const base = { PATH: "/usr/bin", HOME: join(W, "home"), LANG: "C.UTF-8" };
	const bus = { XDG_RUNTIME_DIR: `/run/user/${UID}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${UID}/bus` };
	const gitEnv = {
		...base,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "DEVELOP-VERIFY-TRUST-001",
		GIT_AUTHOR_EMAIL: "study@example.invalid",
		GIT_AUTHOR_DATE: "2026-11-12T00:00:00Z",
		GIT_COMMITTER_NAME: "DEVELOP-VERIFY-TRUST-001",
		GIT_COMMITTER_EMAIL: "study@example.invalid",
		GIT_COMMITTER_DATE: "2026-11-12T00:00:00Z",
	};
	const git = (dir: string, args: string[], env: Record<string, string> = gitEnv) => {
		const r = exec("/usr/bin/git", ["-C", dir, ...args], env, W);
		if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${r.stderr}`);
		return r.stdout.trim();
	};

	// ---- the two verifiers: the frozen one, from Git objects, and this revision's (corrected) ----
	const frozen = join(W, "frozen");
	mkdirSync(frozen);
	const archive = exec(
		"/usr/bin/sh",
		[
			"-c",
			'/usr/bin/git -C "$1" archive "$2" adapters runtime protocol research/develop-verify-trust | /usr/bin/tar -x -C "$3"',
			"sh",
			REPO,
			FROZEN_COMMIT,
			frozen,
		],
		gitEnv,
		W,
	);
	if (archive.status !== 0) throw new Error(`archive: ${archive.stderr}`);
	const VERIFIERS = { frozen, corrected: REPO } as const;
	type Which = keyof typeof VERIFIERS | "modified";
	const roots: Record<Which, string> = { ...VERIFIERS, modified: join(W, "modified") };

	cpSync(join(STUDY, "oracle"), join(W, "verifier/oracle"), { recursive: true });
	const ORACLE = join(W, "verifier/oracle/manifest.json");
	const oracle = JSON.parse(readFileSync(ORACLE, "utf8")) as Oracle;
	const fixture = (c: string, f = "roman.mjs") => readFileSync(join(STUDY, "fixtures/candidates", c, f), "utf8");

	// ---- candidate repositories ----
	const repo = (name: string, files: Record<string, string>, ignore?: string): { dir: string; commit: string } => {
		const dir = join(W, "repos", name);
		mkdirSync(dir, { recursive: true });
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		if (ignore !== undefined) writeFileSync(join(dir, ".gitignore"), ignore);
		git(dir, ["init", "-q", "-b", "main"]);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", `candidate ${name}`]);
		return { dir, commit: git(dir, ["rev-parse", "HEAD"]) };
	};

	// ---- running the verifier ----
	const recordFile = (id: string, which: Which, mech: string) => join(W, "runs", `${id}-${which}-${mech}.json`);
	const launchArgs = (which: Which, mech: string, r: { dir: string }, commit: string, file: string) => [
		join(roots[which], "research/develop-verify-trust/run.sh"),
		"run",
		"--mechanism",
		mech,
		"--oracle",
		ORACLE,
		"--oracle-sha256",
		PIN,
		"--repo",
		r.dir,
		"--commit",
		commit,
		"--out",
		file,
	];
	const read = (file: string, commit?: string) =>
		readRecord(file, ORACLE, PIN, commit === undefined ? {} : { commit });
	const record = (file: string) =>
		existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
	const keep = (file: string, name: string) => {
		if (existsSync(file)) copyFileSync(file, join(out, "records", `${name}.json`));
	};
	const verify = (id: string, which: Which, mech: string, r: { dir: string }, commit: string) => {
		const file = recordFile(id, which, mech);
		const p = exec("/usr/bin/sh", launchArgs(which, mech, r, commit, file), { ...base, ...bus }, W, 180_000);
		const rec = record(file);
		keep(file, `${id}-${which}-${mech}`);
		return {
			file,
			verdict: (rec?.verdict as string | undefined) ?? `no record (exit ${p.status})`,
			reason: (rec?.reason as string | null | undefined) ?? null,
			reader: read(file),
			readerBound: read(file, commit),
			record: rec,
		};
	};
	const verifyAsync = (which: Which, mech: string, r: { dir: string }, commit: string, file: string) =>
		spawn("/usr/bin/sh", launchArgs(which, mech, r, commit, file), {
			env: { ...base, ...bus },
			cwd: W,
			stdio: "ignore",
		});

	// The truth for a probe: every oracle case, run directly on the host from the worktree, as the ordinary check would.
	const hostDirect = (dir: string) => {
		const failing: string[] = [];
		for (const c of oracle.cases) {
			const r = spawnSync("/usr/bin/node", c.argv.slice(1), { cwd: dir, env: base, timeout: 10_000 });
			if (r.status !== c.expect.exitCode || r.stdout.toString() !== c.expect.stdout) failing.push(c.name);
		}
		return { verdict: failing.length === 0 ? "PASS" : "FAIL", failing };
	};

	const probes: Record<string, unknown>[] = [];
	const add = (p: Record<string, unknown>) => {
		probes.push(p);
		log(`${String(p.id).padEnd(4)} ${JSON.stringify(p.summary)}`);
	};

	// ---- R0: baselines (both verifiers, A and B, sandbox) ----
	const A = repo("A", { "roman.mjs": fixture("A") });
	const B = repo("B", { "roman.mjs": fixture("B") });
	{
		const runs = {
			"frozen-A": verify("R0", "frozen", "sandbox", A, A.commit),
			"frozen-B": verify("R0b", "frozen", "sandbox", B, B.commit),
			"corrected-A": verify("R0", "corrected", "sandbox", A, A.commit),
			"corrected-B": verify("R0b", "corrected", "sandbox", B, B.commit),
		};
		add({
			id: "R0",
			title: "baselines: A and B under both verifiers (sandbox)",
			expected: { "frozen-A": "PASS", "frozen-B": "FAIL", "corrected-A": "PASS", "corrected-B": "FAIL" },
			summary: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.verdict])),
			detail: Object.fromEntries(
				Object.entries(runs).map(([k, v]) => [k, { reader: v.reader, bound: v.readerBound }]),
			),
		});
	}
	const frozenSources = (record(recordFile("R0b", "frozen", "sandbox"))?.controller as { sources: unknown }).sources;

	// ---- R1: replace objects. Commit B' is B's program; a replace ref makes Git show A's commit in its place. ----
	{
		const dir = join(W, "repos/replace");
		const b = repo("replace", { "roman.mjs": fixture("B") });
		writeFileSync(join(dir, "roman.mjs"), fixture("A"));
		git(dir, ["commit", "-q", "-am", "candidate A, as the replacement"]);
		const a = git(dir, ["rev-parse", "HEAD"]);
		git(dir, ["replace", b.commit, a]);
		const trueTree = git(dir, ["rev-parse", `${b.commit}^{tree}`], { ...gitEnv, GIT_NO_REPLACE_OBJECTS: "1" });
		const runs = {
			frozen: verify("R1", "frozen", "sandbox", b, b.commit),
			corrected: verify("R1", "corrected", "sandbox", b, b.commit),
		};
		add({
			id: "R1",
			title: "a replace ref in the candidate's repository substitutes the exported tree",
			truth: hostDirect(join(W, "repos/B")).verdict,
			summary: Object.fromEntries(
				Object.entries(runs).map(([k, v]) => [k, `${v.verdict} (bound reader ${v.readerBound.class})`]),
			),
			detail: {
				commit: b.commit,
				commitTree: trueTree,
				replacement: a,
				...Object.fromEntries(
					Object.entries(runs).map(([k, v]) => [
						k,
						{
							verdict: v.verdict,
							reason: v.reason,
							reader: v.reader,
							readerBound: v.readerBound,
							recordCommit: (v.record?.candidate as { commit?: string } | null)?.commit ?? null,
							recordTree: (v.record?.candidate as { tree?: string } | null)?.tree ?? null,
						},
					]),
				),
			},
		});
	}

	// ---- R2: lazy fetch. A partial clone missing B's blob, whose promisor remote's upload-pack is a command the repository names. ----
	{
		const src = repo("lazy-src", { "roman.mjs": fixture("B") });
		const hostPidNs = readlinkSync("/proc/self/ns/pid");
		const runs: Record<string, unknown> = {};
		for (const which of ["frozen", "corrected"] as const) {
			const dir = join(W, `repos/lazy-${which}`);
			git(W, ["init", "-q", "-b", "main", dir]);
			const tree = git(src.dir, ["rev-parse", "HEAD^{tree}"]);
			for (const [type, oid] of [
				["tree", tree],
				["commit", src.commit],
			] as const) {
				const raw = spawnSync("/usr/bin/git", ["-C", src.dir, "cat-file", type, oid], { env: gitEnv });
				const w = spawnSync("/usr/bin/git", ["-C", dir, "hash-object", "-t", type, "-w", "--stdin"], {
					env: gitEnv,
					input: raw.stdout,
				});
				if (w.stdout.toString().trim() !== oid) throw new Error(`lazy ${type}`);
			}
			const marker = join(W, "markers", `lazy-${which}`);
			for (const [k, v] of [
				["core.repositoryformatversion", "1"],
				["extensions.partialClone", "origin"],
				["remote.origin.url", src.dir],
				["remote.origin.promisor", "true"],
				[
					"remote.origin.uploadpack",
					`echo "pidns=$(readlink /proc/self/ns/pid) uid=$(id -u)" > ${marker}; git-upload-pack`,
				],
			])
				git(dir, ["config", k, v]);
			const v = verify("R2", which, "sandbox", { dir }, src.commit);
			const ran = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
			runs[which] = {
				verdict: v.verdict,
				reason: v.reason,
				commandRan: ran !== null,
				ranInHostPidNamespace: ran === null ? null : ran.includes(`pidns=${hostPidNs}`),
			};
		}
		add({
			id: "R2",
			title: "a promisor remote in the candidate's repository runs its command in the controller during export",
			summary: Object.fromEntries(
				Object.entries(runs).map(([k, v]) => [
					k,
					`${(v as { verdict: string }).verdict}; command ran: ${(v as { commandRan: boolean }).commandRan}`,
				]),
			),
			detail: runs,
		});
	}

	// ---- R3: a concurrent same-user process replaces the staged export after the verifier checked it (no verifier change) ----
	{
		const runs: Record<string, unknown> = {};
		for (const which of ["frozen", "corrected"] as const) {
			const file = recordFile("R3", which, "sandbox");
			const staged = `${file}.work/candidate/roman.mjs`;
			const child = verifyAsync(which, "sandbox", B, B.commit, file);
			const exited = new Promise((r) => child.once("exit", r));
			let swappedAtMs: number | null = null;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline && swappedAtMs === null) {
				if (existsSync(staged)) {
					writeFileSync(`${staged}.swap`, fixture("A"), { mode: 0o444 });
					renameSync(`${staged}.swap`, staged);
					swappedAtMs = Date.now();
				} else await sleep(2);
			}
			await exited;
			keep(file, `R3-${which}-sandbox`);
			const rec = record(file);
			const recorded = (rec?.candidate as { files?: { path: string; sha256: string }[] } | null)?.files?.find(
				(f) => f.path === "roman.mjs",
			);
			runs[which] = {
				swapped: swappedAtMs !== null,
				verdict: rec?.verdict ?? null,
				readerBound: read(file, B.commit),
				recordedSha256IsB: recorded?.sha256 === sha256(fixture("B")),
			};
		}
		add({
			id: "R3",
			title: "the staged export is replaced by a same-user process during the run",
			truth: "FAIL (commit B)",
			summary: Object.fromEntries(
				Object.entries(runs).map(([k, v]) => [k, `${(v as { verdict: string }).verdict} (swapped)`]),
			),
			detail: runs,
		});
	}

	// ---- R4: an edited verifier that substitutes the expected output and reports the frozen source digests. R4a edits every phase;
	// R4b only the candidate phase, so that qualification (the reference passes, the negative fails) still holds. ----
	for (const [id, guard] of [
		["R4a", "true"],
		["R4b", 'phase === "candidate"'],
	] as const) {
		const modified = roots.modified;
		rmSync(modified, { recursive: true, force: true });
		cpSync(frozen, modified, { recursive: true });
		const file = join(modified, "research/develop-verify-trust/verify.ts");
		const src = readFileSync(file, "utf8");
		const edited = src
			.replace(
				"\t\tstdout = run.stdout;\n",
				`\t\tstdout = run.stdout;\n\t\tif (${guard}) {\n\t\t\tstdout = expected;\n\t\t\tObject.assign(run, { stdout: expected, exitCode: c.expect.exitCode });\n\t\t}\n`,
			)
			.replace(
				".map((f) => ({ path: relative(REPOSITORY, f), sha256: sha256(readFileSync(f)) }))",
				`.map((f) => ({ path: relative(REPOSITORY, f), sha256: sha256(readFileSync(f.replace(${JSON.stringify(modified)}, ${JSON.stringify(frozen)}))) }))`,
			);
		if (edited.split("Object.assign(run").length !== 2 || edited.split(JSON.stringify(frozen)).length !== 2)
			throw new Error(`${id} edit did not apply`);
		writeFileSync(file, edited);
		const v = verify(id, "modified", "sandbox", B, B.commit);
		const sources = (v.record?.controller as { sources: unknown } | undefined)?.sources;
		const committed = JSON.parse(readFileSync(join(STUDY, "results/run-1/records/2-sandbox.json"), "utf8")) as {
			controller: { sources: unknown };
		};
		add({
			id,
			title: `an edited verifier (output substituted when ${guard}) reports the frozen verifier's source digests`,
			truth: "FAIL (commit B)",
			summary: { modified: `${v.verdict}${v.reason ? ` ${v.reason}` : ""} (bound reader ${v.readerBound.class})` },
			detail: {
				verdict: v.verdict,
				reason: v.reason,
				qualification: v.record?.qualification ?? null,
				reader: v.reader,
				readerBound: v.readerBound,
				sourcesEqualFrozenRun: JSON.stringify(sources) === JSON.stringify(frozenSources),
				sourcesEqualCommittedRecord: JSON.stringify(sources) === JSON.stringify(committed.controller.sources),
				editedVerifySha256: sha256(edited),
			},
		});
	}

	// ---- R5: replay. A genuine PASS record of A, presented as the record for B ----
	{
		const file = recordFile("R0", "corrected", "sandbox");
		add({
			id: "R5",
			title: "a genuine PASS for A, read as the record for B",
			summary: {
				unbound: read(file).class,
				boundToB: read(file, B.commit).class,
				boundToA: read(file, A.commit).class,
			},
			detail: { unbound: read(file), boundToB: read(file, B.commit), boundToA: read(file, A.commit) },
		});
	}

	// ---- R6: interruption, observed live: the scope's processes before and after a SIGKILL of the verifier ----
	{
		const D = repo("D", { "roman.mjs": fixture("D") });
		const file = recordFile("R6", "corrected", "sandbox");
		const journal = () => (existsSync(`${file}.journal`) ? readFileSync(`${file}.journal`, "utf8") : "");
		const child = verifyAsync("corrected", "sandbox", D, D.commit, file);
		const exited = new Promise((r) => child.once("exit", r));
		let unit: string | null = null;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && unit === null) {
			unit =
				/"phase":"candidate","case":"max-3999","unit":"(endo-sandbox-[0-9a-f]{24})"/.exec(journal())?.[1] ?? null;
			if (unit === null) await sleep(20);
		}
		await sleep(1_000);
		const show = (u: string) =>
			Object.fromEntries(
				exec(
					"/usr/bin/systemctl",
					[
						"--user",
						"show",
						`${u}.scope`,
						"-p",
						"LoadState",
						"-p",
						"ActiveState",
						"-p",
						"ControlGroup",
						"--no-pager",
					],
					{ PATH: "/usr/bin", ...bus },
					W,
				)
					.stdout.trim()
					.split("\n")
					.map((l) => l.split(/=(.*)/s).slice(0, 2)),
			) as Record<string, string>;
		const stat = (pid: number) => {
			try {
				const s = readFileSync(`/proc/${pid}/stat`, "utf8");
				const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
				return { comm: s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")), start: rest[19] ?? null };
			} catch {
				return null;
			}
		};
		const before = unit === null ? null : show(unit);
		const cgroup = before?.ControlGroup ? join("/sys/fs/cgroup", before.ControlGroup) : null;
		const pids =
			cgroup !== null && existsSync(join(cgroup, "cgroup.procs"))
				? readFileSync(join(cgroup, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean).map(Number)
				: [];
		const identities = pids.map((pid) => ({ pid, ...stat(pid) }));
		const killedAtMs = Date.now();
		child.kill("SIGKILL");
		await exited;
		await sleep(3_000);
		const after = unit === null ? null : show(unit);
		const survivors = identities.filter((p) => {
			const now = stat(p.pid);
			return now !== null && now.start === p.start;
		});
		// Any process on the host still running the candidate's code, by its command line inside the sandbox.
		const stray = readdirSync("/proc")
			.filter((d) => /^\d+$/.test(d))
			.filter((d) => {
				try {
					return readFileSync(`/proc/${d}/cmdline`, "utf8").includes("roman.mjs\u00003999");
				} catch {
					return false;
				}
			});
		if (existsSync(`${file}.journal`))
			copyFileSync(`${file}.journal`, join(out, "records", "R6-corrected-sandbox.journal"));
		add({
			id: "R6",
			title: "SIGKILL of the verifier during the hanging case, with the scope's processes observed before and after",
			summary: {
				reader: read(file).class,
				scopeBefore: before === null ? null : `${before.LoadState}/${before.ActiveState}`,
				processesBefore: identities.map((p) => p.comm),
				scopeAfter: after === null ? null : `${after.LoadState}/${after.ActiveState}`,
				survivors: survivors.length,
				strayCandidateProcesses: stray.length,
			},
			detail: {
				unit,
				killedAtMs,
				before,
				identities,
				cgroupExistsAfter: cgroup === null ? null : existsSync(cgroup),
				after,
				survivors,
				stray: stray.length,
				reader: read(file),
			},
		});
	}

	// ---- R7: legitimate programs. A's code behind one ordinary Node operation each ----
	{
		const impl = fixture("A");
		const wrap = (side: string) => `${side}\nawait import("./impl.mjs");\n`;
		const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`data/${i}.txt`, `${i}\n`]));
		const probesX: [string, string, Record<string, string>, string?][] = [
			[
				"X1",
				"writes a cache file in its working directory",
				{ "roman.mjs": wrap(`import { writeFileSync } from "node:fs";\nwriteFileSync(".cache.json", "{}");`) },
			],
			[
				"X2",
				"runs /bin/sh as a child process",
				{
					"roman.mjs": wrap(
						`import { execFileSync } from "node:child_process";\nexecFileSync("/bin/sh", ["-c", "exit 0"]);`,
					),
				},
			],
			[
				"X3",
				"imports an installed but uncommitted dependency",
				{ "roman.mjs": wrap(`await import("dep");`), "package.json": '{"type":"module"}\n' },
				"node_modules/\n",
			],
			[
				"X4",
				"imports a committed (vendored) dependency",
				{
					"roman.mjs": wrap(`await import("dep");`),
					"package.json": '{"type":"module"}\n',
					"node_modules/dep/package.json": '{"name":"dep","type":"module","exports":"./index.js"}\n',
					"node_modules/dep/index.js": "export const ok = true;\n",
				},
			],
			["X5", "reads os.userInfo()", { "roman.mjs": wrap(`import { userInfo } from "node:os";\nuserInfo();`) }],
			[
				"X6",
				"writes 20 MiB to os.tmpdir()",
				{
					"roman.mjs": wrap(
						`import { writeFileSync, rmSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nconst f = join(tmpdir(), "x" + process.pid);\nwriteFileSync(f, Buffer.alloc(20 << 20));\nrmSync(f);`,
					),
				},
			],
			["X7", "commits 300 data files", { "roman.mjs": impl, ...many }],
			[
				"X8",
				"spawns a worker thread",
				{
					"roman.mjs": wrap(
						`import { Worker } from "node:worker_threads";\nawait new Promise((ok, no) => new Worker("process.exit(0)", { eval: true }).once("exit", ok).once("error", no));`,
					),
				},
			],
		];
		for (const [id, title, files, ignore] of probesX) {
			const r = repo(`compat-${id}`, { "impl.mjs": impl, ...files }, ignore);
			if (id === "X3") {
				mkdirSync(join(r.dir, "node_modules/dep"), { recursive: true });
				writeFileSync(
					join(r.dir, "node_modules/dep/package.json"),
					'{"name":"dep","type":"module","exports":"./index.js"}\n',
				);
				writeFileSync(join(r.dir, "node_modules/dep/index.js"), "export const ok = true;\n");
			}
			const host = hostDirect(r.dir);
			const f = verify(id, "corrected", "filtered", r, r.commit);
			const s = verify(id, "corrected", "sandbox", r, r.commit);
			const failing = (v: typeof s) =>
				((v.record?.cases as { name: string; matched: boolean; stderrHead: string }[] | undefined) ?? [])
					.filter((c) => !c.matched)
					.map((c) => c.name);
			const firstError = (v: typeof s) =>
				((v.record?.cases as { matched: boolean; stderrHead: string }[] | undefined) ?? [])
					.find((c) => !c.matched)
					?.stderrHead.split("\n")
					.find((l) => /Error|error:|ERR_|ENO|EROFS/.test(l))
					?.slice(0, 160) ?? null;
			add({
				id,
				title,
				summary: { hostDirect: host.verdict, F: f.verdict, S: s.verdict },
				detail: {
					hostDirect: host,
					F: { verdict: f.verdict, reason: f.reason, failing: failing(f), firstError: firstError(f) },
					S: { verdict: s.verdict, reason: s.reason, failing: failing(s), firstError: firstError(s) },
				},
			});
		}
	}

	const results = {
		study: "DEVELOP-VERIFY-TRUST-001 addendum 1 (exploratory, post hoc)",
		frozenCommit: FROZEN_COMMIT,
		pin: PIN,
		host: { node: process.version, kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim() },
		probes,
	};
	writeFileSync(join(out, "results.json"), `${sanitize(JSON.stringify(results, null, 2))}\n`);
	rmSync(roots.modified, { recursive: true, force: true });
	log(`results: ${join(out, "results.json")}`);
}

const [command, dir] = process.argv.slice(2);
if (command === "run" && dir !== undefined) await review(resolve(dir));
else {
	process.stderr.write("usage: review.ts run <new-empty-directory>\n");
	process.exitCode = 64;
}
