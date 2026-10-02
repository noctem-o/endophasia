// The Usage service handle only: the durable ledger page read over the attached Session, free of runtime reads, so
// presentations can bind it without bundling the ledger or feed implementation. The v0 schemas are in
// protocol/usage.ts; the host facet is in runtime/contracts/usage-facet.ts.
import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";
import type { UsageLedgerPageV0, UsageLedgerQueryV0, UsageObservationV0 } from "../../protocol/usage.ts";

/** Durable usage records of the attached Session: a bounded live observation, and forward page reads of the ledger. */
export interface EndophasiaUsageV0 {
	readonly state: ReplicatedState<UsageObservationV0>;
	/**
	 * A forward page of durable usage rows after an exclusive sequence cursor. Not an atomic snapshot of the ledger.
	 * Remote arguments are JSON, so the query is always an object; `{}` reads from the start with the default limit.
	 */
	page(query: UsageLedgerQueryV0, context: Context): Promise<UsageLedgerPageV0>;
}

export const EndophasiaUsageV0 = defineService<EndophasiaUsageV0>("endophasia.usage.v0");
