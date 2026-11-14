// DEVELOP-VERIFY-TRUST-002: the client (ARCHITECTURE.md §5). Research only.
//
// The client is the agent's, and it is not trusted: whatever it sends, the verifier recomputes every object id and resolves the commit
// itself. It reads the candidate repository under 001's C1 environment so that an honest client sends the commit's own objects, and it
// is also what a consumer uses to compute the export digest of its own copy of a commit before it accepts a record.
//
//   node client.ts submit --socket <path> --repo <dir> --commit <id> [--task <name>]
//   node client.ts digest --repo <dir> --commit <id>

import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { type ObjectFormat, type ObjectType, resolveCandidate } from "../service/objects.ts";
import { REQUEST_SCHEMA } from "../service/request.ts";

export const GIT_ENV = {
	PATH: "/usr/bin",
	HOME: "/nonexistent",
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_NO_REPLACE_OBJECTS: "1",
	GIT_NO_LAZY_FETCH: "1",
	GIT_OPTIONAL_LOCKS: "0",
};

const git = (repo: string, args: string[], input?: Buffer) =>
	spawnSync("/usr/bin/git", ["-C", repo, ...args], { env: GIT_ENV, input, maxBuffer: 64 << 20, timeout: 30_000 });

/** The commit's own objects: the commit, every tree under it and every blob, read from Git's object store. */
export function collectObjects(
	repo: string,
	commit: string,
):
	| { ok: true; objectFormat: ObjectFormat; objects: { type: ObjectType; data: Buffer }[] }
	| { ok: false; reason: string } {
	const format = git(repo, ["rev-parse", "--show-object-format"]).stdout?.toString().trim();
	if (format !== "sha1" && format !== "sha256") return { ok: false, reason: "repository-unreadable" };
	const list = git(repo, ["ls-tree", "-r", "-t", "-z", "--full-tree", "--end-of-options", commit]);
	if (list.status !== 0) return { ok: false, reason: "commit-unreadable" };
	const ids = new Set<string>([commit]);
	const tree = git(repo, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
	if (tree.status !== 0) return { ok: false, reason: "commit-unreadable" };
	ids.add(tree.stdout.toString().trim());
	for (const entry of list.stdout.toString("utf8").split("\0")) {
		// Blobs and trees only: a submodule entry names a commit of another repository, which is not here (the verifier refuses the entry).
		const m = /^\d{5,6} (?:blob|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(entry);
		if (m !== null) ids.add(m[1] as string);
	}
	const batch = git(repo, ["cat-file", "--batch"], Buffer.from(`${[...ids].join("\n")}\n`));
	if (batch.status !== 0) return { ok: false, reason: "object-unreadable" };
	const out = batch.stdout;
	const objects: { type: ObjectType; data: Buffer }[] = [];
	let i = 0;
	while (i < out.length) {
		const nl = out.indexOf(0x0a, i);
		const header = out.subarray(i, nl).toString("latin1");
		const m = /^[0-9a-f]+ (commit|tree|blob) (\d+)$/.exec(header);
		if (m === null) return { ok: false, reason: "object-unreadable" };
		const size = Number(m[2]);
		objects.push({ type: m[1] as ObjectType, data: Buffer.from(out.subarray(nl + 1, nl + 1 + size)) });
		i = nl + 1 + size + 1;
	}
	return { ok: true, objectFormat: format, objects };
}

export function encodeRequest(
	task: string,
	objectFormat: ObjectFormat,
	commit: string,
	objects: readonly { type: ObjectType; data: Buffer }[],
	extra: Record<string, unknown> = {},
): Buffer {
	return Buffer.from(
		JSON.stringify({
			schemaVersion: REQUEST_SCHEMA,
			task,
			objectFormat,
			commit,
			objects: objects.map((o) => ({ type: o.type, data: o.data.toString("base64") })),
			...extra,
		}),
	);
}

/** Send one request and read one response line. `hangUp` closes the connection right after sending, without reading. */
export function send(
	socket: string,
	bytes: Buffer,
	options: { timeoutMs?: number; hangUp?: boolean } = {},
): Promise<{ ok: true; response: Record<string, unknown> | null; raw: string } | { ok: false; reason: string }> {
	return new Promise((done) => {
		const s = connect({ path: socket });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			s.destroy();
			done({ ok: false, reason: "timeout" });
		}, options.timeoutMs ?? 300_000);
		s.on("error", (e) => {
			clearTimeout(timer);
			done({ ok: false, reason: `service-unavailable: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
		});
		s.on("connect", () => {
			s.end(bytes, () => {
				if (options.hangUp !== true) return;
				s.destroy();
				clearTimeout(timer);
				done({ ok: true, response: null, raw: "" });
			});
		});
		s.on("data", (c) => chunks.push(c));
		s.on("close", () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks).toString("utf8");
			let response: Record<string, unknown> | null = null;
			try {
				response = JSON.parse(raw.trim()) as Record<string, unknown>;
			} catch {
				response = null;
			}
			done({ ok: true, response, raw });
		});
	});
}

function arg(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	const [command, ...rest] = process.argv.slice(2);
	const repo = arg(rest, "--repo") ?? ".";
	const commit = arg(rest, "--commit") ?? "";
	const collected = collectObjects(repo, commit);
	if (!collected.ok) {
		process.stdout.write(`${JSON.stringify({ verdict: "BLOCKED", reason: `client-${collected.reason}` })}\n`);
		process.exitCode = 3;
	} else if (command === "digest") {
		const r = resolveCandidate(collected.objectFormat, commit, collected.objects);
		process.stdout.write(`${JSON.stringify(r.ok ? { commit, exportSha256: r.candidate.exportSha256 } : r)}\n`);
		process.exitCode = r.ok ? 0 : 1;
	} else if (command === "submit") {
		const bytes = encodeRequest(
			arg(rest, "--task") ?? "roman-numerals-cli",
			collected.objectFormat,
			commit,
			collected.objects,
		);
		const got = await send(arg(rest, "--socket") ?? "", bytes);
		process.stdout.write(`${got.ok ? got.raw.trim() : JSON.stringify({ verdict: "BLOCKED", reason: got.reason })}\n`);
		process.exitCode = got.ok && got.response?.verdict === "PASS" ? 0 : 1;
	} else {
		process.stderr.write(
			"usage: client.ts submit --socket s --repo r --commit c | client.ts digest --repo r --commit c\n",
		);
		process.exitCode = 64;
	}
}
