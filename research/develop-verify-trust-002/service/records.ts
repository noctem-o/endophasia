// DEVELOP-VERIFY-TRUST-002: reading records, and their authority (ARCHITECTURE.md §6). Research only.
//
// A record's content cannot authenticate it (001's 9d). Authority comes from where it is and who owns it: a record is authoritative only
// as `records/<invocation>.json` under the configured state root, owned with every directory on the way by the configured verifier uid,
// which must be neither the reader's own uid nor root, with every ancestor of the state root owned by root, nothing writable by group or
// others, and no symbolic link anywhere. Its content must then be consistent, and bound to what the consumer asks about.
//
//   node records.ts read <invocation> --state <dir> --install <dir> --verifier-uid <uid> [--commit c] [--export-sha256 e]
//   node records.ts commit --state <dir> --install <dir> --verifier-uid <uid> --commit c --export-sha256 e

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	INVOCATION,
	type Installation,
	type Observation,
	RECORD_SCHEMA,
	seal,
	type Verdict,
	verdictOf,
} from "./verifier.ts";

export type ReadClass = Verdict | "UNKNOWN";
export interface Read {
	class: ReadClass;
	authoritative: boolean;
	reason: string | null;
	record?: Record<string, unknown>;
}
/** The file system as the reader sees it; injectable so that tests can stand in for another uid's files. */
export interface FileSystem {
	lstat(path: string): Stats | undefined;
	/** Open without following a final symbolic link, `fstat` the descriptor, read it. */
	readNoFollow(path: string): { stat: Stats; bytes: Buffer } | { error: string };
	uid(): number;
}

export const hostFileSystem: FileSystem = {
	lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
	readNoFollow(path) {
		let fd: number;
		try {
			fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (e) {
			return { error: String((e as NodeJS.ErrnoException).code ?? "error") };
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) return { error: "not-a-file" };
			return { stat, bytes: readFileSync(fd) };
		} finally {
			closeSync(fd);
		}
	},
	uid: () => process.getuid?.() ?? -1,
};

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const writableByOthers = (s: Stats) => (s.mode & 0o022) !== 0;

/** Why `state` and its records directory are not the verifier's, or null when they are (rule 2 for directories). */
export function ownershipProblem(
	fs: FileSystem,
	state: string,
	verifierUid: number,
	installDir: string,
): string | null {
	if (verifierUid === 0) return "verifier-is-root";
	if (verifierUid === fs.uid()) return "verifier-is-reader";
	// The installation manifest the reader compares against is root's, and so is every directory above it and above the state root.
	const rootOwned = [join(installDir, "installation.json"), installDir, dirname(state)];
	for (const start of rootOwned)
		for (let p = start; ; p = dirname(p)) {
			const s = fs.lstat(p);
			if (s === undefined || s.isSymbolicLink()) return `not-root's: ${p}`;
			if (s.uid !== 0 || writableByOthers(s)) return `not-root's: ${p}`;
			if (p === "/") break;
		}
	for (const d of [state, join(state, "records")]) {
		const s = fs.lstat(d);
		if (s === undefined || !s.isDirectory()) return `not-a-directory: ${d}`;
		if (s.uid !== verifierUid || writableByOthers(s)) return `not-the-verifier's: ${d}`;
	}
	return null;
}

/** Content checks: what the verifier itself would have written. They guard against damage, never against a forger. */
export function contentProblem(r: unknown, installationId: string, installation: Installation): string | null {
	if (typeof r !== "object" || r === null || Array.isArray(r)) return "not-a-record";
	const rec = r as Record<string, unknown>;
	if (rec.schemaVersion !== RECORD_SCHEMA) return "not-a-record";
	if (rec.recordSha256 !== seal(rec)) return "seal-mismatch";
	if ((rec.installation as { id?: unknown } | null)?.id !== installationId) return "installation-mismatch";
	const verdict = rec.verdict as Verdict;
	if (verdict === "BLOCKED") return null;
	const oracle = rec.oracle as Record<string, unknown> | null;
	const pin = typeof oracle?.task === "string" ? installation.tasks[oracle.task] : undefined;
	if (
		pin === undefined ||
		oracle?.manifestSha256 !== pin.manifestSha256 ||
		oracle?.referenceSha256 !== pin.referenceSha256 ||
		oracle?.negativeSha256 !== pin.negativeSha256
	)
		return "oracle-mismatch";
	const cases = rec.cases as Observation[];
	if (!Array.isArray(cases)) return "cases-unreadable";
	const total = oracle.cases;
	if (typeof total !== "number") return "cases-unreadable";
	const q = rec.qualification as Record<string, unknown> | null;
	if (verdict !== "INCOMPLETE" && (q?.reference !== "PASS" || q?.negative !== "FAIL"))
		return "qualification-inconsistent";
	if (verdict !== "INCOMPLETE" && verdictOf(cases, total) !== verdict) return "verdict-inconsistent";
	return null;
}

