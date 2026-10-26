import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { readVerifiedCheckpointCandidateV0 } from "../cli/checkpoint-candidate.ts";
import { prepareVerifiedInitialBranchPairV0, readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import type { EndoExperimentConditionV0 } from "../protocol/experiment-spec.ts";
import { type EndoInitialBranchSetV0, readEndoInitialBranchSetV0 } from "../protocol/initial-branch-set.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { archiveEndoWorkspaceV0 } from "../storage/workspace-snapshot.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
const baseline: EndoExperimentConditionV0 = {
	id: "baseline",
	description: "private baseline description",
	settings: { thinkingLevel: "off" },
};
const alternative: EndoExperimentConditionV0 = {
	id: "alternative",
	description: "private planned alternative",
	settings: { thinkingLevel: "high" },
};
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
}, 120_000);
afterAll(() => {
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
const output = () => mkdtempSync(join(fixture.base, "output-"));
function prepare() {
	const parent = output();
	const result = prepareVerifiedInitialBranchPairV0(
		fixture.source,
		fixture.replay,
		fixture.key,
		parent,
		baseline,
		alternative,
	);
	expect(result.status).toBe("prepared");
	if (result.status !== "prepared") throw new Error("synthetic preparation failed");
	return { parent, result };
}
function manifest(file: string): EndoInitialBranchSetV0 {
	return JSON.parse(readFileSync(file, "utf8"));
}
function replace(file: string, value: unknown) {
	writeFileSync(file, canonicalEndoJsonV0(value));
}
function read(parent: string, preparation: string, source = fixture.source, replay = fixture.replay) {
	return readVerifiedInitialBranchSetV0(source, replay, fixture.key, parent, preparation);
}
function reseal(m: EndoInitialBranchSetV0) {
	const { commitment: _, ...content } = m;
	m.commitment = fixture.key.digest({ purpose: "endo.initial-branch-set.manifest.v0", content });
}

describe("verified sibling initial-state preparation", () => {
	it("records and replays a tool session, independently prepares and reads two siblings, and detects only the changed alternative", () => {
		expect(fixture.report.misses).toBe(0);
		expect(fixture.report.unserved).toBe(0);
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
			expect(fixture.report.comparison.layers[layer].status).toBe("EXACT");
		const checkpoint = readVerifiedCheckpointCandidateV0(fixture.source, fixture.replay, fixture.key);
		expect(checkpoint.status).toBe("qualified");
		if (checkpoint.status !== "qualified") return;
		const sourceBefore = readEndoCaptureEventsV0(fixture.source);
		const replayBefore = readEndoCaptureEventsV0(fixture.replay);
		const starts = readFileSync(fixture.starts);
		expect(existsSync(fixture.scratch)).toBe(false);
		// A synthetic sentinel at the recorded root must survive preparation unchanged.
		mkdirSync(fixture.scratch);
		writeFileSync(join(fixture.scratch, "sentinel"), "original scratch untouched");
		const original = archiveEndoWorkspaceV0(fixture.scratch).bytes;
		const { parent, result } = prepare();
		const m = manifest(result.lineageArtifact);
		expect(m.parent).toEqual(checkpoint.candidate);
		expect(m.children.baseline.parent).toEqual(m.parentReference);
		expect(m.children.alternative.parent).toEqual(m.parentReference);
		expect(result.children.baseline.id).not.toBe(result.children.alternative.id);
		expect(result.children.baseline.directory).not.toBe(result.children.alternative.directory);
		expect(m.children.baseline.filesystem).not.toEqual(m.children.alternative.filesystem);
		const archive = createEndoBlobStoreV0(endoCaptureRootV0(fixture.source), fixture.key, { readOnly: true }).get(
			checkpoint.candidate.archive.digest,
		);
		for (const child of Object.values(result.children)) {
			expect(archiveEndoWorkspaceV0(child.directory).bytes).toEqual(archive);
			expect(readFileSync(join(child.directory, "work", "endophasia-study.txt"), "utf8")).toBe(
				"initial scratch content\n",
			);
			expect(lstatSync(child.directory).mode & 0o077).toBe(0);
			expect(existsSync(join(child.directory, "branch-set.json"))).toBe(false);
		}
		expect(lstatSync(result.lineageArtifact).mode & 0o077).toBe(0);
		expect(m.changeCategory).toBe("settings");
		expect(m.children.alternative.manipulation).toBe("planned-not-applied");
		expect(read(parent, result.preparation)).toMatchObject({
			status: "verified-pristine",
			children: { baseline: { status: "pristine" }, alternative: { status: "pristine" } },
			execution: "not-started",
			continuationAuthority: "none",
		});
		expect(JSON.stringify(result)).not.toContain("private planned");
		expect(JSON.stringify(read(parent, result.preparation))).not.toContain("thinkingLevel");
		writeFileSync(
			join(result.children.alternative.directory, "work", "endophasia-study.txt"),
			"changed alternative\n",
		);
		expect(read(parent, result.preparation)).toMatchObject({
			status: "children-changed",
			children: { baseline: { status: "pristine" }, alternative: { status: "modified" } },
		});
		expect(archiveEndoWorkspaceV0(result.children.baseline.directory).bytes).toEqual(archive);
		expect(readVerifiedCheckpointCandidateV0(fixture.source, fixture.replay, fixture.key)).toEqual(checkpoint);
		expect(readEndoCaptureEventsV0(fixture.source)).toEqual(sourceBefore);
		expect(readEndoCaptureEventsV0(fixture.replay)).toEqual(replayBefore);
		expect(readFileSync(fixture.starts)).toEqual(starts);
		expect(archiveEndoWorkspaceV0(fixture.scratch).bytes).toEqual(original);
		rmSync(fixture.scratch, { recursive: true });
	});
	it("refuses a different genuine replay generation even when it qualifies against the identical parent archive", async () => {
		const { parent, result } = prepare();
		const replay = join(mkdtempSync(join(fixture.base, "fresh-replay-")), "store");
		const report = await replayPiCassetteSessionV0({
			store: fixture.source,
			out: replay,
			pi: fixture.pi.bin,
			timing: "immediate",
			keySource: { kind: "fixture", path: endoFixtureDigestKeyPathV0() },
			timeoutMs: 20_000,
		});
		expect(report.checkpointQualification).toEqual({ status: "qualified" });
		const qualified = readVerifiedCheckpointCandidateV0(fixture.source, replay, fixture.key);
		expect(qualified.status).toBe("qualified");
		if (qualified.status !== "qualified") return;
		const before = manifest(result.lineageArtifact).parent;
		expect(qualified.candidate.archive).toEqual(before.archive);
		expect(qualified.candidate.evidence.replayCapture).not.toEqual(before.evidence.replayCapture);
		expect(read(parent, result.preparation, fixture.source, replay)).toEqual({
			status: "refused",
			reason: "parent-stale",
		});
		expect(read(parent, result.preparation).status).toBe("verified-pristine");
	});
	it("binds creation time as well as device/inode when detecting substitution", () => {
		const { parent, result } = prepare();
		const m = manifest(result.lineageArtifact);
		m.children.alternative.filesystem.birthtimeNs = "1";
		reseal(m);
		replace(result.lineageArtifact, m);
		expect(read(parent, result.preparation)).toMatchObject({
			status: "children-changed",
			children: { baseline: { status: "pristine" }, alternative: { status: "substituted" } },
		});
	});

	it("assigns fresh set and child identities on repeated preparations of the same exact parent", () => {
		const a = prepare();
		const b = prepare();
		expect(a.result.id).not.toBe(b.result.id);
		expect(
			new Set([...Object.values(a.result.children), ...Object.values(b.result.children)].map((c) => c.id)).size,
		).toBe(4);
		expect(manifest(a.result.lineageArtifact).parentReference).toEqual(
			manifest(b.result.lineageArtifact).parentReference,
		);
		expect(read(a.parent, a.result.preparation).status).toBe("verified-pristine");
		expect(read(b.parent, b.result.preparation).status).toBe("verified-pristine");
	});
	it.each(["missing", "symlink", "replacement"] as const)(
		"distinguishes a %s alternative while preserving the baseline verdict",
		(mode) => {
			const { parent, result } = prepare();
			const child = result.children.alternative.directory;
			if (mode === "missing") rmSync(child, { recursive: true });
			else {
				renameSync(child, `${child}-original`);
				if (mode === "symlink") symlinkSync(result.children.baseline.directory, child);
				else cpSync(`${child}-original`, child, { recursive: true });
			}
			expect(read(parent, result.preparation)).toMatchObject({
				status: "children-changed",
				children: {
					baseline: { status: "pristine" },
					alternative: { status: mode === "missing" ? "missing" : "substituted" },
				},
			});
		},
	);
	it("refuses pristine status for static cross-child hardlinks even when canonical archives still match", () => {
		const { parent, result } = prepare();
		const a = join(result.children.baseline.directory, "work", "endophasia-study.txt");
		const b = join(result.children.alternative.directory, "work", "endophasia-study.txt");
		const folder = join(result.children.alternative.directory, "work");
		const time = lstatSync(folder).mtimeMs;
		unlinkSync(b);
		linkSync(a, b);
		utimesSync(folder, (Math.floor(time) + 0.5) / 1000, (Math.floor(time) + 0.5) / 1000);
		expect(archiveEndoWorkspaceV0(result.children.baseline.directory).bytes).toEqual(
			archiveEndoWorkspaceV0(result.children.alternative.directory).bytes,
		);
		expect(read(parent, result.preparation)).toMatchObject({
			status: "children-changed",
			children: { baseline: { status: "unverifiable" }, alternative: { status: "unverifiable" } },
		});
		// Repair only the alternative's sharing; the baseline becomes independently pristine again.
		const content = readFileSync(b);
		const fileTime = lstatSync(b).mtimeMs;
		unlinkSync(b);
		writeFileSync(b, content);
		utimesSync(b, (Math.floor(fileTime) + 0.5) / 1000, (Math.floor(fileTime) + 0.5) / 1000);
		utimesSync(folder, (Math.floor(time) + 0.5) / 1000, (Math.floor(time) + 0.5) / 1000);
		expect(read(parent, result.preparation).status).toBe("verified-pristine");
	});

	it("refuses malformed, noncanonical, future, tampered, ambiguous, and authority-bearing manifests", () => {
		const { parent, result } = prepare();
		const m = manifest(result.lineageArtifact);
		const changes: ((m: EndoInitialBranchSetV0) => void)[] = [
			(v) => {
				v.schemaVersion = "endo.initial-branch-set.v9" as never;
			},
			(v) => {
				v.children.alternative.id = v.children.baseline.id;
			},
			(v) => {
				v.children.alternative.directory = "../outside";
			},
			(v) => {
				v.children.alternative.condition.specification.id = v.children.baseline.condition.specification.id;
			},
			(v) => {
				v.children.alternative.condition.specification.settings = { privateSecret: "DO-NOT-ECHO" };
			},
			(v) => {
				v.children.alternative.condition.commitment.value = "a".repeat(64);
				reseal(v);
			},
			(v) => {
				v.children.alternative.parent.value = "b".repeat(64);
				reseal(v);
			},
			(v) => {
				v.parent.session = "endo.session.pi.another";
			},
			(v) => {
				v.execution = "started" as never;
			},
			(v) => {
				v.continuationAuthority = "granted" as never;
			},
			(v) => {
				v.children.alternative.manipulation = "applied" as never;
			},
			(v) => {
				(v as unknown as Record<string, unknown>).executionGrant = true;
			},
		];
		for (const change of changes) {
			const changed = structuredClone(m);
			change(changed);
			replace(result.lineageArtifact, changed);
			const verdict = read(parent, result.preparation);
			expect(verdict.status).toBe("refused");
			expect(JSON.stringify(verdict)).not.toContain("DO-NOT-ECHO");
		}
		writeFileSync(result.lineageArtifact, JSON.stringify(m, null, 2));
		expect(read(parent, result.preparation).status).toBe("refused");
		replace(result.lineageArtifact, m);
		expect(read(parent, result.preparation).status).toBe("verified-pristine");
	});
	it("does not accept a differently qualified session or generation with the same archive", () => {
		const { parent, result } = prepare();
		const m = manifest(result.lineageArtifact);
		m.parent.session = "endo.session.pi.other";
		m.parentReference = fixture.key.digest({ purpose: "endo.initial-branch-set.parent.v0", parent: m.parent });
		m.children.baseline.parent = m.parentReference;
		m.children.alternative.parent = m.parentReference;
		reseal(m);
		replace(result.lineageArtifact, m);
		expect(read(parent, result.preparation)).toEqual({ status: "refused", reason: "parent-stale" });
	});
	it("refuses invalid and ambiguous conditions before staging, without echoing specifications", () => {
		const parent = output();
		for (const condition of [
			{ ...alternative, id: "../secret" },
			{ ...alternative, id: "baseline" },
			{ ...alternative, unknownSecret: "DO-NOT-ECHO" },
			{ ...alternative, description: "x".repeat(70_000) },
			{ ...alternative, modelEntry: { id: "forbidden" } },
		]) {
			const result = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				parent,
				baseline,
				condition,
			);
			expect(result).toEqual({ status: "refused", reason: "conditions-invalid" });
		}
		expect(readdirSync(parent)).toEqual([]);
	});
	it.each([
		"missing-receipt",
		"stale-receipt",
		"source-log",
		"replay-log",
		"capture-generation",
		"blob-missing",
		"blob-tamper",
	])("refuses %s evidence during preparation and subsequent read", (mode) => {
		const { parent, result } = prepare();
		const root = mkdtempSync(join(fixture.base, "evidence-"));
		const source = join(root, "source");
		const replay = join(root, "replay");
		cpSync(fixture.source, source, { recursive: true });
		cpSync(fixture.replay, replay, { recursive: true });
		if (mode === "missing-receipt") rmSync(join(replay, "replay-artifacts", "checkpoint-candidate.json"));
		if (mode === "stale-receipt")
			writeFileSync(join(replay, "replay-artifacts", "checkpoint-candidate.json"), "{}\n");
		if (mode === "source-log") appendFileSync(join(source, "events", "events.log"), Buffer.from([1]));
		if (mode === "replay-log") appendFileSync(join(replay, "capture", "events", "events.log"), Buffer.from([1]));
		if (mode === "capture-generation") {
			const events = structuredClone(readEndoCaptureEventsV0(source));
			const event = events.find((e) => e.kind === "capture.workspace-snapshot")!;
			(event.payload as { workspace: string }).workspace = "mutated";
			rmSync(join(source, "capture", "events", "events.log"));
			const store = createEndoDurableEventStoreV0(join(source, "capture"));
			try {
				for (const e of events) store.ingest(e);
			} finally {
				store.close();
			}
		}
		if (mode.startsWith("blob")) {
			const m = manifest(result.lineageArtifact);
			const file = join(source, "capture", "blobs", fixture.key.keyId, m.parent.archive.digest.value);
			if (mode === "blob-missing") rmSync(file);
			else writeFileSync(file, "substituted archive");
		}
		expect(read(parent, result.preparation, source, replay)).toEqual({ status: "refused", reason: "parent-invalid" });
		const empty = output();
		expect(prepareVerifiedInitialBranchPairV0(source, replay, fixture.key, empty, baseline, alternative).status).toBe(
			"refused",
		);
		expect(readdirSync(empty)).toEqual([]);
	});
	it("refuses wrong digest keys, unsafe parents, area/manifest substitutions and interrupted staging", () => {
		const { parent, result } = prepare();
		const wrong = endoDigestKeyV0(randomBytes(32), "wrong");
		expect(
			readVerifiedInitialBranchSetV0(fixture.source, fixture.replay, wrong, parent, result.preparation).status,
		).toBe("refused");
		expect(
			prepareVerifiedInitialBranchPairV0(fixture.source, fixture.replay, wrong, output(), baseline, alternative)
				.status,
		).toBe("refused");
		for (const unsafe of [fixture.source, fixture.replay, `${parent}/../bad`])
			expect(
				prepareVerifiedInitialBranchPairV0(
					fixture.source,
					fixture.replay,
					fixture.key,
					unsafe,
					baseline,
					alternative,
				).status,
			).toBe("refused");
		const link = join(fixture.base, "output-alias");
		symlinkSync(parent, link);
		expect(read(link, result.preparation).status).toBe("refused");
		expect(read(parent, "../escape").status).toBe("refused");
		const text = readFileSync(result.lineageArtifact);
		rmSync(result.lineageArtifact);
		writeFileSync(`${result.lineageArtifact}.private`, text, { mode: 0o600 });
		symlinkSync(`${result.lineageArtifact}.private`, result.lineageArtifact);
		expect(read(parent, result.preparation).status).toBe("refused");
		rmSync(result.lineageArtifact);
		writeFileSync(result.lineageArtifact, text, { mode: 0o600 });
		chmodSync(result.lineageArtifact, 0o644);
		expect(read(parent, result.preparation).status).toBe("refused");
		chmodSync(result.lineageArtifact, 0o600);
		const area = join(parent, result.preparation);
		renameSync(area, `${area}-original`);
		cpSync(`${area}-original`, area, { recursive: true });
		expect(read(parent, result.preparation).status).toBe("refused");
		const staging = mkdtempSync(join(parent, "endo-initial-branches-"));
		writeFileSync(join(staging, "branch-set.json.tmp"), "unfinished", { mode: 0o600 });
		expect(read(parent, staging.split("/").at(-1)!).status).toBe("refused");
		expect(readFileSync(join(staging, "branch-set.json.tmp"), "utf8")).toBe("unfinished");
	});
	it("returns invalid rather than throwing when required nested fields are missing", () => {
		const { result } = prepare();
		const m = manifest(result.lineageArtifact);
		const cases: Record<string, unknown>[] = [
			m as unknown as Record<string, unknown>,
			m.children as unknown as Record<string, unknown>,
			m.children.baseline as unknown as Record<string, unknown>,
			m.children.baseline.condition as unknown as Record<string, unknown>,
			m.children.baseline.condition.specification as unknown as Record<string, unknown>,
			m.area as unknown as Record<string, unknown>,
			m.area.filesystem as unknown as Record<string, unknown>,
		];
		for (const object of cases)
			for (const name of Object.keys(object).filter((key) => object !== cases[4] || key !== "settings")) {
				const backup = object[name];
				delete object[name];
				try {
					expect(readEndoInitialBranchSetV0(m)).toMatchObject({ ok: false });
				} finally {
					object[name] = backup;
				}
			}
	});

	it("dispatches the narrow schema and refuses unknown nested fields", () => {
		const { result } = prepare();
		const m = manifest(result.lineageArtifact);
		expect(readEndoInitialBranchSetV0(m).ok).toBe(true);
		const unknown = structuredClone(m);
		(unknown.children.baseline as unknown as Record<string, unknown>).futureField = 1;
		expect(readEndoInitialBranchSetV0(unknown).ok).toBe(false);
		expect(readEndoInitialBranchSetV0({ ...m, schemaVersion: "endo.initial-branch-set.v1" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
	});
});
