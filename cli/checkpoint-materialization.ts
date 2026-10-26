// Consume a currently verified Pi cassette candidate as filesystem state only. This never launches Pi or a model.
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { endoCaptureRootV0 } from "../adapters/openai-proxy/capture-log.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import {
	archiveEndoWorkspaceV0,
	ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0,
	readEndoWorkspaceArchiveV0,
	restoreEndoWorkspaceV0,
} from "../storage/workspace-snapshot.ts";
import { readVerifiedCheckpointCandidateV0 } from "./checkpoint-candidate.ts";
import { checkpointOutputParent, identity, sameIdentity } from "./checkpoint-filesystem.ts";

/** Additional resource bounds for this filesystem materialization, beyond the archive writer's file-byte limit. */
export const ENDO_INITIAL_MATERIALIZATION_MAX_ARCHIVE_BYTES_V0 = 128 * 1024 * 1024;
export const ENDO_INITIAL_MATERIALIZATION_MAX_ENTRIES_V0 = 10_000;

export type EndoInitialCheckpointRefusalReasonV0 =
	| "candidate-unverified"
	| "unsupported-boundary"
	| "unsafe-output-parent"
	| "unsafe-recorded-path"
	| "archive-out-of-bounds"
	| "archive-unverifiable"
	| "archive-length"
	| "archive-schema"
	| "archive-symlink-escape"
	| "output-parent-changed"
	| "destination-unavailable"
	| "destination-conflict"
	| "destination-changed"
	| "restored-state-mismatch"
	| "evidence-changed"
	| "materialization-failed"
	| "cleanup-unsafe"
	| "cleanup-unavailable";

export type EndoInitialCheckpointMaterializationV0 =
	| {
			status: "materialized";
			kind: "verified-initial-scratch-materialization";
			directory: string;
			session: string;
			archive: { digest: EndoKeyedDigestV0; bytes: number; schemaVersion: "endo.workspace-archive.v1" };
			verification: "canonical-archive-bytes-equal";
	  }
	| {
			status: "refused";
			reason: EndoInitialCheckpointRefusalReasonV0;
			evidenceReason?: string;
			/** Present only if an operation-created directory could not be safely removed after failure. */
			retainedDirectory?: string;
	  };

const refused = (reason: EndoInitialCheckpointRefusalReasonV0): EndoInitialCheckpointMaterializationV0 => ({
	status: "refused",
	reason,
});

/**
 * Materialize only the verified pre-execution scratch archive into a new private child of `outputParent`.
 * A result is filesystem equivalence, not a process restore, executable replay, continuation, or fork.
 */
export function materializeVerifiedInitialCheckpointV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	outputParent: string,
): EndoInitialCheckpointMaterializationV0 {
	const first = readVerifiedCheckpointCandidateV0(source, replay, key);
	if (first.status !== "qualified")
		return { status: "refused", reason: "candidate-unverified", evidenceReason: first.reason };
	const candidate = first.candidate;
	if (
		candidate.checkpointClass !== "pi-cassette-session" ||
		candidate.boundary !== "pre-execution-scratch" ||
		candidate.archive.schemaVersion !== "endo.workspace-archive.v1"
	)
		return refused("unsupported-boundary");
	const parent = checkpointOutputParent(source, replay, outputParent);
	if (!parent.ok) return refused(parent.reason);
	const { recordedScratch, physicalRecordedScratch } = parent;
	if (
		!Number.isSafeInteger(candidate.archive.bytes) ||
		candidate.archive.bytes <= 0 ||
		candidate.archive.bytes > ENDO_INITIAL_MATERIALIZATION_MAX_ARCHIVE_BYTES_V0 ||
		candidate.archive.digest.keyId !== key.keyId
	)
		return refused("archive-out-of-bounds");

	let bytes: Uint8Array;
	try {
		bytes = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(candidate.archive.digest);
	} catch {
		return refused("archive-unverifiable");
	}
	if (bytes.length !== candidate.archive.bytes) return refused("archive-length");
	const read = readEndoWorkspaceArchiveV0(bytes);
	if (!read.ok || read.schemaVersion !== "endo.workspace-archive.v1") return refused("archive-schema");
	if (
		read.value.entries.length > ENDO_INITIAL_MATERIALIZATION_MAX_ENTRIES_V0 ||
		read.value.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0), 0) >
			ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0
	)
		return refused("archive-out-of-bounds");
	if (
		read.value.entries.some(
			(entry) =>
				entry.type === "symlink" &&
				(entry.target.startsWith("/") || entry.target.includes("\0") || entry.target.split("/").includes("..")),
		)
	)
		return refused("archive-symlink-escape");
	if (!sameIdentity(parent.path, parent.identity)) return refused("output-parent-changed");

	let directory: string;
	try {
		directory = mkdtempSync(join(parent.path, "endo-initial-scratch-"));
	} catch {
		return refused("destination-unavailable");
	}
	const created = identity(directory);
	const cleanup = (reason: EndoInitialCheckpointRefusalReasonV0): EndoInitialCheckpointMaterializationV0 => {
		if (created === null || !sameIdentity(parent.path, parent.identity) || !sameIdentity(directory, created))
			return { status: "refused", reason: "cleanup-unsafe", retainedDirectory: directory };
		try {
			rmSync(directory, { recursive: true });
			return refused(reason);
		} catch {
			return { status: "refused", reason: "cleanup-unavailable", retainedDirectory: directory };
		}
	};
	if (created === null) return cleanup("destination-unavailable");
	try {
		if (resolve(directory) === recordedScratch || resolve(directory) === physicalRecordedScratch)
			return cleanup("destination-conflict");
		if (!sameIdentity(parent.path, parent.identity) || !sameIdentity(directory, created))
			return cleanup("destination-changed");
		const recordedRoot = read.value.entries.find((entry) => entry.path === "work");
		// The candidate contract itself establishes the class and boundary. The archived tree is the whole scratch root.
		if (recordedRoot?.type !== "directory") return cleanup("archive-schema");
		restoreEndoWorkspaceV0(bytes, directory);
		if (!sameIdentity(parent.path, parent.identity) || !sameIdentity(directory, created))
			return cleanup("destination-changed");
		const restored = archiveEndoWorkspaceV0(directory);
		if (!Buffer.from(restored.bytes).equals(Buffer.from(bytes))) return cleanup("restored-state-mismatch");
		const second = readVerifiedCheckpointCandidateV0(source, replay, key);
		if (second.status !== "qualified" || canonicalEndoJsonV0(second.candidate) !== canonicalEndoJsonV0(candidate))
			return cleanup("evidence-changed");
		const currentBytes = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
			candidate.archive.digest,
		);
		if (!Buffer.from(currentBytes).equals(Buffer.from(bytes))) return cleanup("evidence-changed");
		if (!sameIdentity(parent.path, parent.identity) || !sameIdentity(directory, created))
			return cleanup("destination-changed");
		return {
			status: "materialized",
			kind: "verified-initial-scratch-materialization",
			directory,
			session: candidate.session,
			archive: candidate.archive,
			verification: "canonical-archive-bytes-equal",
		};
	} catch {
		return cleanup("materialization-failed");
	}
}
