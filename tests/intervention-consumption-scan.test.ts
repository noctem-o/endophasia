// The consumption check in slices (runtime/contracts/intervention.ts `endoSliceConsumptionV0`, adapters/pi/intervention.ts `consumptionStep`):
// the SAME rule as `endoFindConsumptionV0`, resumable and bounded, and the evidence rules around it. Pure equivalence first; then the real
// desk on a real store (a fake Pi session; the capture is a stub with the bounded reader's shape), because "recorded once" and "never a
// negative from an incomplete scan" are properties of what the desk writes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { ENDO_INTERVENTION_SCHEMA_V0 } from "../protocol/intervention.ts";
import {
	type EndoCaptureIndexEntryV0,
	type EndoCaptureSnapshotV0,
	type EndoInterventionCaptureSourceV0,
	endoFindConsumptionV0,
	endoInterventionMessageRefV0,
	endoNewConsumptionScanV0,
	endoSliceConsumptionV0,
	localOperatorAuthorityV0,
} from "../runtime/contracts/intervention.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const KEY = endoDigestKeyV0(Buffer.alloc(32, 9), "consumption-scan-test");
const TEXT = "Use the read tool, then answer";
const ref = endoInterventionMessageRefV0(KEY, TEXT);
const EVERYTHING = {
	maxBytes: Number.POSITIVE_INFINITY,
	maxRequests: Number.POSITIVE_INFINITY,
	maxBodyBytes: Number.POSITIVE_INFINITY,
};

/** A capture of `counts[i]` copies of the message in request `exchanges[i]`, plus other user messages, in capture order. */
const history = (exchanges: number[], counts: number[], bytesEach = 100) => {
	const bodies = new Map(
		exchanges.map((exchange, i) => [
			exchange,
			{
				messages: [
					{ role: "user", content: "the original prompt" },
					...Array.from({ length: counts[i]! }, () => ({ role: "user", content: TEXT })),
					{ role: "assistant", content: "ok" },
				],
			},
		]),
	);
	const entries: EndoCaptureIndexEntryV0[] = exchanges.map((exchange) => ({
		exchange,
		captureEvent: `endo.event.c${exchange}`,
		at: "2026-10-04T00:00:00.000Z",
		bodyBytes: bytesEach,
	}));
	const reads: number[] = [];
	const snapshot: EndoCaptureSnapshotV0 = {
		entries,
		body: (entry) => {
			reads.push(entry.exchange);
			const body = bodies.get(entry.exchange);
			if (body === undefined) throw new TypeError("missing");
			return body;
		},
	};
	return { entries, snapshot, reads, bodies };
};

