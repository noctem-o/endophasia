// Filesystem preparation and private lineage only. No runtime controller or execution grant is consumed or produced.
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { endoCaptureRootV0 } from "../adapters/openai-proxy/capture-log.ts";
import type { EndoCheckpointCandidateV0 } from "../protocol/checkpoint-candidate.ts";
import { type EndoExperimentConditionV0, endoExperimentConditionProblemV0 } from "../protocol/experiment-spec.ts";
import {
	ENDO_INITIAL_BRANCH_CONDITION_MAX_BYTES_V0,
	ENDO_INITIAL_BRANCH_SET_MAX_BYTES_V0,
	type EndoInitialBranchDirectoryIdentityV0,
	type EndoInitialBranchSetV0,
	type EndoPreparedInitialChildV0,
	isEndoInitialBranchAreaV0,
	readEndoInitialBranchSetV0,
} from "../protocol/initial-branch-set.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { archiveEndoWorkspaceV0, readEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";
import { readVerifiedCheckpointCandidateV0 } from "./checkpoint-candidate.ts";
import { checkpointOutputParent, identity as filesystemIdentity } from "./checkpoint-filesystem.ts";
import { materializeVerifiedInitialCheckpointV0 } from "./checkpoint-materialization.ts";

// POSIX dev/inode alone may be reused after deletion. Require filesystem creation time as well.
function identity(path: string): EndoInitialBranchDirectoryIdentityV0 | null {
	try {
		const found = filesystemIdentity(path);
		const info = lstatSync(path, { bigint: true });
		if (!found || info.birthtimeNs <= 0n) return null;
		return { ...found, birthtimeNs: info.birthtimeNs.toString() };
	} catch {
		return null;
	}
}
const sameIdentity = (path: string, expected: EndoInitialBranchDirectoryIdentityV0): boolean => {
	const found = identity(path);
	return (
		found !== null &&
		found.dev === expected.dev &&
		found.ino === expected.ino &&
		found.birthtimeNs === expected.birthtimeNs
	);
};

export const ENDO_INITIAL_BRANCH_SET_FILE_V0 = "branch-set.json";
export type EndoInitialBranchRefusalReasonV0 =
	| "parent-invalid"
	| "parent-stale"
	| "conditions-invalid"
	| "unsafe-output-parent"
	| "lineage-unverifiable"
	| "materialization-refused"
	| "preparation-failed"
	| "final-verification-failed"
	| "cleanup-unsafe";
export type EndoInitialBranchRefusalV0 = {
	status: "refused";
	reason: EndoInitialBranchRefusalReasonV0;
	retainedPaths?: string[];
};
export type EndoInitialChildStateV0 = {
	id: string;
	status: "pristine" | "modified" | "missing" | "substituted" | "unverifiable";
};
export type EndoInitialBranchReadV0 =
	| EndoInitialBranchRefusalV0
	| {
			status: "verified-pristine" | "children-changed";
			kind: "verified-initial-sibling-preparation";
			id: string;
			parentReference: EndoInitialBranchSetV0["parentReference"];
			children: { baseline: EndoInitialChildStateV0; alternative: EndoInitialChildStateV0 };
			execution: "not-started";
			continuationAuthority: "none";
	  };
export type EndoInitialBranchPreparationV0 =
	| EndoInitialBranchRefusalV0
	| {
			status: "prepared";
			kind: "verified-initial-sibling-preparation";
			id: string;
			/** Local operator references, not public UI or logging projections. */
			preparation: string;
			lineageArtifact: string;
			children: { baseline: { id: string; directory: string }; alternative: { id: string; directory: string } };
			execution: "not-started";
			continuationAuthority: "none";
	  };
const refuse = (reason: EndoInitialBranchRefusalReasonV0): EndoInitialBranchRefusalV0 => ({
	status: "refused",
	reason,
});
const equal = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
const parentRef = (key: EndoDigestKeyV0, parent: EndoCheckpointCandidateV0) =>
	key.digest({ purpose: "endo.initial-branch-set.parent.v0", parent });
const conditionRef = (key: EndoDigestKeyV0, specification: EndoExperimentConditionV0) =>
	key.digest({ purpose: "endo.initial-branch-set.condition.v0", specification });
const manifestRef = (key: EndoDigestKeyV0, content: Omit<EndoInitialBranchSetV0, "commitment">) =>
	key.digest({ purpose: "endo.initial-branch-set.manifest.v0", content });
