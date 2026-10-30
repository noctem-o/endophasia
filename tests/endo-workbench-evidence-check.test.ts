// The workbench's explicit evidence check (adapters/pi/workbench-interventions.ts): bounded, cooperative and honest about what it did not
// establish. At the broker's boundary, with the desk's slices scripted and the yield between slices under the test's control, so the
// interleaving is exact and nothing depends on a sleep. The scan itself, the real desk and a real on-disk capture are in
// intervention-consumption-scan.test.ts and endo-workbench-evidence-live.test.ts.
import { describe, expect, it } from "vitest";
import type { PiConsumptionStepV0 } from "../adapters/pi/intervention.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { WorkbenchEvidenceBudgetV0 } from "../adapters/pi/workbench-interventions.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeDesk, FakeSession, settle } from "./workbench-fixtures.ts";

/** The yield between slices, held by the test: nothing proceeds until `release` says so. */
class Gate {
	waiting: (() => void)[] = [];
	yields = 0;
	/** Called each time a check gives the loop back. */
	onYield: () => void = () => {};
	readonly yieldToLoop = () =>
		new Promise<void>((resolve) => {
			this.yields += 1;
			this.onYield();
			this.waiting.push(resolve);
		});
	async release(times = 1): Promise<void> {
		for (let i = 0; i < times; i++) {
			await settle(2);
			this.waiting.shift()?.();
		}
		await settle(2);
	}
}

const scanning = (requests: number, total = 500): PiConsumptionStepV0 => ({
	status: "scanning",
	scanned: { requests, bytes: requests * 1000 },
	total,
});

function setup(budget: Partial<WorkbenchEvidenceBudgetV0> = {}) {
	const session = new FakeSession();
	session.runActive = true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const gate = new Gate();
	let now = 1_000_000;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		now: () => now,
		yieldToLoop: gate.yieldToLoop,
		evidenceBudget: budget,
	});
	const call = (method: "GET" | "POST", route: string, body: unknown = null, grant: string | null = null) =>
		broker.handle({ method, route: route.split("/"), query: "", grant, body });
	const pair = async () =>
		((await call("POST", "pair", { code: broker.issuePairingCode().code })).body as { grant: string }).grant;
	const view = async (id: string, grant: string) => (await call("GET", `intervention/${id}`, null, grant)).body as any;
	const check = (id: string, grant: string) => call("POST", "intervention/check", { proposalId: id }, grant);
	/** An accepted steer, approved on the terminal and answered by Pi. */
	const accepted = async (grant: string, text = "look again") => {
		const reply = await call("POST", "intervention/propose", { operation: "steer", message: text }, grant);
		const id = (reply.body as { proposalId: string }).proposalId;
		await approval.waitForRequest();
		approval.answer("allow");
		approval.requests.length = 0;
		await settle();
		desk.release(id);
		await settle();
		return id;
	};
	return {
		session,
		desk,
		approval,
		gate,
		broker,
		call,
		pair,
		view,
		check,
		accepted,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("one check at a time per request, resumed rather than repeated", () => {
	it("answers at once, runs one scan however often it is asked, and reads in slices", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.steps = [scanning(64), scanning(128), scanning(192)];
		const first = await t.check(id, grant);
		expect(first).toMatchObject({ status: 202, body: { consumption: { status: "checking" } } });
		// Not even the first slice ran inside the request.
		expect(t.desk.consumptionChecks).toBe(0);
		for (let i = 0; i < 9; i++) expect((await t.check(id, grant)).status).toBe(200);
		await t.gate.release(); // the first slice
		expect(t.desk.consumptionChecks).toBe(1);
		for (let i = 0; i < 9; i++) await t.check(id, grant);
		expect(t.desk.consumptionChecks).toBe(1);
		expect(await t.view(id, grant)).toMatchObject({
			consumption: { status: "checking", scanned: { requests: 64 }, total: 500 },
		});
		await t.gate.release(3);
		expect(t.desk.consumptionChecks).toBe(4);
		expect(t.desk.stepCalls.map((c) => c.fresh)).toEqual([true, false, false, false]);
		expect(await t.view(id, grant)).toMatchObject({ consumption: { status: "not-observed" } });
	});

	it("returns a finished check's answer again during the cooldown, then resumes the same scan afterwards", async () => {
		const t = setup({ cooldownMs: 5_000 });
		const grant = await t.pair();
		const id = await t.accepted(grant);
		await t.check(id, grant);
		await t.gate.release(2);
		const after = await t.view(id, grant);
		expect(after.consumption.status).toBe("not-observed");
		const reads = t.desk.consumptionChecks;
		for (let i = 0; i < 20; i++) expect((await t.check(id, grant)).status).toBe(200);
		expect(t.desk.consumptionChecks).toBe(reads);
		t.advance(5_001);
		expect((await t.check(id, grant)).status).toBe(202);
		await t.gate.release(2);
		expect(t.desk.consumptionChecks).toBeGreaterThan(reads);
	});

	it("treats an observation as final and never reads again", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.consumptionResult = { status: "observed", exchange: 7, captureEvent: "endo.event.c7" };
		await t.check(id, grant);
		await t.gate.release(2);
		expect(await t.view(id, grant)).toMatchObject({ consumption: { status: "observed", exchange: 7 } });
		const reads = t.desk.consumptionChecks;
		t.advance(60_000);
		expect((await t.check(id, grant)).status).toBe(200);
		expect(t.desk.consumptionChecks).toBe(reads);
	});
});

