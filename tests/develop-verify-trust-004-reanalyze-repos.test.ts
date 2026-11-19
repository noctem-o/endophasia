import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCandidate } from "../research/develop-verify-trust-002/service/objects.ts";
import { RECORD_SCHEMA, seal } from "../research/develop-verify-trust-002/service/verifier.ts";
import { acquireObjects } from "../research/develop-verify-trust-003/guest/reader.ts";
import { reanalyze } from "../research/develop-verify-trust-004/reanalyze.ts";

// End to end through reanalyze() on a synthetic pre-read capture: one authentic-shaped PASS record whose candidate is a real commit,
// and installed-1/repos/A arranged per case. Only binding and the repository note are asserted; grading depends on the host.
const INV = "0123456789abcdef0123456789abcdef";
const digest = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_AUTHOR_DATE: "2026-11-12T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-11-12T00:00:00Z",
};
const sh = (cmd: string, args: string[]) => {
	const r = spawnSync(cmd, args, { env: GIT_ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dvt004-repos-test-"));
});
afterEach(() => {
	spawnSync("chmod", ["-R", "u+rwX", root]);
	rmSync(root, { recursive: true, force: true });
});

function makeRepo(dir: string, format: "sha1" | "sha256", packed: boolean) {
	sh("git", ["init", "-q", "-b", "main", `--object-format=${format}`, dir]);
	writeFileSync(join(dir, "roman.mjs"), "console.log('I');\n");
	sh("git", ["-C", dir, "add", "-A"]);
	sh("git", ["-C", dir, "commit", "-q", "-m", "candidate"]);
	if (packed) sh("git", ["-C", dir, "gc", "-q", "--prune=now"]);
	return sh("git", ["-C", dir, "rev-parse", "HEAD"]);
}

async function candidateOf(repo: string, commit: string) {
	const got = await acquireObjects(repo, commit, null);
	if (!got.ok) throw new Error(got.reason);
	const r = resolveCandidate(got.objectFormat, commit, got.objects);
	if (!r.ok) throw new Error(r.reason);
	return {
		objectFormat: got.objectFormat,
		commit,
		tree: r.candidate.tree,
		exportSha256: r.candidate.exportSha256,
		files: r.candidate.files.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 })),
	};
}

interface Shape {
	ancestors?: readonly string[];
	record?: (recFile: string) => void;
	listedMode?: string;
	journals?: string[];
}

const ancestorRows = [
	"directory 0 0 755 20 /",
	"directory 0 0 755 10 /var",
	"directory 0 0 755 10 /var/lib",
	"directory 968 968 700 4 /var/lib/endo-verify-002",
	"directory 968 968 700 2 /var/lib/endo-verify-002/records",
	"directory 968 968 700 2 /var/lib/endo-verify-002/journal",
	"directory 0 0 755 10 /usr",
	"directory 0 0 755 10 /usr/local",
	"directory 0 0 755 10 /usr/local/lib",
	"directory 0 0 755 4 /usr/local/lib/endo-verify-002",
	"regular file 0 0 644 1 /usr/local/lib/endo-verify-002/installation.json",
];

