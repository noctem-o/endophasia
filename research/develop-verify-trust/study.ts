// DEVELOP-VERIFY-TRUST-001: the study runner (PROTOCOL.md §6). It builds every candidate in a new disposable workspace, runs each row of the
// case matrix through the mechanisms the protocol names, and writes the observations beside the preregistered expectations.
//
//   node research/develop-verify-trust/study.ts run <new-empty-directory>      (from the repository root; no build needed)
//   node research/develop-verify-trust/study.ts compare <results-1.json> <results-2.json>
//
// Nothing here calls a model or the network. Every process it starts has an explicit environment, a timeout and a bounded output. The
// workspace must be outside the repository, with no oracle/manifest.json above it (checked), so that candidate C can reach the oracle only
// the ways the protocol says.

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Observation, seal } from "./verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const V = join(REPO, "research/develop-validation");
const PLAN = join(V, "fixtures/roman/verification-plan.json");
const F1_HOOK = join(V, "fixtures/env-hook.mjs");
const FORGE_HOOK = join(HERE, "fixtures/hooks/controller-forge.mjs");
const PIN = "3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31";
const CANDIDATES = ["A", "B", "C", "C2", "D", "E", "P"] as const;
const UID = process.getuid?.() ?? 0;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type Mech = "O" | "F" | "S";
interface Row {
	id: string;
	title: string;
	candidate: string;
	condition: string;
	expected: Partial<Record<Mech, string>>;
	observed: Partial<Record<Mech, string>>;
	detail: Record<string, unknown>;
}

// ---- processes ---------------------------------------------------------------------------------------------------------------------------

function exec(
	command: string,
	args: readonly string[],
	env: Record<string, string>,
	cwd: string,
	timeoutMs = 120_000,
): SpawnSyncReturns<string> {
	return spawnSync(command, [...args], { env, cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 << 20 });
}

function main(): never | Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "run" && rest[0] !== undefined) return study(resolve(rest[0]));
	if (command === "compare" && rest[1] !== undefined) {
		const [a, b] = [rest[0], rest[1]].map((f) => JSON.parse(readFileSync(f as string, "utf8")) as { rows: Row[] });
		const key = (r: Row) => JSON.stringify([r.id, r.observed]);
		const differ = (a?.rows ?? []).filter((r, i) => key(r) !== key((b?.rows ?? [])[i] as Row));
		const same = differ.length === 0 && a?.rows.length === b?.rows.length;
		process.stdout.write(
			`${JSON.stringify({ identical: same, rows: a?.rows.length, differing: differ.map((r) => r.id) })}\n`,
		);
		process.exit(same ? 0 : 1);
	}
	process.stderr.write("usage: study.ts run <new-empty-directory> | study.ts compare <results-1> <results-2>\n");
	process.exit(64);
}

