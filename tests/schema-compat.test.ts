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
import { readEndoExperimentRunRecordFileV0 } from "../cli/experiment-artifacts.ts";
import { createEndoEvidenceLedgerV0, ENDO_EVIDENCE_RECORD_VERSIONS_V0 } from "../evolution/evidence.ts";
import {
	ENDO_EVALUATION_PROFILE_VERSIONS_V0,
	ENDO_EVALUATION_RESULT_PROFILE_VERSIONS_V0,
} from "../protocol/evaluation.ts";
import { ENDO_EVENT_VERSIONS_V0 } from "../protocol/event.ts";
import { ENDO_EVIDENCE_LEDGER_VERSIONS_V0, ENDO_EXPERIMENT_RECORD_VERSIONS_V0 } from "../protocol/evolution.ts";
import {
	ENDO_EXPERIMENT_PLAN_VERSIONS_V0,
	ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0,
	ENDO_EXPERIMENT_RUN_EXPERIMENT_VERSIONS_V0,
	ENDO_EXPERIMENT_RUN_SPEC_VERSIONS_V0,
	ENDO_EXPERIMENT_RUN_VERSIONS_V0,
	ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0,
	ENDO_EXPERIMENT_TRIAL_VERSIONS_V0,
	ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0,
	readEndoExperimentPlanV0,
	readEndoExperimentRunRecordV0,
	readEndoExperimentTrialResultV0,
	readEndoLegacyExperimentPlanV0,
} from "../protocol/experiment-artifacts.ts";
import {
	ENDO_EXPERIMENT_SPEC_SCHEMA_V0,
	ENDO_EXPERIMENT_SPEC_VERSIONS_V0,
	parseEndoExperimentSpecV0,
	readEndoExperimentSpecV0,
	validateEndoExperimentSpecV0,
} from "../protocol/experiment-spec.ts";
import { ENDO_HARNESS_REGISTRY_RECORD_VERSIONS_V0 } from "../protocol/harness.ts";
import { ENDO_HARNESS_SURFACE_VERSIONS_V0 } from "../protocol/harness-surface.ts";
import { ENDO_DURABLE_SCHEMAS_V0 } from "../protocol/schema-compat.ts";
import { EndoSchemaVersionErrorV0, type EndoVersionTableV0, readEndoVersionedV0 } from "../protocol/versioned.ts";
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
	ENDO_EXPERIMENT_SPEC_VERSIONS_V0,
	ENDO_EXPERIMENT_RUN_VERSIONS_V0,
	ENDO_EXPERIMENT_PLAN_VERSIONS_V0,
	ENDO_EXPERIMENT_TRIAL_VERSIONS_V0,
	ENDO_HARNESS_SURFACE_VERSIONS_V0,
];

const tableOf = (version: string): EndoVersionTableV0<unknown> => {
	const tables = TABLES.filter((table) => table.validatorFor(version) !== undefined);
	expect(tables.length, `${version} must be in exactly one version table`).toBe(1);
	return tables[0]!;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (version: string, file: string): Buffer => readFileSync(join(FIXTURES, version, file));

/** Whether `path` is an open container or inside one: an open path's `*` stands for any one segment (an array element or a map key). */
function isOpen(open: readonly string[], path: string): boolean {
	const segments = path === "" ? [] : path.split(".");
	return open.some((container) => {
		const pattern = container.split(".");
		return (
			segments.length >= pattern.length && pattern.every((part, index) => part === "*" || part === segments[index])
		);
	});
}

/** Every plain object inside `value` (the root as ""), by dotted path, with `*` for array elements; an open path is skipped. */
function objectPaths(value: unknown, open: readonly string[], path = ""): string[] {
	if (isOpen(open, path)) return [];
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
		// Array elements need not share a shape: an optional object one element omits is not there to probe.
		if (typeof node !== "object" || node === null) return;
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
		expect(bad("path", { toString: 1, valueOf: 2 })).toBe("invalid"); // a value that cannot be coerced to text
		expect(bad("path", ["a"])).toBe("invalid");
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

	it("reads the experiment record through its version table at the ledger boundaries", () => {
		const root = scratch();
		const kinds = (value: unknown) => {
			try {
				createEndoEvidenceLedgerV0(LEDGER, value);
				return "ok";
			} catch (error) {
				return (error as { kind?: string }).kind ?? "untyped";
			}
		};
		expect(kinds(experiment)).toBe("ok");
		expect(kinds({ ...experiment, schemaVersion: "endo.experiment.v9" })).toBe("unsupported-version");
		const { schemaVersion: _omitted, ...unversioned } = experiment;
		expect(kinds(unversioned)).toBe("missing-version");
		expect(kinds({ ...experiment, futureField: 1 })).toBe("invalid");
		expect(() =>
			createEndoDurableEvidenceLedgerV0(root, LEDGER, { ...experiment, schemaVersion: "endo.experiment.v9" }),
		).toThrow(/unsupported schemaVersion/);
	});
});

