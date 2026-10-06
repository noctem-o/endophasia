// Permanent schema-compatibility conformance. Everything here is derived from one structure, the catalogue
// (protocol/schema-compat.ts), and from each family's own version table. The fixtures are read from committed bytes and
// never rebuilt from current code: a fixture that changes with the writer proves nothing.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, ENDO_EVIDENCE_RECORD_VERSIONS_V0 } from "../evolution/evidence.ts";
import {
	ENDO_EVALUATION_PROFILE_VERSIONS_V0,
	ENDO_EVALUATION_RESULT_PROFILE_VERSIONS_V0,
} from "../protocol/evaluation.ts";
import { ENDO_EVENT_VERSIONS_V0 } from "../protocol/event.ts";
import { ENDO_EVIDENCE_LEDGER_VERSIONS_V0, ENDO_EXPERIMENT_RECORD_VERSIONS_V0 } from "../protocol/evolution.ts";
import { ENDO_HARNESS_REGISTRY_RECORD_VERSIONS_V0 } from "../protocol/harness.ts";
import { ENDO_DURABLE_SCHEMAS_V0 } from "../protocol/schema-compat.ts";
import { type EndoVersionTableV0, readEndoVersionedV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DIGEST_KEY_FILE_VERSIONS_V0, readEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { endoHarnessRegistryDirectoryV0, openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoDurableEvidenceLedgerV0 } from "../storage/ledger.ts";
import { createEndoFrameLogV0 } from "../storage/log.ts";
import {
	archiveEndoWorkspaceV0,
	ENDO_WORKSPACE_ARCHIVE_VERSIONS_V0,
	ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0,
	readEndoWorkspaceArchiveV0,
} from "../storage/workspace-snapshot.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "schema-compat");

/** Every family's version table: each durable version must be in exactly one of these. */
const TABLES: readonly EndoVersionTableV0<unknown>[] = [
	ENDO_EVENT_VERSIONS_V0,
	ENDO_EVIDENCE_RECORD_VERSIONS_V0,
	ENDO_EVIDENCE_LEDGER_VERSIONS_V0,
	ENDO_EXPERIMENT_RECORD_VERSIONS_V0,
	ENDO_EVALUATION_PROFILE_VERSIONS_V0,
	ENDO_HARNESS_REGISTRY_RECORD_VERSIONS_V0,
	ENDO_WORKSPACE_ARCHIVE_VERSIONS_V0,
	ENDO_DIGEST_KEY_FILE_VERSIONS_V0,
];

const tableOf = (version: string): EndoVersionTableV0<unknown> => {
	const tables = TABLES.filter((table) => table.validators.has(version));
	expect(tables.length, `${version} must be in exactly one version table`).toBe(1);
	return tables[0]!;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (version: string, file: string): Buffer => readFileSync(join(FIXTURES, version, file));

/** Every plain object inside `value` (the root as ""), by dotted path, with `*` for array elements; an open path is skipped. */
function objectPaths(value: unknown, open: readonly string[], path = ""): string[] {
	if (open.some((o) => o === path || (path !== "" && path.startsWith(`${o}.`)))) return [];
	if (Array.isArray(value)) return value.flatMap((item) => objectPaths(item, open, path === "" ? "*" : `${path}.*`));
	if (typeof value !== "object" || value === null) return [];
	return [
		path,
		...Object.entries(value).flatMap(([key, child]) =>
			objectPaths(child, open, path === "" ? key : `${path}.${key}`),
		),
	];
}

/** A copy of `root` with an unknown key added at the object found at `path` (the same walk objectPaths made). */
function withUnknownKeyAt(root: unknown, path: string): unknown {
	const copy = structuredClone(root) as Record<string, unknown>;
	const walk = (node: unknown, segments: string[]): void => {
		if (segments.length === 0) {
			(node as Record<string, unknown>).futureField = 1;
			return;
		}
		const [head, ...rest] = segments as [string, ...string[]];
		if (head === "*") {
			for (const item of node as unknown[]) walk(item, rest);
			return;
		}
		walk((node as Record<string, unknown>)[head], rest);
	};
	walk(copy, path === "" ? [] : path.split("."));
	return copy;
}

describe("the catalogue", () => {
	const versions = ENDO_DURABLE_SCHEMAS_V0.map((entry) => entry.schemaVersion);

	it("is sorted, unique and consistent in family and version", () => {
		expect(versions).toEqual([...new Set(versions)].sort());
		for (const entry of ENDO_DURABLE_SCHEMAS_V0) {
			expect(entry.schemaVersion.replace(/\.v\d+$/, "")).toBe(entry.family);
			expect(entry.fixtures.length, `${entry.schemaVersion} needs a permanent fixture`).toBeGreaterThan(0);
		}
	});

	it("names exactly the versions the family tables read: none unread, none uncatalogued", () => {
		const read = TABLES.flatMap((table) => [...table.versions]);
		expect(new Set(read).size, "a version is in two tables").toBe(read.length);
		expect([...read].sort()).toEqual(versions);
	});

	it("keeps every catalogued fixture, byte for byte, and catalogues every fixture on disk", () => {
		const onDisk = readdirSync(FIXTURES)
			.filter((name) => statSync(join(FIXTURES, name)).isDirectory())
			.sort();
		expect(onDisk).toEqual(versions);
		for (const entry of ENDO_DURABLE_SCHEMAS_V0) {
			const files = readdirSync(join(FIXTURES, entry.schemaVersion)).sort();
			expect(files).toEqual(entry.fixtures.map((fixture) => fixture.file).sort());
			for (const fixture of entry.fixtures)
				expect(
					sha256(bytesOf(entry.schemaVersion, fixture.file)),
					`${entry.schemaVersion}/${fixture.file} changed`,
				).toBe(fixture.sha256);
		}
	});

	it("keeps a current version in every family, and marks only superseded versions legacy", () => {
		for (const family of new Set(ENDO_DURABLE_SCHEMAS_V0.map((entry) => entry.family))) {
			const entries = ENDO_DURABLE_SCHEMAS_V0.filter((entry) => entry.family === family);
			expect(
				entries.some((entry) => entry.status === "current"),
				`${family} has no current version`,
			).toBe(true);
		}
		expect(
			ENDO_DURABLE_SCHEMAS_V0.find((entry) => entry.schemaVersion === ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0)
				?.status,
		).toBe("current");
	});
});

describe.each(ENDO_DURABLE_SCHEMAS_V0.flatMap((entry) => entry.fixtures.map((fixture) => ({ entry, fixture }))))(
	"fixture $entry.schemaVersion/$fixture.file",
	({ entry, fixture }) => {
		const table = tableOf(entry.schemaVersion);
		const text = bytesOf(entry.schemaVersion, fixture.file).toString("utf8");
		const parsed: unknown = JSON.parse(text);
		const open = entry.openPaths ?? [];

		it("declares the version of its directory and is accepted under it", () => {
			expect((parsed as { schemaVersion: unknown }).schemaVersion).toBe(entry.schemaVersion);
			const read = readEndoVersionedV0(table, parsed);
			expect(read).toMatchObject({ ok: true, schemaVersion: entry.schemaVersion });
			if (read.ok) expect(read.value).toBe(parsed);
			expect(JSON.stringify(parsed)).toBe(JSON.stringify(JSON.parse(text)));
		});

		it("rejects an unknown, a missing and a non-string schemaVersion distinctly", () => {
			const kind = (schemaVersion: unknown) => {
				const copy = structuredClone(parsed) as Record<string, unknown>;
				if (schemaVersion === undefined) delete copy.schemaVersion;
				else copy.schemaVersion = schemaVersion;
				const read = readEndoVersionedV0(table, copy);
				return read.ok ? "ok" : read.kind;
			};
			expect(kind(`${entry.family}.v999`)).toBe("unsupported-version");
			expect(kind(undefined)).toBe("missing-version");
			expect(kind(7)).toBe("version-not-string");
		});

		it("rejects a plausible future field at the root and in every nested object that is not an open container", () => {
			for (const path of objectPaths(parsed, open)) {
				const read = readEndoVersionedV0(table, withUnknownKeyAt(parsed, path));
				expect(read, `an unknown field at "${path}" was accepted`).toMatchObject({
					ok: false,
					kind: "invalid",
					schemaVersion: entry.schemaVersion,
				});
			}
		});
	},
);

describe("the families keep their old versions", () => {
	const bytes = (version: string, file = "minimal.json") => new Uint8Array(bytesOf(version, file));
	const json = (version: string, file = "minimal.json") => JSON.parse(bytesOf(version, file).toString("utf8"));

	it("reads both workspace archive versions, and only the current one is written", () => {
		expect(readEndoWorkspaceArchiveV0(bytes("endo.workspace-archive.v0"))).toMatchObject({
			ok: true,
			schemaVersion: "endo.workspace-archive.v0",
		});
		expect(readEndoWorkspaceArchiveV0(bytes("endo.workspace-archive.v1"))).toMatchObject({
			ok: true,
			schemaVersion: "endo.workspace-archive.v1",
		});
		const written = JSON.parse(Buffer.from(archiveEndoWorkspaceV0(FIXTURES).bytes).toString("utf8"));
		expect(written.schemaVersion).toBe(ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0);
	});

	it("does not let one archive version borrow another's representation", () => {
		const v0 = json("endo.workspace-archive.v0");
		const v1 = json("endo.workspace-archive.v1");
		const kind = (value: unknown) => {
			const read = readEndoVersionedV0(ENDO_WORKSPACE_ARCHIVE_VERSIONS_V0, value);
			return read.ok ? "ok" : read.kind;
		};
		expect(kind({ ...v0, rootMtimeMs: 1 })).toBe("invalid");
		expect(kind({ ...v1, schemaVersion: "endo.workspace-archive.v0" })).toBe("invalid");
		expect(kind({ ...v0, schemaVersion: "endo.workspace-archive.v1" })).toBe("invalid");
		const withEntryField = structuredClone(v1);
		withEntryField.entries[0].owner = "root";
		expect(kind(withEntryField)).toBe("invalid");
	});

	it("reads an evaluation profile v1 as v1 only, and never falls back to v0", () => {
		const v1 = json("endo.evaluation-profile.v1");
		expect(v1.cognitionPolicy).toBe("none");
		expect(readEndoVersionedV0(ENDO_EVALUATION_PROFILE_VERSIONS_V0, v1)).toMatchObject({
			ok: true,
			schemaVersion: "endo.evaluation-profile.v1",
		});
		// Declared as v0, the same body is not a v0 profile: `none` is not a v0 policy.
		expect(
			readEndoVersionedV0(ENDO_EVALUATION_PROFILE_VERSIONS_V0, {
				...v1,
				schemaVersion: "endo.evaluation-profile.v0",
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
	});

	it("lets a result embed exactly the profile versions its own contract names", () => {
		// The result owns its own set: it is the contract of v0 results, not a view of the profile family's table.
		expect(ENDO_EVALUATION_RESULT_PROFILE_VERSIONS_V0).not.toBe(ENDO_EVALUATION_PROFILE_VERSIONS_V0);
		expect([...ENDO_EVALUATION_RESULT_PROFILE_VERSIONS_V0.versions]).toEqual([
			"endo.evaluation-profile.v0",
			"endo.evaluation-profile.v1",
		]);
		for (const file of ["profile-v0.json", "profile-v1.json"]) {
			const result = json("endo.evaluation-result.v0", file);
			expect(readEndoVersionedV0(ENDO_EVIDENCE_RECORD_VERSIONS_V0, result)).toMatchObject({ ok: true });
			const future = structuredClone(result);
			future.profile.schemaVersion = "endo.evaluation-profile.v2";
			expect(readEndoVersionedV0(ENDO_EVIDENCE_RECORD_VERSIONS_V0, future)).toMatchObject({
				ok: false,
				kind: "invalid",
			});
		}
	});
});

describe("the fixtures work together", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
	const order = fixture("ledger-append-order.json") as string[];
	const record = (entry: string) =>
		JSON.parse(readFileSync(join(FIXTURES, `${entry}.json`), "utf8")) as { schemaVersion: string };
	const experiment = fixture("endo.experiment.v0/minimal.json");

	it("appends the committed evidence records to a ledger, in dependency order, in memory and on disk", () => {
		const memory = createEndoEvidenceLedgerV0("endo.evidence.fx-ledger", experiment);
		const root = mkdtempSync(join(tmpdir(), "endo-compat-"));
		dirs.push(root);
		const durable = createEndoDurableEvidenceLedgerV0(root, "endo.evidence.fx-ledger", experiment);
		for (const entry of order) {
			memory.append(record(entry));
			durable.append(record(entry));
		}
		expect(memory.length).toBe(order.length);
		durable.snapshot();
		durable.close();
		const reopened = createEndoDurableEvidenceLedgerV0(root, "endo.evidence.fx-ledger", experiment, {
			readOnly: true,
		});
		expect(reopened.length).toBe(order.length);
		expect(reopened.ledger().entries).toEqual(memory.ledger().entries);
	});

	it("keeps every catalogued evidence kind in the append order", () => {
		const evidence = new Set(ENDO_EVIDENCE_RECORD_VERSIONS_V0.versions);
		const listed = new Set(order.map((entry) => entry.split("/")[0]!));
		for (const version of evidence) expect(listed.has(version), `${version} is not in the append order`).toBe(true);
	});

	it("refuses an unknown or malformed evidence record with the matching failure", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.fx-ledger", experiment);
		const artifact = record("endo.artifact.v0/minimal");
		for (const bad of ["constructor", "__proto__", "toString", "endo.artifact.v999"])
			expect(() => ledger.append({ ...artifact, schemaVersion: bad })).toThrow(/closed evidence record kinds/);
		expect(() => ledger.append({ ...artifact, futureField: 1 })).toThrow(/not a valid endo.artifact.v0 record/);
		expect(() => ledger.append([artifact])).toThrow(/must be objects/);
		expect(ledger.length).toBe(0);
	});

	it("reads the committed digest-key file, and refuses one with an unknown field", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-compat-"));
		dirs.push(dir);
		const path = join(dir, "digest-key");
		writeFileSync(path, readFileSync(join(FIXTURES, "endo.digest-key.v0/minimal.json")), { mode: 0o600 });
		expect(readEndoDigestKeyV0(path).fingerprint).toBeTypeOf("string");
		const key = fixture("endo.digest-key.v0/minimal.json") as Record<string, unknown>;
		writeFileSync(path, JSON.stringify({ ...key, comment: "extra" }), { mode: 0o600 });
		expect(() => readEndoDigestKeyV0(path)).toThrow(/not an endo.digest-key.v0 file/);
		writeFileSync(path, JSON.stringify({ ...key, schemaVersion: "endo.digest-key.v1" }), { mode: 0o600 });
		expect(() => readEndoDigestKeyV0(path)).toThrow(/unsupported schemaVersion/);
		expect(existsSync(path)).toBe(true);
	});
});

describe("storage boundaries reject what they do not know", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-compat-"));
		dirs.push(dir);
		return dir;
	};
	const fixture = (path: string) =>
		JSON.parse(readFileSync(join(FIXTURES, `${path}.json`), "utf8")) as Record<string, any>;
	const encode = (value: unknown) => new TextEncoder().encode(canonicalEndoJsonV0(value));
	const experiment = fixture("endo.experiment.v0/minimal");
	const LEDGER = "endo.evidence.fx-ledger";

	const kindOf = (bytes: Uint8Array) => {
		const read = readEndoWorkspaceArchiveV0(bytes);
		return read.ok ? "ok" : read.kind;
	};

	it("reads a workspace archive only when it is exactly its declared version, in canonical form", () => {
		const v1 = fixture("endo.workspace-archive.v1/minimal");
		expect(kindOf(encode(v1))).toBe("ok");
		expect(kindOf(encode({ ...v1, futureRootField: 1 }))).toBe("invalid");
		expect(kindOf(encode({ ...v1, schemaVersion: "endo.workspace-archive.v2" }))).toBe("unsupported-version");
		const { schemaVersion: _omitted, ...unversioned } = v1;
		expect(kindOf(encode(unversioned))).toBe("missing-version");
		expect(kindOf(encode({ ...v1, schemaVersion: 1 }))).toBe("version-not-string");
		expect(kindOf(encode([v1]))).toBe("not-an-object");
		expect(kindOf(new Uint8Array([0xff, 0xfe]))).toBe("not-an-object");
		expect(kindOf(new TextEncoder().encode("null"))).toBe("not-an-object");
		expect(kindOf(new TextEncoder().encode(JSON.stringify(v1)))).toBe("invalid"); // valid, but not canonical bytes
		const bad = (field: string, value: unknown) => {
			const copy = structuredClone(v1);
			copy.entries[0][field] = value;
			return kindOf(encode(copy));
		};
		expect(bad("owner", "root")).toBe("invalid"); // an unknown field inside an entry
		expect(bad("base64", "aGk")).toBe("invalid"); // not canonical base64
		expect(bad("base64", "a!GkA")).toBe("invalid"); // characters Buffer would silently skip
		expect(bad("bytes", 3)).toBe("invalid");
		expect(bad("bytes", 2.5)).toBe("invalid");
		expect(bad("executable", "no")).toBe("invalid");
		expect(bad("type", "socket")).toBe("invalid");
		const withNull = structuredClone(v1);
		withNull.entries.push(null);
		expect(kindOf(encode(withNull))).toBe("invalid"); // a null entry is a refusal, not a crash
		const symlink = fixture("endo.workspace-archive.v0/minimal");
		symlink.entries[3].mtimeMs = 1;
		expect(kindOf(encode(symlink))).toBe("invalid");
	});

	it("keeps the archive reader's writer on the current version", () => {
		const bytes = archiveEndoWorkspaceV0(join(FIXTURES, "endo.workspace-archive.v0")).bytes;
		expect(readEndoWorkspaceArchiveV0(bytes)).toMatchObject({
			ok: true,
			schemaVersion: ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0,
		});
	});

	it("opens a ledger only when its meta and snapshot hold exactly the keys the writer emits", () => {
		const root = scratch();
		const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER, experiment);
		ledger.append(fixture("endo.artifact.v0/minimal"));
		ledger.snapshot();
		ledger.close();
		const meta = join(root, "ledger", "ledger.meta.json");
		const snapshot = join(root, "ledger", "ledger.snapshot.json");
		const original = { meta: readFileSync(meta, "utf8"), snapshot: readFileSync(snapshot, "utf8") };
		const open = () => createEndoDurableEvidenceLedgerV0(root, LEDGER, experiment, { readOnly: true });
		expect(open().length).toBe(1);

		// Extra key on the meta with its digest recomputed over it: the digest verifies, the key is still refused.
		const m = JSON.parse(original.meta) as Record<string, unknown>;
		const { digest: _digest, ...rest } = m;
		const extended = { ...rest, comment: "extra" };
		writeFileSync(meta, canonicalEndoJsonV0({ digest: sha256HexV0(canonicalEndoJsonV0(extended)), ...extended }));
		expect(open).toThrow(/does not know/);
		writeFileSync(meta, original.meta);

		const s = JSON.parse(original.snapshot) as Record<string, unknown>;
		writeFileSync(snapshot, canonicalEndoJsonV0({ ...s, comment: "extra" }));
		expect(open).toThrow(/does not know/);
		writeFileSync(snapshot, original.snapshot);
		expect(open().length).toBe(1);
	});

	it("opens a harness registry only when every frame is exactly { kind, record } of the kind's own version", () => {
		const root = scratch();
		const registry = openEndoHarnessRegistryV0(root, "fx.attachment");
		const fingerprint = fixture("endo.harness-fingerprint.v0/minimal") as never;
		registry.append("fingerprint", fingerprint);
		expect(openEndoHarnessRegistryV0(root, "fx.attachment", { readOnly: true }).list("fingerprint")).toHaveLength(1);

		const framed = (value: unknown) => {
			const dir = scratch();
			const directory = endoHarnessRegistryDirectoryV0(dir, "fx.attachment");
			mkdirSync(directory, { recursive: true });
			const log = createEndoFrameLogV0(`${directory}/records.log`, {});
			log.append(encode(value));
			return () => openEndoHarnessRegistryV0(dir, "fx.attachment", { readOnly: true });
		};
		expect(framed({ kind: "fingerprint", record: fingerprint })()).toBeTruthy();
		expect(framed({ kind: "fingerprint", record: fingerprint, note: "x" })).toThrow(/exactly/);
		expect(framed(null)).toThrow(/exactly/);
		expect(framed({ kind: "constructor", record: fingerprint })).toThrow(/unknown harness registry record kind/);
		// A record of another kind's version under this kind is refused, not re-read as the other kind.
		expect(framed({ kind: "change", record: fingerprint })).toThrow(/is not a change record/);
		expect(
			framed({
				kind: "fingerprint",
				record: { ...(fingerprint as object), schemaVersion: "endo.harness-fingerprint.v9" },
			}),
		).toThrow(/unsupported schemaVersion/);
		expect(framed({ kind: "fingerprint", record: { ...(fingerprint as object), futureField: 1 } })).toThrow(
			/not a valid fingerprint record/,
		);
	});
});
