// DEVELOP-VERIFY-TRUST-002: the installation layout and its units (INSTALL-PLAN.md). Research only.
//
// One function renders the units for both phases, and one function builds the installation tree from a commit, so that the rehearsal
// runs what the installed phase would install. Building is unprivileged: it writes a directory. Installing it (root ownership, the
// system user, linger) is INSTALL-PLAN.md's, and is not done here.
//
//   node layout.ts build --commit <id> --out <dir> --mode installed|rehearsal --operator-uid <uid> --operator-home <dir>
//   node layout.ts package --commit <id> --out <file.tar> --operator-uid <uid> --operator-home <dir>
//   node layout.ts units --mode installed|rehearsal [--install <dir> --state <dir> --socket <path>]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { GIT_ENV } from "../client/client.ts";
import { INSTALLATION_SCHEMA, type Installation } from "../service/verifier.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
export const REPOSITORY = resolve(HERE, "../../..");
const RESEARCH = "research/develop-verify-trust-002";
/** The entry points; everything they import (value imports, transitively) is installed with them. */
const ENTRIES = [`${RESEARCH}/service/verifier.ts`, `${RESEARCH}/service/records.ts`];
const ORACLE = "research/develop-verify-trust/oracle";
export const TASK = "roman-numerals-cli";

export const INSTALLED = {
	user: "endo-verify-002",
	install: "/usr/local/lib/endo-verify-002",
	state: "/var/lib/endo-verify-002",
	socket: "/run/endo-verify-002/verify.sock",
	unit: "endo-verify-002",
} as const;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Value imports only: `import type` is erased by Node's type stripping and never loaded. */
export function importClosure(read: (path: string) => string, entries: readonly string[]): string[] {
	const seen = new Set<string>();
	const walk = (path: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		const text = read(path);
		for (const m of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"(\.{1,2}\/[^"]+\.ts)";/gms))
			walk(relative(".", join(dirname(path), m[1] as string)));
	};
	for (const e of entries) walk(e);
	return [...seen].sort();
}

/** Build the installation tree for `commit` into `out` (which must not exist). Files come from Git objects, never from a working tree. */
export function build(options: {
	commit: string;
	out: string;
	mode: "installed" | "rehearsal";
	operatorUid: number;
	operatorHome: string;
	repository?: string;
}): Installation {
	const repo = options.repository ?? REPOSITORY;
	const show = (path: string): Buffer => {
		// Development only: the working tree. A recorded trial builds from a commit (rehearsal.ts refuses this).
		if (options.commit === "worktree") return readFileSync(join(repo, path));
		const r = spawnSync("/usr/bin/git", ["-C", repo, "cat-file", "blob", `${options.commit}:${path}`], {
			env: GIT_ENV,
			maxBuffer: 16 << 20,
		});
		if (r.status !== 0) throw new Error(`not in ${options.commit}: ${path}`);
		return r.stdout;
	};
	if (existsSync(options.out)) throw new Error(`${options.out} exists`);
	const code = importClosure((p) => show(p).toString("utf8"), ENTRIES);
	const files = new Map<string, Buffer>();
	for (const p of code) files.set(p, show(p));
	// Node decides a .ts file's module type from the nearest package.json; one at the root ends that walk inside the installation.
	files.set("package.json", Buffer.from(`${JSON.stringify({ type: "module", private: true }, null, 2)}\n`));
	const manifest = show(`${ORACLE}/manifest.json`);
	const oracle = JSON.parse(manifest.toString("utf8")) as { reference: string; negative: string };
	const reference = show(`${ORACLE}/${oracle.reference}`);
	const negative = show(`${ORACLE}/${oracle.negative}`);
	const oracleDir = `oracle/${TASK}`;
	files.set(`${oracleDir}/manifest.json`, manifest);
	files.set(`${oracleDir}/${oracle.reference}`, reference);
	files.set(`${oracleDir}/${oracle.negative}`, negative);
	for (const [p, b] of files) {
		mkdirSync(dirname(join(options.out, p)), { recursive: true });
		writeFileSync(join(options.out, p), b, { flag: "wx" });
	}
	const installation: Installation = {
		schemaVersion: INSTALLATION_SCHEMA,
		mode: options.mode,
		sourceCommit: options.commit,
		operatorUid: options.operatorUid,
		operatorHome: options.operatorHome,
		tools: { node: "/usr/bin/node", bwrap: "/usr/bin/bwrap", systemdRun: "/usr/bin/systemd-run" },
		files: [...files.keys()].sort().map((path) => ({ path, sha256: sha256(files.get(path) as Buffer) })),
		tasks: {
			[TASK]: {
				dir: oracleDir,
				manifestSha256: sha256(manifest),
				referenceSha256: sha256(reference),
				negativeSha256: sha256(negative),
			},
		},
	};
	writeFileSync(join(options.out, "installation.json"), `${canonicalEndoJsonV0(installation as never)}\n`, {
		flag: "wx",
	});
	return installation;
}

export interface UnitPaths {
	install: string;
	state: string;
	socket: string;
	unit: string;
	/** `ConditionUser=`: installed units sit in /etc/systemd/user, where every user's manager would see them. */
	conditionUser: string | null;
}

