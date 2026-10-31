/**
 * Pi runtime-content identity (adapters/pi/runtime-content.ts, endo.harness-fingerprint.v1, endo.harness-change.v1).
 *
 * Three groups. (1) The digest itself, on throwaway trees: determinism, sensitivity, the filesystem boundary, bounds,
 * and the rule that incomplete coverage yields no digest at all. (2) Fingerprints of fake-Pi installs shaped like
 * npm's layout: a same-version edit behind an unchanged launcher is seen, and the v0 algorithm provably is not
 * (these assertions fail under the launcher-only identity). (3) History: v0 records stay readable and unchanged in a
 * mixed registry, a new basis never inherits old evidence, and nothing says the runtime changed merely because the
 * basis did. No test runs a model provider; the fake Pi is never evidence about a real release.
 */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piAssessmentV0, renderPiAssessmentV0 } from "../adapters/pi/assessment.ts";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { piChangeV0, piFingerprintDifferencesV0, piNotificationV0 } from "../adapters/pi/evidence.ts";
import { fingerprintPiRuntimeV0 } from "../adapters/pi/identity.ts";
import { hashPiRuntimeContentV1, piRuntimeContentScopeV1 } from "../adapters/pi/runtime-content.ts";
import { harnessStatusCommand } from "../cli/harness.ts";
import {
	type EndoHarnessFingerprintV0,
	type EndoHarnessFingerprintV1,
	endoHarnessIdentityBasisV0,
	endoHarnessIdentityBasisV1,
	endoHarnessObservationBasisV0,
	validateEndoHarnessChangeV0,
	validateEndoHarnessChangeV1,
	validateEndoHarnessFingerprintV0,
	validateEndoHarnessFingerprintV1,
} from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});
const scratch = (prefix: string): string => {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
};

/** A package with `dist/bundle` holding a launcher, a runtime file and two chunks; returns the paths. */
function tree(files: Record<string, string> = {}) {
	const packageRoot = scratch("endo-rc-");
	const bundle = join(packageRoot, "dist", "bundle");
	const all = {
		"cli.js": "#!/usr/bin/env node\nrequire('./cli-runtime.js');\n",
		"cli-runtime.js": "import './chunks/chunk-A.js';\n",
		"chunks/chunk-A.js": "export const a = 1;\n",
		"chunks/chunk-B.js": "export const b = 2;\n",
		...files,
	};
	for (const [relative, content] of Object.entries(all)) {
		mkdirSync(dirname(join(bundle, relative)), { recursive: true });
		writeFileSync(join(bundle, relative), content);
	}
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
	return { packageRoot, bundle, entrypoint: join(bundle, "cli.js") };
}

const digestOf = async (t: { packageRoot: string; entrypoint: string }, extra = {}) => {
	const result = await hashPiRuntimeContentV1({ entrypoint: t.entrypoint, packageRoot: t.packageRoot, ...extra });
	return result.ok ? result.content.sha256 : result;
};

