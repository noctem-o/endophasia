// The runtime-neutral core services: canonical JSON and digests, the in-memory event store, replay and result
// bundles, and deep immutability. No runtime, transport or presentation code is reachable from here.
export { assertPlainJsonValueV0, canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
export {
	buildEndoResultBundleV0,
	reduceEndoEventSummaryV0,
	reduceEndoEventsV0,
	replayEndoEventRecordV0,
} from "./event-replay.ts";
export type { EndoEventStoreV0 } from "./event-store.ts";
export {
	createEndoEventStoreV0,
	ENDO_EVENT_RECORD_PAGE_DEFAULT_LIMIT_V0,
	ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0,
} from "./event-store.ts";
export { deepFreezeCopyV0 } from "./immutability.ts";
