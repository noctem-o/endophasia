// Test-side defaults for the cockpit's explicit digest key. The library requires a key on every read, projection and
// freshness check and supplies none; the tests supply a synthetic one. Public: it protects nothing, which is the point
// of a fixture. Each wrapper takes an optional key so a test can name another explicitly.

import { projectEndoCockpitCapabilityStateV0 as projectCapabilities } from "../cockpit/projections/capability-state.ts";
import type { EndoCockpitRegistryInputV0 } from "../cockpit/projections/common.ts";
import { cockpitAliasesV0 } from "../cockpit/projections/common.ts";
import { projectEndoCockpitRuntimeIdentityV0 as projectIdentity } from "../cockpit/projections/runtime-identity.ts";
import {
	type EndoCockpitTimelineInputV0,
	projectEndoCockpitSessionTimelineV0 as projectTimeline,
} from "../cockpit/projections/session-timeline.ts";
import {
	checkEndoCockpitSourceFreshnessV0 as checkFreshness,
	type EndoCockpitEventLogReadOptionsV0,
	readEndoCockpitEventLogV0 as readEventLog,
	readEndoCockpitRegistryV0 as readRegistry,
} from "../cockpit/reader.ts";
import {
	type EndoCockpitSnapshotOptionsV0,
	readEndoCockpitRuntimeV0 as readRuntime,
	readEndoCockpitSnapshotV0 as readSnapshot,
	readEndoCockpitTimelineV0 as readTimeline,
} from "../cockpit/snapshot.ts";
import type { EndoCockpitEventLogSourceV0, EndoCockpitRegistrySourceV0 } from "../protocol/cockpit.ts";
import { type EndoDigestKeyV0, endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { modelPrefixDigest } from "./cockpit-fixtures.ts";

export * from "../cockpit/index.ts";

/** A synthetic public key for fixtures, and a private-shaped one for tests that need a second domain. */
export const TEST_KEY: EndoDigestKeyV0 = endoDigestKeyV0(Buffer.alloc(32, 0x5a), "cockpit-fixture", { public: true });
export const OTHER_KEY: EndoDigestKeyV0 = endoDigestKeyV0(Buffer.alloc(32, 0x11), "installation");

/** A public identifier as the cockpit presents it under the fixture key. */
export const publicIdV0 = (id: string, key: EndoDigestKeyV0 = TEST_KEY): string => cockpitAliasesV0(key).id(id);

/**
 * A timeline input whose source models what a reader reports. The window that is the whole log (it begins at the start and
 * holds every event up to the declared length) carries the prefix digest a reader advertises for exactly its events, restated
 * independently (modelPrefixDigest); any other window keeps the digest it names, which nobody can check from a window. Every
 * other property of the fixture is left as written, so a fixture that is wrong in another way stays wrong in that way.
 */
export function readAs<T extends { source: any; afterSequence: number; events: readonly { event: unknown }[] }>(
	input: T,
	key: EndoDigestKeyV0 = TEST_KEY,
): T {
	const mark = input.source?.watermark;
	if (!mark || input.afterSequence !== 0 || mark.length === 0 || input.events.length !== mark.length) return input;
	const prefixDigest = modelPrefixDigest(
		input.events.map((stored) => stored.event),
		key,
	);
	return { ...input, source: { ...input.source, watermark: { ...mark, prefixDigest } } };
}

type Options<T> = Omit<T, "digestKey"> & { digestKey?: EndoDigestKeyV0 };

export const projectEndoCockpitRuntimeIdentityV0 = (input: EndoCockpitRegistryInputV0, key = TEST_KEY) =>
	projectIdentity(input, key);
export const projectEndoCockpitCapabilityStateV0 = (input: EndoCockpitRegistryInputV0, key = TEST_KEY) =>
	projectCapabilities(input, key);
export const projectEndoCockpitSessionTimelineV0 = (input: EndoCockpitTimelineInputV0, key = TEST_KEY) =>
	projectTimeline(input, key);
export const readEndoCockpitEventLogV0 = (root: string, options: Options<EndoCockpitEventLogReadOptionsV0> = {}) =>
	readEventLog(root, { digestKey: TEST_KEY, ...options });
export const readEndoCockpitRegistryV0 = (root: string, attachment: string, key = TEST_KEY) =>
	readRegistry(root, attachment, key);
export const readEndoCockpitTimelineV0 = (root: string, options: Options<EndoCockpitEventLogReadOptionsV0> = {}) =>
	readTimeline(root, { digestKey: TEST_KEY, ...options });
export const readEndoCockpitRuntimeV0 = (root: string, attachment: string, key = TEST_KEY) =>
	readRuntime(root, attachment, key);
export const readEndoCockpitSnapshotV0 = (root: string, options: Options<EndoCockpitSnapshotOptionsV0> = {}) =>
	readSnapshot(root, { digestKey: TEST_KEY, ...options });
export const checkEndoCockpitSourceFreshnessV0 = (
	root: string,
	previous: EndoCockpitEventLogSourceV0 | EndoCockpitRegistrySourceV0,
	key = TEST_KEY,
) => checkFreshness(root, previous, key);
