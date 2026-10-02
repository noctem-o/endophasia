// The Runtime Profile v0 schema and the closed v0 capability catalogue. The service handle is in
// runtime/contracts/runtime-profile.ts; the generic host publisher in runtime/contracts/runtime-profile-facet.ts.

/**
 * The closed v0 catalogue of Endophasia semantic capabilities, in canonical order. These are Endophasia semantics, not
 * Chord service IDs: Runtime Metrics and Operation Outcome are separate capabilities although one service exposes both.
 */
export const ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0 = [
	"endophasia.session-overview.v0",
	"endophasia.mission-trace.v0",
	"endophasia.runtime-metrics.v0",
	"endophasia.operation-outcome.v0",
	"endophasia.usage.v0",
	"endophasia.continuity.v0",
] as const;

export type EndophasiaRuntimeCapabilityIdV0 = (typeof ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0)[number];

/**
 * What one Session worker's Endophasia composition claims: the runtime family it is composed around, and the exact
 * Endophasia v0 capabilities it deliberately installs. An attestation by the trusted composition root, not a runtime's
 * self-report, a feature negotiation or a conformance result.
 */
export interface RuntimeProfileV0 {
	schemaVersion: "runtime-profile.v0";
	/** This worker's composition and lifetime, not durable Session history. */
	scope: "session-worker-lifetime";
	/** Informational family identifier only. Consumers must not infer capabilities from it. */
	runtimeFamily: string;
	/**
	 * Opaque identifier of the Endophasia composition. It is not a runtime build identity and does not imply any
	 * capability.
	 */
	adapterProfileId: string;
	/**
	 * The exact Endophasia v0 capabilities this composition deliberately advertises, in canonical catalogue order with no
	 * duplicates. Presence means the exact v0 semantics are offered; absence means only that this worker does not
	 * advertise the capability.
	 */
	capabilities: EndophasiaRuntimeCapabilityIdV0[];
}
