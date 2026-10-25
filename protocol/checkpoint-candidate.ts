// A receipt for one qualified Pi cassette pre-execution scratch boundary. This is not a live checkpoint.
import { type EndoKeyedDigestV0, isEndoKeyedDigestV0 } from "./keyed-digest-shape.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, endoFirstUnknownKeyV0, readEndoVersionedV0 } from "./versioned.ts";

export const ENDO_CHECKPOINT_CANDIDATE_VERSION_V0 = "endo.checkpoint-candidate.v0";
export interface EndoCheckpointCandidateV0 {
	schemaVersion: typeof ENDO_CHECKPOINT_CANDIDATE_VERSION_V0;
	checkpointClass: "pi-cassette-session";
	boundary: "pre-execution-scratch";
	session: string;
	archive: { digest: EndoKeyedDigestV0; bytes: number; schemaVersion: "endo.workspace-archive.v1" };
	evidence: {
		sourceCapture: EndoKeyedDigestV0;
		replayCapture: EndoKeyedDigestV0;
		sourceTrajectory: string;
		replayTrajectory: string;
		comparison: string;
	};
	environment: { source: EndoKeyedDigestV0; replay: EndoKeyedDigestV0 };
	qualification: "completed-cassette-zero-misses-four-exact-layers";
	scope: "recorded-scratch-and-observed-cassette-equivalence";
	limitations: "no-live-state-mid-run-or-external-environment-restoration";
}

const keys = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
	isPlainJsonObjectV0(value) && endoFirstUnknownKeyV0(value as object, allowed) === undefined;
const hex = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const digest = (value: unknown) => isEndoKeyedDigestV0(value);

export const ENDO_CHECKPOINT_CANDIDATE_VERSIONS_V0 = defineEndoVersionTableV0<EndoCheckpointCandidateV0>(
	"endo.checkpoint-candidate",
	[
		[
			ENDO_CHECKPOINT_CANDIDATE_VERSION_V0,
			(value) => {
				if (
					!keys(value, [
						"schemaVersion",
						"checkpointClass",
						"boundary",
						"session",
						"archive",
						"evidence",
						"environment",
						"qualification",
						"scope",
						"limitations",
					])
				)
					return null;
				if (
					value.checkpointClass !== "pi-cassette-session" ||
					value.boundary !== "pre-execution-scratch" ||
					typeof value.session !== "string" ||
					!/^endo\.session\.pi\.[a-zA-Z0-9._-]+$/.test(value.session)
				)
					return null;
				const archive = value.archive;
				if (
					!keys(archive, ["digest", "bytes", "schemaVersion"]) ||
					!digest(archive.digest) ||
					!Number.isSafeInteger(archive.bytes) ||
					(archive.bytes as number) <= 0 ||
					archive.schemaVersion !== "endo.workspace-archive.v1"
				)
					return null;
				const evidence = value.evidence;
				if (
					!keys(evidence, [
						"sourceCapture",
						"replayCapture",
						"sourceTrajectory",
						"replayTrajectory",
						"comparison",
					]) ||
					!digest(evidence.sourceCapture) ||
					!digest(evidence.replayCapture) ||
					!hex(evidence.sourceTrajectory) ||
					!hex(evidence.replayTrajectory) ||
					!hex(evidence.comparison)
				)
					return null;
				const environment = value.environment;
				if (!keys(environment, ["source", "replay"]) || !digest(environment.source) || !digest(environment.replay))
					return null;
				const keyId = archive.digest.keyId;
				if (
					[evidence.sourceCapture, evidence.replayCapture, environment.source, environment.replay].some(
						(ref) => (ref as EndoKeyedDigestV0).keyId !== keyId,
					)
				)
					return null;
				if (
					value.qualification !== "completed-cassette-zero-misses-four-exact-layers" ||
					value.scope !== "recorded-scratch-and-observed-cassette-equivalence" ||
					value.limitations !== "no-live-state-mid-run-or-external-environment-restoration"
				)
					return null;
				return value as unknown as EndoCheckpointCandidateV0;
			},
		],
	],
);

export const readEndoCheckpointCandidateV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_CHECKPOINT_CANDIDATE_VERSIONS_V0, value);