/** The two units. The same text for both phases, except the paths and the user condition. */
export function renderUnits(p: UnitPaths): Record<string, string> {
	const condition = p.conditionUser === null ? "" : `ConditionUser=${p.conditionUser}\n`;
	const socket = `# DEVELOP-VERIFY-TRUST-002 research verifier: one instance per connection. Research only.
[Unit]
Description=DEVELOP-VERIFY-TRUST-002 research verifier socket
${condition}
[Socket]
ListenStream=${p.socket}
SocketMode=0666
Accept=yes
MaxConnections=4

[Install]
WantedBy=sockets.target
`;
	const service = `# DEVELOP-VERIFY-TRUST-002 research verifier: one request on standard input, one response on standard output. Research only.
[Unit]
Description=DEVELOP-VERIFY-TRUST-002 research verifier (one request)
${condition}CollectMode=inactive-or-failed

[Service]
Type=exec
StandardInput=socket
StandardOutput=socket
StandardError=journal
ExecStart=/usr/bin/node ${p.install}/${RESEARCH}/service/verifier.ts serve --install ${p.install} --state ${p.state} --peer %i
WorkingDirectory=${p.state}
Environment=PATH=/usr/bin LANG=C.UTF-8
UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT
UMask=0022
NoNewPrivileges=yes
RuntimeMaxSec=900
TasksMax=1024
`;
	return { [`${p.unit}.socket`]: socket, [`${p.unit}@.service`]: service };
}

/** The principal: a locked system user, no login shell, a root-owned home that holds only masks (INSTALL-PLAN.md §2). */
export const SYSUSERS = `# DEVELOP-VERIFY-TRUST-002 research verifier principal. Research only; removed by uninstall.sh.
u! ${INSTALLED.user} - "DEVELOP-VERIFY-TRUST-002 research verifier" ${INSTALLED.state}-home /usr/bin/nologin
`;
/** The state directory (the verifier's) and the socket's directory (where its user manager creates the socket). */
export const TMPFILES = `# DEVELOP-VERIFY-TRUST-002 research verifier. Research only; removed by uninstall.sh.
d ${INSTALLED.state} 0755 ${INSTALLED.user} ${INSTALLED.user} -
d ${dirname(INSTALLED.socket)} 0755 ${INSTALLED.user} ${INSTALLED.user} -
`;

/**
 * The installed phase's package: `lib/` (the installation tree, built from the commit's objects) and `system/` (units, sysusers, tmpfiles),
 * as one tar with fixed names, order, times and owners, so that its SHA-256 can be checked before root extracts it.
 */
export function packageInstallation(options: {
	commit: string;
	out: string;
	operatorUid: number;
	operatorHome: string;
}): string {
	const stage = mkdtempSync(join(tmpdir(), "endo-verify-002-package-"));
	try {
		build({
			commit: options.commit,
			out: join(stage, "lib"),
			mode: "installed",
			operatorUid: options.operatorUid,
			operatorHome: options.operatorHome,
		});
		mkdirSync(join(stage, "system"));
		for (const [name, text] of Object.entries(renderUnits({ ...INSTALLED, conditionUser: INSTALLED.user })))
			writeFileSync(join(stage, "system", name), text);
		writeFileSync(join(stage, "system", "sysusers.conf"), SYSUSERS);
		writeFileSync(join(stage, "system", "tmpfiles.conf"), TMPFILES);
		const tar = spawnSync(
			"/usr/bin/tar",
			[
				"--sort=name",
				"--mtime=@0",
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				"--mode=u+rw,go+r,go-w",
				"--format=gnu",
				"-C",
				stage,
				"-cf",
				resolve(options.out),
				"lib",
				"system",
			],
			{ env: { PATH: "/usr/bin", LC_ALL: "C" }, encoding: "utf8" },
		);
		if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
		return sha256(readFileSync(resolve(options.out)));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

function arg(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const [command, ...rest] = process.argv.slice(2);
	const mode = arg(rest, "--mode") === "installed" ? "installed" : "rehearsal";
	if (command === "build") {
		const inst = build({
			commit: arg(rest, "--commit") ?? "",
			out: resolve(arg(rest, "--out") ?? ""),
			mode,
			operatorUid: Number(arg(rest, "--operator-uid") ?? "-1"),
			operatorHome: arg(rest, "--operator-home") ?? "",
		});
		const id = sha256(readFileSync(join(resolve(arg(rest, "--out") ?? ""), "installation.json")));
		process.stdout.write(
			`${JSON.stringify({ installationId: id, files: inst.files.length, tasks: Object.keys(inst.tasks) })}\n`,
		);
	} else if (command === "package") {
		const digest = packageInstallation({
			commit: arg(rest, "--commit") ?? "",
			out: arg(rest, "--out") ?? "",
			operatorUid: Number(arg(rest, "--operator-uid") ?? "-1"),
			operatorHome: arg(rest, "--operator-home") ?? "",
		});
		process.stdout.write(`${JSON.stringify({ package: arg(rest, "--out"), sha256: digest })}\n`);
	} else if (command === "units") {
		const units = renderUnits(
			mode === "installed"
				? { ...INSTALLED, conditionUser: INSTALLED.user }
				: {
						install: arg(rest, "--install") ?? "",
						state: arg(rest, "--state") ?? "",
						socket: arg(rest, "--socket") ?? "",
						unit: "endo-dvt002-rehearsal",
						conditionUser: null,
					},
		);
		for (const [name, text] of Object.entries(units)) process.stdout.write(`### ${name}\n${text}\n`);
	} else {
		process.stderr.write("usage: layout.ts build ... | layout.ts units ...\n");
		process.exitCode = 64;
	}
}