// --- the experiment runner's run-directory artifacts -----------------------------------------------------------------

const UNVERSIONED = join(import.meta.dirname, "fixtures", "schema-compat-unversioned");
const LEGACY_PLAN = join(UNVERSIONED, "experiment-plan", "plan.json");
const LEGACY_PLAN_SHA256 = "a23e75c6a271ff2e1810846f910d4fb1158ad029e9fa91c002ef3fd2d30f6459";

describe("the experiment runner's artifacts", () => {
	const json = (version: string, file: string) => JSON.parse(bytesOf(version, file).toString("utf8"));
	const kind = (read: { ok: boolean; kind?: string }) => (read.ok ? "ok" : read.kind);

	it("writes exactly the current catalogued versions, and the spec stays v0", () => {
		expect(ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0).toBe("endo.experiment-run.v0");
		expect(ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0).toBe("endo.experiment-plan.v0");
		// The runner writes trial v1 (the harness surface); v0 is read-only history.
		expect(ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0).toBe("endo.experiment-trial.v1");
		expect(ENDO_EXPERIMENT_SPEC_SCHEMA_V0).toBe("endo.experiment-spec.v0");
		for (const version of [
			ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0,
			ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0,
			ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0,
			ENDO_EXPERIMENT_SPEC_SCHEMA_V0,
		])
			expect(ENDO_DURABLE_SCHEMAS_V0.find((entry) => entry.schemaVersion === version)?.status).toBe("current");
	});

	it("reads a spec by its declared version; validating a selected v0 contract is a different operation", () => {
		const spec = json("endo.experiment-spec.v0", "full.json");
		expect(readEndoExperimentSpecV0(spec)).toMatchObject({ ok: true, schemaVersion: "endo.experiment-spec.v0" });
		expect(parseEndoExperimentSpecV0(spec)).toBe(spec);
		expect(kind(readEndoExperimentSpecV0({ ...spec, schemaVersion: "endo.experiment-spec.v1" }))).toBe(
			"unsupported-version",
		);
		expect(() => parseEndoExperimentSpecV0({ ...spec, schemaVersion: "endo.experiment-spec.v1" })).toThrow(
			EndoSchemaVersionErrorV0,
		);
		expect(() => validateEndoExperimentSpecV0({ ...spec, schemaVersion: "endo.experiment-spec.v1" })).toThrow(
			/schemaVersion must be/,
		);
		// A map key is data, not a schema field: a file named like a field is a file.
		const mapKeys = structuredClone(spec);
		mapKeys.tasks[1].workspace = { schemaVersion: "x\n", futureField: "y\n" };
		expect(kind(readEndoExperimentSpecV0(mapKeys))).toBe("ok");
		// The closed neighbour of an open map still refuses what it does not define.
		const manipulation = structuredClone(spec);
		manipulation.manipulation.conditions.tuned.futureField = 1;
		expect(kind(readEndoExperimentSpecV0(manipulation))).toBe("invalid");
	});

	it("each family's versions are its own: no version is readable through another family's table", () => {
		for (const [version, file, table] of [
			["endo.experiment-spec.v0", "minimal.json", ENDO_EXPERIMENT_SPEC_VERSIONS_V0],
			["endo.experiment-run.v0", "minimal.json", ENDO_EXPERIMENT_RUN_VERSIONS_V0],
			["endo.experiment-trial.v0", "minimal.json", ENDO_EXPERIMENT_TRIAL_VERSIONS_V0],
			["endo.experiment-plan.v0", "blocked.json", ENDO_EXPERIMENT_PLAN_VERSIONS_V0],
		] as readonly (readonly [string, string, EndoVersionTableV0<unknown>])[]) {
			for (const other of TABLES.filter((candidate) => candidate !== table))
				expect(readEndoVersionedV0(other, json(version, file)), `${version} read by ${other.family}`).toMatchObject(
					{
						ok: false,
					},
				);
			// ...and is not readable as another version of its own family.
			const borrowed = { ...json(version, file), schemaVersion: version.replace(/v\d+$/, "v999") };
			expect(kind(readEndoVersionedV0(table, borrowed))).toBe("unsupported-version");
		}
	});

	it("a run record embeds the spec and experiment versions the run names, not whatever those families learn", () => {
		expect(ENDO_EXPERIMENT_RUN_SPEC_VERSIONS_V0).not.toBe(ENDO_EXPERIMENT_SPEC_VERSIONS_V0);
		expect([...ENDO_EXPERIMENT_RUN_SPEC_VERSIONS_V0.versions]).toEqual(["endo.experiment-spec.v0"]);
		expect([...ENDO_EXPERIMENT_RUN_EXPERIMENT_VERSIONS_V0.versions]).toEqual(["endo.experiment.v0"]);
		const run = json("endo.experiment-run.v0", "full.json");
		const futureSpec = { ...run, spec: { ...run.spec, schemaVersion: "endo.experiment-spec.v1" } };
		expect(readEndoExperimentRunRecordV0(futureSpec)).toMatchObject({
			ok: false,
			kind: "invalid",
			message: expect.stringMatching(/spec: .*unsupported schemaVersion/),
		});
		const futureExperiment = { ...run, experiment: { ...run.experiment, schemaVersion: "endo.experiment.v1" } };
		expect(readEndoExperimentRunRecordV0(futureExperiment)).toMatchObject({ ok: false, kind: "invalid" });
		const { schemaVersion: _omitted, ...unversionedSpec } = run.spec;
		expect(kind(readEndoExperimentRunRecordV0({ ...run, spec: unversionedSpec }))).toBe("invalid");
	});

	it("the run fixtures are consistent: the recorded sha256 is that of their own spec", () => {
		for (const file of ["minimal.json", "full.json"]) {
			const run = json("endo.experiment-run.v0", file);
			expect(run.specSha256).toBe(sha256HexV0(canonicalEndoJsonV0(run.spec)));
		}
	});

	it("refuses a run record or trial result that would make the runner leave its directory", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		for (const store of ["/etc", "../outside", "trials/../../x", "a//b", "a\\b", ""])
			expect(kind(readEndoExperimentTrialResultV0({ ...trial, store })), `store ${store}`).toBe("invalid");
		for (const task of ["../x", "a/b", "A", ""])
			expect(kind(readEndoExperimentTrialResultV0({ ...trial, task })), `task ${task}`).toBe("invalid");
		const plan = json("endo.experiment-plan.v0", "blocked.json");
		for (const task of ["../x", "a/b", ""]) {
			const order = structuredClone(plan.order);
			order[1].task = task;
			expect(kind(readEndoExperimentPlanV0({ ...plan, order }))).toBe("invalid");
		}
	});

	it("keeps a trial's recorded request parameters open JSON objects, and nothing else", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		const deep = { ...trial, requestParameters: [{ a: { b: [{ c: null, d: 1.5 }] } }, {}] };
		expect(kind(readEndoExperimentTrialResultV0(deep))).toBe("ok");
		// Valid JSON is valid however deep (a JSON Schema in response_format): there is no depth limit to trip over.
		let nested: Record<string, unknown> = { leaf: true };
		for (let depth = 0; depth < 5000; depth += 1) nested = { next: nested };
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, requestParameters: [nested] }))).toBe("ok");
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const [index, requestParameters] of [
			[{ f: () => 1 }],
			[{ n: Number.NaN }],
			[{ u: undefined }],
			[cycle],
			{},
			[null],
			[[]],
			["text"],
			[3],
		].entries())
			expect(kind(readEndoExperimentTrialResultV0({ ...trial, requestParameters })), `case ${index}`).toBe(
				"invalid",
			);
	});

	it("the host reader refuses a run record whose digest is not that of its embedded spec", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-run-digest-"));
		try {
			const run = json("endo.experiment-run.v0", "full.json");
			const write = (value: unknown) => writeFileSync(join(dir, "experiment.json"), JSON.stringify(value));
			write(run);
			expect(readEndoExperimentRunRecordFileV0(dir).specSha256).toBe(run.specSha256);
			write({ ...run, spec: { ...run.spec, description: "another experiment" } });
			expect(() => readEndoExperimentRunRecordFileV0(dir)).toThrow(/not the digest of the embedded spec/);
			write({ ...run, specSha256: "0".repeat(64) });
			expect(() => readEndoExperimentRunRecordFileV0(dir)).toThrow(EndoSchemaVersionErrorV0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses an embedded experiment record that is not what the runner derives from the spec", () => {
		const run = json("endo.experiment-run.v0", "full.json");
		const withExperiment = (change: object) =>
			kind(readEndoExperimentRunRecordV0({ ...run, experiment: { ...run.experiment, ...change } }));
		expect(withExperiment({})).toBe("ok");
		expect(withExperiment({ id: "endo.experiment.another" })).toBe("invalid");
		expect(withExperiment({ model: "fixture/another-model" })).toBe("invalid");
		expect(withExperiment({ budget: { trialsPerCell: 9, cells: 4 } })).toBe("invalid");
		expect(withExperiment({ budget: { trialsPerCell: 2, cells: 4, extra: 1 } })).toBe("invalid");
		for (const budget of [null, 5, "x", [], undefined]) expect(withExperiment({ budget })).toBe("invalid");
		expect(withExperiment({ provenance: "endo-experiment-runner.3; spec sha256 abc" })).toBe("invalid");
		expect(kind(readEndoExperimentRunRecordV0({ ...run, runner: "endo-experiment-runner.9" }))).toBe("invalid");
	});

	it("refuses a run whose seed does not follow from the embedded spec's seed", () => {
		const run = json("endo.experiment-run.v0", "full.json");
		const seeded = (specSeed: number | null, seed: number, seedSource: string) =>
			kind(readEndoExperimentRunRecordV0({ ...run, spec: { ...run.spec, seed: specSeed }, seed, seedSource }));
		expect(seeded(7, 7, "spec")).toBe("ok");
		expect(seeded(7, 8, "spec")).toBe("invalid");
		expect(seeded(7, 7, "drawn")).toBe("invalid");
		expect(seeded(null, 123, "drawn")).toBe("ok");
		expect(seeded(null, 123, "spec")).toBe("invalid");
	});

	it("refuses a scratch root that is not the runner's for this spec digest", () => {
		const run = json("endo.experiment-run.v0", "full.json");
		const at = (scratchRoot: string) => kind(readEndoExperimentRunRecordV0({ ...run, scratchRoot }));
		const digest = run.specSha256.slice(0, 12);
		expect(at(`/var/tmp/endo-experiment-${digest}/scratch`)).toBe("ok");
		expect(at(`C:\\temp\\endo-experiment-${digest}\\scratch`)).toBe("ok");
		for (const bad of [
			"/home/user",
			"/",
			"/tmp/scratch",
			`/tmp/endo-experiment-${digest}`,
			`/tmp/endo-experiment-${digest}/work`,
			"/tmp/endo-experiment-0/scratch",
		])
			expect(at(bad)).toBe("invalid");
	});

	it("refuses a completed trial that names no session", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, session: null }))).toBe("invalid");
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, status: "error", error: "failed", session: null }))).toBe(
			"ok",
		);
	});

	it("refuses a trial that ends before it starts", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		const at = (startedAt: string, endedAt: string) =>
			kind(readEndoExperimentTrialResultV0({ ...trial, startedAt, endedAt }));
		expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("ok");
		expect(at("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z")).toBe("ok");
		expect(at("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z")).toBe("invalid");
	});

	it("refuses a success check whose verdict is not its exit code and timeout", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		const check = (change: object) =>
			kind(readEndoExperimentTrialResultV0({ ...trial, check: { ...trial.check, ...change } }));
		expect(check({})).toBe("ok");
		expect(check({ exitCode: 1, passed: false })).toBe("ok");
		expect(check({ exitCode: null, passed: false, timedOut: true })).toBe("ok");
		expect(check({ exitCode: 1, passed: true })).toBe("invalid");
		expect(check({ passed: false })).toBe("invalid");
		expect(check({ timedOut: true, passed: true })).toBe("invalid");
		expect(check({ exitCode: null, passed: true })).toBe("invalid");
	});

	it("refuses a trial whose status contradicts its error: completed holds exactly when there is no error", () => {
		const trial = json("endo.experiment-trial.v0", "full.json");
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, status: "error", error: "the session failed" }))).toBe(
			"ok",
		);
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, status: "completed", error: "failed" }))).toBe("invalid");
		expect(kind(readEndoExperimentTrialResultV0({ ...trial, status: "error", error: null }))).toBe("invalid");
	});

	it("refuses a version in a hostile shape without echoing the record", () => {
		const plan = json("endo.experiment-plan.v0", "blocked.json");
		const read = readEndoExperimentPlanV0({
			...plan,
			schemaVersion: `endo.experiment-plan.v${"9".repeat(400)}\n`,
			secret: "hunter2",
		});
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.kind).toBe("unsupported-version");
		expect(read.message.length).toBeLessThan(400);
		expect(read.message).not.toMatch(/hunter2|\n/);
	});
});

