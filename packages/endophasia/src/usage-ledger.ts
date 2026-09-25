import type { Context, Session, UsageRow } from "@earendil-works/pi-agent-core";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

export interface UsageLedgerQueryV0 {
	/** Return rows whose Pi session sequence is strictly greater than this value. Default 0. */
	afterSequence?: number;
	/** Maximum rows in this page. Default 1000, maximum 10000. */
	limit?: number;
}

/**
 * One durable Pi usage row. Pi stores no lane, cause, operation, attempt, or timestamp on the row,
 * so none is reported. `details` is deliberately omitted.
 */
export interface UsageLedgerRowV0 {
	/** Opaque Pi usage-row identity. */
	id: string;
	/**
	 * Pi's session-global durable sequence, shared with entries and values: gaps between rows are normal.
	 * Unrelated to Mission Trace sequence numbers.
	 */
	sequence: number;
	/** True when the row was recorded as a caller adjustment (recordUsage); false says only that it was not. */
	adjustment: boolean;
	/** Association identifier only: not resolved, and not proof that the entry exists or of the row's cause. */
	entryId?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h?: number;
		reasoning?: number;
		/** Pi's reported value, not recomputed from components. */
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}

/**
 * A forward page of committed usage rows after a durable session sequence cursor.
 * Not an atomic snapshot of the whole ledger: later commits are reached by calling again with `nextAfterSequence`.
 */
export interface UsageLedgerPageV0 {
	schemaVersion: "usage-ledger.v0";
	scope: "session";
	order: "ascending";
	rows: UsageLedgerRowV0[];
	/** The last returned row's sequence, or the input afterSequence when no rows were returned. */
	nextAfterSequence: number;
}

/** Package-internal: the one payload-minimal projection shared by the ledger inspector and the usage feed. */
export function projectUsageLedgerRowV0(row: UsageRow): UsageLedgerRowV0 {
	const { usage } = row;
	return {
		id: row.id,
		sequence: row.seq,
		adjustment: row.adjustment,
		...(row.entryId === undefined ? {} : { entryId: row.entryId }),
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
			...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
			totalTokens: usage.totalTokens,
			cost: {
				input: usage.cost.input,
				output: usage.cost.output,
				cacheRead: usage.cost.cacheRead,
				cacheWrite: usage.cost.cacheWrite,
				total: usage.cost.total,
			},
		},
	};
}

/** Page forward through Pi's durable session usage ledger. Read failures propagate. */
export async function readUsageLedgerV0(
	session: Pick<Session, "scanUsage">,
	query: UsageLedgerQueryV0 | undefined,
	context: Context,
): Promise<UsageLedgerPageV0> {
	const afterSequence = query?.afterSequence ?? 0;
	const limit = query?.limit ?? DEFAULT_LIMIT;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
		throw new RangeError("Invalid usage ledger cursor");
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new RangeError("Invalid usage ledger limit");
	}
	// Pi's fromSeq is inclusive; afterSequence is exclusive.
	const rows =
		afterSequence === Number.MAX_SAFE_INTEGER
			? []
			: (await session.scanUsage({ fromSeq: afterSequence + 1, order: "asc", limit }, context)).map(
					projectUsageLedgerRowV0,
				);
	return {
		schemaVersion: "usage-ledger.v0",
		scope: "session",
		order: "ascending",
		rows,
		nextAfterSequence: rows.length === 0 ? afterSequence : rows[rows.length - 1]!.sequence,
	};
}