describe("a bound on how many checks run at once", () => {
	it("admits two, refuses a third as busy without touching the capture, and admits it when one ends", async () => {
		const t = setup({ concurrent: 2 });
		const grant = await t.pair();
		const ids = [await t.accepted(grant, "one"), await t.accepted(grant, "two"), await t.accepted(grant, "three")];
		t.desk.steps = [scanning(64), scanning(64)];
		expect((await t.check(ids[0]!, grant)).status).toBe(202);
		expect((await t.check(ids[1]!, grant)).status).toBe(202);
		const busy = await t.check(ids[2]!, grant);
		expect(busy).toMatchObject({ status: 409, body: { error: "check-busy" } });
		expect(t.desk.consumptionChecks).toBe(0);
		await t.gate.release(4);
		expect((await t.view(ids[0]!, grant)).consumption.status).not.toBe("checking");
		expect((await t.check(ids[2]!, grant)).status).toBe(202);
	});
});

describe("a check that does not finish establishes nothing", () => {
	it("stops at its request limit as incomplete, never as not observed, and resumes after the cooldown", async () => {
		const t = setup({ checkRequests: 100, cooldownMs: 5_000 });
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.steps = Array.from({ length: 10 }, (_, i) => scanning(64 * (i + 1), 1000));
		await t.check(id, grant);
		await t.gate.release(6);
		const stopped = await t.view(id, grant);
		expect(stopped.consumption).toMatchObject({ status: "incomplete", total: 1000 });
		expect(stopped.consumption.reason).toContain("work limit");
		expect(stopped.consumption.retryAtMs).toBeGreaterThan(1_000_000);
		const readsAtStop = t.desk.consumptionChecks;
		// Asked again at once: the same answer, no new reading.
		await t.check(id, grant);
		expect(t.desk.consumptionChecks).toBe(readsAtStop);
		t.advance(5_001);
		t.desk.steps = [];
		await t.check(id, grant);
		await t.gate.release(2);
		expect(t.desk.stepCalls.at(-1)).toEqual({ fresh: true });
	});

	it("stops at its time limit, by the broker's own clock", async () => {
		const t = setup({ checkMs: 1_000 });
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.steps = Array.from({ length: 10 }, (_, i) => scanning(i + 1));
		t.gate.onYield = () => t.advance(400);
		await t.check(id, grant);
		await t.gate.release(6);
		expect((await t.view(id, grant)).consumption).toMatchObject({ status: "incomplete" });
		expect(t.desk.consumptionChecks).toBeLessThan(6);
	});

	it("reports what the desk could not inspect as incomplete, in the desk's words", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.consumptionResult = {
			status: "incomplete",
			reason:
				"2 captured requests could not be inspected (unreadable, or over the per-request limit); the message was not found in the others",
			scanned: { requests: 9, bytes: 900 },
			total: 9,
		};
		await t.check(id, grant);
		await t.gate.release(2);
		const done = (await t.view(id, grant)).consumption;
		expect(done).toMatchObject({ status: "incomplete", total: 9 });
		expect(done.reason).toContain("could not be inspected");
		expect(done.status).not.toBe("not-observed");
	});

	it("does not let a desk that throws turn into a negative", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.consumptionStep = () => {
			throw new Error("EIO: /private/path/capture");
		};
		await t.check(id, grant);
		await t.gate.release(2);
		const done = (await t.view(id, grant)).consumption;
		expect(done).toMatchObject({ status: "incomplete", reason: "the evidence could not be read just now" });
		expect(JSON.stringify(done)).not.toContain("private");
	});
});

