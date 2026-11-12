// DEVELOP-VERIFY-TRUST-002: the experiment harness (PROTOCOL.md §5). Research only.
//
//   node rehearsal.ts run <workspace> --commit <frozen commit> [--repository <dir>] [--target rehearsal|installed]
//
// Rehearsal (this phase): it builds the installation from the frozen commit into the workspace, renders the same units as the installed
// phase into the operator's runtime unit directory ($XDG_RUNTIME_DIR/systemd/user, removed at the end), and runs the matrix as the
// operator's uid against that socket. The verifier, the attacker and the reader share one uid, so every record must read
// non-authoritative, and every positive control must succeed at its tampering step.
//
// Installed (not run in this phase; INSTALL-PLAN.md): the same matrix against the installed socket, as the operator's uid. Rows that need
// root's configuration (T11b to d) are not applicable there, and the positive controls are expected to fail.
//
// The harness never uses sudo, never changes system configuration, and removes everything it added to the user manager.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import { audit } from "./audit.ts";
import { collectObjects, encodeRequest, GIT_ENV, send } from "./client/client.ts";
import { build, INSTALLED, renderUnits, TASK } from "./install/layout.ts";
import { type ObjectType, objectId, resolveCandidate } from "./service/objects.ts";
import { consumerVerdict, readAuthoritative } from "./service/records.ts";
import { seal } from "./service/verifier.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(HERE, "../..");
const V1 = join(REPO, "research/develop-verify-trust");
const F1_HOOK = join(REPO, "research/develop-validation/fixtures/env-hook.mjs");
const UID = process.getuid?.() ?? -1;
const UNIT = "endo-dvt002-rehearsal";
/** A uid that is neither this user nor root, to show what rule 2 says about the rehearsal's own files (THREAT-MODEL §6). */
const FICTIONAL_VERIFIER_UID = 61234;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
	id: string;
	title: string;
	expected: string;
	observed: string;
	held: boolean;
	positiveControl: boolean;
	detail: Record<string, unknown>;
}