describe("the sliced scan is the same rule as endoFindConsumptionV0", () => {
	it("finds the same first request, for every slice size, on many deterministic histories", () => {
		let seed = 12345;
		const next = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		let hits = 0;
		for (let c = 0; c < 400; c++) {
			const length = 1 + next(9);
			let exchange = 0;
			const exchanges = Array.from({ length }, () => {
				exchange += 1 + next(2);
				return exchange;
			});
			// Mostly rising counts (a message delivered stays in the history), with the odd drop and repeat.
			let level = next(2);
			const counts = Array.from({ length }, () => {
				const roll = next(6);
				level = roll === 0 ? Math.max(0, level - 1) : roll < 3 ? level + 1 : level;
				return level;
			});
			const from = 1 + next(exchange + 2);
			const h = history(exchanges, counts);
			const requests = exchanges.map((e) => ({
				exchange: e,
				captureEvent: `endo.event.c${e}`,
				at: "2026-10-04T00:00:00.000Z",
				body: h.bodies.get(e),
			}));
			const expected = endoFindConsumptionV0(requests, ref, KEY, from)?.exchange ?? null;
			if (expected !== null) hits += 1;
			for (const maxRequests of [1, 2, 3, 100]) {
				const scan = endoNewConsumptionScanV0();
				let found: number | null = null;
				for (let guard = 0; guard < 50; guard++) {
					const slice = endoSliceConsumptionV0(scan, h.snapshot, from, ref, KEY, { ...EVERYTHING, maxRequests });
					if (slice.kind === "found") found = slice.exchange;
					if (slice.kind !== "more") break;
				}
				expect(found, `case ${c}, slice ${maxRequests}`).toBe(expected);
				expect(scan.unreadable).toEqual([]);
			}
		}
		expect(hits).toBeGreaterThan(40); // the cases are not all negatives
	});

	it("stops a slice at its request and byte limits, and a resumed scan reads each body once", () => {
		const exchanges = [1, 2, 3, 4, 5, 6];
		const h = history(exchanges, [0, 0, 0, 0, 0, 1], 600_000);
		const scan = endoNewConsumptionScanV0();
		const limits = { maxBytes: 1024 * 1024, maxRequests: 64, maxBodyBytes: 4 * 1024 * 1024 };
		const kinds: string[] = [];
		for (let guard = 0; guard < 20; guard++) {
			const slice = endoSliceConsumptionV0(scan, h.snapshot, 1, ref, KEY, limits);
			kinds.push(slice.kind);
			if (slice.kind !== "more") break;
		}
		// 600 kB bodies against a 1 MiB slice: two per slice (the second crosses the limit), so three slices and a find.
		expect(kinds).toEqual(["more", "more", "found"]);
		expect(h.reads).toEqual([1, 2, 3, 4, 5, 6]);
		expect(scan.scanned).toEqual({ requests: 6, bytes: 3_600_000 });
	});

	it("counts a body it cannot read or will not read, so the caller can never mistake the scan for a negative", () => {
		const h = history([1, 2, 3], [0, 0, 0]);
		const broken: EndoCaptureSnapshotV0 = {
			entries: [...h.entries, { exchange: 4, captureEvent: "endo.event.c4", at: h.entries[0]!.at, bodyBytes: 100 }],
			body: h.snapshot.body,
		};
		const scan = endoNewConsumptionScanV0();
		expect(endoSliceConsumptionV0(scan, broken, 1, ref, KEY, { ...EVERYTHING, maxBodyBytes: 50 }).kind).toBe("end");
		expect(scan.tooLarge).toEqual([1, 2, 3, 4]);
		const again = endoNewConsumptionScanV0();
		expect(endoSliceConsumptionV0(again, broken, 1, ref, KEY, EVERYTHING).kind).toBe("end");
		expect(again.unreadable).toEqual([4]);
	});
});

// --- the real desk ------------------------------------------------------------------------------------------------------------

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

async function openSession(): Promise<PiSessionAttachmentV0> {
	const install = installFakePi("1.0.0");
	cleanup.push(() => install.remove());
	const pi = new PiAttachmentV0({
		root: temp("endo-scan-"),
		cwd: temp("endo-scan-cwd-"),
		executable: install.bin,
		env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
		requestTimeoutMs: 10_000,
		digestKey: KEY,
	});
	await pi.checkLocal();
	install.setScenario("");
	const session = await pi.openSession();
	let closed = false;
	cleanup.push(async () => {
		if (!closed) await session.close();
	});
	(session as unknown as { closeOnce: () => Promise<void> }).closeOnce = async () => {
		closed = true;
		await session.close();
	};
	return session;
}

/**
 * A steer the desk holds as proposed, authorized, requested at exchange 0 and accepted: what consumption is about. The request and its
 * acceptance are recorded through the session, so the desk that is returned is a fresh one over the same store, which indexes them.
 */
function acceptedSteer(
	session: PiSessionAttachmentV0,
	capture: EndoInterventionCaptureSourceV0 | null,
	text = TEXT,
): { desk: PiInterventionDeskV0; id: string } {
	const writer = new PiInterventionDeskV0(session, KEY);
	const proposal = writer.propose({ operation: "steer", message: text, nonce: "scan-1" });
	const authorization = writer.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
	const requestId = `endo.evidence.intervention.request.${proposal.proposalId.slice(-16)}`;
	const request = session.recordIntervention(
		"intervention.request",
		{
			schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
			requestId,
			proposalId: proposal.proposalId,
			authorizationId: authorization.authorizationId,
			operation: "steer",
			capability: "steering.steer",
			at: { exchange: 0, chunks: 0 },
		},
		[],
	);
	session.recordIntervention(
		"intervention.accepted",
		{ schemaVersion: ENDO_INTERVENTION_SCHEMA_V0, requestId, disposition: "queued" },
		[request.id],
	);
	return { desk: new PiInterventionDeskV0(session, KEY, capture), id: proposal.proposalId };
}

