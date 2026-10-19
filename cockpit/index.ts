// The cockpit observation bridge's public surface: harness-neutral, read-only, deterministic. A transport or a renderer
// imports this module and the contracts in protocol/cockpit.ts; it needs nothing from storage/ or an adapter.
export * from "../protocol/cockpit.ts";
// What a transport needs to answer exactly as the reader would, with nothing from storage/ or runtime/: the canonical JSON the
// contracts are serialized with, the predicates the reader applies to a digest key and to an attachment name (so a server
// refuses what the reader would throw on, as a client error, before reading), and the grammar the name is first checked against.
export { endoCockpitDigestKeyAdmittedV0, isEndoCockpitSourceKindAdmittedV0 } from "../protocol/cockpit-fields.ts";
export { isWellFormedKindV0 } from "../protocol/identity.ts";
export { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
// The type of the explicit digest key every read and projection takes (the bridge neither creates nor loads one).
export type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
export { projectEndoCockpitCapabilityStateV0 } from "./projections/capability-state.ts";
export type { EndoCockpitRegistryInputV0, EndoCockpitRegistryRecordsV0 } from "./projections/common.ts";
// A direct projector admits only an input its source describes; these are the constructions the reader advertises: a registry's
// content watermark and, for an event log read whole, the prefix digest of its events.
export { eventLogPrefixDigestV0, registryWatermarkV0 } from "./projections/common.ts";
export { projectEndoCockpitRuntimeIdentityV0 } from "./projections/runtime-identity.ts";
export type {
	EndoCockpitStoredEventV0,
	EndoCockpitTimelineInputV0,
} from "./projections/session-timeline.ts";
export { projectEndoCockpitSessionTimelineV0 } from "./projections/session-timeline.ts";
export type { EndoCockpitEventLogReadOptionsV0, EndoCockpitEventLogReadV0, EndoCockpitFreshnessV0 } from "./reader.ts";
export {
	checkEndoCockpitSourceFreshnessV0,
	ENDO_COCKPIT_PAGE_DEFAULT_LIMIT_V0,
	ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
	listEndoCockpitAttachmentsV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
} from "./reader.ts";
export type { EndoCockpitSnapshotOptionsV0 } from "./snapshot.ts";
export { readEndoCockpitRuntimeV0, readEndoCockpitSnapshotV0, readEndoCockpitTimelineV0 } from "./snapshot.ts";
