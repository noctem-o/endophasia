// The opt-in single-turn profile is evidenced by driver v3 AND the actual attachment launch.
// Legacy studies remain ordinary; no caller can promote a replay to governed execution.

import { join } from "node:path";
import { endoCaptureRootV0 } from "../adapters/openai-proxy/capture-log.ts";
import { piRpcArgumentsV0 } from "../adapters/pi/rpc.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { readEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";
import { supportedInitialRuntimeArchiveV0 } from "./initial-runtime-archive.ts";
import { readEndoStoreEventsV0 } from "./trajectory.ts";

export const PI_CASSETTE_GOVERNED_DRIVER_V0 = "pi-cassette-driver.3";
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("invalid cassette launch evidence");
	return value as Record<string, unknown>;
}
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);

/** PR81 restrictions, plus this recording's exact proxy endpoint. */
export function assertGovernedCassetteArchiveV0(
	bytes: Uint8Array,
	provider: string,
	model: string,
	proxyOrigin: string,
): void {
	const problem =
		bytes.length > 16 * 1024 * 1024
			? "source archive exceeds bound"
			: supportedInitialRuntimeArchiveV0(bytes, provider, model);
	if (problem) throw new TypeError(problem);
	const archive = readEndoWorkspaceArchiveV0(bytes);
	if (!archive.ok) throw new TypeError("invalid governed source archive");
	const entry = archive.value.entries.find((entry) => entry.path === "agent/models.json");
	if (
		entry?.type !== "file" ||
		JSON.parse(Buffer.from(entry.base64, "base64").toString("utf8")).providers[provider].baseUrl !==
			`${proxyOrigin}/v1`
	)
		throw new TypeError("governed cassette models.json must name the recording proxy");
}

/** Exclude only the store-local session directory from the reproducible launch evidence. */
export function governedCassetteLaunchEvidenceV0(root: string, provider: string, model: string, sessionId: string) {
	const events = readEndoStoreEventsV0(root);
	const attached = events.filter((event) => event.kind === "harness.attached");
	if (
		attached.length !== 1 ||
		events.some((event) =>
			[
				"harness.session-mismatch",
				"harness.output-limit-exceeded",
				"harness.runtime-changed",
				"harness.protocol-fault",
				"tool.started",
				"tool.finished",
			].includes(event.kind),
		)
	)
		throw new TypeError("ambiguous governed cassette attachment");
	const fact = record(attached[0]!.payload);
	const args = piRpcArgumentsV0({
		executable: "pi",
		cwd: "/",
		env: {},
		session: { kind: "persistent", sessionDir: join(root, "pi-sessions", "pi.default"), sessionId },
		provider,
		model,
		tools: "none",
		governedToolFree: true,
		offline: true,
	});
	if (
		!same(fact.args, args) ||
		fact.piSessionId !== sessionId ||
		fact.requestedSessionId !== sessionId ||
		![fact.identityDigest, fact.version, fact.userConfigurationDigest, fact.projectConfigurationDigest].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	)
		throw new TypeError("governed cassette launch evidence mismatch");
	return {
		profile: "governed-tool-free",
		provider,
		model,
		sessionId,
		args: args.filter((_, index) => index !== 1),
		identityDigest: String(fact.identityDigest),
		version: String(fact.version),
		userConfigurationDigest: String(fact.userConfigurationDigest),
		projectConfigurationDigest: String(fact.projectConfigurationDigest),
	};
}

/** Read from source evidence, never a replay option. Reject partial or downgraded declarations. */
export function governedCassetteSourceV0(source: string, events: readonly EndoEventV0[], key: EndoDigestKeyV0) {
	const steps = events
		.filter((event) => event.producer === "capture:driver" && event.kind === "capture.driver-step")
		.map((event) => record(event.payload));
	const governed = steps.some((step) => step.driver === PI_CASSETTE_GOVERNED_DRIVER_V0);
	if (!governed) {
		if (
			steps.some((step) => step.launchEvidence !== undefined) ||
			readEndoStoreEventsV0(source).some(
				(event) =>
					event.kind === "harness.attached" &&
					Array.isArray(record(event.payload).args) &&
					(record(event.payload).args as unknown[]).includes("--no-tools"),
			)
		)
			throw new TypeError("legacy cassette cannot declare a governed profile");
		return null;
	}
	if (
		!same(
			steps.map((step) => step.op),
			["open", "prompt", "settled", "close"],
		) ||
		steps.some((step) => step.driver !== PI_CASSETTE_GOVERNED_DRIVER_V0) ||
		steps[1]!.mode !== "settle"
	)
		throw new TypeError("unsupported governed cassette script");
	if (events.some((event) => event.kind === "capture.environment"))
		throw new TypeError("governed cassette environment overrides are unsupported");
	const open = steps[0]!;
	if (typeof open.provider !== "string" || typeof open.model !== "string" || typeof open.piSessionId !== "string")
		throw new TypeError("missing governed cassette identity");
	const snapshots = events.filter(
		(event) => event.producer === "capture:driver" && event.kind === "capture.workspace-snapshot",
	);
	const starts = events.filter((event) => event.producer === "capture:record" && event.kind === "capture.started");
	if (snapshots.length !== 1 || starts.length !== 1) throw new TypeError("ambiguous governed source boundary");
	const ref = record(record(snapshots[0]!.payload).archive);
	const bytes = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
		ref.digest as EndoKeyedDigestV0,
	);
	if (bytes.length !== ref.bytes) throw new TypeError("governed source archive length mismatch");
	assertGovernedCassetteArchiveV0(bytes, open.provider, open.model, String(record(starts[0]!.payload).listen));
	const requests = events.filter((event) => event.producer === "capture:record" && event.kind === "capture.request");
	if (requests.length !== 1) throw new TypeError("governed cassette requires one captured request");
	const request = record(requests[0]!.payload);
	const bodyRef = record(request.body);
	const body = record(
		JSON.parse(
			Buffer.from(
				createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
					bodyRef.digest as EndoKeyedDigestV0,
				),
			).toString("utf8"),
		),
	);
	if (
		request.method !== "POST" ||
		request.path !== "/v1/chat/completions" ||
		body.model !== open.model ||
		(body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) ||
		body.functions !== undefined
	)
		throw new TypeError("governed cassette effective request model or tools mismatch");
	const evidence = governedCassetteLaunchEvidenceV0(source, open.provider, open.model, open.piSessionId);
	if (!same(open.launchEvidence, key.digest({ purpose: "endo.cassette-launch.v0", evidence })))
		throw new TypeError("unbound governed cassette launch evidence");
	return evidence;
}

export function verifyGovernedCassetteReplayV0(
	source: string,
	replay: string,
	events: readonly EndoEventV0[],
	key: EndoDigestKeyV0,
): void {
	const sourceEvidence = governedCassetteSourceV0(source, events, key);
	if (sourceEvidence === null) return;
	const replayEvidence = governedCassetteLaunchEvidenceV0(
		replay,
		sourceEvidence.provider,
		sourceEvidence.model,
		sourceEvidence.sessionId,
	);
	if (!same(sourceEvidence, replayEvidence)) throw new TypeError("source/replay governed launch policy mismatch");
}
