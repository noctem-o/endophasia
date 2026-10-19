// Registry-side builders shared by the round-20 cockpit tests: registry inputs with a faithful watermark, fingerprint records
// of a chosen runtime family, the two projections and a snapshot whose timeline models a real complete read.
import { cockpitAliasesV0, registryWatermarkV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	type EndoCockpitCapabilityStateV0,
	type EndoCockpitRuntimeIdentityV0,
} from "../protocol/cockpit.ts";
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { completeLogSource, event, specimen, type specimenRecords, stored } from "./cockpit-fixtures.ts";
import {
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	TEST_KEY,
} from "./cockpit-keyed.ts";

export const CLEAN = { state: "readable", tornTail: null, sealedAt: null, error: null } as const;

export const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = structuredClone(value);
	edit(copy);
	return copy;
};
export const aliasOf = (id: string) => cockpitAliasesV0(TEST_KEY).id(id);
export const rank = (code: string) => ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(code as never);
export const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
export const admittedAt = (p: { capabilities: { status: string }[] }) =>
	p.capabilities.flatMap((c, at) => (c.status === "unverified" ? [] : [at]));

export function registryInput(records: ReturnType<typeof specimenRecords>, attachment = "pi.default") {
	const total = Object.values(records).reduce((sum, list) => sum + list.length, 0);
	const state = total === 0 ? ("empty" as const) : ("readable" as const);
	return {
		source: {
			domain: "harness-registry" as const,
			attachment,
			condition: { ...CLEAN, state },
			watermark: registryWatermarkV0(TEST_KEY, state, records),
		},
		records,
	} as never;
}

/** A fingerprint of the specimen's shape at another path (so another identity and id), of the runtime family named. */
export function fingerprintAt(realPath: string, runtime = "pi") {
	const base = specimen().fingerprint;
	const local = { ...base.local, realPath };
	const identity = {
		digest: sha256HexV0(
			canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported: base.reported })),
		),
		confidence: base.identity.confidence,
	};
	const { id: _id, ...rest } = base;
	const body = { ...rest, runtime, local, identity };
	return { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
}
export type Fingerprint = ReturnType<typeof fingerprintAt>;

export const identityOf = (records: unknown): EndoCockpitRuntimeIdentityV0 =>
	projectEndoCockpitRuntimeIdentityV0(registryInput(records as never), TEST_KEY);
export const capabilitiesOf = (records: unknown): EndoCockpitCapabilityStateV0 =>
	projectEndoCockpitCapabilityStateV0(registryInput(records as never), TEST_KEY);

/** The timeline of a clean log read whole: its source commits to exactly these events. */
export const timelineOf = (...events: ReturnType<typeof event>[]) =>
	projectEndoCockpitSessionTimelineV0(
		{ source: completeLogSource(events, TEST_KEY), afterSequence: 0, events: stored(events) } as never,
		TEST_KEY,
	);

let fixedTimeline: ReturnType<typeof timelineOf> | undefined;
/** One timeline for every snapshot of a test run (a fixture event's id counts up), so two snapshots differ only by their registries. */
function sharedTimeline() {
	fixedTimeline ??= timelineOf(event("agent.prompt-accepted"));
	return structuredClone(fixedTimeline);
}
export const snapshotFrom = (identity: any, capabilities: any): any => ({
	schemaVersion: "endo.cockpit-snapshot.v0",
	projectionVersion: "cockpit-snapshot.3",
	consistency: "independent-sources",
	timeline: sharedTimeline(),
	runtimes: [{ identity, capabilities }],
});
export const snapshotOf = (records: unknown) => snapshotFrom(identityOf(records), capabilitiesOf(records));

/** Evidence that matches `target` (digest and fingerprint), so that no limit in the capability view cites it. */
export const evidenceMatching = (
	records: ReturnType<typeof specimenRecords>,
	target: { id: string; identity: { digest: string } },
) =>
	records.evidence.map((item) => ({
		...item,
		dependencies: { ...item.dependencies, identityDigest: target.identity.digest, fingerprintId: target.id },
	}));

export const foreign = <T extends object>(item: T) => ({ ...item, attachment: "other.attachment" });
