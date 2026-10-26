// Private preparation lineage. A condition is declared only; this record grants no execution authority.
import { type EndoCheckpointCandidateV0, readEndoCheckpointCandidateV0 } from "./checkpoint-candidate.ts";
import { type EndoExperimentConditionV0, endoExperimentConditionProblemV0 } from "./experiment-spec.ts";
import { type EndoKeyedDigestV0, isEndoKeyedDigestV0 } from "./keyed-digest-shape.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, endoFirstUnknownKeyV0, readEndoVersionedV0 } from "./versioned.ts";

export const ENDO_INITIAL_BRANCH_SET_VERSION_V0 = "endo.initial-branch-set.v0";
export const ENDO_INITIAL_BRANCH_CONDITION_MAX_BYTES_V0 = 64 * 1024;
export const ENDO_INITIAL_BRANCH_SET_MAX_BYTES_V0 = 256 * 1024;
export interface EndoInitialBranchDirectoryIdentityV0 {
	dev: number;
	ino: number;
	/** Filesystem creation time; prevents ordinary inode reuse from retaining a child identity. */
	birthtimeNs: string;
}
export interface EndoPreparedInitialChildV0 {
	id: string;
	parent: EndoKeyedDigestV0;
	/** One generated directory segment, relative to the preparation area. */
	directory: string;
	filesystem: EndoInitialBranchDirectoryIdentityV0;
	/** Private, existing experiment-condition vocabulary; never applied by preparation. */
	condition: { specification: EndoExperimentConditionV0; commitment: EndoKeyedDigestV0 };
	manipulation: "planned-not-applied";
}
export interface EndoInitialBranchSetV0 {
	schemaVersion: typeof ENDO_INITIAL_BRANCH_SET_VERSION_V0;
	id: string;
	parent: EndoCheckpointCandidateV0;
	parentReference: EndoKeyedDigestV0;
	area: {
		directory: string;
		filesystem: EndoInitialBranchDirectoryIdentityV0;
		outputParent: EndoInitialBranchDirectoryIdentityV0;
	};
	children: { baseline: EndoPreparedInitialChildV0; alternative: EndoPreparedInitialChildV0 };
	changeCategory:
		| "modelEntry"
		| "settings"
		| "extensions"
		| "environment"
		| "interventions"
		| "composite"
		| "declared-noop";
	preparation: "completed";
	execution: "not-started";
	continuationAuthority: "none";
	outcomes: "not-observed";
	/** Domain-separated keyed integrity commitment to every other manifest field; not a signature or grant. */
	commitment: EndoKeyedDigestV0;
}
const keys = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
	isPlainJsonObjectV0(value) && endoFirstUnknownKeyV0(value as object, allowed) === undefined;
const identity = (value: unknown): boolean =>
	keys(value, ["dev", "ino", "birthtimeNs"]) &&
	typeof value.birthtimeNs === "string" &&
	/^[1-9][0-9]{0,29}$/.test(value.birthtimeNs) &&
	[value.dev, value.ino].every((n) => Number.isSafeInteger(n) && (n as number) >= 0);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const id = (value: unknown, kind: string) =>
	typeof value === "string" && new RegExp(`^endo\\.${kind}\\.${uuid}$`).test(value);
export const isEndoInitialBranchAreaV0 = (value: unknown): value is string =>
	typeof value === "string" && /^endo-initial-branches-[A-Za-z0-9]{6}$/.test(value);
const child = (value: unknown): value is EndoPreparedInitialChildV0 => {
	if (
		!keys(value, ["id", "parent", "directory", "filesystem", "condition", "manipulation"]) ||
		!id(value.id, "prepared-child") ||
		!isEndoKeyedDigestV0(value.parent) ||
		typeof value.directory !== "string" ||
		!/^endo-initial-scratch-[A-Za-z0-9]{6}$/.test(value.directory) ||
		!identity(value.filesystem) ||
		value.manipulation !== "planned-not-applied" ||
		!keys(value.condition, ["specification", "commitment"]) ||
		!isEndoKeyedDigestV0(value.condition.commitment)
	)
		return false;
	if (endoExperimentConditionProblemV0(value.condition.specification) !== null) return false;
	try {
		return (
			Buffer.byteLength(JSON.stringify(value.condition.specification)) <= ENDO_INITIAL_BRANCH_CONDITION_MAX_BYTES_V0
		);
	} catch {
		return false;
	}
};
export const ENDO_INITIAL_BRANCH_SET_VERSIONS_V0 = defineEndoVersionTableV0<EndoInitialBranchSetV0>(
	"endo.initial-branch-set",
	[
		[
			ENDO_INITIAL_BRANCH_SET_VERSION_V0,
			(value) => {
				if (
					!keys(value, [
						"schemaVersion",
						"id",
						"parent",
						"parentReference",
						"area",
						"children",
						"changeCategory",
						"preparation",
						"execution",
						"continuationAuthority",
						"outcomes",
						"commitment",
					]) ||
					!id(value.id, "initial-branch-set") ||
					!readEndoCheckpointCandidateV0(value.parent).ok ||
					!isEndoKeyedDigestV0(value.parentReference) ||
					!isEndoKeyedDigestV0(value.commitment) ||
					!keys(value.area, ["directory", "filesystem", "outputParent"]) ||
					!isEndoInitialBranchAreaV0(value.area.directory) ||
					!identity(value.area.filesystem) ||
					!identity(value.area.outputParent) ||
					!keys(value.children, ["baseline", "alternative"]) ||
					!child(value.children.baseline) ||
					!child(value.children.alternative)
				)
					return null;
				const { baseline, alternative } = value.children;
				if (
					baseline.id === alternative.id ||
					baseline.directory === alternative.directory ||
					(baseline.filesystem.dev === alternative.filesystem.dev &&
						baseline.filesystem.ino === alternative.filesystem.ino) ||
					baseline.condition.specification.id === alternative.condition.specification.id
				)
					return null;
				const domain = (value.parent as EndoCheckpointCandidateV0).archive.digest.keyId;
				if (
					[
						value.parentReference,
						value.commitment,
						baseline.parent,
						alternative.parent,
						baseline.condition.commitment,
						alternative.condition.commitment,
					].some((d) => d.keyId !== domain)
				)
					return null;
				if (
					![
						"modelEntry",
						"settings",
						"extensions",
						"environment",
						"interventions",
						"composite",
						"declared-noop",
					].includes(value.changeCategory as string) ||
					value.preparation !== "completed" ||
					value.execution !== "not-started" ||
					value.continuationAuthority !== "none" ||
					value.outcomes !== "not-observed"
				)
					return null;
				return value as unknown as EndoInitialBranchSetV0;
			},
		],
	],
);
/** Shape/version validation only. Filesystem/evidence trust requires readVerifiedInitialBranchSetV0. */
export const readEndoInitialBranchSetV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_INITIAL_BRANCH_SET_VERSIONS_V0, value);