describe("the workbench stays responsive while a check runs, and stops when the session closes", () => {
	it("serves status, a request's view and a STOP between slices of a check that is still running", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.steps = [scanning(64), scanning(128), scanning(192)];
		await t.check(id, grant);
		await t.gate.release(); // one slice read, the check is parked between slices
		const status = (await t.call("GET", "status")).body as any;
		expect(status.interventions.find((i: any) => i.proposalId === id).consumption.status).toBe("checking");
		expect((await t.call("GET", "transcript", null, grant)).status).toBe(200);
		const stop = await t.call("POST", "intervention/propose", { operation: "stop" }, grant);
		expect(stop.status).toBe(202);
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		expect(t.desk.applyCalls.at(-1)).toBe((stop.body as { proposalId: string }).proposalId);
		// Throughout, the check was only ever between slices: still running, and not finished by any of this.
		expect((await t.view(id, grant)).consumption.status).toBe("checking");
		await t.gate.release(3);
		expect((await t.view(id, grant)).consumption.status).not.toBe("checking");
	});

	it("stops at the next slice when the session begins to close, and says closing will check once more", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		t.desk.steps = [scanning(64), scanning(128), scanning(192)];
		await t.check(id, grant);
		await t.gate.release();
		t.desk.finish(); // the desk's final finish tells the broker first
		await t.gate.release(2);
		const done = (await t.view(id, grant)).consumption;
		expect(done).toMatchObject({ status: "incomplete" });
		expect(done.reason).toContain("closing the session checks the capture once more");
		expect(t.desk.consumptionChecks).toBe(1); // no slice was read after the close began
		expect((await t.check(id, grant)).status).toBe(409);
		await t.broker.dispose();
	});
});

describe("what the check asks of the capture", () => {
	it("never reads on a status poll, a transcript read or a view", async () => {
		const t = setup();
		const grant = await t.pair();
		const id = await t.accepted(grant);
		for (let i = 0; i < 10; i++) {
			await t.call("GET", "status");
			await t.call("GET", "transcript", null, grant);
			await t.view(id, grant);
		}
		expect(t.desk.consumptionChecks).toBe(0);
	});

	it("is refused for a STOP and for a request Pi has not accepted", async () => {
		const t = setup();
		const grant = await t.pair();
		const stop = await t.call("POST", "intervention/propose", { operation: "stop" }, grant);
		expect((await t.check((stop.body as { proposalId: string }).proposalId, grant)).status).toBe(409);
		// (A fresh broker: a pending stop withholds a new steer.)
		const u = setup();
		const g = await u.pair();
		const steer = await u.call("POST", "intervention/propose", { operation: "steer", message: "x" }, g);
		expect((await u.check((steer.body as { proposalId: string }).proposalId, g)).status).toBe(409);
		expect(u.desk.consumptionChecks).toBe(0);
		expect(t.desk.consumptionChecks).toBe(0);
	});
});
