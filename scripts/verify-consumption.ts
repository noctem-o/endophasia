// Re-checks every recorded `intervention.consumed` in the raw run data (the research-data directory, research/DATA.md) (the steering and path-sensitivity
// studies) against the CURRENT consumption rule (runtime/contracts/intervention.ts: a request shows the message one more
// time than the request before it did), and against the OLD rule (the message is present), from each store's own proxy
// capture. Built for the post-merge audit of #29 and #31 (docs/audits/pr29-post-merge.md): the rule changed, and this shows
// whether any published result depends on the change.
//
//   node scripts/verify-consumption.ts            prints one JSON summary; exits 1 if any recorded exchange differs

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { endoInterventionCaptureSourceV0 } from "../cli/intervention-capture.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import type { EndoInterventionMessageRefV0 } from "../protocol/intervention.ts";
import { rawDirectory, researchDataRoot } from "../research/data.ts";
import { endoFindConsumptionV0, endoUserMessageTextsV0 } from "../runtime/contracts/intervention.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());

/** Every trial store under a raw run directory: `<run>/trials/<task>/<condition>/<n>/store`. */
function trialStores(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (!entry.isDirectory()) continue;
			if (entry.name === "store" && existsSync(join(full, "capture"))) out.push(full);
			else if (entry.name !== "blobs" && entry.name !== "evidence" && entry.name !== "capture") walk(full);
		}
	};
	walk(dir);
	return out;
}

const roots = [
	join(rawDirectory("steering"), "pilot"),
	join(rawDirectory("steering"), "main"),
	join(rawDirectory("steering"), "posthoc-pilot-path"),
	join(rawDirectory("steering"), "posthoc-main-path"),
	join(rawDirectory("path-sensitivity"), "pilot"),
	join(rawDirectory("path-sensitivity"), "main"),
].filter((root) => existsSync(root) && statSync(root).isDirectory());

const summary = {
	stores: 0,
	withIntervention: 0,
	consumed: 0,
	sameAsRecordedNew: 0,
	sameAsRecordedOld: 0,
	differs: [] as string[],
};
for (const root of roots) {
	for (const store of trialStores(root)) {
		summary.stores += 1;
		const events = readEndoStoreEventsV0(store).filter((event) => event.kind.startsWith("intervention."));
		const proposal = events.find((event) => event.kind === "intervention.proposal")?.payload as
			| { message: EndoInterventionMessageRefV0 | null }
			| undefined;
		const request = events.find((event) => event.kind === "intervention.request")?.payload as
			| { at: { exchange: number } | null }
			| undefined;
		const recorded = events.find((event) => event.kind === "intervention.consumed")?.payload as
			| { exchange: number }
			| undefined;
		if (proposal === undefined || request === undefined) continue;
		summary.withIntervention += 1;
		if (proposal.message === null) continue;
		const requests = endoInterventionCaptureSourceV0(store, key).requests() ?? [];
		const from = request.at === null ? 1 : request.at.exchange + 1;
		const current = endoFindConsumptionV0(requests, proposal.message, key, from)?.exchange ?? null;
		const old =
			requests.find(
				(entry) =>
					entry.exchange >= from &&
					endoUserMessageTextsV0(entry.body).some(
						(text) => key.digestBytes(Buffer.from(text, "utf8")).value === proposal.message!.digest.value,
					),
			)?.exchange ?? null;
		if (recorded !== undefined) summary.consumed += 1;
		if ((recorded?.exchange ?? null) === current) summary.sameAsRecordedNew += 1;
		else
			summary.differs.push(
				`${relative(researchDataRoot(), store)}: recorded ${recorded?.exchange ?? null}, new rule ${current}`,
			);
		if ((recorded?.exchange ?? null) === old) summary.sameAsRecordedOld += 1;
	}
}
process.stdout.write(`${JSON.stringify({ roots, ...summary }, null, "\t")}\n`);
if (summary.differs.length > 0) process.exit(1);
