/**
 * Phase 6 — artifact construction (README "## Phase 6 — Evolution substrate": artifact/version
 * semantics). Building an artifact is pure: the content is canonicalised and digested here, and the
 * returned record is valid by construction. Storing it is the core registry's job
 * (evolution/core.ts), which rejects any second record under the same id — a digest change under a
 * stable id is detected, never silently accepted.
 */

import type { EndoArtifactV0 } from "../protocol/evolution.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "../protocol/identity.ts";
import { assertPlainJsonValueV0, canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

const SHA256_HEX_V0 = /^[0-9a-f]{64}$/;

/**
 * Build an artifact record from its id, kind, and content (or a supplied digest when the content is
 * stored elsewhere).
 *
 * When the content is present it must be plain JSON, and the digest is computed over its canonical
 * form — the same content always yields the same digest, and a supplied digest must agree with the
 * computed one. When the content is absent the digest is required. Throws TypeError when the id is
 * not an endo.evidence.* identifier, the kind is not a well-formed dotted kind, the content is not
 * plain JSON, a supplied digest does not match, or a source revision is malformed.
 */
export function buildEndoArtifactV0(args: {
	id: unknown;
	kind: unknown;
	content?: unknown;
	digest?: unknown;
	sourceRevision?: unknown;
}): EndoArtifactV0 {
	if (typeof args.id !== "string" || !isEndoIdentifierV0(args.id, "evidence")) {
		throw new TypeError("artifact id must be an endo.evidence.* identifier");
	}
	if (typeof args.kind !== "string" || !isWellFormedKindV0(args.kind)) {
		throw new TypeError("artifact kind must be a well-formed dotted kind");
	}
	let digest: string;
	if (args.content !== undefined) {
		assertPlainJsonValueV0(args.content);
		const computed = sha256HexV0(canonicalEndoJsonV0(args.content));
		if (args.digest !== undefined && args.digest !== computed) {
			throw new TypeError("artifact digest does not match the canonical content");
		}
		digest = computed;
	} else {
		if (typeof args.digest !== "string" || !SHA256_HEX_V0.test(args.digest)) {
			throw new TypeError("artifact digest is required when the content is not recorded");
		}
		digest = args.digest;
	}
	const artifact: EndoArtifactV0 = {
		schemaVersion: "endo.artifact.v0",
		id: args.id,
		kind: args.kind,
		digest,
	};
	if (args.content !== undefined) artifact.content = args.content;
	if (args.sourceRevision !== undefined) {
		if (
			typeof args.sourceRevision !== "string" ||
			args.sourceRevision.length < 1 ||
			args.sourceRevision.length > 256
		) {
			throw new TypeError("artifact sourceRevision must be a non-empty string of at most 256 characters");
		}
		artifact.sourceRevision = args.sourceRevision;
	}
	return artifact;
}