describe("the legacy unversioned plan", () => {
	const legacyBytes = readFileSync(LEGACY_PLAN);
	const legacy = JSON.parse(legacyBytes.toString("utf8"));
	const versioned = JSON.parse(bytesOf("endo.experiment-plan.v0", "blocked.json").toString("utf8"));

	it("is a permanent fixture, pinned, kept outside the versioned catalogue", () => {
		expect(sha256(legacyBytes)).toBe(LEGACY_PLAN_SHA256);
		expect(Object.keys(legacy).sort()).toEqual(["order", "ordering", "seed"]);
		expect(readdirSync(FIXTURES)).not.toContain("experiment-plan");
	});

	it("cannot take part in version dispatch: the ordinary table refuses it as having no version", () => {
		expect(readEndoVersionedV0(ENDO_EXPERIMENT_PLAN_VERSIONS_V0, legacy)).toMatchObject({
			ok: false,
			kind: "missing-version",
		});
	});

	it("is read by its own exact reader, and reported as the legacy form, never as a v0 plan", () => {
		const read = readEndoExperimentPlanV0(legacy);
		expect(read).toMatchObject({ ok: true, form: "legacy-unversioned" });
		if (read.ok) {
			expect(read.plan).toBe(legacy);
			expect("schemaVersion" in read.plan).toBe(false);
		}
		expect(readEndoExperimentPlanV0(versioned)).toMatchObject({
			ok: true,
			form: "versioned",
			schemaVersion: "endo.experiment-plan.v0",
		});
		expect(readEndoLegacyExperimentPlanV0(legacy)).toMatchObject({ ok: true });
	});

	it("is narrow: an extra or missing root field, a bad entry or a declared version is refused", () => {
		const refused = (value: unknown) => readEndoExperimentPlanV0(value);
		expect(refused({ ...legacy, extra: 1 })).toMatchObject({ ok: false, kind: "invalid" });
		const { seed: _seed, ...withoutSeed } = legacy;
		expect(refused(withoutSeed)).toMatchObject({ ok: false, kind: "invalid" });
		const { ordering: _ordering, ...withoutOrdering } = legacy;
		expect(refused(withoutOrdering)).toMatchObject({ ok: false, kind: "invalid" });
		expect(refused({ order: legacy.order })).toMatchObject({ ok: false, kind: "invalid" });
		for (const mutate of [
			(entry: Record<string, unknown>) => {
				entry.extra = 1;
			},
			(entry: Record<string, unknown>) => {
				entry.position = 9;
			},
			(entry: Record<string, unknown>) => {
				entry.task = "../escape";
			},
			(entry: Record<string, unknown>) => {
				delete entry.trial;
			},
		]) {
			const copy = structuredClone(legacy);
			mutate(copy.order[1]);
			expect(refused(copy), JSON.stringify(copy.order[1])).toMatchObject({ ok: false, kind: "invalid" });
		}
		const duplicate = structuredClone(legacy);
		duplicate.order[3] = { ...duplicate.order[1], position: 3 };
		expect(refused(duplicate)).toMatchObject({ ok: false, kind: "invalid" });
		// A record that declares a version is the version table's, whatever else it looks like.
		expect(refused({ ...legacy, schemaVersion: "endo.experiment-plan.v1" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
		expect(refused({ ...legacy, schemaVersion: 0 })).toMatchObject({ ok: false, kind: "version-not-string" });
		expect(refused({ ...legacy, schemaVersion: "endo.experiment-plan.v0" })).toMatchObject({
			ok: true,
			form: "versioned",
		});
	});

	it("is not what a v0 plan is: the legacy reader refuses a record that declares a version", () => {
		expect(readEndoLegacyExperimentPlanV0(versioned)).toMatchObject({ ok: false });
		expect(readEndoLegacyExperimentPlanV0(null)).toMatchObject({ ok: false });
		expect(readEndoLegacyExperimentPlanV0([])).toMatchObject({ ok: false });
	});
});

describe("every committed run directory is read by the governed readers", () => {
	const research = join(import.meta.dirname, "..", "research");
	const files = existsSync(research)
		? readdirSync(research, { recursive: true })
				.map(String)
				.filter((path) => /(^|\/)(experiment|plan|result)\.json$/.test(path))
		: [];

	it.skipIf(files.length === 0)(
		"reads every committed experiment.json, plan.json (as the legacy form) and trial result.json",
		() => {
			const seen = { run: 0, plan: 0, trial: 0 };
			for (const path of files) {
				const value = JSON.parse(readFileSync(join(research, path), "utf8"));
				if (path.endsWith("experiment.json")) {
					expect(readEndoExperimentRunRecordV0(value), path).toMatchObject({ ok: true });
					seen.run += 1;
				} else if (path.endsWith("plan.json")) {
					expect(readEndoExperimentPlanV0(value), path).toMatchObject({ ok: true, form: "legacy-unversioned" });
					seen.plan += 1;
				} else if (/(^|\/)trials\//.test(path)) {
					expect(readEndoExperimentTrialResultV0(value), path).toMatchObject({ ok: true });
					seen.trial += 1;
				}
			}
			expect(seen.run).toBeGreaterThan(0);
			expect(seen.run).toBe(seen.plan);
			expect(seen.trial).toBeGreaterThan(0);
		},
		120_000,
	);
});
