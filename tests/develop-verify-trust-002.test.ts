// DEVELOP-VERIFY-TRUST-002 (research/develop-verify-trust-002/): the parts of the separate-principal design that need no sandbox and no
// second uid. The request parser, the object verifier, the record reader's authority rules (with another uid's files stood in for by an
// injected file system), the installation's import closure and its units.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { processStartTimeV0 } from "../adapters/sandbox/containment.ts";
import { accountGroups, audit, H0_LIMITS, look, polkitGrants } from "../research/develop-verify-trust-002/audit.ts";
import { collectObjects, encodeRequest } from "../research/develop-verify-trust-002/client/client.ts";
import {
	INSTALLED,
	importClosure,
	renderUnits,
	tmpfilesConf,
} from "../research/develop-verify-trust-002/install/layout.ts";
import { type ObjectType, objectId, resolveCandidate } from "../research/develop-verify-trust-002/service/objects.ts";
import {
	consumerVerdict,
	type FileSystem,
	hostFileSystem,
	readAuthoritative,
} from "../research/develop-verify-trust-002/service/records.ts";
import { MAX_REQUEST_BYTES, parsePeer, parseRequest } from "../research/develop-verify-trust-002/service/request.ts";
import {
	collectOrphans,
	compatibilitySignals,
	INSTALLATION_SCHEMA,
	type Observation,
	RECORD_SCHEMA,
	seal,
} from "../research/develop-verify-trust-002/service/verifier.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "dvt002-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_TRUSTED = (() => {
	try {
		return statSync("/usr/bin/git").uid === 0;
	} catch {
		return false;
	}
})();

const blob = Buffer.from('console.log("I");\n');
const tree = (entries: [string, string, Buffer][]) =>
	Buffer.concat(entries.map(([mode, name, id]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), id])));
const commitOf = (treeId: string) =>
	Buffer.from(`tree ${treeId}\nauthor t <t@example.invalid> 0 +0000\ncommitter t <t@example.invalid> 0 +0000\n\nc\n`);
/** A commit with the given root entries, as objects. */
function crafted(entries: [string, string, string][], extra: { type: ObjectType; data: Buffer }[] = []) {
	const t = tree(entries.map(([m, n, id]) => [m, n, Buffer.from(id, "hex")]));
	const c = commitOf(objectId("sha1", "tree", t));
	return {
		commit: objectId("sha1", "commit", c),
		objects: [
			{ type: "commit" as ObjectType, data: c },
			{ type: "tree" as ObjectType, data: t },
			{ type: "blob" as ObjectType, data: blob },
			...extra,
		],
	};
}
const blobId = objectId("sha1", "blob", blob);