function exec(
	cmd: string,
	args: readonly string[],
	options: { env?: Record<string, string>; cwd?: string; input?: Buffer } = {},
) {
	return spawnSync(cmd, [...args], {
		env: options.env ?? GIT_ENV,
		cwd: options.cwd,
		input: options.input,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16 << 20,
	});
}
const git = (dir: string, args: string[]) => {
	const r = exec("/usr/bin/git", ["-C", dir, ...args], {
		env: {
			...GIT_ENV,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
			GIT_AUTHOR_DATE: "2026-11-12T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-11-12T00:00:00Z",
		},
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const errCode = (f: () => unknown): string => {
	try {
		f();
		return "ok";
	} catch (e) {
		return String((e as NodeJS.ErrnoException).code ?? "error");
	}
};

// ---- the run ----------------------------------------------------------------------------------------------------------------------------

async function run(W: string, argv: readonly string[]): Promise<number> {
	const arg = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
	const commit = arg("--commit") ?? "";
	const repository = resolve(arg("--repository") ?? REPO);
	const target = arg("--target") === "installed" ? "installed" : "rehearsal";
	const dev = argv.includes("--dev");
	if (!dev && !/^[0-9a-f]{40}$/.test(commit))
		throw new Error("--commit must be a full commit id (a recorded trial is built from a commit)");
	if (existsSync(W)) throw new Error(`${W} exists`);
	mkdirSync(W, { recursive: true });
	for (const d of ["repos", "attacker", "markers", "variants"]) mkdirSync(join(W, d));
	const log = (line: string) => {
		appendFileSync(join(W, "rehearsal.log"), `${line}\n`);
		process.stdout.write(`${line}\n`);
	};
	const wallStart = Date.now();

	// -- the installation and the units --
	const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${UID}`;
	let install: string;
	let state: string;
	let socket: string;
	let verifierUid: number;
	const unitDir = join(runtimeDir, "systemd/user");
	const added: string[] = [];
	const systemctl = (...a: string[]) =>
		exec("/usr/bin/systemctl", ["--user", ...a], { env: { ...process.env } as Record<string, string> });
	if (target === "rehearsal") {
		install = join(W, "install");
		state = join(W, "state");
		socket = join(runtimeDir, "endo-dvt002", `${randomBytes(4).toString("hex")}.sock`);
		mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
		// The installed phase's tmpfiles.d entry creates the state directory; the unit's WorkingDirectory needs it.
		mkdirSync(state, { mode: 0o755 });
		build({
			commit: dev ? "worktree" : commit,
			out: install,
			mode: "rehearsal",
			operatorUid: UID,
			operatorHome: homedir(),
			repository,
		});
		mkdirSync(unitDir, { recursive: true });
		for (const [name, text] of Object.entries(
			renderUnits({ install, state, socket, unit: UNIT, conditionUser: null }),
		)) {
			if (existsSync(join(unitDir, name))) throw new Error(`${name} already exists in ${unitDir}`);
			writeFileSync(join(unitDir, name), text);
			added.push(join(unitDir, name));
		}
		systemctl("daemon-reload");
		const started = systemctl("start", `${UNIT}.socket`);
		if (started.status !== 0) throw new Error(`socket did not start: ${started.stderr}`);
		verifierUid = UID;
	} else {
		// Gate IP0 (PROTOCOL.md §6): H0 from this very session, before anything else.
		const h0 = audit(true);
		writeFileSync(join(W, "audit.json"), `${JSON.stringify(h0, null, 2)}\n`);
		if (!h0.h0) {
			log(`IP0: H0 does not hold in this session; no trial runs. ${JSON.stringify(h0.checks.filter((c) => !c.ok))}`);
			return 3;
		}
		install = INSTALLED.install;
		state = INSTALLED.state;
		socket = INSTALLED.socket;
		const id = exec("/usr/bin/id", ["-u", INSTALLED.user], { env: { PATH: "/usr/bin" } });
		if (id.status !== 0) throw new Error("the verifier principal does not exist: nothing is installed");
		verifierUid = Number(id.stdout.trim());
	}
	const installationId = sha256(readFileSync(join(install, "installation.json")));
	log(`DEVELOP-VERIFY-TRUST-002 ${target} run; installation ${installationId}; commit ${commit || "worktree"}`);

	const dropIn = (name: string, text: string) => {
		const dir = join(unitDir, `${UNIT}@.service.d`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.conf`), text);
		added.push(join(dir, `${name}.conf`));
		systemctl("daemon-reload");
	};
	const removeDropIns = () => {
		rmSync(join(unitDir, `${UNIT}@.service.d`), { recursive: true, force: true });
		systemctl("daemon-reload");
	};

	const rows: Row[] = [];
	const records = new Map<string, string>(); // name -> sha256, for the never-overwritten check
	const overwritten: string[] = [];
	const snapshot = (exclude: readonly string[] = []) => {
		for (const n of readdirSync(join(state, "records"))) {
			if (!n.endsWith(".json") || exclude.includes(n)) continue;
			const h = sha256(readFileSync(join(state, "records", n)));
			const was = records.get(n);
			if (was !== undefined && was !== h) overwritten.push(n);
			records.set(n, h);
		}
	};
	const row = (r: Omit<Row, "held"> & { held?: boolean }, held: boolean) => {
		const full = { ...r, held } as Row;
		rows.push(full);
		log(`${held ? "held  " : "BROKEN"} ${r.id}: ${r.observed}   (expected ${r.expected})`);
		snapshot(forged);
	};
	const forged: string[] = [];
	/** Commits whose candidate is correct (A, P): an authoritative PASS for any other commit is a false PASS (IA3). */
	const correctCommits = new Set<string>();

	try {
		// -- fixtures: ground truth and repositories --
		const oracle = JSON.parse(readFileSync(join(V1, "oracle/manifest.json"), "utf8")) as {
			cases: { name: string; argv: string[]; expect: { exitCode: number; stdout: string } }[];
		};
		const fixtureDir = (c: string) =>
			["S", "X", "M"].includes(c) ? join(HERE, "fixtures/candidates", c) : join(V1, "fixtures/candidates", c);
		const truth: Record<string, { correct: boolean; failing: string[]; stderrBytesMax: number }> = {};
		for (const c of ["A", "B", "D", "E", "P", "S", "X", "M"]) {
			const failing: string[] = [];
			let stderrMax = 0;
			for (const k of oracle.cases) {
				const tmp = join(W, "truth", `${c}-${k.name}`);
				cpSync(fixtureDir(c), tmp, { recursive: true });
				const r = spawnSync("/usr/bin/node", k.argv.slice(1), {
					cwd: tmp,
					env: { PATH: "/usr/bin", HOME: tmp },
					timeout: 5_000,
					maxBuffer: 8 << 20,
				});
				stderrMax = Math.max(stderrMax, r.stderr?.length ?? 0);
				if (r.status !== k.expect.exitCode || r.stdout?.toString("utf8") !== k.expect.stdout) failing.push(k.name);
			}
			truth[c] = { correct: failing.length === 0, failing, stderrBytesMax: stderrMax };
		}
		rmSync(join(W, "truth"), { recursive: true, force: true });
		log(
			`truth: ${JSON.stringify(Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, v.correct ? "correct" : `incorrect(${v.failing.length})`])))}`,
		);
		const repo = (name: string, from: string, extra?: (dir: string) => void) => {
			const dir = join(W, "repos", name);
			cpSync(from, dir, { recursive: true });
			git(dir, ["init", "-q", "-b", "main"]);
			extra?.(dir);
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-q", "-m", name]);
			return { dir, commit: git(dir, ["rev-parse", "HEAD"]) };
		};
		const R: Record<string, { dir: string; commit: string }> = {};
		for (const c of ["A", "B", "D", "E", "P", "S", "X", "M"]) R[c] = repo(c, fixtureDir(c));
		R.L = repo("L", fixtureDir("A"), (d) => symlinkSync("roman.mjs", join(d, "link.mjs")));
		// Installed target only (review V2): A, but 4 s per case, so that an operator has time to interrupt it by hand (about 60 s).
		R.Aslow = repo("Aslow", fixtureDir("A"), (d) => {
			const f = join(d, "roman.mjs");
			writeFileSync(
				f,
				`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);\n${readFileSync(f, "utf8")}`,
			);
		});

		const objectsOf = (r: { dir: string; commit: string }) => {
			const got = collectObjects(r.dir, r.commit);
			if (!got.ok) throw new Error(`collect ${r.dir}: ${got.reason}`);
			return got;
		};
		const requestFor = (r: { dir: string; commit: string }, extra: Record<string, unknown> = {}) => {
			const o = objectsOf(r);
			return encodeRequest(TASK, o.objectFormat, r.commit, o.objects, extra);
		};
		const exportOf = (r: { dir: string; commit: string }) => {
			const o = objectsOf(r);
			const c = resolveCandidate(o.objectFormat, r.commit, o.objects);
			if (!c.ok) throw new Error(c.reason);
			return c.candidate.exportSha256;
		};
		const read = (invocation: string, expect?: { commit?: string; exportSha256?: string }) =>
			readAuthoritative({
				state,
				installDir: install,
				verifierUid,
				invocation,
				...(expect === undefined ? {} : { expect }),
			});
		/** Submit, then read the record back by its invocation: the response's verdict, the record's class and authority. */
		const submit = async (bytes: Buffer, options: { hangUp?: boolean } = {}) => {
			const got = await send(socket, bytes, options);
			if (!got.ok)
				return {
					verdict: "BLOCKED",
					reason: got.reason,
					invocation: null as string | null,
					class: null as string | null,
					authoritative: false,
					readReason: null as string | null,
				};
			const inv = (got.response?.invocation as string | undefined) ?? null;
			const r = inv === null ? null : read(inv);
			return {
				verdict: (got.response?.verdict as string | undefined) ?? "none",
				reason: (got.response?.reason as string | null | undefined) ?? null,
				invocation: inv,
				class: r?.class ?? null,
				authoritative: r?.authoritative ?? false,
				readReason: r?.reason ?? null,
				record: r?.record,
			};
		};
		const authOk = (authoritative: boolean, wantAuth: boolean) => authoritative === wantAuth;
		const wantAuthPass = target === "installed";
		const journals = () => new Set(readdirSync(join(state, "journal")));
		/** Wait for a new invocation to reach a journal event, then return its id. */
		const waitFor = async (before: Set<string>, pattern: RegExp, timeoutMs = 60_000): Promise<string | null> => {
			const until = Date.now() + timeoutMs;
			while (Date.now() < until) {
				for (const n of readdirSync(join(state, "journal"))) {
					if (before.has(n)) continue;
					const text = readFileSync(join(state, "journal", n), "utf8");
					if (pattern.test(text)) return n.replace(/\.jsonl$/, "");
				}
				await sleep(20);
			}
			return null;
		};
		/** The live verifier instance's pid, found as any process would find it: by owner and command line. */
		const instancePid = (): number | null => {
			for (const p of readdirSync("/proc")) {
				if (!/^\d+$/.test(p)) continue;
				try {
					if (statSync(`/proc/${p}`).uid !== verifierUid) continue;
					const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8");
					if (cmd.includes("service/verifier.ts\0serve")) return Number(p);
				} catch {
					// gone
				}
			}
			return null;
		};

		// ---- T1, T2 ----
		const t1 = await submit(requestFor(R.A));
		const t2 = await submit(requestFor(R.B));
		{
			const requester = (t1.record?.invocation as { requester?: { pid: number; uid: number } } | undefined)
				?.requester;
			row(
				{
					id: "T1",
					title: "correct candidate, ordinary request",
					expected: `PASS, authoritative ${wantAuthPass ? "yes" : "no"}`,
					observed: `${t1.verdict}/${t1.class}, authoritative ${t1.authoritative ? "yes" : "no"} (${t1.readReason})`,
					positiveControl: false,
					detail: { ...t1, record: undefined, requester, harnessPid: process.pid },
				},
				t1.verdict === "PASS" &&
					t1.class === "PASS" &&
					authOk(t1.authoritative, wantAuthPass) &&
					requester?.pid === process.pid &&
					requester?.uid === UID,
			);
			row(
				{
					id: "T2",
					title: "incorrect output, exit 0",
					expected: "FAIL",
					observed: `${t2.verdict}/${t2.class}`,
					positiveControl: false,
					detail: { ...t2, record: undefined },
				},
				t2.verdict === "FAIL" && t2.class === "FAIL" && t2.authoritative === wantAuthPass,
			);
		}
		correctCommits.add(R.A.commit).add(R.P.commit).add(R.Aslow.commit);

		// ---- T3, T4: the caller's environment ----
		const clientIn = (env: Record<string, string>, r: { dir: string; commit: string }) => {
			const out = exec(
				"/usr/bin/node",
				[join(HERE, "client/client.ts"), "submit", "--socket", socket, "--repo", r.dir, "--commit", r.commit],
				{ env },
			);
			let response: Record<string, unknown> | null = null;
			try {
				response = JSON.parse(out.stdout.trim().split("\n").pop() ?? "");
			} catch {
				response = null;
			}
			return response;
		};
		const envNamesOf = (inv: string | undefined) => {
			const r = inv === undefined ? null : read(inv).record;
			const c = r?.controller as { environmentNames?: string[]; hostileVariables?: string[] } | undefined;
			return { names: c?.environmentNames ?? null, hostile: c?.hostileVariables ?? null };
		};
		{
			const shim = join(W, "attacker", "shim");
			mkdirSync(shim);
			writeFileSync(join(shim, "node"), `#!/bin/sh\necho MCMXCIV\n`, { mode: 0o755 });
			const resp = clientIn({ PATH: `${shim}:/usr/bin`, HOME: homedir(), NODE_OPTIONS: `--import=${F1_HOOK}` }, R.B);
			const inv = resp?.invocation as string | undefined;
			const env = envNamesOf(inv);
			const cls = inv === undefined ? null : read(inv).class;
			const clean = env.names !== null && !env.names.includes("NODE_OPTIONS") && (env.hostile?.length ?? 1) === 0;
			row(
				{
					id: "T3",
					title: "NODE_OPTIONS hook and PATH shim in the caller",
					expected: "FAIL; no hostile name in the verifier",
					observed: `${resp?.verdict}/${cls}; verifier environment clean: ${clean}`,
					positiveControl: false,
					detail: { response: resp, environment: env },
				},
				resp?.verdict === "FAIL" && cls === "FAIL" && clean,
			);
		}
		{
			const src = join(W, "attacker", "marker.c");
			const lib = join(W, "attacker", "marker.so");
			const markers = join(W, "markers", "preload");
			mkdirSync(markers);
			writeFileSync(
				src,
				`#include <stdio.h>\n#include <unistd.h>\n#include <fcntl.h>\n__attribute__((constructor)) static void mark(void) {\n  char path[512], cmd[256] = {0};\n  int fd = open("/proc/self/cmdline", O_RDONLY); ssize_t n = fd >= 0 ? read(fd, cmd, sizeof cmd - 1) : 0; if (fd >= 0) close(fd);\n  for (ssize_t i = 0; i < n; i++) if (cmd[i] == 0) cmd[i] = ' ';\n  snprintf(path, sizeof path, "${markers}/%d", (int)getpid());\n  FILE *f = fopen(path, "w"); if (f) { fprintf(f, "uid=%d cmd=%s\\n", (int)getuid(), cmd); fclose(f); }\n}\n`,
			);
			const cc = exec("/usr/bin/gcc", ["-shared", "-fPIC", "-o", lib, src], { env: { PATH: "/usr/bin" } });
			if (cc.status !== 0) throw new Error(`gcc: ${cc.stderr}`);
			const env = { PATH: "/usr/bin", HOME: homedir(), LD_PRELOAD: lib };
			const rb = clientIn(env, R.B);
			const ra = clientIn(env, R.A);
			const marks = readdirSync(markers).map((f) => readFileSync(join(markers, f), "utf8").trim());
			const fromVerifier = marks.filter((m) => m.includes("verifier.ts"));
			const envB = envNamesOf(rb?.invocation as string | undefined);
			const clean = envB.names !== null && !envB.names.includes("LD_PRELOAD");
			row(
				{
					id: "T4",
					title: "LD_PRELOAD in the caller",
					expected: "B FAIL, A PASS; markers only from client processes",
					observed: `B ${rb?.verdict}, A ${ra?.verdict}; markers ${marks.length}, from a verifier ${fromVerifier.length}; verifier environment clean: ${clean}`,
					positiveControl: false,
					detail: { markers: marks.map((m) => m.replace(W, "<W>")), fromVerifier },
				},
				rb?.verdict === "FAIL" && ra?.verdict === "PASS" && marks.length > 0 && fromVerifier.length === 0 && clean,
			);
		}

		// ---- T5: Git inputs ----
		{
			// a. A replace ref in the candidate's repository: B's commit replaced by A's.
			const dir = join(W, "repos", "T5a");
			cpSync(fixtureDir("A"), dir, { recursive: true });
			git(dir, ["init", "-q", "-b", "main"]);
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-q", "-m", "A"]);
			const a = git(dir, ["rev-parse", "HEAD"]);
			cpSync(join(fixtureDir("B"), "roman.mjs"), join(dir, "roman.mjs"));
			git(dir, ["commit", "-q", "-am", "B"]);
			const b = git(dir, ["rev-parse", "HEAD"]);
			git(dir, ["replace", b, a]);
			const plainGitSeesA = exec("/usr/bin/git", ["-C", dir, "show", `${b}:roman.mjs`], {
				env: { PATH: "/usr/bin", HOME: "/nonexistent" },
			}).stdout.includes("thousands");
			const t5a = await submit(requestFor({ dir, commit: b }));
			row(
				{
					id: "T5a",
					title: "replace ref in the candidate repository, honest client",
					expected: "FAIL (B's own objects)",
					observed: `${t5a.verdict}/${t5a.class}; plain git shows A for B: ${plainGitSeesA}`,
					positiveControl: false,
					detail: { verdict: t5a.verdict, plainGitSeesA },
				},
				t5a.verdict === "FAIL" && plainGitSeesA,
			);
			// b. A hostile client: A's objects, named as B's commit.
			const oa = objectsOf(R.A);
			const t5b = await submit(encodeRequest(TASK, oa.objectFormat, R.B.commit, oa.objects));
			row(
				{
					id: "T5b",
					title: "hostile client sends A's objects as B's commit",
					expected: "BLOCKED object-missing",
					observed: `${t5b.verdict} ${t5b.reason}`,
					positiveControl: false,
					detail: { verdict: t5b.verdict, reason: t5b.reason },
				},
				t5b.verdict === "BLOCKED" && t5b.reason === "object-missing",
			);
			// c. A partial clone missing B's blob, whose promisor remote's upload-pack writes a marker.
			const lazy = join(W, "repos", "T5c");
			git(W, ["init", "-q", "-b", "main", lazy]);
			const tree = git(R.B.dir, ["rev-parse", "HEAD^{tree}"]);
			for (const [type, oid] of [
				["tree", tree],
				["commit", R.B.commit],
			] as const) {
				const raw = spawnSync("/usr/bin/git", ["-C", R.B.dir, "cat-file", type, oid], { env: GIT_ENV });
				const w = spawnSync("/usr/bin/git", ["-C", lazy, "hash-object", "-t", type, "-w", "--stdin"], {
					env: GIT_ENV,
					input: raw.stdout,
				});
				if (w.stdout.toString().trim() !== oid) throw new Error(`T5c ${type}`);
			}
			const marker = join(W, "markers", "T5c-uploadpack");
			for (const [k, v] of [
				["core.repositoryformatversion", "1"],
				["extensions.partialClone", "origin"],
				["remote.origin.url", R.B.dir],
				["remote.origin.promisor", "true"],
				["remote.origin.uploadpack", `echo "uid=$(id -u)" > ${marker}; git-upload-pack`],
			])
				git(lazy, ["config", k, v]);
			const honest = collectObjects(lazy, R.B.commit);
			// What a hostile client can send: the commit and its tree, without the missing blob.
			const partial = [
				{
					type: "commit" as ObjectType,
					data: spawnSync("/usr/bin/git", ["-C", lazy, "cat-file", "commit", R.B.commit], { env: GIT_ENV }).stdout,
				},
				{
					type: "tree" as ObjectType,
					data: spawnSync("/usr/bin/git", ["-C", lazy, "cat-file", "tree", tree], { env: GIT_ENV }).stdout,
				},
			];
			const t5c = await submit(encodeRequest(TASK, "sha1", R.B.commit, partial));
			const ran = existsSync(marker);
			row(
				{
					id: "T5c",
					title: "promisor remote with a marker upload-pack, blob missing",
					expected: "BLOCKED object-missing; no marker",
					observed: `client ${honest.ok ? "collected" : honest.reason}; ${t5c.verdict} ${t5c.reason}; marker ${ran ? "WRITTEN" : "absent"}`,
					positiveControl: false,
					detail: {
						honestClient: honest.ok ? "collected" : honest.reason,
						verdict: t5c.verdict,
						reason: t5c.reason,
						markerWritten: ran,
					},
				},
				!honest.ok && t5c.verdict === "BLOCKED" && t5c.reason === "object-missing" && !ran,
			);
		}

		// ---- T6: concurrent modification of the staged candidate (positive control) ----
		{
			const before = journals();
			const pending = submit(requestFor(R.B));
			const inv = await waitFor(before, /"phase":"candidate"/);
			let tamper = "no-invocation";
			if (inv !== null) {
				const staged = join(state, "work", inv, "candidate");
				tamper = errCode(() => {
					chmodSync(staged, 0o755);
					unlinkSync(join(staged, "roman.mjs"));
					writeFileSync(join(staged, "roman.mjs"), readFileSync(join(fixtureDir("A"), "roman.mjs")));
				});
			}
			const t6 = await pending;
			const wantTamper = target === "rehearsal" ? "ok" : "EACCES";
			row(
				{
					id: "T6",
					title: "concurrent same-user swap of the staged candidate",
					expected:
						target === "rehearsal" ? "tamper write succeeds; auth no" : "tamper write EACCES; FAIL, auth yes",
					observed: `tamper ${tamper}; ${t6.verdict} ${t6.reason ?? ""}; authoritative ${t6.authoritative ? "yes" : "no"}`,
					positiveControl: true,
					detail: { tamper, verdict: t6.verdict, reason: t6.reason, authoritative: t6.authoritative },
				},
				tamper === wantTamper &&
					(target === "rehearsal" ? !t6.authoritative : t6.verdict === "FAIL" && t6.authoritative),
			);
		}

		// ---- T7: the verifier's code and configuration (positive control) ----
		{
			const code = join(install, "research/develop-verify-trust-002/service/verifier.ts");
			const directWrite = errCode(() => appendFileSync(code, ""));
			let dropInWrite = "not-applicable";
			let t7: Awaited<ReturnType<typeof submit>>;
			if (target === "rehearsal") {
				// An edited copy (001's R4b: the expected output substituted in the candidate phase only), with its own installation manifest,
				// run by a drop-in for the verifier's unit in the operator's runtime unit directory.
				const edited = join(W, "variants", "T7-install");
				cpSync(install, edited, { recursive: true });
				const file = join(edited, "research/develop-verify-trust-002/service/verifier.ts");
				const text = readFileSync(file, "utf8");
				const patched = text.replace(
					"const stdout = run.stdout;",
					'const stdout = phase === "candidate" ? expected : run.stdout;',
				);
				if (patched === text) throw new Error("T7: patch point not found");
				writeFileSync(file, patched);
				rewriteInstallation(edited, (i) => i);
				dropInWrite = errCode(() =>
					dropIn(
						"t7",
						`[Service]\nExecStart=\nExecStart=/usr/bin/node ${file} serve --install ${edited} --state ${state} --peer %i\n`,
					),
				);
				t7 = await submit(requestFor(R.B));
				removeDropIns();
			} else {
				// The installed configuration is root's; a drop-in in the operator's own configuration reaches only the operator's manager.
				const etc = errCode(() => {
					mkdirSync(`/etc/systemd/user/${INSTALLED.unit}@.service.d`, { recursive: true });
					writeFileSync(`/etc/systemd/user/${INSTALLED.unit}@.service.d/t7.conf`, "[Service]\n");
				});
				const own = join(homedir(), ".config/systemd/user", `${INSTALLED.unit}@.service.d`);
				mkdirSync(own, { recursive: true });
				writeFileSync(join(own, "t7.conf"), "[Service]\nEnvironment=DVT002_T7=1\n");
				dropInWrite = `etc ${etc}; operator's own ${existsSync(join(own, "t7.conf")) ? "written" : "absent"}`;
				t7 = await submit(requestFor(R.B));
				rmSync(own, { recursive: true, force: true });
			}
			const ok =
				target === "rehearsal"
					? directWrite === "ok" && dropInWrite === "ok" && t7.verdict === "PASS" && !t7.authoritative
					: directWrite === "EACCES" && t7.verdict === "FAIL" && t7.authoritative;
			row(
				{
					id: "T7",
					title: "edited verifier through a unit drop-in; direct write to its code",
					expected: target === "rehearsal" ? "writes succeed; PASS; auth no" : "writes fail; FAIL, auth yes",
					observed: `code write ${directWrite}; drop-in ${dropInWrite}; ${t7.verdict}/${t7.class} (${t7.readReason}); authoritative ${t7.authoritative ? "yes" : "no"}`,
					positiveControl: true,
					detail: { directWrite, dropInWrite, verdict: t7.verdict, class: t7.class, readReason: t7.readReason },
				},
				ok,
			);
		}

		// ---- T8: forged records (positive control) ----
		{
			const genuine = JSON.parse(readFileSync(join(state, "records", `${t1.invocation}.json`), "utf8")) as Record<
				string,
				any
			>;
			const b = JSON.parse(readFileSync(join(state, "records", `${t2.invocation}.json`), "utf8")) as Record<
				string,
				any
			>;
			const id = randomBytes(16).toString("hex");
			const forgedRecord: Record<string, any> = {
				...genuine,
				invocation: { ...genuine.invocation, id },
				candidate: b.candidate,
			};
			forgedRecord.recordSha256 = seal(forgedRecord);
			const text = `${JSON.stringify(forgedRecord, null, 2)}\n`;
			// a. Into the records directory.
			const writeA = errCode(() => writeFileSync(join(state, "records", `${id}.json`), text, { flag: "wx" }));
			if (writeA === "ok") forged.push(`${id}.json`);
			const readA = read(id, { commit: R.B.commit, exportSha256: exportOf(R.B) });
			// b. A state root of the attacker's own, with every rule except "verifier is the reader" in force (a fictional verifier uid).
			const fake = join(W, "attacker", "state");
			mkdirSync(join(fake, "records"), { recursive: true });
			writeFileSync(join(fake, "records", `${id}.json`), text);
			const readB = readAuthoritative({
				state: fake,
				installDir: install,
				verifierUid: FICTIONAL_VERIFIER_UID,
				invocation: id,
			});
			// c. A symbolic link in the records directory.
			const id2 = randomBytes(16).toString("hex");
			const writeC = errCode(() =>
				symlinkSync(join(fake, "records", `${id}.json`), join(state, "records", `${id2}.json`)),
			);
			if (writeC === "ok") forged.push(`${id2}.json`);
			const readC = read(id2);
			const ok =
				target === "rehearsal"
					? writeA === "ok" &&
						readA.class === "PASS" &&
						!readA.authoritative &&
						!readB.authoritative &&
						readC.reason === "symbolic-link"
					: writeA === "EACCES" && !readB.authoritative && writeC === "EACCES";
			row(
				{
					id: "T8",
					title: "resealed forgery of T1's record for B: in records/, outside, as a link",
					expected:
						target === "rehearsal"
							? "(a) written, auth no; (b) refused; (c) refused"
							: "(a) EACCES; (b) refused; (c) EACCES",
					observed: `(a) write ${writeA}, read ${readA.class} auth ${readA.authoritative ? "yes" : "no"} (${readA.reason}); (b) auth ${readB.authoritative ? "yes" : "no"} (${String(readB.reason).replace(W, "<W>")}); (c) link ${writeC}, read ${readC.class} (${readC.reason})`,
					positiveControl: true,
					detail: {
						writeA,
						readA: { class: readA.class, authoritative: readA.authoritative, reason: readA.reason },
						readB: {
							class: readB.class,
							authoritative: readB.authoritative,
							reason: String(readB.reason).replace(W, "<W>"),
						},
						writeC,
						readC: { class: readC.class, reason: readC.reason },
					},
				},
				ok,
			);
		}

		// ---- T9: replay ----
		{
			const asB = read(t1.invocation as string, { commit: R.B.commit });
			const consumerB = consumerVerdict({
				state,
				installDir: install,
				verifierUid,
				commit: R.B.commit,
				exportSha256: exportOf(R.B),
			});
			const consumerA = consumerVerdict({
				state,
				installDir: install,
				verifierUid,
				commit: R.A.commit,
				exportSha256: exportOf(R.A),
			});
			row(
				{
					id: "T9",
					title: "A's genuine PASS presented as B's",
					expected: `candidate-mismatch; consumer verdict for B not PASS${wantAuthPass ? "; for A PASS" : ""}`,
					observed: `${asB.class} ${asB.reason}; consumer B ${consumerB.verdict}; consumer A ${consumerA.verdict}`,
					positiveControl: false,
					detail: { asB: { class: asB.class, reason: asB.reason }, consumerB, consumerA },
				},
				asB.reason === "candidate-mismatch" &&
					consumerB.verdict !== "PASS" &&
					(wantAuthPass ? consumerA.verdict === "PASS" : consumerA.verdict === "NONE"),
			);
		}

		// ---- T10: interruption and retry; a client that hangs up ----
		{
			const before = journals();
			const pending = submit(requestFor(target === "installed" ? R.Aslow : R.A));
			const inv = await waitFor(before, /"phase":"candidate"/);
			const pid = instancePid();
			const kill = pid === null ? "no-instance" : errCode(() => process.kill(pid, "SIGKILL"));
			// In the installed phase the agent's kill fails; the operator's approved interruption (INSTALL-PLAN.md §6) happens now, while
			// the slow candidate is still running, and before the response is awaited (review V2).
			if (target === "installed" && kill !== "ok") {
				log("T10: interrupt the instance now with the approved operator command; waiting up to 120 s");
				for (let i = 0; i < 1200 && instancePid() !== null; i++) await sleep(100);
			}
			const first = await pending;
			await sleep(200);
			const interrupted = inv === null ? null : read(inv);
			const retry = await submit(requestFor(R.A));
			const orphanGone = inv === null ? false : !existsSync(join(state, "work", inv)) || target === "installed";
			const beforeHang = new Set(readdirSync(join(state, "records")));
			const hang = await submit(requestFor(R.A), { hangUp: true });
			let hangRecord: string | null = null;
			for (let i = 0; i < 600 && hangRecord === null; i++) {
				await sleep(100);
				hangRecord =
					readdirSync(join(state, "records")).find((n) => !beforeHang.has(n) && /^[0-9a-f]{32}\.json$/.test(n)) ??
					null;
			}
			const hangRead = hangRecord === null ? null : read(hangRecord.slice(0, 32));
			const killExpected = target === "rehearsal" ? "ok" : "EPERM";
			row(
				{
					id: "T10",
					title: "kill mid-run, then retry; client hangs up",
					expected: `kill ${killExpected}; interrupted INCOMPLETE; retry PASS under a new id; hang-up record PASS`,
					observed: `kill ${kill}; first response ${first.verdict}; interrupted ${interrupted?.class} (${interrupted?.reason}); retry ${retry.verdict} new id ${retry.invocation !== inv}; orphan work removed ${orphanGone}; hang-up record ${hangRead?.class ?? "none"}`,
					positiveControl: false,
					detail: {
						kill,
						interrupted: interrupted && { class: interrupted.class, reason: interrupted.reason },
						retry: retry.verdict,
						hangUp: hangRead?.class ?? null,
					},
				},
				kill === killExpected &&
					interrupted?.class === "INCOMPLETE" &&
					retry.verdict === "PASS" &&
					retry.invocation !== inv &&
					orphanGone &&
					hangRead?.class === "PASS" &&
					hang.verdict === "none",
			);
		}

		// ---- T11: refusals ----
		{
			const noSocket = await send(join(dirname(socket), "absent.sock"), requestFor(R.A));
			const results: Record<string, string> = { a: noSocket.ok ? "connected" : noSocket.reason };
			if (target === "rehearsal") {
				const variant = (name: string, change: (i: Record<string, any>) => Record<string, any>) => {
					const dir = join(W, "variants", name);
					cpSync(install, dir, { recursive: true });
					rewriteInstallation(dir, change);
					return dir;
				};
				const run = async (name: string, conf: string) => {
					dropIn(name, conf);
					const r = await submit(requestFor(R.A));
					removeDropIns();
					return `${r.verdict} ${r.reason}`;
				};
				const exe = (dir: string) =>
					`[Service]\nExecStart=\nExecStart=/usr/bin/node ${join(dir, "research/develop-verify-trust-002/service/verifier.ts")} serve --install ${dir} --state ${state} --peer %i\n`;
				const pin = variant("T11b", (i) => ({
					...i,
					tasks: { [TASK]: { ...i.tasks[TASK], manifestSha256: "0".repeat(64) } },
				}));
				results.b = await run("t11b", exe(pin));
				results.c = await run("t11c", "[Service]\nUnsetEnvironment=XDG_RUNTIME_DIR\n");
				const bw = variant("T11d", (i) => ({ ...i, tools: { ...i.tools, bwrap: "/usr/bin/bwrap-absent" } }));
				results.d = await run("t11d", exe(bw));
			}
			const ok =
				results.a?.startsWith("service-unavailable") === true &&
				(target === "installed" ||
					(results.b === "BLOCKED oracle-not-pinned" &&
						results.c === "BLOCKED containment-unavailable" &&
						results.d === "BLOCKED isolation-missing"));
			row(
				{
					id: "T11",
					title: "no socket; wrong oracle pin; no containment; no bubblewrap",
					expected: "BLOCKED each, never PASS",
					observed: JSON.stringify(results),
					positiveControl: false,
					detail: results,
				},
				ok,
			);
		}

		// ---- T12: legitimate facilities and incompatibility ----
		{
			const p = await submit(requestFor(R.P));
			const x = await submit(requestFor(R.X));
			const m = await submit(requestFor(R.M));
			const sig = (r: typeof p) => ((r.record?.compatibility as string[] | undefined) ?? []).join(",");
			row(
				{
					id: "T12",
					title: "P (files, tmp, child node); X (writes its cwd); M (uncommitted dependency)",
					expected: "P PASS; X FAIL [EROFS]; M FAIL [ERR_MODULE_NOT_FOUND]",
					observed: `P ${p.verdict}; X ${x.verdict} [${sig(x)}]; M ${m.verdict} [${sig(m)}]`,
					positiveControl: false,
					detail: {
						P: p.verdict,
						X: { verdict: x.verdict, signals: sig(x) },
						M: { verdict: m.verdict, signals: sig(m) },
						truth: { P: truth.P, X: truth.X, M: truth.M },
					},
				},
				p.verdict === "PASS" &&
					x.verdict === "FAIL" &&
					sig(x).includes("EROFS") &&
					m.verdict === "FAIL" &&
					sig(m).includes("ERR_MODULE_NOT_FOUND"),
			);
		}

		// ---- E1: unsupported entries ----
		{
			const l = await submit(requestFor(R.L));
			// A submodule entry and a tree entry named "..", crafted as objects.
			const blob = readFileSync(join(fixtureDir("A"), "roman.mjs"));
			const blobId = objectId("sha1", "blob", blob);
			const craft = (entries: [string, string, string][]) => {
				const tree = Buffer.concat(
					entries.map(([mode, name, id]) =>
						Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]),
					),
				);
				const treeId = objectId("sha1", "tree", tree);
				const commitObj = Buffer.from(
					`tree ${treeId}\nauthor t <t@example.invalid> 0 +0000\ncommitter t <t@example.invalid> 0 +0000\n\ncrafted\n`,
				);
				const commitId = objectId("sha1", "commit", commitObj);
				return {
					commitId,
					objects: [
						{ type: "commit" as ObjectType, data: commitObj },
						{ type: "tree" as ObjectType, data: tree },
						{ type: "blob" as ObjectType, data: blob },
					],
				};
			};
			const sub = craft([
				["100644", "roman.mjs", blobId],
				["160000", "sub", R.A.commit],
			]);
			const dots = craft([["100644", "..", blobId]]);
			const s = await submit(encodeRequest(TASK, "sha1", sub.commitId, sub.objects));
			const d = await submit(encodeRequest(TASK, "sha1", dots.commitId, dots.objects));
			row(
				{
					id: "E1",
					title: "symbolic link; submodule; entry named ..",
					expected: "BLOCKED unsupported-120000, unsupported-160000, unsupported-name",
					observed: `${l.verdict} ${l.reason}; ${s.verdict} ${s.reason}; ${d.verdict} ${d.reason}`,
					positiveControl: false,
					detail: { link: l.reason, submodule: s.reason, dots: d.reason },
				},
				l.reason === "unsupported-120000" &&
					s.reason === "unsupported-160000" &&
					d.reason === "unsupported-name" &&
					[l, s, d].every((x) => x.verdict === "BLOCKED"),
			);
		}

		// ---- E2: concurrency ----
		{
			const [a, b] = await Promise.all([submit(requestFor(R.A)), submit(requestFor(R.B))]);
			row(
				{
					id: "E2",
					title: "A and B at once",
					expected: "PASS and FAIL, distinct invocations",
					observed: `A ${a.verdict}, B ${b.verdict}, distinct ${a.invocation !== b.invocation}`,
					positiveControl: false,
					detail: { a: a.verdict, b: b.verdict },
				},
				a.verdict === "PASS" && b.verdict === "FAIL" && a.invocation !== b.invocation,
			);
		}

		// ---- E3: the instance stopped mid-run (a restart), then a new request ----
		{
			const before = journals();
			const pending = submit(requestFor(target === "installed" ? R.Aslow : R.A));
			const inv = await waitFor(before, /"phase":"candidate"/);
			let stop = "not-applicable";
			if (target === "rehearsal") {
				const units = exec(
					"/usr/bin/systemctl",
					["--user", "list-units", "--plain", "--no-legend", `${UNIT}@*.service`],
					{ env: { ...process.env } as Record<string, string> },
				).stdout;
				const unit = units
					.split("\n")
					.map((l) => l.trim().split(/\s+/)[0])
					.find((u) => u?.startsWith(`${UNIT}@`));
				stop = unit === undefined ? "no-unit" : systemctl("stop", unit).status === 0 ? "ok" : "failed";
			} else {
				log("E3: restart the verifier's manager now with the approved operator command; waiting up to 120 s");
				for (let i = 0; i < 1200 && instancePid() !== null; i++) await sleep(100);
			}
			await pending;
			await sleep(200);
			const interrupted = inv === null ? null : read(inv);
			const next = await submit(requestFor(R.A));
			const journal =
				next.invocation === null ? "" : readFileSync(join(state, "journal", `${next.invocation}.jsonl`), "utf8");
			const collected = inv !== null && journal.includes(inv);
			row(
				{
					id: "E3",
					title: "instance stopped mid-run, then a new request",
					expected: "INCOMPLETE; the next instance removes the orphan",
					observed: `stop ${stop}; ${interrupted?.class} (${interrupted?.reason}); next ${next.verdict}; orphan collected by next ${collected}`,
					positiveControl: false,
					detail: { stop, interrupted: interrupted?.class, next: next.verdict, collected },
				},
				interrupted?.class === "INCOMPLETE" && next.verdict === "PASS" && (collected || target === "installed"),
			);
		}

		// ---- E4: hang, standard output, standard error ----
		{
			const d = await submit(requestFor(R.D));
			const e = await submit(requestFor(R.E));
			const s = await submit(requestFor(R.S));
			row(
				{
					id: "E4",
					title: "D hangs; E 1 MiB stdout; S 70,000 B stderr",
					expected: "FAIL each",
					observed: `D ${d.verdict}, E ${e.verdict}, S ${s.verdict}`,
					positiveControl: false,
					detail: { D: d.verdict, E: e.verdict, S: s.verdict, truthS: truth.S },
				},
				d.verdict === "FAIL" && e.verdict === "FAIL" && s.verdict === "FAIL",
			);
		}

		// ---- E5: request validation ----
		{
			const oa = objectsOf(R.A);
			const big = await submit(Buffer.alloc((8 << 20) + 1, 0x20));
			const env = await submit(requestFor(R.A, { env: { NODE_OPTIONS: "--import=x" } }));
			const argvKey = await submit(requestFor(R.A, { argv: ["node", "x"] }));
			const expect = await submit(requestFor(R.A, { expect: { stdout: "" } }));
			const extra = await submit(
				encodeRequest(TASK, oa.objectFormat, R.A.commit, [
					...oa.objects,
					{ type: "blob", data: Buffer.from("unreferenced\n") },
				]),
			);
			const task = await submit(encodeRequest("another-task", oa.objectFormat, R.A.commit, oa.objects));
			const junk = await submit(Buffer.from("{not json"));
			const got = {
				big: big.reason,
				env: env.reason,
				argv: argvKey.reason,
				expect: expect.reason,
				unreferenced: extra.reason,
				task: task.reason,
				junk: junk.reason,
			};
			const all = [big, env, argvKey, expect, extra, task, junk];
			row(
				{
					id: "E5",
					title: "oversized; env, argv, expect keys; unreferenced object; unknown task; malformed",
					expected: "BLOCKED each, with its reason",
					observed: JSON.stringify(got),
					positiveControl: false,
					detail: got,
				},
				all.every((x) => x.verdict === "BLOCKED") &&
					got.big === "request-too-large" &&
					got.env === "request-invalid" &&
					got.argv === "request-invalid" &&
					got.expect === "request-invalid" &&
					got.unreferenced === "object-unreferenced" &&
					got.task === "task-unknown" &&
					got.junk === "request-invalid",
			);
		}

		// ---- E6: reading the oracle; inspecting and signalling the instance (positive control) ----
		{
			const oracleRead = errCode(() => readFileSync(join(install, "oracle", TASK, "manifest.json")));
			const before = journals();
			const pending = submit(requestFor(R.A));
			await waitFor(before, /"phase":"candidate"/);
			const pid = instancePid();
			const environ = pid === null ? "no-instance" : errCode(() => readFileSync(`/proc/${pid}/environ`));
			const signal = pid === null ? "no-instance" : errCode(() => process.kill(pid, 0));
			const r = await pending;
			const want = target === "rehearsal" ? ["ok", "ok", "ok"] : ["EACCES", "EACCES", "EPERM"];
			row(
				{
					id: "E6",
					title: "read the oracle; read the instance's environ; signal it",
					expected: want.join(", "),
					observed: `${oracleRead}, ${environ}, ${signal}; run ${r.verdict}`,
					positiveControl: true,
					detail: { oracleRead, environ, signal },
				},
				oracleRead === want[0] && environ === want[1] && signal === want[2] && r.verdict === "PASS",
			);
		}
	} finally {
		if (target === "rehearsal") {
			systemctl("stop", `${UNIT}.socket`);
			for (const f of added) rmSync(f, { force: true });
			rmSync(join(unitDir, `${UNIT}@.service.d`), { recursive: true, force: true });
			systemctl("daemon-reload");
			systemctl("reset-failed", `${UNIT}*`);
			rmSync(socket, { force: true });
		}
	}

	// ---- acceptance (PROTOCOL.md §6) ----
	snapshot(forged);
	const all = readdirSync(join(state, "records")).filter((n) => /^[0-9a-f]{32}\.json$/.test(n));
	const reads = all.map((n) => ({ name: n, r: read2(state, install, verifierUid, n.slice(0, 32)) }));
	const authoritative = reads.filter((x) => x.r.authoritative).map((x) => x.name);
	const falsePasses = reads
		.filter((x) => x.r.authoritative && x.r.class === "PASS")
		.filter((x) => !correctCommits.has(String((x.r.record?.candidate as { commit?: unknown } | null)?.commit)))
		.map((x) => x.name);
	const by = (id: string) => rows.find((r) => r.id === id);
	const held = (...ids: string[]) => ids.every((id) => by(id)?.held === true);
	const acceptance =
		target === "rehearsal"
			? {
					RA1: held("T1", "T2", "T12"),
					RA2: held("T2", "T3", "T4", "T5a", "T5b", "T5c", "T9", "T11", "E1", "E4", "E5"),
					RA3: held("T3", "T4"),
					RA4: held("T6", "T7", "T8", "E6"),
					RA5: authoritative.length === 0 && falsePasses.length === 0,
					RA6: held("T10", "E3") && overwritten.length === 0,
					RA7: held("T5b", "T5c", "T11", "E1", "E5"),
				}
			: {
					IA1: held("T1"),
					IA2: held("T6", "T7", "T8", "E6"),
					IA3: falsePasses.length === 0,
					IA4: held(
						"T2",
						"T3",
						"T4",
						"T5a",
						"T5b",
						"T5c",
						"T9",
						"T10",
						"T11",
						"T12",
						"E1",
						"E2",
						"E3",
						"E4",
						"E5",
					),
				};
	const results = {
		schemaVersion: "endo.research.dvt002.results.v0",
		target,
		commit: commit || "worktree",
		installationId,
		host: { kernel: release(), node: process.version, uid: UID, verifierUid },
		wallMs: Date.now() - wallStart,
		records: {
			total: all.length,
			forgedByAttacker: forged.length,
			authoritative: authoritative.length,
			authoritativeFalsePasses: falsePasses,
			overwritten,
		},
		acceptance,
		rows,
	};
	const text = `${JSON.stringify(results, null, 2)}\n`.split(W).join("<W>").split(homedir()).join("<home>");
	writeFileSync(join(W, "results.json"), text);
	log(`acceptance: ${JSON.stringify(acceptance)}`);
	log(`records: ${JSON.stringify(results.records)}; wall ${results.wallMs} ms`);
	return Object.values(acceptance).every(Boolean) ? 0 : 1;
}

function read2(state: string, install: string, verifierUid: number, invocation: string) {
	return readAuthoritative({ state, installDir: install, verifierUid, invocation });
}

/** Rewrite a copy's installation manifest after a change, with every file's digest recomputed (an attacker can do the same). */
function rewriteInstallation(dir: string, change: (i: Record<string, any>) => Record<string, any>): void {
	const file = join(dir, "installation.json");
	const inst = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
	inst.files = (inst.files as { path: string }[]).map((f) => ({
		path: f.path,
		sha256: sha256(readFileSync(join(dir, f.path))),
	}));
	writeFileSync(file, `${canonicalEndoJsonV0(change(inst) as never)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const [command, W, ...rest] = process.argv.slice(2);
	if (command === "run" && W !== undefined) process.exitCode = await run(resolve(W), rest);
	else {
		process.stderr.write(
			"usage: rehearsal.ts run <workspace> --commit <id> [--repository <dir>] [--target rehearsal|installed]\n",
		);
		process.exitCode = 64;
	}
}
