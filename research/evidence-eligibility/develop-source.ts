// Reading a DEVELOP store for the eligibility projection: the write-once attempt records and their receipts, through the stores' own
// readers (storage/develop-attempts.ts, storage/develop-receipts.ts), which refuse links, malformed and misnamed files and report each as a
// problem. Read-only: neither store creates anything on read. The task file, the session log and the brief's text are not collected; the
// brief is kept as its sha256 only.

import { renderEndoDevelopBriefV0 } from "../../protocol/develop-attempts.ts";
import type { EndoDevelopReceiptV0 } from "../../protocol/develop-receipts.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { DevelopAttemptsStoreV0, type EndoAttemptEntryV0 } from "../../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";
import type { DecisionFeatures, SourceProblem } from "./contract.ts";

export interface AttemptFacts {
	entry: EndoAttemptEntryV0;
	receipts: EndoDevelopReceiptV0[];
	/** Problems in this attempt's receipt directory (count only is used; names are relative). */
	receiptProblems: number;
	receiptsReadable: boolean;
	recordSha256: string;
}

export interface StoreFacts {
	attempts: AttemptFacts[];
	problems: Omit<SourceProblem, "sourceId">[];
}

/**
 * What could be known when the attempt was prepared: its prepared record alone. Receipts, handoff, outcome and authorisation all come later
 * and are never passed in.
 */
export function decisionOfAttempt(attempt: EndoAttemptEntryV0["attempt"]): DecisionFeatures {
	return {
		kind: "prepared-attempt",
		mechanism: "operator",
		preparedAtMs: attempt.preparedAtMs,
		projectId: attempt.projectId,
		taskId: attempt.taskId,
		taskRevision: attempt.task.revision,
		briefSha256: sha256HexV0(renderEndoDevelopBriefV0(attempt)),
	};
}

export function readDevelopStore(root: string): StoreFacts | { problem: Omit<SourceProblem, "sourceId"> } {
	const attemptsStore = new DevelopAttemptsStoreV0(root);
	const read = attemptsStore.read();
	if (!read.ok) return { problem: { path: "develop/attempts", kind: "unreadable", detail: read.reason } };
	const receiptsStore = new DevelopReceiptsStoreV0(root);
	const problems: Omit<SourceProblem, "sourceId">[] = read.problems.map((p) => ({
		path: `develop/attempts/${p.name}`,
		kind: "problem-file",
		detail: p.reason,
	}));
	const attempts = [...read.entries]
		.sort((a, b) => (a.attempt.id < b.attempt.id ? -1 : a.attempt.id > b.attempt.id ? 1 : 0))
		.map((entry): AttemptFacts => {
			const r = receiptsStore.read(entry.attempt.id);
			if (r.ok)
				for (const p of r.problems)
					problems.push({
						path: `develop/receipts/${entry.attempt.id}/${p.name}`,
						kind: "problem-file",
						detail: p.reason,
					});
			return {
				entry,
				receipts: r.ok
					? [...r.receipts].sort((a, b) => a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : 1))
					: [],
				receiptProblems: r.ok ? r.problems.length : 0,
				receiptsReadable: r.ok,
				// The records as the store validated them (it holds them whole or not at all), in a stable form.
				recordSha256: sha256HexV0(canonicalEndoJsonV0(entry as unknown as Record<string, unknown>)),
			};
		});
	return { attempts, problems };
}