describe("DEVELOP-VERIFY-TRUST-002 object transfer", () => {
	it("resolves a commit from its own objects, with object and byte identity", () => {
		const c = crafted([["100644", "roman.mjs", blobId]]);
		const r = resolveCandidate("sha1", c.commit, c.objects);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidate.files.map((f) => [f.path, f.mode, f.sha256])).toEqual([["roman.mjs", "100644", sha256(blob)]]);
		expect(r.candidate.exportSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses substituted, missing, extra, duplicated and wrong-typed objects", () => {
		const c = crafted([["100644", "roman.mjs", blobId]]);
		const other = { type: "blob" as ObjectType, data: Buffer.from("other\n") };
		// The tree names a blob the request does not carry; the bytes it carries instead hash to another id.
		expect(resolveCandidate("sha1", c.commit, [c.objects[0], c.objects[1], other] as never)).toEqual({
			ok: false,
			reason: "object-missing",
		});
		expect(resolveCandidate("sha1", c.commit, [...c.objects, other])).toEqual({
			ok: false,
			reason: "object-unreferenced",
		});
		expect(resolveCandidate("sha1", c.commit, [...c.objects, c.objects[2] as never])).toEqual({
			ok: false,
			reason: "object-duplicate",
		});
		const asTree = c.objects.map((o) => (o.type === "blob" ? { ...o, type: "tree" as ObjectType } : o));
		expect(resolveCandidate("sha1", c.commit, asTree).ok).toBe(false);
		expect(resolveCandidate("sha1", "0".repeat(40), c.objects)).toEqual({ ok: false, reason: "object-missing" });
	});

	it("refuses links, submodules, unplain and colliding names", () => {
		const reason = (entries: [string, string, string][]) => {
			const r = resolveCandidate("sha1", crafted(entries).commit, crafted(entries).objects);
			return r.ok ? "ok" : r.reason;
		};
		expect(reason([["120000", "link", blobId]])).toBe("unsupported-120000");
		expect(
			reason([
				["100644", "a", blobId],
				["160000", "sub", "1".repeat(40)],
			]),
		).toBe("unsupported-160000");
		for (const name of ["..", ".", ".git", ".GIT", "a b", "a\\b"])
			expect(reason([["100644", name, blobId]]), name).toBe("unsupported-name");
		expect(
			reason([
				["100644", "A", blobId],
				["100644", "a", blobId],
			]),
		).toBe("unsupported-name");
	});

	it.skipIf(!GIT_TRUSTED)("exports a real repository's commit exactly, SHA-1 and SHA-256 alike", () => {
		for (const format of ["sha1", "sha256"] as const) {
			const dir = join(scratch, `repo-${format}`);
			const env = {
				PATH: "/usr/bin",
				HOME: "/nonexistent",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			};
			const git = (...a: string[]) => {
				const r = spawnSync(
					"/usr/bin/git",
					["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a],
					{ env },
				);
				if (r.status !== 0) throw new Error(r.stderr.toString());
				return r.stdout.toString().trim();
			};
			mkdirSync(join(dir, "lib"), { recursive: true });
			writeFileSync(join(dir, "roman.mjs"), 'import "./lib/x.mjs";\n');
			writeFileSync(join(dir, "lib/x.mjs"), "export {};\n", { mode: 0o755 });
			git("init", "-q", `--object-format=${format}`);
			git("add", "-A");
			git("commit", "-q", "-m", "c");
			const commit = git("rev-parse", "HEAD");
			const got = collectObjects(dir, commit);
			expect(got.ok).toBe(true);
			if (!got.ok) continue;
			const r = resolveCandidate(format, commit, got.objects);
			expect(r.ok, format).toBe(true);
			if (!r.ok) continue;
			expect(r.candidate.files.map((f) => `${f.mode} ${f.path}`)).toEqual(["100755 lib/x.mjs", "100644 roman.mjs"]);
			expect(r.candidate.tree).toBe(git("rev-parse", "HEAD^{tree}"));
		}
	});
});

describe("DEVELOP-VERIFY-TRUST-002 request", () => {
	const c = crafted([["100644", "roman.mjs", blobId]]);
	const good = () => encodeRequest("roman-numerals-cli", "sha1", c.commit, c.objects);
	it("accepts exactly the request format", () => {
		const r = parseRequest(good());
		expect(r.ok).toBe(true);
	});
	it("refuses every field that could carry a program, a path, an environment, an option or an expected result", () => {
		for (const key of [
			"env",
			"argv",
			"executable",
			"command",
			"path",
			"oracle",
			"expect",
			"timeoutMs",
			"options",
			"cwd",
		]) {
			expect(
				parseRequest(encodeRequest("roman-numerals-cli", "sha1", c.commit, c.objects, { [key]: "x" })),
				key,
			).toEqual({
				ok: false,
				reason: "request-invalid",
			});
		}
		const withObjectKey = JSON.parse(good().toString()) as Record<string, any>;
		withObjectKey.objects[0].path = "../x";
		expect(parseRequest(Buffer.from(JSON.stringify(withObjectKey))).ok).toBe(false);
	});
	it("refuses paths as tasks, malformed ids, non-canonical base64, invalid UTF-8 and oversize", () => {
		expect(parseRequest(encodeRequest("../oracle", "sha1", c.commit, c.objects)).ok).toBe(false);
		expect(parseRequest(encodeRequest("roman-numerals-cli", "sha1", c.commit.toUpperCase(), c.objects)).ok).toBe(
			false,
		);
		const nonCanonical = JSON.parse(good().toString()) as Record<string, any>;
		nonCanonical.objects[2].data = `${nonCanonical.objects[2].data.slice(0, -2)}x=`;
		expect(parseRequest(Buffer.from(JSON.stringify(nonCanonical))).ok).toBe(false);
		expect(parseRequest(Buffer.from([0x7b, 0xff, 0x7d])).ok).toBe(false);
		expect(parseRequest(Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20))).toEqual({
			ok: false,
			reason: "request-too-large",
		});
	});
	it("reads the requester's pid and uid from systemd's instance name, and nothing else", () => {
		expect(parsePeer("0-72-362663_385246-1000")).toEqual({ pid: 362663, uid: 1000 });
		expect(parsePeer("3-12345-1000")).toEqual({ pid: 12345, uid: 1000 });
		for (const bad of ["", "x", "0-1-2-3-4", "0-12-a-1000", "0-1-2_3-1000; rm"])
			expect(parsePeer(bad), bad).toBeNull();
	});
});

