// The cockpit observation bridge's public surface: harness-neutral, read-only, deterministic. A transport or a renderer
// imports this module and the contracts in protocol/cockpit.ts; it needs nothing from storage/ or an adapter.
export * from "../protocol/cockpit.ts";
// The type of the explicit digest key every read and projection takes (the bridge neither creates nor loads one).
export type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
export { projectEndoCockpitCapabilityStateV0 } from "./projections/capability-state.ts";
export type { EndoCockpitRegistryInputV0, EndoCockpitRegistryRecordsV0 } from "./projections/common.ts";
// A direct registry projector admits only an input its source describes; this is the construction the reader advertises.
export { registryWatermarkV0 } from "./projections/common.ts";
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