describe("the runtime-content digest", () => {
	it("is identical for an identical tree, wherever and in whatever order it was written", async () => {
		const a = tree();
		const b = tree({}); // same content, written in the same order…
		expect(await digestOf(a)).toBe(await digestOf(b));
		// …and written in the opposite order, in a different directory.
		const c = scratch("endo-rc-");
		const bundle = join(c, "dist", "bundle");
		for (const [relative, content] of [
			["chunks/chunk-B.js", "export const b = 2;\n"],
			["chunks/chunk-A.js", "export const a = 1;\n"],
			["cli-runtime.js", "import './chunks/chunk-A.js';\n"],
			["cli.js", "#!/usr/bin/env node\nrequire('./cli-runtime.js');\n"],
		] as const) {
			mkdirSync(dirname(join(bundle, relative)), { recursive: true });
			writeFileSync(join(bundle, relative), content);
		}
		writeFileSync(join(c, "package.json"), "{}");
		expect(await digestOf({ packageRoot: c, entrypoint: join(bundle, "cli.js") })).toBe(await digestOf(a));
	});

	it("changes when one byte of the runtime file or of a chunk changes", async () => {
		const t = tree();
		const before = await digestOf(t);
		appendFileSync(join(t.bundle, "cli-runtime.js"), " ");
		const afterRuntime = await digestOf(t);
		expect(afterRuntime).not.toBe(before);
		writeFileSync(join(t.bundle, "cli-runtime.js"), "import './chunks/chunk-A.js';\n");
		expect(await digestOf(t)).toBe(before);
		writeFileSync(join(t.bundle, "chunks", "chunk-B.js"), "export const b = 3;\n");
		expect(await digestOf(t)).not.toBe(before);
	});

	it("changes when a covered file is added, removed or renamed, without any file list", async () => {
		const t = tree();
		const before = await digestOf(t);
		writeFileSync(join(t.bundle, "chunks", "chunk-NEW-FROM-A-LATER-RELEASE.js"), "export {};\n");
		const added = await digestOf(t);
		expect(added).not.toBe(before);
		rmSync(join(t.bundle, "chunks", "chunk-NEW-FROM-A-LATER-RELEASE.js"));
		rmSync(join(t.bundle, "chunks", "chunk-B.js"));
		expect(await digestOf(t)).not.toBe(before);
		writeFileSync(join(t.bundle, "chunks", "chunk-B2.js"), "export const b = 2;\n"); // same bytes, other name
		expect(await digestOf(t)).not.toBe(before);
	});

	it("ignores modification times, permissions and files outside the scope", async () => {
		const t = tree();
		const before = await digestOf(t);
		const past = new Date("2001-01-01T00:00:00Z");
		utimesSync(join(t.bundle, "chunks", "chunk-A.js"), past, past);
		utimesSync(join(t.bundle, "cli-runtime.js"), past, past);
		chmodSync(join(t.bundle, "cli-runtime.js"), 0o600);
		// Credentials, configuration, docs and dependencies beside the bundle are not Pi's executable content.
		writeFileSync(join(t.packageRoot, ".env"), "OPENAI_API_KEY=sk-not-real\n");
		writeFileSync(join(t.packageRoot, "auth.json"), '{"token":"x"}');
		mkdirSync(join(t.packageRoot, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(t.packageRoot, "node_modules", "dep", "index.js"), "1");
		writeFileSync(join(t.packageRoot, "dist", "other.js"), "outside the entrypoint's directory");
		expect(await digestOf(t)).toBe(before);
	});

	it("records a symbolic link by its text and covers its target by its own entry; retargeting changes the digest", async () => {
		const t = tree();
		const before = await digestOf(t);
		symlinkSync("chunks/chunk-A.js", join(t.bundle, "alias.js"));
		const linked = await digestOf(t);
		expect(typeof linked).toBe("string");
		expect(linked).not.toBe(before);
		rmSync(join(t.bundle, "alias.js"));
		symlinkSync("chunks/chunk-B.js", join(t.bundle, "alias.js"));
		expect(await digestOf(t)).not.toBe(linked);
	});

	it("ends coverage, with no digest, on a link out of scope, a dangling or cyclic link, a special file, node_modules, an odd name", async () => {
		const outside = scratch("endo-rc-outside-");
		writeFileSync(join(outside, "secret.js"), "outside");
		const cases: [string, (t: ReturnType<typeof tree>) => void, RegExp][] = [
			["out-of-scope link", (t) => symlinkSync(join(outside, "secret.js"), join(t.bundle, "x.js")), /outside/],
			["dangling link", (t) => symlinkSync("nope.js", join(t.bundle, "x.js")), /dangling|cyclic/],
			[
				"cyclic links",
				(t) => {
					symlinkSync("b.js", join(t.bundle, "a.js"));
					symlinkSync("a.js", join(t.bundle, "b.js"));
				},
				/dangling|cyclic/,
			],
			["link to a directory outside", (t) => symlinkSync(outside, join(t.bundle, "dir")), /outside/],
			["a FIFO", (t) => execFileSync("mkfifo", [join(t.bundle, "pipe")]), /not a regular file/],
			["node_modules in scope", (t) => mkdirSync(join(t.bundle, "node_modules")), /node_modules/],
			["a newline in a name", (t) => writeFileSync(join(t.bundle, "a\nb.js"), "x"), /clean text/],
		];
		for (const [name, mutate, reason] of cases) {
			const t = tree();
			mutate(t);
			const result = await hashPiRuntimeContentV1({ entrypoint: t.entrypoint, packageRoot: t.packageRoot });
			expect(result.ok, name).toBe(false);
			if (!result.ok) expect(result.reason, name).toMatch(reason);
		}
	});

	it("does not follow a link that loops back inside the scope, so it cannot traverse forever", async () => {
		const t = tree();
		symlinkSync(".", join(t.bundle, "chunks", "self"));
		const result = await hashPiRuntimeContentV1({ entrypoint: t.entrypoint, packageRoot: t.packageRoot });
		expect(result.ok).toBe(true);
	});

	it("never truncates: every bound ends coverage instead of yielding a smaller digest", async () => {
		const t = tree();
		const reasons: [Partial<Parameters<typeof hashPiRuntimeContentV1>[0]["limits"]>, RegExp][] = [
			[{ maxEntries: 3 }, /more than 3 entries/],
			[{ maxFileBytes: 10 }, /over the 10-byte file bound/],
			[{ maxTotalBytes: 20 }, /over the 20-byte bound/],
			[{ maxDepth: 0 }, /deeper than 0/],
			[{ maxDirectories: 1 }, /more than 1 directories/],
		];
		for (const [limits, reason] of reasons) {
			const result = await hashPiRuntimeContentV1({ entrypoint: t.entrypoint, packageRoot: t.packageRoot, limits });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(reason);
		}
		// A deadline that has already passed.
		let ticks = 0;
		const late = await hashPiRuntimeContentV1({
			entrypoint: t.entrypoint,
			packageRoot: t.packageRoot,
			limits: { deadlineMs: 5 },
			now: () => {
				ticks += 10;
				return ticks;
			},
		});
		expect(late).toMatchObject({ ok: false });
		// Within bounds the same tree is covered completely.
		expect(await digestOf(t, { limits: { maxEntries: 4, maxDepth: 1 } })).toMatch(/^[0-9a-f]{64}$/);
	});

	it("detects a change made while it was being read, and reports no digest", async () => {
		const edits: [string, (t: ReturnType<typeof tree>) => void][] = [
			["a file edited", (t) => appendFileSync(join(t.bundle, "chunks", "chunk-A.js"), "// x\n")],
			["a file added", (t) => writeFileSync(join(t.bundle, "late.js"), "x")],
			["a file removed", (t) => rmSync(join(t.bundle, "chunks", "chunk-B.js"))],
		];
		for (const [name, edit] of edits) {
			const t = tree();
			const result = await hashPiRuntimeContentV1({
				entrypoint: t.entrypoint,
				packageRoot: t.packageRoot,
				afterHashing: async () => edit(t),
			});
			expect(result.ok, name).toBe(false);
			if (!result.ok) expect(result.reason, name).toMatch(/while the fingerprint was being taken/);
		}
	});

	it("supports no scope for an entrypoint in the package root, outside any package, or inside node_modules", async () => {
		const root = scratch("endo-rc-");
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "cli.js"), "x");
		expect(piRuntimeContentScopeV1(join(root, "cli.js"), root)).toMatch(/package root/);
		expect(piRuntimeContentScopeV1("/usr/bin/pi", "/opt/elsewhere")).toMatch(/not inside/);
		expect(piRuntimeContentScopeV1(join(root, "node_modules", "x", "cli.js"), root)).toMatch(/node_modules/);
		expect(piRuntimeContentScopeV1(join(root, "dist", "bundle", "cli.js"), root)).toEqual({
			scopeDir: join(root, "dist", "bundle"),
			scope: "dist/bundle",
		});
	});
});