function boundedCondition(value: unknown): value is EndoExperimentConditionV0 {
	try {
		return (
			Buffer.byteLength(canonicalEndoJsonV0(value)) <= ENDO_INITIAL_BRANCH_CONDITION_MAX_BYTES_V0 &&
			endoExperimentConditionProblemV0(value) === null
		);
	} catch {
		return false;
	}
}
function changeCategory(
	baseline: EndoExperimentConditionV0,
	alternative: EndoExperimentConditionV0,
): EndoInitialBranchSetV0["changeCategory"] {
	const changed = (["modelEntry", "settings", "extensions", "environment", "interventions"] as const).filter(
		(name) => !equal(baseline[name] ?? null, alternative[name] ?? null),
	);
	return changed.length === 0 ? "declared-noop" : changed.length === 1 ? changed[0]! : "composite";
}
function validCommitments(manifest: EndoInitialBranchSetV0, key: EndoDigestKeyV0): boolean {
	const { commitment, ...content } = manifest;
	if (
		!equal(commitment, manifestRef(key, content)) ||
		!equal(manifest.parentReference, parentRef(key, manifest.parent))
	)
		return false;
	for (const child of Object.values(manifest.children))
		if (
			!boundedCondition(child.condition.specification) ||
			!equal(child.parent, manifest.parentReference) ||
			!equal(child.condition.commitment, conditionRef(key, child.condition.specification))
		)
			return false;
	return (
		manifest.changeCategory ===
		changeCategory(
			manifest.children.baseline.condition.specification,
			manifest.children.alternative.condition.specification,
		)
	);
}
/** Open only a private regular file, never follow its final symlink. No diagnostic includes file contents. */
function readPrivateManifest(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = fstatSync(fd);
		if (
			!info.isFile() ||
			info.uid !== process.getuid?.() ||
			(info.mode & 0o077) !== 0 ||
			info.size > ENDO_INITIAL_BRANCH_SET_MAX_BYTES_V0
		)
			throw new Error("private manifest unavailable");
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
	} finally {
		closeSync(fd);
	}
}
function inspectChild(
	area: string,
	child: EndoPreparedInitialChildV0,
	archive: Uint8Array,
	filePaths: readonly string[],
): EndoInitialChildStateV0 {
	const path = join(area, child.directory);
	const state = (status: EndoInitialChildStateV0["status"]): EndoInitialChildStateV0 => ({ id: child.id, status });
	try {
		lstatSync(path);
	} catch (error) {
		return state((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverifiable");
	}
	if (!sameIdentity(path, child.filesystem)) return state("substituted");
	try {
		const info = lstatSync(path);
		if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return state("unverifiable");
		const bytes = archiveEndoWorkspaceV0(path).bytes;
		if (!sameIdentity(path, child.filesystem)) return state("substituted");
		if (!Buffer.from(bytes).equals(Buffer.from(archive))) return state("modified");
		// Archive bytes omit hardlink relationships. Pristine siblings must also retain independently mutable files.
		for (const relative of filePaths) {
			const entry = lstatSync(join(path, relative));
			if (!entry.isFile() || entry.nlink !== 1) return state("unverifiable");
		}
		return state("pristine");
	} catch {
		return state("unverifiable");
	}
}

function archiveFilePaths(archive: Uint8Array): string[] {
	const parsed = readEndoWorkspaceArchiveV0(archive);
	if (!parsed.ok || parsed.schemaVersion !== "endo.workspace-archive.v1")
		throw new Error("unsupported source archive");
	return parsed.value.entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
}

/** Revalidate current evidence, private commitments and both current trees. Historical preparation is never sufficient. */
export function readVerifiedInitialBranchSetV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	outputParent: string,
	preparation: string,
): EndoInitialBranchReadV0 {
	const first = readVerifiedCheckpointCandidateV0(source, replay, key);
	if (first.status !== "qualified") return refuse("parent-invalid");
	const parent = checkpointOutputParent(source, replay, outputParent);
	if (!parent.ok) return refuse("unsafe-output-parent");
	const outputIdentity = identity(parent.path);
	if (!outputIdentity) return refuse("unsafe-output-parent");
	if (!isEndoInitialBranchAreaV0(preparation)) return refuse("lineage-unverifiable");
	const area = join(parent.path, preparation);
	try {
		const file = join(area, ENDO_INITIAL_BRANCH_SET_FILE_V0);
		const areaIdentity = identity(area);
		const info = lstatSync(area);
		if (!areaIdentity || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
			return refuse("lineage-unverifiable");
		const text = readPrivateManifest(file);
		const read = readEndoInitialBranchSetV0(JSON.parse(text));
		if (!read.ok || text !== canonicalEndoJsonV0(read.value)) return refuse("lineage-unverifiable");
		const manifest = read.value;
		if (
			manifest.area.directory !== preparation ||
			!sameIdentity(area, manifest.area.filesystem) ||
			!sameIdentity(parent.path, manifest.area.outputParent) ||
			!validCommitments(manifest, key)
		)
			return refuse("lineage-unverifiable");
		if (!equal(first.candidate, manifest.parent)) return refuse("parent-stale");
		const archive = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
			manifest.parent.archive.digest,
		);
		if (archive.length !== manifest.parent.archive.bytes) return refuse("parent-invalid");
		const filePaths = archiveFilePaths(archive);
		const children = {
			baseline: inspectChild(area, manifest.children.baseline, archive, filePaths),
			alternative: inspectChild(area, manifest.children.alternative, archive, filePaths),
		};
		const second = readVerifiedCheckpointCandidateV0(source, replay, key);
		if (second.status !== "qualified") return refuse("parent-invalid");
		if (!equal(first.candidate, second.candidate)) return refuse("parent-stale");
		if (
			!sameIdentity(parent.path, outputIdentity) ||
			!sameIdentity(area, areaIdentity) ||
			readPrivateManifest(file) !== text
		)
			return refuse("lineage-unverifiable");
		// Detect a top-level substitution that occurred while inspecting the other sibling.
		for (const role of ["baseline", "alternative"] as const)
			if (
				children[role].status === "pristine" &&
				!sameIdentity(join(area, manifest.children[role].directory), manifest.children[role].filesystem)
			)
				children[role].status = "substituted";
		return {
			status: Object.values(children).every((c) => c.status === "pristine")
				? "verified-pristine"
				: "children-changed",
			kind: "verified-initial-sibling-preparation",
			id: manifest.id,
			parentReference: manifest.parentReference,
			children,
			execution: "not-started",
			continuationAuthority: "none",
		};
	} catch {
		return refuse("lineage-unverifiable");
	}
}

/** Prepare two siblings. Declarations are retained privately and are never applied or executed. */
export function prepareVerifiedInitialBranchPairV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	outputParent: string,
	baseline: EndoExperimentConditionV0,
	alternative: EndoExperimentConditionV0,
): EndoInitialBranchPreparationV0 {
	const first = readVerifiedCheckpointCandidateV0(source, replay, key);
	if (first.status !== "qualified") return refuse("parent-invalid");
	if (!boundedCondition(baseline) || !boundedCondition(alternative) || baseline.id === alternative.id)
		return refuse("conditions-invalid");
	const parent = checkpointOutputParent(source, replay, outputParent);
	if (!parent.ok) return refuse("unsafe-output-parent");
	const outputIdentity = identity(parent.path);
	if (!outputIdentity) return refuse("unsafe-output-parent");
	let area: string;
	try {
		area = mkdtempSync(join(parent.path, "endo-initial-branches-"));
	} catch {
		return refuse("preparation-failed");
	}
	const areaIdentity = identity(area);
	const owned = new Map<string, { dev: number; ino: number; birthtimeNs?: string }>();
	let uncertainChild = false;
	const cleanup = (reason: EndoInitialBranchRefusalReasonV0): EndoInitialBranchRefusalV0 => {
		try {
			if (
				!areaIdentity ||
				!sameIdentity(parent.path, outputIdentity) ||
				!sameIdentity(area, areaIdentity) ||
				uncertainChild
			)
				return { ...refuse("cleanup-unsafe"), retainedPaths: [area] };
			// Every top-level entry must still be one we created; refuse deletion of substituted or injected entries.
			for (const name of readdirSync(area)) {
				const expected = owned.get(name);
				const current = lstatSync(join(area, name));
				if (
					!expected ||
					current.isSymbolicLink() ||
					current.dev !== expected.dev ||
					current.ino !== expected.ino ||
					(expected.birthtimeNs !== undefined &&
						!sameIdentity(join(area, name), expected as EndoInitialBranchDirectoryIdentityV0))
				)
					return { ...refuse("cleanup-unsafe"), retainedPaths: [area] };
			}
			rmSync(area, { recursive: true });
			return refuse(reason);
		} catch {
			return { ...refuse("cleanup-unsafe"), retainedPaths: [area] };
		}
	};
	try {
		if (!areaIdentity || !sameIdentity(parent.path, outputIdentity)) return cleanup("preparation-failed");
		const children = {} as EndoInitialBranchSetV0["children"];
		const reference = parentRef(key, first.candidate);
		for (const [role, specification] of [
			["baseline", baseline],
			["alternative", alternative],
		] as const) {
			const materialized = materializeVerifiedInitialCheckpointV0(source, replay, key, area);
			if (materialized.status !== "materialized") {
				uncertainChild = materialized.retainedDirectory !== undefined;
				return cleanup("materialization-refused");
			}
			const name = basename(materialized.directory);
			const filesystem = identity(materialized.directory);
			if (!filesystem || join(area, name) !== materialized.directory) {
				uncertainChild = true;
				return cleanup("materialization-refused");
			}
			owned.set(name, filesystem);
			children[role] = {
				id: `endo.prepared-child.${randomUUID()}`,
				parent: reference,
				directory: name,
				filesystem,
				condition: { specification: structuredClone(specification), commitment: conditionRef(key, specification) },
				manipulation: "planned-not-applied",
			};
		}
		const second = readVerifiedCheckpointCandidateV0(source, replay, key);
		if (second.status !== "qualified" || !equal(second.candidate, first.candidate)) return cleanup("parent-stale");
		const content: Omit<EndoInitialBranchSetV0, "commitment"> = {
			schemaVersion: "endo.initial-branch-set.v0",
			id: `endo.initial-branch-set.${randomUUID()}`,
			parent: first.candidate,
			parentReference: reference,
			area: { directory: basename(area), filesystem: areaIdentity, outputParent: outputIdentity },
			children,
			changeCategory: changeCategory(baseline, alternative),
			preparation: "completed",
			execution: "not-started",
			continuationAuthority: "none",
			outcomes: "not-observed",
		};
		const manifest: EndoInitialBranchSetV0 = { ...content, commitment: manifestRef(key, content) };
		const text = canonicalEndoJsonV0(manifest);
		if (
			!readEndoInitialBranchSetV0(manifest).ok ||
			!validCommitments(manifest, key) ||
			Buffer.byteLength(text) > ENDO_INITIAL_BRANCH_SET_MAX_BYTES_V0
		)
			return cleanup("preparation-failed");
		const archive = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
			first.candidate.archive.digest,
		);
		const filePaths = archiveFilePaths(archive);
		if (Object.values(children).some((c) => inspectChild(area, c, archive, filePaths).status !== "pristine"))
			return cleanup("final-verification-failed");
		// Canonical private temporary + fsync + atomic no-clobber publication + directory fsync.
		const temporary = join(area, "branch-set.json.tmp");
		const file = join(area, ENDO_INITIAL_BRANCH_SET_FILE_V0);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			const info = fstatSync(fd);
			owned.set(basename(temporary), { dev: info.dev, ino: info.ino });
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (!sameIdentity(parent.path, outputIdentity) || !sameIdentity(area, areaIdentity))
			return cleanup("preparation-failed");
		const beforePublication = readVerifiedCheckpointCandidateV0(source, replay, key);
		if (beforePublication.status !== "qualified" || !equal(first.candidate, beforePublication.candidate))
			return cleanup("parent-stale");
		linkSync(temporary, file);
		owned.set(ENDO_INITIAL_BRANCH_SET_FILE_V0, owned.get(basename(temporary))!);
		unlinkSync(temporary);
		const dirFd = openSync(area, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		const outputFd = openSync(parent.path, "r");
		try {
			fsyncSync(outputFd);
		} finally {
			closeSync(outputFd);
		}
		const verified = readVerifiedInitialBranchSetV0(source, replay, key, parent.path, basename(area));
		if (verified.status !== "verified-pristine") return cleanup("final-verification-failed");
		return {
			status: "prepared",
			kind: "verified-initial-sibling-preparation",
			id: manifest.id,
			preparation: basename(area),
			lineageArtifact: file,
			children: {
				baseline: { id: children.baseline.id, directory: join(area, children.baseline.directory) },
				alternative: { id: children.alternative.id, directory: join(area, children.alternative.directory) },
			},
			execution: "not-started",
			continuationAuthority: "none",
		};
	} catch {
		return cleanup("preparation-failed");
	}
}