async function analyse(candidate: Record<string, unknown>, place: (repos: string) => void, shape: Shape = {}) {
	const pre = join(root, "evidence/pre");
	mkdirSync(pre, { recursive: true });
	const inst = join(root, "inst/endo-verify-002");
	mkdirSync(join(inst, "oracle/roman-numerals-cli"), { recursive: true });
	const oracle = JSON.stringify({
		timeoutMs: 5000,
		maxOutputBytes: 4096,
		cases: [{ name: "one", argv: ["roman.mjs"], expect: { exitCode: 0, stdout: "I\n" } }],
	});
	writeFileSync(join(inst, "oracle/roman-numerals-cli/manifest.json"), oracle);
	const pin = {
		dir: "oracle/roman-numerals-cli",
		manifestSha256: digest(oracle),
		referenceSha256: "a".repeat(64),
		negativeSha256: "b".repeat(64),
	};
	const installation = JSON.stringify({ files: [], tasks: { "roman-numerals-cli": pin } });
	writeFileSync(join(inst, "installation.json"), installation);
	sh("tar", ["-cf", join(pre, "install.tar"), "-C", join(root, "inst"), "endo-verify-002"]);
	const rec: Record<string, unknown> = {
		schemaVersion: RECORD_SCHEMA,
		invocation: { id: INV },
		installation: { id: digest(installation) },
		verdict: "PASS",
		oracle: { task: "roman-numerals-cli", ...pin, cases: 1 },
		cases: [{ started: true, termination: "confirmed", matched: true }],
		qualification: { reference: "PASS", negative: "FAIL" },
		candidate,
	};
	rec.recordSha256 = seal(rec);
	const st = join(root, "st/endo-verify-002");
	mkdirSync(join(st, "records"), { recursive: true });
	mkdirSync(join(st, "journal"));
	const recFile = join(st, "records", `${INV}.json`);
	writeFileSync(recFile, JSON.stringify(rec));
	shape.record?.(recFile);
	for (const id of shape.journals ?? []) writeFileSync(join(st, "journal", `${id}.jsonl`), "{}\n");
	sh("tar", [
		"--numeric-owner",
		"--owner=968",
		"--group=968",
		"-cf",
		join(pre, "state.tar"),
		"-C",
		join(root, "st"),
		"endo-verify-002",
	]);
	const S = "/var/lib/endo-verify-002";
	const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
	writeFileSync(
		join(pre, "listing.txt"),
		[
			`d ${mode(st)} 968 968 4 0 0 0 1 ${S}`,
			`d ${mode(join(st, "records"))} 968 968 2 0 0 0 2 ${S}/records`,
			`f ${shape.listedMode ?? mode(recFile)} 968 968 1 0 0 0 3 ${S}/records/${INV}.json`,
		].join("\n"),
	);
	writeFileSync(
		join(pre, "principals.txt"),
		"endo-verify-002:x:968:968::/var/lib/endo-verify-002-home:/usr/bin/nologin\n",
	);
	writeFileSync(join(pre, "ancestors.txt"), `${(shape.ancestors ?? ancestorRows).join("\n")}\n`);
	for (const a of ["availability", "installed-1", "installed-2"]) {
		const base = join(root, `ws-${a}`);
		mkdirSync(join(base, "repos"), { recursive: true });
		if (a === "installed-1") place(join(base, "repos"));
		sh("tar", ["-cf", join(pre, `repos-${a}.tar`), "-C", base, "repos"]);
	}
	const names = readdirSync(pre).sort();
	writeFileSync(
		join(pre, "SHA256SUMS"),
		names.map((n) => `${digest(spawnSync("cat", [join(pre, n)]).stdout)}  ${n}\n`).join(""),
	);
	writeFileSync(join(root, "live.json"), '{"rows":[]}');
	const result = await reanalyze(join(root, "evidence"), join(root, "live.json"));
	return {
		row: result.rows.find((r) => r.invocation === INV) as Record<string, any>,
		repo: (result.repositories as Record<string, any>[]).find((n) => n.repo === "installed-1/A"),
		repositories: result.repositories as Record<string, any>[],
		rows: result.rows as Record<string, any>[],
		summary: result.summary,
	};
}