// ---- the reader's authority rules, with ownership stood in for ----------------------------------------------------------------------

const VERIFIER = 4242;
const READER = 1000;
function setup(name: string) {
	const root = join(scratch, name);
	const install = join(root, "install");
	const state = join(root, "state");
	for (const d of [install, join(state, "records"), join(state, "journal")]) mkdirSync(d, { recursive: true });
	const pins = {
		dir: "oracle/t",
		manifestSha256: "a".repeat(64),
		referenceSha256: "b".repeat(64),
		negativeSha256: "c".repeat(64),
	};
	const installation = { schemaVersion: INSTALLATION_SCHEMA, mode: "installed", tasks: { t: pins }, files: [] };
	writeFileSync(join(install, "installation.json"), JSON.stringify(installation));
	const installationId = sha256(readFileSync(join(install, "installation.json")));
	const write = (verdict: "PASS" | "FAIL", commit = "1".repeat(40), exportSha256 = "e".repeat(64)) => {
		const id = randomBytes(16).toString("hex");
		const matched = verdict === "PASS";
		const cases: Observation[] = Array.from({ length: 3 }, (_, i) => ({
			name: `c${i}`,
			started: true,
			exitCode: 0,
			timedOut: false,
			truncated: false,
			termination: "confirmed",
			stdoutBytes: 1,
			stdoutSha256: "0".repeat(64),
			stderrHead: "",
			durationMs: 1,
			matched: i === 0 ? matched : true,
		}));
		const record: Record<string, unknown> = {
			schemaVersion: RECORD_SCHEMA,
			verdict,
			reason: null,
			invocation: { id },
			installation: { id: installationId },
			oracle: {
				task: "t",
				manifestSha256: pins.manifestSha256,
				referenceSha256: pins.referenceSha256,
				negativeSha256: pins.negativeSha256,
				cases: 3,
			},
			candidate: { commit, exportSha256 },
			qualification: { reference: "PASS", negative: "FAIL" },
			cases,
			recordSha256: null,
		};
		record.recordSha256 = seal(record);
		writeFileSync(join(state, "records", `${id}.json`), JSON.stringify(record));
		return id;
	};
	return { root, install, state, write };
}
/** The host's file system, except that ownership and modes are what `owner` says: root above, the verifier's below. */
function standIn(
	s: { install: string; state: string },
	change: (path: string, st: Stats) => Partial<Stats> = () => ({}),
): FileSystem {
	const as = (path: string, real: Stats): Stats => {
		const verifiers = path === s.state || path.startsWith(`${s.state}/`);
		const base = { uid: verifiers ? VERIFIER : 0, mode: real.mode & ~0o022, nlink: real.isFile() ? 1 : real.nlink };
		return Object.assign(Object.create(Object.getPrototypeOf(real)), real, base, change(path, real)) as Stats;
	};
	return {
		lstat: (path) => {
			const real = hostFileSystem.lstat(path);
			return real === undefined ? undefined : as(path, real);
		},
		readNoFollow: (path) => {
			const got = hostFileSystem.readNoFollow(path);
			return "error" in got ? got : { stat: as(path, got.stat), bytes: got.bytes };
		},
		uid: () => READER,
	};
}

