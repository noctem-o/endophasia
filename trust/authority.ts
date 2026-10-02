/**
 * Phase 8 — the promotion closure check (README "## Phase 8 — Trust integrations"): the authority
 * loop a "granted" promotion decision does not itself close.
 *
 * The decision is the recorded ask (it carries an authority identity, not a grant); the lease is
 * the authority grant — checked against the exact decision it binds to, never a general credential
 * that happens to be nearby; the receipt records what happened to the leased operation. The check
 * is a derived view: it names the unmet conditions, it confers no authority, and a rolled-back or
 * refused receipt still closes the loop — the loop closes with the recorded outcome.
 */

import type { EndoPromotionClosureV0 } from "../protocol/trust.ts";
import { validateEndoPromotionDecisionV0, validateEndoPromotionRequestV0 } from "../protocol/evolution.ts";
import {
	ENDO_CLOSURE_DECISION_GRANTED_V0,
	ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0,
	ENDO_CLOSURE_LEASE_BINDS_DECISION_V0,
	ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0,
	ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0,
	validateEndoLeaseRecordV0,
	validateEndoPromotionClosureV0,
	validateEndoReceiptRecordV0,
} from "../protocol/trust.ts";

/**
 * Check whether the authority loop of a promotion request, decision, lease, and receipt is
 * closed. Pure: the four records validate at the door (TypeError, never a repair); the conditions
 * are checked in the fixed protocol order; and the report exits through the protocol validator.
 */
export function verifyEndoPromotionClosureV0(
	request: unknown,
	decision: unknown,
	lease: unknown,
	receipt: unknown,
): EndoPromotionClosureV0 {
	const req = validateEndoPromotionRequestV0(request);
	if (req === null) {
		throw new TypeError("verifyEndoPromotionClosureV0 requires a valid endo.promotion-request.v0");
	}
	const dec = validateEndoPromotionDecisionV0(decision);
	if (dec === null) {
		throw new TypeError("verifyEndoPromotionClosureV0 requires a valid endo.promotion-decision.v0");
	}
	const leaseRecord = validateEndoLeaseRecordV0(lease);
	if (leaseRecord === null) {
		throw new TypeError("verifyEndoPromotionClosureV0 requires a valid endo.lease.v0");
	}
	const receiptRecord = validateEndoReceiptRecordV0(receipt);
	if (receiptRecord === null) {
		throw new TypeError("verifyEndoPromotionClosureV0 requires a valid endo.receipt.v0");
	}

	const unmet: string[] = [];
	if (dec.outcome !== "granted") {
		unmet.push(ENDO_CLOSURE_DECISION_GRANTED_V0);
	}
	if (dec.requestId !== req.id || dec.experimentId !== req.experimentId || dec.candidateId !== req.candidateId) {
		unmet.push(ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0);
	}
	if (leaseRecord.boundTo !== dec.id) {
		unmet.push(ENDO_CLOSURE_LEASE_BINDS_DECISION_V0);
	}
	if (receiptRecord.leaseId !== leaseRecord.id) {
		unmet.push(ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0);
	}
	if (receiptRecord.route !== leaseRecord.route) {
		unmet.push(ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0);
	}

	const report: EndoPromotionClosureV0 = {
		schemaVersion: "endo.promotion-closure.v0",
		decisionId: dec.id,
		closed: unmet.length === 0,
		unmet,
		outcome: receiptRecord.outcome,
	};
	const out = validateEndoPromotionClosureV0(report);
	if (out === null) {
		throw new TypeError("internal error: the promotion closure report failed validation");
	}
	return out;
}