async function study(W: string): Promise<void> {
	if (existsSync(W) && readdirSync(W).length > 0) throw new Error(`${W} is not empty`);
	if (W === REPO || W.startsWith(`${REPO}/`)) throw new Error("the workspace must be outside the repository");
	for (let d = W; ; d = dirname(d)) {
		if (existsSync(join(d, "oracle", "manifest.json")))
			throw new Error(`an oracle is reachable above the workspace at ${d}`);
		if (d === "/") break;
	}
	const started = Date.now();
	for (const d of [
		"home",
		"repos",
		"verifier",
		"results",
		"out/evidence",
		"out/records",
		"stores",
		"truth",
		"agent-bin",
		"user-node",
	])
		mkdirSync(join(W, d), { recursive: true });
	const out = join(W, "out");
	const sanitize = (s: string) =>
		s.split(W).join("<workspace>").split(REPO).join("<repository>").split(homedir()).join("<home>");
	const save = (name: string, content: string) => writeFileSync(join(out, "evidence", name), sanitize(content));
	const base = { PATH: "/usr/bin", HOME: join(W, "home"), LANG: "C.UTF-8" };
	const bus = { XDG_RUNTIME_DIR: `/run/user/${UID}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${UID}/bus` };

	// ---- the workspace ----
	cpSync(join(HERE, "oracle"), join(W, "verifier/oracle"), { recursive: true });
	cpSync(join(HERE, "oracle"), join(W, "verifier/oracle-tampered"), { recursive: true });
	const tampered = join(W, "verifier/oracle-tampered/manifest.json");
	writeFileSync(tampered, readFileSync(tampered, "utf8").replace('"stdout": "IV\\n"', '"stdout": "IIII\\n"'));
	const ORACLE = join(W, "verifier/oracle/manifest.json");
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
	const commits: Record<string, string> = {};
	const commit = (name: string, dir: string) => {
		for (const args of [
			["init", "-q", "-b", "main"],
			["add", "-A"],
			["commit", "-q", "-m", `candidate ${name}`],
		]) {
			const r = exec("/usr/bin/git", args, gitEnv, dir);
			if (r.status !== 0) throw new Error(`git ${args[0]} failed for ${name}: ${r.stderr}`);
		}
		commits[name] = exec("/usr/bin/git", ["rev-parse", "HEAD"], gitEnv, dir).stdout.trim();
	};
	for (const c of CANDIDATES) {
		cpSync(join(HERE, "fixtures/candidates", c), join(W, "repos", c), { recursive: true });
		commit(c, join(W, "repos", c));
	}
	cpSync(join(HERE, "fixtures/candidates/A"), join(W, "repos/A-link"), { recursive: true });
	symlinkSync("roman.mjs", join(W, "repos/A-link/alias.mjs"));
	commit("A-link", join(W, "repos/A-link"));
	// Case 5: an agent-writable directory outside every worktree, first on PATH, whose `node` loads the F1 hook into the real one.
	writeFileSync(join(W, "agent-bin/node"), `#!/bin/sh\nexec /usr/bin/node --import=${F1_HOOK} "$@"\n`, {
		mode: 0o755,
	});
	// Case 7d: the runtime as a user-owned copy.
	copyFileSync("/usr/bin/node", join(W, "user-node/node"));

	// ---- the truth: DEVELOP-VALIDATION-001's hand-written oracle, over an archive of each commit, with no oracle reachable ----
	const truth: Record<string, string> = {};
	for (const c of CANDIDATES) {
		const dir = join(W, "truth", c);
		mkdirSync(dir);
		const archive = exec(
			"/usr/bin/sh",
			["-c", `/usr/bin/git -C "$1" archive HEAD | /usr/bin/tar -x -C "$2"`, "sh", join(W, "repos", c), dir],
			gitEnv,
			W,
		);
		if (archive.status !== 0) throw new Error(`archive ${c}: ${archive.stderr}`);
		const r = exec(
			"/usr/bin/timeout",
			["20", "/usr/bin/sh", join(V, "oracles/roman.sh"), dir],
			{ PATH: "/usr/bin" },
			W,
			30_000,
		);
		const last = r.stdout.trim().split("\n").at(-1) ?? "";
		truth[c] =
			r.status === 124
				? "FAIL (hung: killed after 20 s)"
				: last === "ORACLE PASS"
					? "PASS"
					: last === "ORACLE FAIL"
						? "FAIL"
						: `? ${last}`;
		save(`truth-${c}.txt`, `${r.stdout}\n[exit ${r.status}]\n`);
	}

	// ---- O: the ordinary DEVELOP path, through the real CLI of this revision ----
	const endo = (args: string[], env: Record<string, string>, cwd: string, timeoutMs = 60_000) =>
		exec("/usr/bin/node", [join(REPO, "cli/index.ts"), ...args], env, cwd, timeoutMs);
	const idOf = (kind: string, text: string) => new RegExp(`endo\\.${kind}\\.[0-9a-f]{32}`).exec(text)?.[0] ?? "";
	const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { checks: { name: string; argv: string[] }[] };
	const conditionEnv = (condition: string): Record<string, string> =>
		condition === "f1-hook"
			? { ...base, NODE_OPTIONS: `--import=${F1_HOOK}` }
			: condition === "path-shadow"
				? { ...base, PATH: `${join(W, "agent-bin")}:/usr/bin` }
				: base;
	const ordinary = (row: string, c: string, condition: string, extra: { argv: string[]; timeout?: string }[] = []) => {
		const repo = join(W, "repos", c);
		const store = join(W, "stores", row);
		const both = (r: SpawnSyncReturns<string>) => `${r.stdout}\n${r.stderr}`;
		const project = idOf(
			"project",
			both(endo(["project", "add", "--root", store, "--name", `row ${row}`, "--path", repo], base, repo)),
		);
		const task = idOf(
			"task",
			both(
				endo(
					[
						"task",
						"add",
						"--root",
						store,
						"--project",
						project,
						"--title",
						"Roman numerals use subtractive notation",
					],
					base,
					repo,
				),
			),
		);
		const attempt = idOf(
			"attempt",
			both(
				endo(
					[
						"attempt",
						"prepare",
						"--root",
						store,
						"--project",
						project,
						"--task",
						task,
						"--objective",
						"Make roman.mjs subtractive",
						"--plan-file",
						PLAN,
					],
					base,
					repo,
				),
			),
		);
		if (!attempt) throw new Error(`row ${row}: no attempt was prepared`);
		const env = conditionEnv(condition);
		const runs: { argv: string[]; exit: number | null; recorded: string }[] = [];
		for (const argv of [
			...plan.checks.map((p): { argv: string[]; timeout?: string } => ({ argv: p.argv })),
			...extra,
		]) {
			const r = endo(
				[
					"attempt",
					"check",
					"--root",
					store,
					"--attempt",
					attempt,
					"--keep-output",
					...(argv.timeout !== undefined ? ["--timeout", argv.timeout] : []),
					"--",
					...argv.argv,
				],
				env,
				repo,
			);
			runs.push({
				argv: argv.argv,
				exit: r.status,
				recorded: /recorded: [^.]*/.exec(r.stderr)?.[0] ?? "(no recorded line)",
			});
		}
		const ev = endo(["attempt", "evidence", "--root", store, "--attempt", attempt], base, repo);
		save(`ordinary-${row}-evidence.json`, ev.stdout);
		save(`ordinary-${row}-evidence.txt`, ev.stderr);
		const e = (JSON.parse(ev.stdout) as { evidence: Record<string, any> }).evidence;
		const checks = (e.verification.checks as { name: string; state: string; label: string }[]).map((k) => ({
			name: k.name,
			state: k.state,
			label: k.label,
		}));
		const criteria = (e.verification.criteria as { state: string; label?: string }[]).map((k) => k.state);
		const receiptsDir = join(store, "develop/receipts", attempt);
		const receipts = readdirSync(receiptsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(receiptsDir, f), "utf8")) as Record<string, any>)
			.map((r) => ({
				argv: r.check.argv,
				executable: sanitize(r.check.executable),
				realExecutable: sanitize(r.check.realExecutable),
				outcome: r.outcome,
				reasons: r.reasons,
			}));
		const states = checks.map((k) => k.state);
		const ledger = states.every((s) => s === "passed")
			? "passed"
			: states.includes("failed")
				? "failed"
				: `other: ${states.join(",")}`;
		return {
			ledger,
			checks,
			criteria,
			problems: e.checks.problems as number,
			receiptCount: e.checks.receipts as number,
			receipts,
			runs,
		};
	};

	// ---- F and S: the controlled verifier, through its launcher or (4b, 4c) started directly ----
	interface VerifyOptions {
		launcher?: boolean;
		env?: Record<string, string>;
		oracle?: string;
		repo?: string;
		flags?: string[];
	}
	const recordSummary = (file: string) => {
		if (!existsSync(file)) return null;
		const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		return {
			verdict: r.verdict,
			reason: r.reason,
			commit: r.candidate?.commit ?? null,
			candidateSha256: r.candidate?.sha256 ?? null,
			preflight:
				r.preflight === null
					? null
					: {
							status: r.preflight.status,
							probes: r.preflight.probes.length,
							failed: r.preflight.probes.filter((p: any) => !p.passed).map((p: any) => p.id),
						},
			qualification: r.qualification,
			mismatched: (r.cases as Observation[])
				.filter((c) => !c.matched)
				.map((c) => ({
					name: c.name,
					exitCode: c.exitCode,
					timedOut: c.timedOut,
					truncated: c.truncated,
					stdoutBytes: c.stdoutBytes,
				})),
			hostileVariables: r.controller.launch.hostileVariables,
			environmentNames: r.controller.environmentNames,
			durationMs: r.endedAtMs - r.startedAtMs,
		};
	};
	const read = (file: string) => {
		const r = exec(
			"/usr/bin/sh",
			[join(HERE, "run.sh"), "read", file, "--oracle", ORACLE, "--oracle-sha256", PIN],
			base,
			W,
		);
		return JSON.parse(r.stdout) as { class: string; reason: string | null };
	};
	const verifyArgs = (row: string, mech: "sandbox" | "filtered", c: string, o: VerifyOptions) => {
		const repo = o.repo ?? join(W, "repos", c);
		const file = join(W, "results", `${row}-${mech}.json`);
		const args = [
			"run",
			"--mechanism",
			mech,
			"--oracle",
			o.oracle ?? ORACLE,
			"--oracle-sha256",
			PIN,
			"--repo",
			repo,
			"--commit",
			commits[o.repo === undefined ? c : "A-link"] as string,
			"--out",
			file,
			...(o.flags ?? []),
		];
		const launch: [string, string[], Record<string, string>] =
			o.launcher === false
				? ["/usr/bin/node", [join(HERE, "verify.ts"), ...args], { ...base, ...bus, ...(o.env ?? {}) }]
				: ["/usr/bin/sh", [join(HERE, "run.sh"), ...args], { ...base, ...(o.env ?? {}) }];
		return { file, launch };
	};
	const verify = (row: string, mech: "sandbox" | "filtered", c: string, o: VerifyOptions = {}) => {
		const { file, launch } = verifyArgs(row, mech, c, o);
		const t = Date.now();
		const r = exec(launch[0], launch[1], launch[2], W, 300_000);
		const summary = recordSummary(file);
		const reader = read(file);
		if (existsSync(file)) copyFileSync(file, join(out, "records", `${row}-${mech}.json`));
		if (existsSync(`${file}.journal`))
			copyFileSync(`${file}.journal`, join(out, "records", `${row}-${mech}.journal`));
		return {
			verdict: summary?.verdict ?? "(no record)",
			exit: r.status,
			wallMs: Date.now() - t,
			reader,
			summary,
			stderr: sanitize(r.stderr.slice(0, 600)),
		};
	};

	const rows: Row[] = [];
	const add = (row: Row) => {
		rows.push(row);
		const marks = (Object.keys(row.expected) as Mech[]).map(
			(m) => `${m}:${row.observed[m]}${row.observed[m] === row.expected[m] ? "" : ` (expected ${row.expected[m]})`}`,
		);
		process.stderr.write(`row ${row.id.padEnd(10)} ${marks.join("  ")}\n`);
	};
	const sRow = (v: ReturnType<typeof verify>) => v.verdict;

	// 1, 2, 10: clean
	for (const [id, c, exp] of [
		["1", "A", ["passed", "PASS"]],
		["2", "B", ["failed", "FAIL"]],
		["10", "P", ["passed", "PASS"]],
	] as const) {
		const o = ordinary(id, c, "clean");
		const f = verify(id, "filtered", c);
		const s = verify(id, "sandbox", c);
		add({
			id,
			title: id === "10" ? "positive control" : id === "1" ? "correct, clean" : "incorrect, clean",
			candidate: c,
			condition: "clean",
			expected: { O: exp[0], F: exp[1], S: exp[1] },
			observed: { O: o.ledger, F: f.verdict, S: sRow(s) },
			detail: { truth: truth[c], ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 3: F1 reproduction on the ordinary path
	{
		const o = ordinary("3", "B", "f1-hook");
		add({
			id: "3",
			title: "F1 reproduction",
			candidate: "B",
			condition: "NODE_OPTIONS=--import=<env-hook.mjs> (outside the repository)",
			expected: { O: "passed" },
			observed: { O: o.ledger },
			detail: { truth: truth.B, ordinary: o },
		});
	}
	// 4a-4d: the hostile environment, controlled
	{
		const env = { NODE_OPTIONS: `--import=${F1_HOOK}` };
		const f = verify("4a", "filtered", "B", { env });
		const s = verify("4a", "sandbox", "B", { env });
		add({
			id: "4a",
			title: "F1, controlled (through run.sh)",
			candidate: "B",
			condition: "caller has NODE_OPTIONS=--import=<env-hook.mjs>",
			expected: { F: "FAIL", S: "FAIL" },
			observed: { F: f.verdict, S: s.verdict },
			detail: { truth: truth.B, filtered: f, sandbox: s },
		});
		const b = verify("4b", "sandbox", "B", { env, launcher: false });
		add({
			id: "4b",
			title: "hostile controller env, no launcher",
			candidate: "B",
			condition: "verify.ts started directly with NODE_OPTIONS=--import=<env-hook.mjs>",
			expected: { S: "BLOCKED" },
			observed: { S: b.verdict },
			detail: { truth: truth.B, sandbox: b },
		});
		const forge = { NODE_OPTIONS: `--import=${FORGE_HOOK}` };
		const c = verify("4c", "sandbox", "B", { env: forge, launcher: false });
		add({
			id: "4c",
			title: "self-hiding controller hook, no launcher",
			candidate: "B",
			condition: "verify.ts started directly with NODE_OPTIONS=--import=<controller-forge.mjs>",
			expected: { S: "PASS" },
			observed: { S: c.verdict },
			detail: {
				truth: truth.B,
				sandbox: c,
				note: "expected PASS is a false pass: it demonstrates that the controller is trusted",
			},
		});
		const d = verify("4d", "sandbox", "B", { env: forge });
		add({
			id: "4d",
			title: "the 4c hook, through run.sh",
			candidate: "B",
			condition: "caller has NODE_OPTIONS=--import=<controller-forge.mjs>",
			expected: { S: "FAIL" },
			observed: { S: d.verdict },
			detail: { truth: truth.B, sandbox: d },
		});
	}
	// 5: shadowed PATH
	{
		const o = ordinary("5", "B", "path-shadow");
		const env = { PATH: `${join(W, "agent-bin")}:/usr/bin` };
		const f = verify("5", "filtered", "B", { env });
		const s = verify("5", "sandbox", "B", { env });
		add({
			id: "5",
			title: "shadowed PATH",
			candidate: "B",
			condition: "PATH=<workspace>/agent-bin:/usr/bin; agent-bin/node loads the F1 hook",
			expected: { O: "passed", F: "FAIL", S: "FAIL" },
			observed: { O: o.ledger, F: f.verdict, S: s.verdict },
			detail: { truth: truth.B, ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 6: candidate-modified tests and oracle, host lookup
	{
		const o = ordinary("6", "C", "clean", [{ argv: ["node", "--test"] }]);
		const f = verify("6", "filtered", "C");
		const s = verify("6", "sandbox", "C");
		add({
			id: "6",
			title: "candidate-modified tests and oracle; host lookup",
			candidate: "C",
			condition: "clean",
			expected: { O: "passed", F: "PASS", S: "FAIL" },
			observed: { O: o.ledger, F: f.verdict, S: s.verdict },
			detail: { truth: truth.C, ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 6x: EXPLORATORY, added after preregistration (deviation 1): C2 reads every ancestor's arguments, not only its parent's. Not in §8.
	{
		const o = ordinary("6x", "C2", "clean", [{ argv: ["node", "--test"] }]);
		const f = verify("6x", "filtered", "C2");
		const s = verify("6x", "sandbox", "C2");
		add({
			id: "6x",
			title: "EXPLORATORY: C2, ancestor lookup",
			candidate: "C2",
			condition: "clean",
			expected: { O: "passed", F: "PASS", S: "FAIL" },
			observed: { O: o.ledger, F: f.verdict, S: s.verdict },
			detail: { exploratory: true, truth: truth.C2, ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 7a-7e: missing or refused prerequisites
	{
		const a = verify("7a", "sandbox", "A", { flags: ["--bwrap", "/nonexistent/bwrap"] });
		add({
			id: "7a",
			title: "bubblewrap missing",
			candidate: "A",
			condition: "--bwrap /nonexistent/bwrap",
			expected: { S: "BLOCKED" },
			observed: { S: a.verdict },
			detail: { truth: truth.A, sandbox: a },
		});
		const b = verify("7b", "sandbox", "A", { flags: ["--systemd-run", "/nonexistent/systemd-run"] });
		add({
			id: "7b",
			title: "containment missing",
			candidate: "A",
			condition: "--systemd-run /nonexistent/systemd-run",
			expected: { S: "BLOCKED" },
			observed: { S: b.verdict },
			detail: { truth: truth.A, sandbox: b },
		});
		const cf = verify("7c", "filtered", "A", { oracle: tampered });
		const cs = verify("7c", "sandbox", "A", { oracle: tampered });
		add({
			id: "7c",
			title: "oracle not the pinned one",
			candidate: "A",
			condition: "the workspace oracle copy says 4 is IIII",
			expected: { F: "BLOCKED", S: "BLOCKED" },
			observed: { F: cf.verdict, S: cs.verdict },
			detail: { truth: truth.A, filtered: cf, sandbox: cs },
		});
		const userNode = ["--node", join(W, "user-node/node")];
		const df = verify("7d", "filtered", "A", { flags: userNode });
		const ds = verify("7d", "sandbox", "A", { flags: userNode });
		add({
			id: "7d",
			title: "runtime not trusted",
			candidate: "A",
			condition: "--node <workspace>/user-node/node (a user-owned copy)",
			expected: { F: "BLOCKED", S: "BLOCKED" },
			observed: { F: df.verdict, S: ds.verdict },
			detail: { truth: truth.A, filtered: df, sandbox: ds },
		});
		const link = join(W, "repos/A-link");
		const ef = verify("7e", "filtered", "A", { repo: link });
		const es = verify("7e", "sandbox", "A", { repo: link });
		add({
			id: "7e",
			title: "unsupported candidate (a symbolic link)",
			candidate: "A-link",
			condition: "clean",
			expected: { F: "BLOCKED", S: "BLOCKED" },
			observed: { F: ef.verdict, S: es.verdict },
			detail: { truth: truth.A, filtered: ef, sandbox: es },
		});
	}
	// 8: timeout
	{
		const o = ordinary("8", "D", "clean", [{ argv: ["node", "roman.mjs", "3999"], timeout: "2" }]);
		const f = verify("8", "filtered", "D");
		const s = verify("8", "sandbox", "D");
		add({
			id: "8",
			title: "timeout",
			candidate: "D",
			condition: "clean",
			expected: { O: "passed", F: "FAIL", S: "FAIL" },
			observed: { O: o.ledger, F: f.verdict, S: s.verdict },
			detail: { truth: truth.D, ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 9a: interrupted
	{
		const { file, launch } = verifyArgs("9a", "sandbox", "D", {});
		const child = spawn(launch[0], launch[1], { env: launch[2], cwd: W, stdio: "ignore" });
		// Addendum 1, v1.1: observe an early exit (a refused run) instead of waiting on an exit that already happened.
		let exitedEarly = false;
		const exited = new Promise((r) => child.once("exit", r)).then(() => {
			exitedEarly = true;
		});
		const journal = () => (existsSync(`${file}.journal`) ? readFileSync(`${file}.journal`, "utf8") : "");
		const deadline = Date.now() + 120_000;
		let armed = false;
		while (Date.now() < deadline && !exitedEarly) {
			if (journal().includes('"phase":"candidate","case":"max-3999"')) {
				armed = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 1_000));
		const killedAtMs = Date.now();
		child.kill("SIGKILL");
		await exited;
		await new Promise((r) => setTimeout(r, 3_000));
		const units = [...journal().matchAll(/"unit":"(endo-sandbox-[0-9a-f]{24})"/g)].map((m) => m[1] as string);
		const states = units.map((unit) => {
			const r = exec(
				"/usr/bin/systemctl",
				["--user", "show", `${unit}.scope`, "-p", "ActiveState", "-p", "LoadState", "--no-pager"],
				{ PATH: "/usr/bin", ...bus },
				W,
			);
			return { unit, state: r.stdout.trim().split("\n").join(" ") };
		});
		const active = states.filter((s) => /ActiveState=(active|activating|deactivating)/.test(s.state));
		const reader = read(file);
		if (existsSync(`${file}.journal`)) copyFileSync(`${file}.journal`, join(out, "records", "9a-sandbox.journal"));
		add({
			id: "9a",
			title: "interrupted (SIGKILL while 3999 runs)",
			candidate: "D",
			condition: "the verifier is killed mid-case",
			expected: { S: "INCOMPLETE" },
			observed: { S: reader.class },
			detail: {
				truth: truth.D,
				armed,
				killedAtMs,
				recordWritten: existsSync(file),
				reader,
				scopesRecorded: units.length,
				scopesStillActive: active,
				lastScope: states.at(-1) ?? null,
			},
		});
	}
	// 9b: incomplete output
	{
		const o = ordinary("9b", "E", "clean");
		const f = verify("9b", "filtered", "E");
		const s = verify("9b", "sandbox", "E");
		add({
			id: "9b",
			title: "incomplete output (1 MiB before the answer)",
			candidate: "E",
			condition: "clean",
			expected: { O: "passed", F: "FAIL", S: "FAIL" },
			observed: { O: o.ledger, F: f.verdict, S: s.verdict },
			detail: { truth: truth.E, ordinary: o, filtered: f, sandbox: s },
		});
	}
	// 9c, 9d: damaged and forged records, from row 2's sandbox record
	{
		const source = join(W, "results", "2-sandbox.json");
		const text = readFileSync(source, "utf8");
		const variant = (name: string, change: (r: Record<string, any>) => string) => {
			const file = join(W, "results", `${name}.json`);
			writeFileSync(file, change(JSON.parse(text) as Record<string, any>));
			copyFileSync(file, join(out, "records", `${name}.json`));
			return read(file);
		};
		const resealed = (r: Record<string, any>) => {
			r.recordSha256 = seal(r);
			return `${JSON.stringify(r, null, 2)}\n`;
		};
		const oracle = JSON.parse(readFileSync(ORACLE, "utf8")) as {
			cases: { expect: { exitCode: number; stdout: string } }[];
		};
		const results: Record<string, { class: string; reason: string | null }> = {
			"9c-verdict-flipped": variant(
				"9c-verdict-flipped",
				(r) => `${JSON.stringify({ ...r, verdict: "PASS" }, null, 2)}\n`,
			),
			"9c-flipped-resealed": variant("9c-flipped-resealed", (r) => resealed({ ...r, verdict: "PASS" })),
			"9c-case-removed": variant("9c-case-removed", (r) => resealed({ ...r, cases: r.cases.slice(0, -1) })),
			"9c-truncated": variant("9c-truncated", () => text.slice(0, Math.floor(text.length / 2))),
			"9c-other-oracle": variant("9c-other-oracle", (r) =>
				resealed({ ...r, oracle: { ...r.oracle, sha256: sha256(readFileSync(tampered)) } }),
			),
		};
		add({
			id: "9c",
			title: "damaged records (five variants of row 2's record)",
			candidate: "B",
			condition: "record edited after the run",
			expected: { S: "UNKNOWN" },
			observed: {
				S: Object.values(results).every((x) => x.class === "UNKNOWN")
					? "UNKNOWN"
					: JSON.stringify(Object.values(results).map((x) => x.class)),
			},
			detail: { truth: truth.B, variants: results },
		});
		const forged = variant("9d-forged", (r) =>
			resealed({
				...r,
				verdict: "PASS",
				cases: (r.cases as Observation[]).map((c, i) => {
					const e = oracle.cases[i]?.expect as { exitCode: number; stdout: string };
					return {
						...c,
						exitCode: e.exitCode,
						stdoutSha256: sha256(e.stdout),
						stdoutBytes: Buffer.byteLength(e.stdout),
						timedOut: false,
						truncated: false,
						matched: true,
					};
				}),
			}),
		);
		add({
			id: "9d",
			title: "consistent forgery of row 2's record",
			candidate: "B",
			condition: "every observation rewritten, resealed",
			expected: { S: "PASS" },
			observed: { S: forged.class },
			detail: {
				truth: truth.B,
				reader: forged,
				note: "expected PASS is undetectable forgery of an unsigned local record (as C8)",
			},
		});
	}

	// ---- acceptance (PROTOCOL.md §8) ----
	const by = (id: string) => rows.find((r) => r.id === id) as Row;
	const ok = (id: string, m: Mech) => by(id).observed[m] === by(id).expected[m];
	const r3 = by("3").detail.ordinary as ReturnType<typeof ordinary>;
	const sandboxDurations = rows
		.map((r) => (r.detail.sandbox as ReturnType<typeof verify> | undefined)?.summary)
		.filter((s) => s?.verdict === "PASS" || s?.verdict === "FAIL")
		.map((s) => s?.durationMs as number);
	const acceptance = {
		R1: {
			holds: ok("3", "O") && r3.problems === 0 && r3.receiptCount === 3,
			detail: "row 3: planned checks passed at HEAD for B; every receipt readable",
		},
		R2: {
			holds: ["1", "2", "4a", "4d", "5", "6", "8", "9b", "10"].every((id) => ok(id, "S")),
			detail: "S: A and P pass; B, C, D, E fail, under the launcher",
		},
		R3: {
			holds: ["4b", "7a", "7b", "7c", "7d", "7e", "9a", "9c"].every(
				(id) => ok(id, "S") && by(id).observed.S !== "PASS",
			),
			detail: "S: refused, interrupted and damaged rows have their expected class, never PASS",
		},
		R4: { holds: null, detail: "needs a second run: study.ts compare" },
		R5: {
			holds: sandboxDurations.every((d) => d < 60_000),
			detail: `S per-candidate duration, max ${Math.max(...sandboxDurations)} ms`,
		},
		R6: { holds: ok("6", "F") && ok("6", "S"), detail: "row 6: F PASS (false), S FAIL" },
		R6x: {
			holds: ok("6x", "F") && ok("6x", "S"),
			detail: "EXPLORATORY row 6x (not a preregistered criterion): F PASS (false), S FAIL",
		},
	};
	const readerDisagreements = rows.flatMap((r) =>
		(["filtered", "sandbox"] as const)
			.map((m) => [m, r.detail[m] as ReturnType<typeof verify> | undefined] as const)
			.filter(([, v]) => v !== undefined && v.reader.class !== v.verdict)
			.map(([m, v]) => ({ row: r.id, mechanism: m, verdict: v?.verdict, reader: v?.reader })),
	);
	const results = {
		study: "DEVELOP-VERIFY-TRUST-001",
		pin: PIN,
		host: {
			kernel: release(),
			node: exec("/usr/bin/node", ["--version"], { PATH: "/usr/bin" }, W).stdout.trim(),
			git: exec("/usr/bin/git", ["--version"], { PATH: "/usr/bin" }, W).stdout.trim(),
			bubblewrap: exec("/usr/bin/bwrap", ["--version"], { PATH: "/usr/bin" }, W).stdout.trim(),
			systemd: exec("/usr/bin/systemd-run", ["--version"], { PATH: "/usr/bin" }, W).stdout.split("\n")[0],
			repositoryHead: exec("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"], { PATH: "/usr/bin" }, W).stdout.trim(),
			repositoryClean:
				exec(
					"/usr/bin/git",
					["-C", REPO, "status", "--porcelain", "--untracked-files=no"],
					{ PATH: "/usr/bin" },
					W,
				).stdout.trim() === "",
		},
		commits,
		truth,
		rows: rows.map((r) => ({
			...r,
			agree: Object.fromEntries(
				(Object.keys(r.expected) as Mech[]).map((m) => [m, r.observed[m] === r.expected[m]]),
			),
		})),
		readerDisagreements,
		acceptance,
		wallMs: Date.now() - started,
	};
	writeFileSync(join(out, "results.json"), `${sanitize(JSON.stringify(results, null, 2))}\n`);
	process.stderr.write(
		`\nacceptance: ${JSON.stringify(Object.fromEntries(Object.entries(acceptance).map(([k, v]) => [k, v.holds])))}\n`,
	);
	process.stderr.write(
		`reader disagreements: ${JSON.stringify(readerDisagreements)}\nwall ${results.wallMs} ms; results: ${join(out, "results.json")}\n`,
	);
}

await main();