/** Rule 1 to 5, for one invocation id. `expect` is the consumer's binding; each field present must match. */
export function readAuthoritative(
	options: {
		state: string;
		installDir: string;
		verifierUid: number;
		invocation: string;
		expect?: { commit?: string; exportSha256?: string };
	},
	fs: FileSystem = hostFileSystem,
): Read {
	if (!INVOCATION.test(options.invocation))
		return { class: "UNKNOWN", authoritative: false, reason: "invocation-invalid" };
	const state = resolve(options.state);
	const file = join(state, "records", `${options.invocation}.json`);
	let installationBytes: Buffer;
	let installation: Installation;
	try {
		installationBytes = readFileSync(join(options.installDir, "installation.json"));
		installation = JSON.parse(installationBytes.toString("utf8")) as Installation;
	} catch {
		return { class: "UNKNOWN", authoritative: false, reason: "installation-unreadable" };
	}
	const got = fs.readNoFollow(file);
	if ("error" in got) {
		// No record: a journal means the invocation started and never finished.
		const journal = fs.lstat(join(state, "journal", `${options.invocation}.jsonl`));
		if (got.error === "ENOENT" && journal?.isFile())
			return { class: "INCOMPLETE", authoritative: false, reason: "journal-without-record" };
		return {
			class: "UNKNOWN",
			authoritative: false,
			reason: got.error === "ELOOP" ? "symbolic-link" : `no-record: ${got.error}`,
		};
	}
	let record: unknown;
	try {
		record = JSON.parse(got.bytes.toString("utf8"));
	} catch {
		return { class: "UNKNOWN", authoritative: false, reason: "unreadable" };
	}
	const content = contentProblem(record, sha256(installationBytes), installation);
	if (content !== null) return { class: "UNKNOWN", authoritative: false, reason: content };
	const rec = record as Record<string, unknown>;
	if ((rec.invocation as { id?: unknown } | null)?.id !== options.invocation)
		return { class: "UNKNOWN", authoritative: false, reason: "invocation-mismatch" };
	const candidate = rec.candidate as { commit?: unknown; exportSha256?: unknown } | null;
	if (options.expect?.commit !== undefined && candidate?.commit !== options.expect.commit)
		return { class: "UNKNOWN", authoritative: false, reason: "candidate-mismatch" };
	if (options.expect?.exportSha256 !== undefined && candidate?.exportSha256 !== options.expect.exportSha256)
		return { class: "UNKNOWN", authoritative: false, reason: "export-mismatch" };
	const cls = rec.verdict as Verdict;
	// Authority: the directories, then this very file (by the descriptor that was read).
	const owner = ownershipProblem(fs, state, options.verifierUid, resolve(options.installDir));
	const fileProblem =
		got.stat.uid !== options.verifierUid || writableByOthers(got.stat) || got.stat.nlink !== 1
			? "file-not-the-verifier's"
			: null;
	const problem = owner ?? fileProblem;
	return {
		class: cls,
		authoritative: problem === null,
		reason: problem ?? (rec.reason as string | null) ?? null,
		record: rec,
	};
}

/** The consumer rule for one commit (ARCHITECTURE.md §6): PASS only with an authoritative PASS and no authoritative FAIL, same binding. */
export function consumerVerdict(
	options: { state: string; installDir: string; verifierUid: number; commit: string; exportSha256: string },
	fs: FileSystem = hostFileSystem,
): { verdict: "PASS" | "FAIL" | "NONE"; records: { invocation: string; class: ReadClass; authoritative: boolean }[] } {
	const ids = readdirSync(join(options.state, "records"))
		.filter((n) => /^[0-9a-f]{32}\.json$/.test(n))
		.map((n) => n.slice(0, 32));
	const records: { invocation: string; class: ReadClass; authoritative: boolean }[] = [];
	for (const invocation of ids) {
		const r = readAuthoritative(
			{ ...options, invocation, expect: { commit: options.commit, exportSha256: options.exportSha256 } },
			fs,
		);
		if (r.reason === "candidate-mismatch" || r.reason === "export-mismatch") continue;
		records.push({ invocation, class: r.class, authoritative: r.authoritative });
	}
	const auth = records.filter((r) => r.authoritative);
	const verdict = auth.some((r) => r.class === "FAIL")
		? "FAIL"
		: auth.some((r) => r.class === "PASS")
			? "PASS"
			: "NONE";
	return { verdict, records };
}

function arg(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const [command, ...rest] = process.argv.slice(2);
	const common = {
		state: arg(rest, "--state") ?? "",
		installDir: arg(rest, "--install") ?? "",
		verifierUid: Number(arg(rest, "--verifier-uid") ?? "-1"),
	};
	if (command === "read" && rest[0] !== undefined) {
		const commit = arg(rest, "--commit");
		const exportSha256 = arg(rest, "--export-sha256");
		const r = readAuthoritative({
			...common,
			invocation: rest[0],
			expect: {
				...(commit === undefined ? {} : { commit }),
				...(exportSha256 === undefined ? {} : { exportSha256 }),
			},
		});
		process.stdout.write(`${JSON.stringify({ class: r.class, authoritative: r.authoritative, reason: r.reason })}\n`);
		process.exitCode = r.class === "PASS" && r.authoritative ? 0 : 1;
	} else if (command === "commit") {
		const r = consumerVerdict({
			...common,
			commit: arg(rest, "--commit") ?? "",
			exportSha256: arg(rest, "--export-sha256") ?? "",
		});
		process.stdout.write(`${JSON.stringify(r)}\n`);
		process.exitCode = r.verdict === "PASS" ? 0 : 1;
	} else {
		process.stderr.write("usage: records.ts read <invocation> ... | records.ts commit ...\n");
		process.exitCode = 64;
	}
}