describe("DEVELOP-VERIFY-TRUST-002 record authority", () => {
	const s = setup("authority");
	const pass = s.write("PASS");
	const read = (fs: FileSystem, invocation = pass, verifierUid = VERIFIER, expect = {}) =>
		readAuthoritative({ state: s.state, installDir: s.install, verifierUid, invocation, expect }, fs);

	it("accepts a record only where the verifier's ownership is complete (positive control of the rule)", () => {
		expect(read(standIn(s))).toMatchObject({ class: "PASS", authoritative: true });
	});
	it("never treats the reader's own files, or root's, as the verifier's", () => {
		expect(read(standIn(s), pass, READER)).toMatchObject({ authoritative: false, reason: "verifier-is-reader" });
		expect(read(standIn(s), pass, 0)).toMatchObject({ authoritative: false, reason: "verifier-is-root" });
		// The host as it is: everything here belongs to the user running the test.
		const own = hostFileSystem.uid();
		expect(read(hostFileSystem, pass, own)).toMatchObject({
			class: "PASS",
			authoritative: false,
			reason: "verifier-is-reader",
		});
	});
	it("refuses a record whose file, directory or ancestors anyone else could have written", () => {
		const file = join(s.state, "records", `${pass}.json`);
		const records = join(s.state, "records");
		const cases: [string, (p: string, st: Stats) => Partial<Stats>, RegExp][] = [
			["file owned by the reader", (p) => (p === file ? { uid: READER } : {}), /file-not-the-verifier's/],
			["file group-writable", (p, st) => (p === file ? { mode: st.mode | 0o020 } : {}), /file-not-the-verifier's/],
			["file with a second link", (p) => (p === file ? { nlink: 2 } : {}), /file-not-the-verifier's/],
			["records directory owned by the reader", (p) => (p === records ? { uid: READER } : {}), /not-the-verifier's/],
			[
				"records directory writable by others",
				(p, st) => (p === records ? { mode: st.mode | 0o002 } : {}),
				/not-the-verifier's/,
			],
			["state root's parent not root's", (p) => (p === dirname(s.state) ? { uid: READER } : {}), /not-root's/],
			[
				"installation manifest not root's",
				(p) => (p === join(s.install, "installation.json") ? { uid: READER } : {}),
				/not-root's/,
			],
		];
		for (const [name, change, reason] of cases) {
			const r = read(standIn(s, change));
			expect(r.authoritative, name).toBe(false);
			expect(r.reason, name).toMatch(reason);
		}
	});
	it("refuses a symbolic link, a forged id, an edited record and a record of another installation", () => {
		const link = randomBytes(16).toString("hex");
		spawnSync("/usr/bin/ln", [
			"-s",
			join(s.state, "records", `${pass}.json`),
			join(s.state, "records", `${link}.json`),
		]);
		expect(read(standIn(s), link)).toMatchObject({ class: "UNKNOWN", reason: "symbolic-link" });
		expect(read(standIn(s), "../../x")).toMatchObject({ class: "UNKNOWN", reason: "invocation-invalid" });
		const copy = randomBytes(16).toString("hex");
		writeFileSync(join(s.state, "records", `${copy}.json`), readFileSync(join(s.state, "records", `${pass}.json`)));
		expect(read(standIn(s), copy)).toMatchObject({ class: "UNKNOWN", reason: "invocation-mismatch" });
		const edited = JSON.parse(readFileSync(join(s.state, "records", `${pass}.json`), "utf8"));
		edited.verdict = "FAIL";
		writeFileSync(join(s.state, "records", `${pass}.json`), JSON.stringify(edited));
		expect(read(standIn(s))).toMatchObject({ class: "UNKNOWN", reason: "seal-mismatch" });
		edited.verdict = "PASS";
		edited.installation.id = "f".repeat(64);
		edited.recordSha256 = seal(edited);
		writeFileSync(join(s.state, "records", `${pass}.json`), JSON.stringify(edited));
		expect(read(standIn(s))).toMatchObject({ class: "UNKNOWN", reason: "installation-mismatch" });
	});
	it("binds a record to the commit and the export digest it is read for", () => {
		const t = setup("binding");
		const id = t.write("PASS", "2".repeat(40), "d".repeat(64));
		const r = (expect: Record<string, string>) =>
			readAuthoritative(
				{ state: t.state, installDir: t.install, verifierUid: VERIFIER, invocation: id, expect },
				standIn(t),
			);
		expect(r({ commit: "2".repeat(40), exportSha256: "d".repeat(64) })).toMatchObject({
			class: "PASS",
			authoritative: true,
		});
		expect(r({ commit: "3".repeat(40) })).toMatchObject({ class: "UNKNOWN", reason: "candidate-mismatch" });
		expect(r({ commit: "2".repeat(40), exportSha256: "9".repeat(64) })).toMatchObject({
			class: "UNKNOWN",
			reason: "export-mismatch",
		});
	});
	it("reads an invocation with a journal and no record as INCOMPLETE, never PASS", () => {
		const t = setup("incomplete");
		const id = randomBytes(16).toString("hex");
		writeFileSync(join(t.state, "journal", `${id}.jsonl`), "{}\n");
		expect(
			readAuthoritative(
				{ state: t.state, installDir: t.install, verifierUid: VERIFIER, invocation: id },
				standIn(t),
			),
		).toMatchObject({
			class: "INCOMPLETE",
			authoritative: false,
		});
	});
	it("gives a commit PASS only with an authoritative PASS and no authoritative FAIL for the same binding", () => {
		const t = setup("consumer");
		const q = {
			state: t.state,
			installDir: t.install,
			verifierUid: VERIFIER,
			commit: "5".repeat(40),
			exportSha256: "e".repeat(64),
		};
		expect(consumerVerdict(q, standIn(t)).verdict).toBe("NONE");
		t.write("PASS", q.commit);
		t.write("PASS", "6".repeat(40));
		expect(consumerVerdict(q, standIn(t)).verdict).toBe("PASS");
		t.write("FAIL", q.commit);
		expect(consumerVerdict(q, standIn(t)).verdict).toBe("FAIL");
		expect(consumerVerdict({ ...q, verifierUid: READER }, standIn(t)).verdict).toBe("NONE");
	});
});

describe("DEVELOP-VERIFY-TRUST-002 installation", () => {
	it("installs the verifier's whole value-import closure and nothing it only imports for types", () => {
		const closure = importClosure(
			(p) => readFileSync(join(REPO, p), "utf8"),
			[
				"research/develop-verify-trust-002/service/verifier.ts",
				"research/develop-verify-trust-002/service/records.ts",
			],
		);
		expect(closure).toEqual([
			"adapters/sandbox/bubblewrap.ts",
			"adapters/sandbox/containment.ts",
			"adapters/sandbox/preflight.ts",
			"research/develop-verify-trust-002/service/objects.ts",
			"research/develop-verify-trust-002/service/records.ts",
			"research/develop-verify-trust-002/service/request.ts",
			"research/develop-verify-trust-002/service/verifier.ts",
			"runtime/contracts/canonical-json.ts",
		]);
		// Everything Node would load: the closure's value imports are relative and stay inside it; no bare specifier, so no node_modules.
		for (const f of closure) {
			const text = readFileSync(join(REPO, f), "utf8");
			for (const m of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)";/gms)) {
				const spec = m[1] as string;
				if (spec.startsWith("node:")) continue;
				expect(closure, `${f} imports ${spec}`).toContain(relative(REPO, resolve(REPO, dirname(f), spec)));
			}
		}
	});
	it("renders units whose program, arguments and environment come only from the unit", () => {
		const units = renderUnits({ ...INSTALLED, conditionUser: INSTALLED.user });
		const service = units[`${INSTALLED.unit}@.service`] as string;
		expect(units[`${INSTALLED.unit}.socket`]).toContain("Accept=yes");
		expect(service).toContain(`ConditionUser=${INSTALLED.user}`);
		expect(service).toMatch(
			/^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/endo-verify-002\/\S+ serve --install \S+ --state \S+ --peer %i$/m,
		);
		expect(service).toContain("UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT");
		expect(service).not.toMatch(/%h|%S|\/home\/|sh -c|EnvironmentFile/);
		expect(lstatSync(join(REPO, "research/develop-verify-trust-002/install")).isDirectory()).toBe(true);
	});
	it("reads compatibility signals from failing cases only, as advice", () => {
		const o = (stderrHead: string, matched = false) => ({ stderrHead, matched }) as Observation;
		expect(compatibilitySignals([o("Error: EROFS: read-only file system"), o("ENOSPC", true)])).toEqual(["EROFS"]);
		expect(
			compatibilitySignals([o("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'"), o("spawn /bin/sh ENOENT")]),
		).toEqual(["ERR_MODULE_NOT_FOUND", "no-shell"]);
		expect(
			compatibilitySignals([o("Error: spawnSync /bin/sh ENOENT"), o("uv_os_get_passwd returned ENOENT")]),
		).toEqual(["no-passwd", "no-shell"]);
	});
});

describe("DEVELOP-VERIFY-TRUST-002 working directories (correction D1)", () => {
	it("collects only the directories of instances that are gone, and never one still being made", () => {
		const work = join(scratch, "work-d1");
		mkdirSync(work);
		const id = () => randomBytes(16).toString("hex");
		const startTime = processStartTimeV0(process.pid);
		const make = (name: string, owner?: object) => {
			mkdirSync(join(work, name));
			if (owner !== undefined) writeFileSync(join(work, name, "owner.json"), JSON.stringify(owner));
			return name;
		};
		const own = make(id(), { pid: process.pid, startTime });
		const live = make(id(), { pid: process.pid, startTime });
		const dead = make(id(), { pid: process.pid, startTime: "0" });
		const halfMade = make(`.new-${id()}`);
		const removed = collectOrphans(work, own);
		expect(removed).toEqual([dead]);
		expect(readdirSync(work).sort()).toEqual([own, live, halfMade].sort());
		// A half-made directory is collected only once no instance can still be making it.
		expect(collectOrphans(work, own, Date.now() + 11 * 60_000)).toEqual([halfMade]);
	});
});

describe("DEVELOP-VERIFY-TRUST-002 host audit (review V5)", () => {
	it("counts groups the account is configured for, not only those this process holds", () => {
		const account = {
			uid: 1500,
			passwd: "agent:x:1500:1500::/home/agent:/bin/sh\n",
			group: "agent:x:1500:\ndocker:x:962:other,agent\nlibvirt:x:954:agent\nwheel:x:998:\n",
			// The groups were dropped from this process (setpriv --clear-groups); newgrp would give them back.
			status: "Name:\tx\nGroups:\t1500 \n",
		};
		const groups = accountGroups(account);
		expect(groups.find((g) => g.name === "docker")).toMatchObject({ held: false, configured: true });
		expect(groups.map((g) => g.name).sort()).toEqual(["agent", "docker", "libvirt"]);
		const checks = audit(false, account).checks;
		expect(checks.find((c) => c.id === "h0-group-docker")?.ok).toBe(false);
		expect(checks.find((c) => c.id === "h0-group-libvirt")?.ok).toBe(false);
		expect(
			audit(false, { ...account, group: "agent:x:1500:\n" }).checks.find((c) => c.id === "h0-group-docker")?.ok,
		).toBe(true);
	});
	it("reports a path it cannot look up instead of failing (D3: CI's /run/podman is not searchable)", () => {
		const locked = join(scratch, "locked");
		mkdirSync(locked, { mode: 0o000 });
		try {
			// Root ignores the mode; the point is that look() never throws.
			expect(["EACCES", "absent"]).toContain(look(join(locked, "x.sock")));
		} finally {
			spawnSync("/usr/bin/chmod", ["700", locked]);
		}
	});
});

describe("DEVELOP-VERIFY-TRUST-002 operator review of the install plan", () => {
	it("removes the whole private staging directory: the variable the exit trap names is never reassigned", () => {
		const script = readFileSync(join(REPO, "research/develop-verify-trust-002/install/install.sh"), "utf8");
		const trap = /^trap 'rm -rf "\$(\w+)"' EXIT$/m.exec(script);
		expect(trap?.[1]).toBe("PRIVATE");
		const after = script.slice((trap?.index ?? 0) + (trap?.[0].length ?? 0));
		expect(after).not.toMatch(/^\s*PRIVATE=/m);
		// The package copy lives in it, and nothing is extracted outside it.
		expect(after).toContain('cp -- "$TARBALL" "$PRIVATE/package.tar"');
		expect(after).toContain('STAGE="$PRIVATE/x"');
	});
	it("gates the socket by its directory: the verifier's, mode 0750, the operator's group", () => {
		const conf = tmpfilesConf("noctem");
		expect(conf).toContain("d /run/endo-verify-002 0750 endo-verify-002 noctem -");
		expect(conf).toContain("d /var/lib/endo-verify-002 0755 endo-verify-002 endo-verify-002 -");
		for (const bad of ["", "a b", "x;rm", "-x", "root\nd /etc 0777"]) expect(() => tmpfilesConf(bad), bad).toThrow();
	});
	it("finds polkit rules that give the account's groups YES, says what it could not read, and states its limits", () => {
		const account = {
			uid: 1500,
			passwd: "agent:x:1500:1500::/home/agent:/bin/sh\n",
			group: "agent:x:1500:\nlibvirt:x:954:agent\nwheel:x:998:agent\n",
			status: "Groups:\t1500 954 998\n",
		};
		const files = (dir: string) =>
			dir.startsWith("/etc")
				? "EACCES"
				: [
						{ name: "50-libvirt.rules", text: 'if (subject.isInGroup("libvirt")) return polkit.Result.YES;' },
						{ name: "50-default.rules", text: 'return ["unix-group:wheel"]; // auth_admin' },
						{ name: "x.rules", text: 'if (subject.isInGroup("other")) return polkit.Result.YES;' },
						{ name: "u.rules", text: 'if (subject.user == "agent") return polkit.Result.YES;' },
					];
		const got = polkitGrants(account, files);
		expect(got.grants).toEqual([
			"/usr/share/polkit-1/rules.d/50-libvirt.rules: YES for libvirt",
			"/usr/share/polkit-1/rules.d/u.rules: YES for user agent",
		]);
		expect(got.unread).toEqual(["/etc/polkit-1/rules.d: EACCES"]);
		expect(H0_LIMITS.join(" ")).toMatch(/sudo/);
		expect(audit(false, account).scope).toMatch(/necessary check, not a proof/);
	});
});

describe("DEVELOP-VERIFY-TRUST-002 committed evidence", () => {
	const RESULTS = join(REPO, "research/develop-verify-trust-002/results");
	const load = (run: string) =>
		JSON.parse(readFileSync(join(RESULTS, run, "results.json"), "utf8")) as {
			commit: string;
			installationId: string;
			acceptance: Record<string, boolean>;
			records: { authoritative: number; authoritativeFalsePasses: string[]; overwritten: string[] };
			rows: { id: string; held: boolean; observed: string; positiveControl: boolean }[];
		};
	it("holds every rehearsal acceptance condition, identically in both runs, with no authoritative record", () => {
		const [a, b] = [load("run-1"), load("run-2")];
		for (const r of [a, b]) {
			expect(Object.values(r.acceptance).every(Boolean)).toBe(true);
			expect(r.records).toMatchObject({ authoritative: 0, authoritativeFalsePasses: [], overwritten: [] });
			expect(r.rows.every((row) => row.held)).toBe(true);
			expect(r.commit).toBe("c968895fc608ba3552e15d745b585315a08eb6fd");
		}
		expect(a.installationId).toBe(b.installationId);
		expect(a.rows.map((r) => [r.id, r.observed])).toEqual(b.rows.map((r) => [r.id, r.observed]));
		expect(a.rows.filter((r) => r.positiveControl).map((r) => r.id)).toEqual(["T6", "T7", "T8", "E6"]);
		// The confirmation run after the review corrections: another installation, the same observations.
		const c = load("run-3-corrected");
		expect(c.commit).toBe("e1c52e02e879732f5c9a90e07570375b2da3bee8");
		expect(Object.values(c.acceptance).every(Boolean)).toBe(true);
		expect(c.installationId).not.toBe(a.installationId);
		expect(c.rows.map((r) => [r.id, r.observed])).toEqual(a.rows.map((r) => [r.id, r.observed]));
	});
	it("keeps the committed record copies non-authoritative: they are copies, owned by whoever checked them out", () => {
		const dir = join(RESULTS, "run-1/records");
		const t1 = JSON.parse(readFileSync(join(dir, "T1-genuine-pass-A.json"), "utf8"));
		const forged = JSON.parse(readFileSync(join(dir, "T8a-forged-pass-B.json"), "utf8"));
		// Both are internally consistent: content alone cannot tell the forgery from the genuine record.
		expect(t1.recordSha256).toBe(seal(t1));
		expect(forged.recordSha256).toBe(seal(forged));
		expect(forged.verdict).toBe("PASS");
		expect(forged.candidate.commit).not.toBe(t1.candidate.commit);
	});
});