const source = (h: { snapshot: EndoCaptureSnapshotV0 }): EndoInterventionCaptureSourceV0 => ({
	requests: () => null,
	open: () => h.snapshot,
});
const stored = (session: PiSessionAttachmentV0, kind: string): EndoEventV0[] => {
	const store = createEndoDurableEventStoreV0(session.owner.options.root, { readOnly: true });
	const all: EndoEventV0[] = [];
	for (let after = 0; ; ) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		if (page.events.length === 0) break;
		all.push(...page.events.filter((e) => e.kind === kind));
		after = page.nextAfterSequence;
	}
	store.close();
	return all;
};
const SMALL = { maxBytes: 1024, maxRequests: 2, maxBodyBytes: 1024 * 1024 };
const drive = (desk: PiInterventionDeskV0, id: string, limits = SMALL) => {
	const out: string[] = [];
	for (let guard = 0; guard < 100; guard++) {
		const step = desk.consumptionStep(id, limits, { fresh: guard === 0 });
		out.push(step.status);
		if (step.status !== "scanning") return { out, step };
	}
	throw new Error("never finished");
};

describe("the desk's bounded check", () => {
	it("finds consumption after several exchanges, records it once, and the closing finish does not record it again", async () => {
		const session = await openSession();
		const h = history([1, 2, 3, 4, 5, 6, 7], [0, 0, 0, 0, 0, 1, 1]);
		const { desk, id } = acceptedSteer(session, source(h));
		const { out, step } = drive(desk, id);
		expect(out).toEqual(["scanning", "scanning", "observed"]); // [1,2] [3,4] [5,6]: found at 6
		expect(step).toMatchObject({ status: "observed", exchange: 6, captureEvent: "endo.event.c6" });
		expect(stored(session, "intervention.consumed")).toHaveLength(1);
		// Observed is final: another step, another desk over the same store, and the closing finish all agree and write nothing more.
		expect(desk.consumptionStep(id, SMALL)).toMatchObject({ status: "observed", exchange: 6 });
		await desk.finish();
		expect(stored(session, "intervention.consumed")).toHaveLength(1);
		expect((stored(session, "intervention.consequence")[0]!.payload as any).consumption).toMatchObject({
			status: "observed",
			exchange: 6,
		});
	});

	it("records it once when the closing finish runs in the middle of an explicit check", async () => {
		const session = await openSession();
		const h = history([1, 2, 3, 4, 5], [0, 0, 0, 1, 1]);
		const { desk, id } = acceptedSteer(session, source(h));
		expect(desk.consumptionStep(id, SMALL, { fresh: true }).status).toBe("scanning");
		await desk.finish(); // reads the capture whole, records, then the consequence
		expect(stored(session, "intervention.consumed")).toHaveLength(1);
		// The explicit check, resuming, sees the finding and records nothing.
		expect(desk.consumptionStep(id, SMALL)).toMatchObject({ status: "observed", exchange: 4 });
		await desk.finish();
		expect(stored(session, "intervention.consumed")).toHaveLength(1);
	});

	it("says there is no capture when there is none, and applies to nothing it should not", async () => {
		const session = await openSession();
		const { desk, id } = acceptedSteer(session, { requests: () => null, open: () => null });
		expect(desk.consumptionStep(id, SMALL, { fresh: true })).toEqual({
			status: "not-observed",
			reason: "this session store holds no proxy capture",
		});
		const bare = new PiInterventionDeskV0(session, KEY, null);
		expect(bare.consumptionStep(id, SMALL, { fresh: true })).toMatchObject({ status: "not-observed" });
		expect(desk.consumptionStep("endo.evidence.intervention.proposal.nope", SMALL)).toMatchObject({
			status: "not-applicable",
		});
		const stop = desk.propose({ operation: "stop" });
		expect(desk.consumptionStep(stop.proposalId, SMALL)).toMatchObject({ status: "not-applicable" });
	});

	it("reports a body it cannot read as incomplete, not as not observed, and records no consumption", async () => {
		const session = await openSession();
		const h = history([1, 2, 3], [0, 0, 0]);
		h.bodies.delete(2); // exchange 2's blob is missing or does not verify
		const { desk, id } = acceptedSteer(session, source(h));
		const { step } = drive(desk, id);
		expect(step).toMatchObject({ status: "incomplete" });
		expect((step as { reason: string }).reason).toContain("1 captured request could not be inspected");
		expect(stored(session, "intervention.consumed")).toEqual([]);
		// The closing record is explicit about it as well: not established, and why.
		await desk.finish();
		const consumption = (stored(session, "intervention.consequence")[0]!.payload as any).consumption;
		expect(consumption.status).toBe("not-observed");
		expect(consumption.reason).toContain("not established");
		expect(consumption.reason).toContain("could not be inspected");
	});

	it("does not let an unreadable baseline invent a finding", async () => {
		const session = await openSession();
		// Request 0 is the baseline for from=1 and cannot be read; request 1 and 2 carry the message: with no baseline nothing is an increase.
		const h = history([0, 1, 2], [1, 1, 1]);
		h.bodies.delete(0);
		const { desk, id } = acceptedSteer(session, source(h));
		const { step } = drive(desk, id);
		expect(step.status).toBe("incomplete");
		expect(stored(session, "intervention.consumed")).toEqual([]);
	});

	it("reports an over-limit body and a capture it cannot index as incomplete", async () => {
		const session = await openSession();
		const h = history([1, 2], [0, 0], 5_000_000);
		const { desk, id } = acceptedSteer(session, source(h));
		expect(drive(desk, id, { ...SMALL, maxBodyBytes: 1_000_000 }).step).toMatchObject({ status: "incomplete" });
		const huge = new PiInterventionDeskV0(session, KEY, {
			requests: () => null,
			open: () => {
				throw new RangeError("the capture's event log is larger than the bounded index");
			},
		});
		expect(huge.consumptionStep(id, SMALL, { fresh: true })).toMatchObject({
			status: "incomplete",
			reason: expect.stringContaining("bounded reader's limit"),
		});
	});

	it("sees only the capture as it stood when the check opened, and a later check picks up what was added", async () => {
		const session = await openSession();
		const h = history([1, 2, 3], [0, 0, 0]);
		const grown = history([1, 2, 3, 4, 5], [0, 0, 0, 0, 1]);
		let current = h;
		const { desk, id } = acceptedSteer(session, { requests: () => null, open: () => current.snapshot });
		expect(desk.consumptionStep(id, { ...SMALL, maxRequests: 1 }, { fresh: true })).toMatchObject({
			status: "scanning",
			total: 3,
		});
		current = grown; // the capture grows while the check is between slices
		// The running check keeps its snapshot: it ends on what it opened, and says what that was.
		let last = desk.consumptionStep(id, { ...SMALL, maxRequests: 1 });
		while (last.status === "scanning") last = desk.consumptionStep(id, { ...SMALL, maxRequests: 1 });
		expect(last).toMatchObject({ status: "not-observed", reason: expect.stringContaining("(3 captured)") });
		// A new check opens the grown capture and resumes after what was already read.
		const before = grown.reads.length;
		const resumed = drive(desk, id);
		expect(resumed.step).toMatchObject({ status: "observed", exchange: 5 });
		expect(grown.reads.slice(before)).toEqual([4, 5]);
	});

	it("still reads a capture too large for the bounded index when the session closes, and records what it shows", async () => {
		const session = await openSession();
		const h = history([1, 2, 3], [0, 1, 1]);
		// A capture whose index is over the bounded reader's limit: the workbench's check cannot open it, the closing record can.
		const capped: EndoInterventionCaptureSourceV0 = {
			requests: () => null,
			open: (options) => {
				if (options?.maxIndexBytes !== Number.POSITIVE_INFINITY)
					throw new RangeError("the capture's event log is larger than the bounded index");
				return h.snapshot;
			},
		};
		const { desk, id } = acceptedSteer(session, capped);
		expect(desk.consumptionStep(id, SMALL, { fresh: true })).toMatchObject({ status: "incomplete" });
		expect(stored(session, "intervention.consumed")).toEqual([]);
		await desk.finish();
		expect(stored(session, "intervention.consumed")).toHaveLength(1);
		expect((stored(session, "intervention.consequence")[0]!.payload as any).consumption).toMatchObject({
			status: "observed",
			exchange: 2,
		});
		// The public whole-check read (the control socket's) takes the same unbounded path.
		expect(desk.consumption(id)).toMatchObject({ status: "observed", exchange: 2 });
	});

	it("does not touch the store once it is closed, and reports the finding it could not record as incomplete", async () => {
		const session = await openSession();
		const h = history([1, 2], [0, 1]);
		const { desk, id } = acceptedSteer(session, source(h));
		await (session as unknown as { closeOnce: () => Promise<void> }).closeOnce();
		const step = desk.consumptionStep(id, SMALL, { fresh: true });
		expect(step.status).toBe("incomplete");
		expect((step as { reason: string }).reason).toContain("closed");
	});
});