describe("TRUST-004 offline binding from archived repositories", () => {
	describe("protected ancestor metadata", () => {
		const inspect = async (ancestors: readonly string[]) =>
			(await analyse({}, () => {}, { ancestors })).row.authenticity;

		it("accepts the complete capture", async () => {
			expect(await inspect(ancestorRows)).toEqual({ class: "PASS", authoritative: true, reason: null });
		});

		it.each(ancestorRows)("requires the row: %s", async (row) => {
			expect(await inspect(ancestorRows.filter((r) => r !== row))).toMatchObject({
				authoritative: false,
				reason: `ancestor metadata: missing ${row.split(" ").at(-1)}`,
			});
		});

		it.each([
			["duplicate", [...ancestorRows, ancestorRows[0]], "duplicate /"],
			["invalid mode", ["directory 0 0 758 2 /", ...ancestorRows.slice(1)], "malformed row"],
			["invalid gid", ["directory 0 x 755 2 /", ...ancestorRows.slice(1)], "malformed row"],
			["invalid links", ["directory 0 0 755 -1 /", ...ancestorRows.slice(1)], "malformed row"],
			["absent", ["absent /", ...ancestorRows.slice(1)], "malformed row"],
			["wrong type", ["symbolic link 0 0 755 1 /", ...ancestorRows.slice(1)], "wrong type for /"],
			[
				"wrong manifest type",
				ancestorRows.map((r) => r.replace("regular file", "directory")),
				"wrong type for /usr/local/lib/endo-verify-002/installation.json",
			],
			["unexpected path", [...ancestorRows, "directory 0 0 755 2 /unexpected"], "unexpected /unexpected"],
			["root uid", ["directory 1500 0 755 2 /", ...ancestorRows.slice(1)], "wrong owner for /"],
			[
				"verifier uid",
				ancestorRows.map((r) => r.replace("968 968", "0 968")),
				"wrong owner for /var/lib/endo-verify-002",
			],
			["writable", ["directory 0 0 775 2 /", ...ancestorRows.slice(1)], "writable /"],
		] as const)("rejects %s", async (_, rows, reason) => {
			expect(await inspect(rows)).toMatchObject({ authoritative: false, reason: `ancestor metadata: ${reason}` });
		});
	});
	it.each([
		["sha1", false],
		["sha1", true],
		["sha256", false],
		["sha256", true],
	] as const)(
		"binds a valid %s repository (packed: %s) with its own object format",
		async (format, packed) => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, format, packed);
			const candidate = await candidateOf(repo, commit);
			const {
				row,
				repo: note,
				summary,
			} = await analyse(candidate, (repos) => cpSync(repo, join(repos, "A"), { recursive: true }));
			expect(row.authenticity).toMatchObject({ class: "PASS", authoritative: true });
			expect(row.binding).toMatchObject({ status: "valid", exportSha256: candidate.exportSha256 });
			expect(note).toMatchObject({ objectFormat: format, alternates: false });
			expect(summary.repositoriesRefused).toBe(0);
		},
		60_000,
	);

	it.each([false, true])(
		"refuses a repository whose configuration contradicts its objects (packed: %s)",
		async (packed) => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, "sha256", packed);
			const candidate = await candidateOf(repo, commit);
			const { row, repo: note } = await analyse(candidate, (repos) => {
				cpSync(repo, join(repos, "A"), { recursive: true });
				writeFileSync(join(repos, "A/.git/config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
			});
			expect(row.binding.status).not.toBe("valid");
			expect(row.confirmedPass).toBe(false);
			expect(row.unconfirmedPass).toBe(true);
			expect(note?.refused).toMatch(/is sha256, configuration declares sha1/);
		},
		60_000,
	);

	it("refuses a repository with a file where a fan-out directory belongs and still analyses the others", async () => {
		const repo = join(root, "candidate");
		const commit = makeRepo(repo, "sha1", false);
		const candidate = await candidateOf(repo, commit);
		const {
			row,
			repo: note,
			repositories,
			summary,
		} = await analyse(candidate, (repos) => {
			cpSync(repo, join(repos, "A"), { recursive: true });
			cpSync(repo, join(repos, "B"), { recursive: true });
			writeFileSync(join(repos, "B/.git/objects/ab"), "not a directory");
		});
		expect(note).toMatchObject({ objectFormat: "sha1" });
		expect(row.binding).toMatchObject({ status: "valid", exportSha256: candidate.exportSha256 });
		expect(summary.repositoriesRefused).toBe(1);
		expect(repositories.find((n) => n.repo === "installed-1/B")?.refused).toBe(
			"object format: objects/ab is not a directory",
		);
	}, 60_000);

	describe("record metadata and content", () => {
		const passing = async (shape: Shape) => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, "sha1", false);
			const candidate = await candidateOf(repo, commit);
			return analyse(candidate, (repos) => cpSync(repo, join(repos, "A"), { recursive: true }), shape);
		};

		it.each([
			["the archive is group- and other-writable while the listing says 644", "644", 0o666],
			["the listing says 666 while the archive is 644", "666", 0o644],
			["the listing and the archive disagree on a safe mode", "600", 0o644],
		])(
			"never trusts a record when %s",
			async (_, listedMode, archived) => {
				const { row } = await passing({ listedMode, record: (f) => chmodSync(f, archived) });
				expect(row.authenticity).toMatchObject({ authoritative: false, reason: "file-not-the-verifier's" });
				expect(row.confirmedPass).toBe(false);
			},
			60_000,
		);

		it("trusts a record whose listing and archive agree on a safe mode", async () => {
			const { row } = await passing({ listedMode: "640", record: (f) => chmodSync(f, 0o640) });
			expect(row.authenticity).toMatchObject({ class: "PASS", authoritative: true });
		}, 60_000);

		it("refuses a symbolically linked record without opening it", async () => {
			const outside = join(root, "outside-record.json");
			const { row } = await passing({
				record: (f) => {
					cpSync(f, outside);
					rmSync(f);
					symlinkSync(outside, f);
				},
			});
			expect(row.authenticity.class).toBe("UNKNOWN");
			expect(row.authenticity.authoritative).toBe(false);
			expect(row.authenticity.reason).toMatch(/not a regular file in the capture; not opened/);
			expect(row.confirmedPass).toBe(false);
		}, 60_000);

		it("refuses a malformed record and still reports the other invocations", async () => {
			const other = "fedcba9876543210fedcba9876543210";
			const result = await passing({ record: (f) => writeFileSync(f, "{"), journals: [other] });
			expect(result.row.authenticity).toMatchObject({ class: "UNKNOWN", authoritative: false });
			expect(result.row.authenticity.reason).toMatch(/^malformed-record: /);
			expect(result.rows.find((r) => r.invocation === other)?.authenticity.reason).toBe("journal-without-record");
		}, 60_000);
	});

	describe("commits that cannot be bound", () => {
		it("reports a retained commit whose objects cannot be read as unreadable, not as absent", async () => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, "sha1", false);
			const candidate = await candidateOf(repo, commit);
			const tree = sh("git", ["-C", repo, "rev-parse", "HEAD^{tree}"]);
			const { row, summary } = await analyse(candidate, (repos) => {
				cpSync(repo, join(repos, "A"), { recursive: true });
				rmSync(join(repos, "A/.git/objects", tree.slice(0, 2), tree.slice(2)));
			});
			expect(row.binding).toMatchObject({ status: "unavailable", reason: "commit-unreadable" });
			expect(row.binding.unreadable).toEqual(["installed-1-A: commit-unreadable"]);
			expect(summary.commitsUnreadable).toEqual([commit]);
			expect(summary.commitsWithoutObjects).toEqual([]);
			expect(row.confirmedPass).toBe(false);
		}, 60_000);

		it("reports a commit no retained repository holds as absent", async () => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, "sha1", false);
			const candidate = await candidateOf(repo, commit);
			const { row, summary } = await analyse(candidate, (repos) => sh("git", ["init", "-q", join(repos, "A")]));
			expect(row.binding).toMatchObject({ status: "unavailable", reason: "commit-not-found" });
			expect(summary.commitsWithoutObjects).toEqual([commit]);
			expect(summary.commitsUnreadable).toEqual([]);
		}, 60_000);

		it("counts unread and malformed records under UNKNOWN", async () => {
			const repo = join(root, "candidate");
			const commit = makeRepo(repo, "sha1", false);
			const candidate = await candidateOf(repo, commit);
			const { summary } = await analyse(candidate, (repos) => cpSync(repo, join(repos, "A"), { recursive: true }), {
				record: (f) => writeFileSync(f, "{"),
			});
			expect(summary.byClass.UNKNOWN).toBe(1);
		}, 60_000);
	});

	// Each layout leaves every retained object path empty: the commit is reachable only through a link out of the capture.
	const outside: [string, (repos: string, external: string) => void][] = [
		[
			"absolute fan-out directories",
			(repos, external) => {
				sh("git", ["init", "-q", join(repos, "A")]);
				for (const fan of readdirSync(join(external, ".git/objects")).filter((n) => /^[0-9a-f]{2}$/.test(n)))
					symlinkSync(join(external, ".git/objects", fan), join(repos, "A/.git/objects", fan));
			},
		],
		[
			"an objects directory",
			(repos, external) => {
				sh("git", ["init", "-q", join(repos, "A")]);
				rmSync(join(repos, "A/.git/objects"), { recursive: true });
				symlinkSync(join(external, ".git/objects"), join(repos, "A/.git/objects"));
			},
		],
		[
			"an intermediate .git component",
			(repos, external) => {
				mkdirSync(join(repos, "A"));
				symlinkSync(join(external, ".git"), join(repos, "A/.git"));
			},
		],
		[
			"a pack directory",
			(repos, external) => {
				sh("git", ["-C", external, "gc", "-q", "--prune=now"]);
				sh("git", ["init", "-q", join(repos, "A")]);
				rmSync(join(repos, "A/.git/objects/pack"), { recursive: true });
				symlinkSync(join(external, ".git/objects/pack"), join(repos, "A/.git/objects/pack"));
			},
		],
	];
	it.each(outside)(
		"never binds a PASS from objects reached through %s",
		async (_, place) => {
			const external = join(root, "outside-the-capture");
			const commit = makeRepo(external, "sha1", false);
			const candidate = await candidateOf(external, commit);
			const { row, repo: note, summary } = await analyse(candidate, (repos) => place(repos, external));
			expect(summary.refusedRepositoryArchives).toEqual(["repos-installed-1.tar"]);
			expect(row.authenticity).toMatchObject({ class: "PASS", authoritative: true });
			expect(row.binding.status).not.toBe("valid");
			expect(row.confirmedPass).toBe(false);
			expect(note?.refused).toMatch(/symbolic link/);
		},
		60_000,
	);
});
