// The cockpit's projection API: what a transport (PR B) calls. It reads the sources read-only (reader.ts), projects them
// with the pure projections, and returns validated, versioned contracts. A caller imports this module (cockpit/index.ts),
// never the storage layer, and never needs to know where a record came from.
//
// The sources are read one after another: the event log first, then each attachment's registry in code-unit order. They
// are independent histories with no shared sequence and no shared snapshot boundary; a snapshot carries each source's own
// watermark and says so (`consistency: "independent-sources"`). Nothing here reads the clock or the root's path into a
// result, so the same stores read twice with no writer in between give byte-identical canonical output.

import {
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	type EndoCockpitCapabilityStateV0,
	type EndoCockpitRuntimeIdentityV0,
	type EndoCockpitSessionTimelineV0,
	type EndoCockpitSnapshotV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { projectEndoCockpitCapabilityStateV0 } from "./projections/capability-state.ts";
import { projectEndoCockpitRuntimeIdentityV0 } from "./projections/runtime-identity.ts";
import { projectEndoCockpitSessionTimelineV0 } from "./projections/session-timeline.ts";
import {
	type EndoCockpitEventLogReadOptionsV0,
	listEndoCockpitAttachmentsV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
} from "./reader.ts";

/** A projection that fails its own contract is a defect here, not a source condition; it is never returned. */
function checked<T>(name: string, value: T, validate: (value: unknown) => T | null): T {
	if (validate(value) === null) throw new TypeError(`the ${name} projection does not satisfy its contract`);
	return value;
}

/** The session timeline window `options` names (default: the first page). */
export function readEndoCockpitTimelineV0(
	root: string,
	options: EndoCockpitEventLogReadOptionsV0 = {},
): EndoCockpitSessionTimelineV0 {
	const read = readEndoCockpitEventLogV0(root, options);
	return checked(
		"session timeline",
		projectEndoCockpitSessionTimelineV0({
			source: read.source,
			afterSequence: read.afterSequence,
			events: read.events,
		}),
		validateEndoCockpitSessionTimelineV0,
	);
}

/** One attachment's runtime identity and capability state, from one read of its registry. */
export function readEndoCockpitRuntimeV0(
	root: string,
	attachment: string,
): { identity: EndoCockpitRuntimeIdentityV0; capabilities: EndoCockpitCapabilityStateV0 } {
	const input = readEndoCockpitRegistryV0(root, attachment);
	return {
		identity: checked(
			"runtime identity",
			projectEndoCockpitRuntimeIdentityV0(input),
			validateEndoCockpitRuntimeIdentityV0,
		),
		capabilities: checked(
			"capability state",
			projectEndoCockpitCapabilityStateV0(input),
			validateEndoCockpitCapabilityStateV0,
		),
	};
}

export interface EndoCockpitSnapshotOptionsV0 extends EndoCockpitEventLogReadOptionsV0 {
	/** The attachments to include. Default: every registry directory found under the root. */
	attachments?: readonly string[];
}

/** The snapshot: a timeline window and the runtime views of the attachments, each with its own source position. */
export function readEndoCockpitSnapshotV0(
	root: string,
	options: EndoCockpitSnapshotOptionsV0 = {},
): EndoCockpitSnapshotV0 {
	const timeline = readEndoCockpitTimelineV0(root, options);
	const names =
		options.attachments === undefined ? listEndoCockpitAttachmentsV0(root) : [...new Set(options.attachments)].sort();
	return checked(
		"snapshot",
		{
			schemaVersion: "endo.cockpit-snapshot.v0",
			projectionVersion: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.snapshot,
			consistency: "independent-sources",
			timeline,
			runtimes: names.map((attachment) => readEndoCockpitRuntimeV0(root, attachment)),
		},
		validateEndoCockpitSnapshotV0,
	);
}