function install(version = "1.0.0") {
	const fake = installFakePi(version);
	cleanup.push(() => fake.remove());
	return fake;
}
const fingerprintOf = (executable: string, extra: Record<string, unknown> = {}) =>
	fingerprintPiRuntimeV0({ attachment: "pi.default", executable, env: fakePiEnv(), ...extra });

/** The digest the v0 algorithm assigns to the facts of a fingerprint: what the launcher-only identity would have said. */
const v0DigestOf = (fp: EndoHarnessFingerprintV1): string =>
	sha256HexV0(
		canonicalEndoJsonV0(
			endoHarnessIdentityBasisV0({
				runtime: fp.runtime,
				local: {
					requested: fp.local.requested,
					resolvedPath: fp.local.resolvedPath,
					realPath: fp.local.realPath,
					entrypoint: fp.local.entrypoint,
					package: fp.local.package,
				},
				reported: fp.reported,
			}),
		),
	);

describe("the v1 fingerprint of an installed Pi", () => {
	it("covers the whole bundle directory and is strong", async () => {
		const fake = install();
		const fp = await fingerprintOf(fake.bin);
		expect(fp.schemaVersion).toBe("endo.harness-fingerprint.v1");
		expect(fp.identity.basis).toBe("runtime-content.v1");
		expect(fp.identity.confidence).toBe("strong");
		expect(fp.local.runtimeContent).toMatchObject({ scope: "dist/bundle", files: 4 });
		expect(fp.methods).toContain("runtime-content-sha256");
		expect(validateEndoHarnessFingerprintV1(JSON.parse(JSON.stringify(fp)))).not.toBeNull();
		// Stable across repeated identification of an unchanged runtime.
		const again = await fingerprintOf(fake.bin);
		expect(again.identity.digest).toBe(fp.identity.digest);
	});

	it("sees a same-version edit behind an unchanged launcher and version, which the launcher-only identity does not", async () => {
		const fake = install();
		const before = await fingerprintOf(fake.bin);
		fake.writeBundleFile("chunks/chunk-AAAA1111.js", "export const a = 'patched';\n");
		const after = await fingerprintOf(fake.bin);
		// Launcher bytes, reported version and package are all unchanged…
		expect(after.local.entrypoint).toEqual(before.local.entrypoint);
		expect(after.reported.version).toBe(before.reported.version);
		// …so the v0 algorithm gives the same answer for both (this is the weakness),
		expect(v0DigestOf(after)).toBe(v0DigestOf(before));
		// while the runtime-content identity differs.
		expect(after.identity.digest).not.toBe(before.identity.digest);
		expect(piFingerprintDifferencesV0(before, after)).toEqual(["runtimeContent"]);
	});

	it("is the same through a symlinked path, an explicit path or PATH, and differs between side-by-side installs", async () => {
		const a = install("1.0.4");
		const b = install("1.4.0");
		const viaBin = await fingerprintOf(a.bin);
		const viaEntrypoint = await fingerprintOf(a.entrypoint);
		expect(viaEntrypoint.identity.digest).toBe(viaBin.identity.digest);
		const viaPath = await fingerprintPiRuntimeV0({
			attachment: "pi.default",
			command: "pi",
			path: dirname(a.bin),
			env: fakePiEnv(),
		});
		expect(viaPath.identity.digest).toBe(viaBin.identity.digest);
		const other = await fingerprintOf(b.bin);
		expect(other.identity.digest).not.toBe(viaBin.identity.digest);
		expect(other.reported.version).toBe("1.4.0");
	});

	it("is reduced, not rejected, when the layout has no supported scope, and says why", async () => {
		const fake = install();
		// Pi's entrypoint directly in the package root: its directory would be the whole package.
		const root = join(fake.prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		writeFileSync(join(root, "cli.js"), readFileSync(fake.entrypoint));
		chmodSync(join(root, "cli.js"), 0o755);
		const flat = await fingerprintOf(join(root, "cli.js"));
		expect(flat.identity.confidence).toBe("reduced");
		expect(flat.local.runtimeContent).toBeNull();
		expect(flat.gaps.find((gap) => gap.fact === "runtimeContent")?.reason).toMatch(/package root/);
		expect(flat.reported.version).toBe("1.0.0");
		expect(validateEndoHarnessFingerprintV1(JSON.parse(JSON.stringify(flat)))).not.toBeNull();
		// An unreadable tree: also reduced, with the reason; never a partial digest.
		const partial = await fingerprintOf(fake.bin, { runtimeContent: { limits: { maxEntries: 2 } } });
		expect(partial.identity.confidence).toBe("reduced");
		expect(partial.local.runtimeContent).toBeNull();
		expect(partial.identity.digest).not.toBe((await fingerprintOf(fake.bin)).identity.digest);
		expect(partial.gaps.find((gap) => gap.fact === "runtimeContent")?.reason).toMatch(/more than 2 entries/);
	});

	it("is reduced, with a gap, when the package manifest is missing or malformed", async () => {
		const fake = install();
		writeFileSync(fake.packageJson, "{ not json");
		const fp = await fingerprintOf(fake.bin);
		expect(fp.local.package).toBeNull();
		expect(fp.local.runtimeContent).toBeNull();
		expect(fp.identity.confidence).toBe("reduced");
		expect(fp.gaps.map((gap) => gap.fact)).toEqual(expect.arrayContaining(["package", "runtimeContent"]));
	});

	it("does not include credentials or configuration kept beside the runtime", async () => {
		const fake = install();
		const before = await fingerprintOf(fake.bin);
		const root = join(fake.prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		writeFileSync(join(root, "auth.json"), '{"anthropic":{"key":"sk-ant-not-real"}}');
		writeFileSync(join(fake.prefix, ".env"), "KEY=1");
		const home = scratch("endo-rc-home-");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
		expect((await fingerprintOf(fake.bin)).identity.digest).toBe(before.identity.digest);
	});
});

describe("history: v0 records stay what they were", () => {
	const researchFingerprint = JSON.parse(
		readFileSync(new URL("../research/pi-conformance/1.0.0/fingerprint.json", import.meta.url), "utf8"),
	) as EndoHarnessFingerprintV0;

	it("reproduces a recorded v0 digest only under the v0 algorithm, and a v1 digest never equals it", async () => {
		expect(validateEndoHarnessFingerprintV0(researchFingerprint)).not.toBeNull();
		const v0 = sha256HexV0(
			canonicalEndoJsonV0(
				endoHarnessIdentityBasisV0({
					runtime: researchFingerprint.runtime,
					local: researchFingerprint.local,
					reported: researchFingerprint.reported,
				}),
			),
		);
		expect(v0).toBe(researchFingerprint.identity.digest);
		// A v1 reading of the same facts is a different digest, by construction (the basis names itself).
		const v1 = sha256HexV0(
			canonicalEndoJsonV0(
				endoHarnessIdentityBasisV1({
					runtime: researchFingerprint.runtime,
					local: { ...researchFingerprint.local, runtimeContent: null },
					reported: researchFingerprint.reported,
				}),
			),
		);
		expect(v1).not.toBe(v0);
		// A v0 record is not a v1 record, and the reverse.
		expect(validateEndoHarnessFingerprintV1(researchFingerprint)).toBeNull();
		const fake = install();
		expect(validateEndoHarnessFingerprintV0(JSON.parse(JSON.stringify(await fingerprintOf(fake.bin))))).toBeNull();
	});

	/** A registry as an older Endophasia left it: a v0 fingerprint, its v0 first-observation change. */
	function v0Registry(root: string, fake: ReturnType<typeof install>): EndoHarnessFingerprintV0 {
		const entrypointBytes = readFileSync(fake.entrypoint);
		const local = {
			requested: fake.bin,
			resolvedPath: fake.bin,
			realPath: realpathSync(fake.entrypoint),
			entrypoint: { sha256: sha256HexV0(entrypointBytes), bytes: entrypointBytes.length },
			package: {
				name: "@earendil-works/pi-coding-agent",
				version: "1.0.0",
				root: join(fake.prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
			},
		};
		const reported = { versionText: "1.0.0", version: "1.0.0" };
		const body = {
			schemaVersion: "endo.harness-fingerprint.v0" as const,
			attachment: "pi.default",
			runtime: "pi",
			observedAt: "2026-10-01T00:00:00.000Z",
			methods: ["explicit-path", "realpath", "entrypoint-sha256", "package-manifest", "version-command"] as const,
			local,
			reported,
			gaps: [],
			identity: {
				digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported }))),
				confidence: "strong" as const,
			},
		};
		const record = {
			...body,
			methods: [...body.methods],
			id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}`,
		};
		const registry = openEndoHarnessRegistryV0(root, "pi.default");
		registry.append("fingerprint", record);
		const ref = {
			fingerprintId: record.id,
			identityDigest: record.identity.digest,
			confidence: "strong" as const,
			version: "1.0.0",
			realPath: local.realPath,
		};
		const change = {
			schemaVersion: "endo.harness-change.v0" as const,
			attachment: "pi.default",
			runtime: "pi",
			at: record.observedAt,
			kind: "first-observation" as const,
			previous: null,
			current: ref,
			differences: [],
			versionOrder: "unknown" as const,
		};
		expect(validateEndoHarnessChangeV0({ ...change, id: "endo.evidence.pi-change.v0-seed" })).not.toBeNull();
		registry.append("change", { ...change, id: "endo.evidence.pi-change.v0-seed" });
		return record;
	}

	const attach = (fake: ReturnType<typeof install>, root: string) =>
		new PiAttachmentV0({
			root,
			cwd: scratch("endo-rc-cwd-"),
			executable: fake.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "5" }),
			requestTimeoutMs: 10_000,
		});

	it("keeps earlier frames byte for byte when a v1 generation is appended, and reads both", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		const seeded = v0Registry(root, fake);
		const log = join(root, "harness", "pi.default", "records.log");
		const before = readFileSync(log);
		const pi = attach(fake, root);
		const { fingerprint } = await pi.identify();
		const after = readFileSync(log);
		expect(after.subarray(0, before.length).equals(before)).toBe(true);
		expect(after.length).toBeGreaterThan(before.length);
		const reopened = openEndoHarnessRegistryV0(root, "pi.default", { readOnly: true });
		expect(reopened.list("fingerprint").map((fp) => fp.schemaVersion)).toEqual([
			"endo.harness-fingerprint.v0",
			"endo.harness-fingerprint.v1",
		]);
		expect(reopened.list("fingerprint")[0]).toEqual(seeded);
		expect(reopened.list("change").map((change) => change.schemaVersion)).toEqual([
			"endo.harness-change.v0",
			"endo.harness-change.v1",
		]);
		expect(fingerprint?.schemaVersion).toBe("endo.harness-fingerprint.v1");
	});

	it("records a basis change as exactly that: not a runtime-content difference, and not 'first observation'", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		const seeded = v0Registry(root, fake);
		const { fingerprint, change, notification } = await attach(fake, root).identify();
		expect(fingerprint?.identity.digest).not.toBe(seeded.identity.digest);
		expect(change.kind).toBe("changed");
		expect(change.schemaVersion).toBe("endo.harness-change.v1");
		expect(change.differences).toContain("identityBasis");
		expect(change.differences).not.toContain("runtimeContent");
		expect(endoHarnessObservationBasisV0(change.previous!)).toBe("entrypoint.v0");
		expect(endoHarnessObservationBasisV0(change.current!)).toBe("runtime-content.v1");
		expect(validateEndoHarnessChangeV1(change)).not.toBeNull();
		expect(notification?.title).toMatch(/new basis/);
		expect(notification?.lines.join("\n")).toMatch(/does not show that Pi changed/);
		// The same runtime, identified again on the same basis, is unchanged — not a second basis change.
		const second = await attach(fake, root).identify();
		expect(second.change.kind).toBe("unchanged");
		expect(second.notification).toBeNull();
	});

	it("does not let evidence recorded under the old basis apply, and says it needs requalification", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		// Evidence made by an attachment that still identified on v0 cannot be produced any more; take real v1 evidence,
		// then show the v0 generation's evidence against it using a v0 fingerprint of the same install.
		const pi = attach(fake, root);
		await pi.checkLocal();
		const admittedBefore = pi.state().capabilities.filter((entry) => entry.status !== "unverified").length;
		expect(admittedBefore).toBeGreaterThan(0);
		// Reopen as an older registry would look to a new build: same evidence, but the identity on record is v0-only.
		const oldRoot = scratch("endo-rc-store-");
		const seeded = v0Registry(oldRoot, fake);
		const registry = openEndoHarnessRegistryV0(oldRoot, "pi.default");
		for (const evidence of pi.registry.list("evidence")) {
			// Rebind each evidence record to the v0 observation, as the older build would have written it.
			const rebound = {
				...evidence,
				dependencies: {
					...evidence.dependencies,
					fingerprintId: seeded.id,
					identityDigest: seeded.identity.digest,
				},
			};
			const { id: _id, ...body } = rebound;
			registry.append("evidence", {
				...body,
				id: `endo.evidence.pi-capability.${sha256HexV0(canonicalEndoJsonV0(body))}`,
			});
		}
		const next = attach(fake, oldRoot);
		await next.identify();
		const state = next.state();
		expect(state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		expect(state.capabilities[0]?.reason).toMatch(
			/entrypoint\.v0 identity basis.*runtime-content\.v1.*requalification/,
		);
		const assessment = piAssessmentV0(openEndoHarnessRegistryV0(oldRoot, "pi.default", { readOnly: true }));
		expect(assessment.current?.identityBasis).toBe("runtime-content.v1");
		expect(assessment.previous?.identityBasis).toBe("entrypoint.v0");
		expect(assessment.comparisons.detail).toMatch(/different basis.*not established either way/);
		expect(assessment.limitations.join("\n")).toMatch(/digests cannot be compared/);
		const text = renderPiAssessmentV0(assessment).join("\n");
		expect(text).toMatch(/not comparable, so no code change is asserted/);
		expect(text).toMatch(/basis runtime-content\.v1/);
		expect(assessment.capabilities.every((entry) => entry.effective !== "admitted")).toBe(true);
	});

	it("detects a same-version modified runtime under the new basis and invalidates its evidence", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		const pi = attach(fake, root);
		await pi.checkLocal();
		expect(
			pi.state().capabilities.some((entry) => entry.status === "admitted" || entry.status === "admitted-partial"),
		).toBe(true);
		fake.writeBundleFile("chunks/chunk-BBBB2222.js", "export const b = 'patched';\n");
		const next = attach(fake, root);
		const { change } = await next.identify();
		expect(change.kind).toBe("changed");
		expect(change.differences).toEqual(["runtimeContent"]);
		expect(change.versionOrder).toBe("equal");
		const state = next.state();
		expect(state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		expect(state.capabilities[0]?.reason).toMatch(/different runtime fingerprint/);
	});

	it("keeps a failed identification from resurrecting admitted capabilities across generations", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		const pi = attach(fake, root);
		await pi.checkLocal();
		rmSync(fake.bin);
		rmSync(fake.entrypoint);
		const next = attach(fake, root);
		const { fingerprint, change } = await next.identify();
		expect(fingerprint).toBeNull();
		expect(change.kind).toBe("collection-failed");
		expect(next.state().capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		const assessment = piAssessmentV0(openEndoHarnessRegistryV0(root, "pi.default", { readOnly: true }));
		expect(assessment.unidentified).not.toBeNull();
		expect(assessment.capabilities.every((entry) => entry.effective === "unverified")).toBe(true);
	});

	it("keeps status read-only for a mixed registry", async () => {
		const fake = install();
		const root = scratch("endo-rc-store-");
		v0Registry(root, fake);
		await attach(fake, root).identify();
		const log = join(root, "harness", "pi.default", "records.log");
		const before = readFileSync(log);
		const originalError = process.stderr.write.bind(process.stderr);
		const originalLog = console.log;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		console.log = () => undefined;
		try {
			await harnessStatusCommand([root]);
		} finally {
			process.stderr.write = originalError;
			console.log = originalLog;
		}
		expect(readFileSync(log).equals(before)).toBe(true);
	});
});

describe("a same-version rebuild while a check runs", () => {
	it("discards the check's evidence and records the change (detected through the runtime content)", async () => {
		const fake = install();
		fake.setScenario("mutate-bundle-on:get_available_models");
		const root = scratch("endo-rc-store-");
		const pi = new PiAttachmentV0({
			root,
			cwd: scratch("endo-rc-cwd-"),
			executable: fake.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "5" }),
			requestTimeoutMs: 10_000,
		});
		const result = await pi.checkLocal();
		expect(result.ran).toBe(true);
		expect(result.recorded).toBe(false);
		expect(pi.registry.list("evidence")).toHaveLength(0);
		const change = pi.registry.last("change");
		expect(change?.kind).toBe("changed");
		expect(change?.current?.version).toBe("1.0.0");
		expect(result.state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
	});

	it("does not admit a fingerprint taken while the tree changed under it", async () => {
		const fake = install();
		const fp = await fingerprintOf(fake.bin, {
			runtimeContent: {
				afterHashing: async () => fake.writeBundleFile("chunks/chunk-AAAA1111.js", "export const a = 'racing';\n"),
			},
		});
		expect(fp.local.runtimeContent).toBeNull();
		expect(fp.identity.confidence).toBe("reduced");
		expect(fp.gaps.find((gap) => gap.fact === "runtimeContent")?.reason).toMatch(
			/while the fingerprint was being taken/,
		);
	});
});

describe("the v1 change and fingerprint validators", () => {
	const ref = (basis: "entrypoint.v0" | "runtime-content.v1", digest: string) => ({
		fingerprintId: `endo.evidence.fx-${digest.slice(0, 4)}`,
		identityDigest: digest.repeat(64).slice(0, 64),
		confidence: "strong" as const,
		version: "1.0.0",
		realPath: null,
		basis,
	});
	const change = (over: Record<string, unknown>) => ({
		schemaVersion: "endo.harness-change.v1",
		id: "endo.evidence.fx-change",
		attachment: "pi.default",
		runtime: "pi",
		at: "2026-01-01T00:00:00.000Z",
		kind: "changed",
		previous: ref("entrypoint.v0", "a"),
		current: ref("runtime-content.v1", "b"),
		differences: ["identityBasis"],
		versionOrder: "equal",
		...over,
	});

	it("requires identityBasis exactly when the bases differ, and runtimeContent only within one content basis", () => {
		expect(validateEndoHarnessChangeV1(change({}))).not.toBeNull();
		expect(validateEndoHarnessChangeV1(change({ differences: ["version"] }))).toBeNull();
		expect(validateEndoHarnessChangeV1(change({ differences: ["identityBasis", "runtimeContent"] }))).toBeNull();
		const sameBasis = { previous: ref("runtime-content.v1", "a") };
		expect(validateEndoHarnessChangeV1(change({ ...sameBasis, differences: ["runtimeContent"] }))).not.toBeNull();
		expect(validateEndoHarnessChangeV1(change({ ...sameBasis, differences: ["identityBasis"] }))).toBeNull();
		const v0Sides = { previous: ref("entrypoint.v0", "a"), current: ref("entrypoint.v0", "b") };
		expect(validateEndoHarnessChangeV1(change({ ...v0Sides, differences: ["runtimeContent"] }))).toBeNull();
		// 'unchanged' needs the same digest and the same basis.
		expect(
			validateEndoHarnessChangeV1(
				change({ kind: "unchanged", differences: [], current: ref("entrypoint.v0", "a") }),
			),
		).not.toBeNull();
		expect(
			validateEndoHarnessChangeV1(
				change({
					kind: "unchanged",
					differences: [],
					previous: ref("entrypoint.v0", "a"),
					current: { ...ref("runtime-content.v1", "a") },
				}),
			),
		).toBeNull();
		// v0 validators do not accept v1 records, and unknown fields are refused.
		expect(validateEndoHarnessChangeV0(change({}))).toBeNull();
		expect(validateEndoHarnessChangeV1(change({ extra: 1 }))).toBeNull();
	});

	it("builds the cross-basis change from two real fingerprints without inventing a content difference", async () => {
		const fake = install();
		const v1 = await fingerprintOf(fake.bin);
		const v0 = JSON.parse(
			readFileSync(new URL("../research/pi-conformance/1.0.0/fingerprint.json", import.meta.url), "utf8"),
		) as EndoHarnessFingerprintV0;
		const record = piChangeV0({ attachment: "pi.default", previous: v0, current: v1, at: v1.observedAt });
		expect(record.kind).toBe("changed");
		expect(record.differences).toContain("identityBasis");
		expect(record.differences).not.toContain("runtimeContent");
		expect(record.previous?.basis).toBe("entrypoint.v0");
		expect(piNotificationV0(record)?.kind).toBe("runtime-changed");
	});

	it("refuses a v1 fingerprint whose digest claims coverage it does not record", async () => {
		const fake = install();
		const good = JSON.parse(JSON.stringify(await fingerprintOf(fake.bin))) as Record<string, any>;
		const without = structuredClone(good);
		without.local.runtimeContent = null; // present digest removed, but no gap and the method still listed
		expect(validateEndoHarnessFingerprintV1(without)).toBeNull();
		const strongWithoutContent = structuredClone(without);
		strongWithoutContent.methods = strongWithoutContent.methods.filter((m: string) => m !== "runtime-content-sha256");
		strongWithoutContent.gaps = [{ fact: "runtimeContent", reason: "x" }];
		expect(validateEndoHarnessFingerprintV1(strongWithoutContent)).toBeNull(); // still says "strong"
		strongWithoutContent.identity.confidence = "reduced";
		expect(validateEndoHarnessFingerprintV1(strongWithoutContent)).not.toBeNull();
		const escaping = structuredClone(good);
		escaping.local.runtimeContent.scope = "../outside";
		expect(validateEndoHarnessFingerprintV1(escaping)).toBeNull();
		const wrongBasis = structuredClone(good);
		wrongBasis.identity.basis = "entrypoint.v0";
		expect(validateEndoHarnessFingerprintV1(wrongBasis)).toBeNull();
	});
});

describe("a launcher that loads its program from outside its own directory", () => {
	it("ends coverage instead of claiming strong identity over the launcher's directory alone", async () => {
		const t = tree({ "cli.js": "#!/usr/bin/env node\nrequire('../lib/runtime.js');\n" });
		const result = await hashPiRuntimeContentV1({ entrypoint: t.entrypoint, packageRoot: t.packageRoot });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/refers to \.\.\/lib\/runtime\.js, outside/);
		// Pi's own launcher shape (a relative load of a sibling) stays covered.
		const pi = tree({ "cli.js": 'createRequire(import.meta.url)("./cli-runtime.js");\n' });
		expect((await hashPiRuntimeContentV1({ entrypoint: pi.entrypoint, packageRoot: pi.packageRoot })).ok).toBe(true);
	});
});
