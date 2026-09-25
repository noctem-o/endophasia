import { createModels, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
	type EventListener,
	type Events,
	type HarnessEvent,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessClosed } from "../../agent/src/harness/result.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session, UsageRow, UsageScan } from "../../agent/src/harness/session/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import { attachUsageFeedV0, readUsageLedgerV0, type UsageFeedSourceV0, type UsageLedgerRowV0 } from "../src/index.ts";
import { exactUsageProvider, usage } from "./exact-usage-provider.ts";

const sessions: Session[] = [];

const A = usage(11, 7, 13, 5, 41, [0.5, 0.25, 0.125, 0.0625, 0.9375]);
const B = usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125]);
const C = usage(29, 23, 31, 37, 120, [2, 4, 8, 16, 30]);
const D = usage(1, 1, 1, 1, 7, [0.5, 0.5, 0.5, 0.5, 2]);

async function fixture(): Promise<{
	session: StorageBackedSession;
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	reported: Usage[];
	source: UsageFeedSourceV0;
}> {
	const session = new StorageBackedSession(
		{ id: `usage-feed-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const reported: Usage[] = [];
	const models = createModels();
	models.setProvider(exactUsageProvider(faux, reported));
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { session, harness, lane, faux, reported, source: { events: harness.events, session } };
}

function collector() {
	const rows: UsageLedgerRowV0[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const listener = async (row: UsageLedgerRowV0) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await Promise.resolve();
		rows.push(row);
		inFlight--;
	};
	return {
		rows,
		listener,
		usages: () => rows.map((row) => row.usage),
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

async function record(lane: AgentLane, value: Usage, details?: UsageRow["details"]): Promise<void> {
	const result = await lane.recordUsage(value, details === undefined ? undefined : { details }, BACKGROUND_CONTEXT);
	if (!result.ok) throw result.error;
}

async function sequences(session: Session): Promise<number[]> {
	return (await session.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ seq }) => seq);
}

/** Wrap a session so each scanUsage call can run a hook before and/or after the real read. */
function hookedSession(
	session: Session,
	hooks: {
		before?: (call: number, query: UsageScan) => Promise<void>;
		after?: (call: number, query: UsageScan) => Promise<void>;
	},
) {
	const calls: UsageScan[] = [];
	const scanUsage = async (query: UsageScan, context: typeof BACKGROUND_CONTEXT) => {
		const call = calls.length;
		calls.push(query);
		await hooks.before?.(call, query);
		const rows = await session.scanUsage(query, context);
		await hooks.after?.(call, query);
		return rows;
	};
	return { session: { scanUsage }, calls };
}

/** A fully fake source exposing only events.on("usage") and session.scanUsage. */
function fakeSource(initial: UsageRow[] = []) {
	const rows = [...initial];
	const listeners = new Set<EventListener>();
	const removed = vi.fn();
	const events: Pick<Events, "on"> = {
		on: ((type: string, listener: EventListener) => {
			expect(type).toBe("usage");
			listeners.add(listener);
			return () => {
				removed();
				listeners.delete(listener);
			};
		}) as Events["on"],
	};
	const calls: UsageScan[] = [];
	let beforeScan: ((call: number) => void | Promise<void>) | undefined;
	const session = {
		scanUsage: async (query: UsageScan) => {
			calls.push(query);
			await beforeScan?.(calls.length - 1);
			const selected = rows
				.filter(
					(row) =>
						(query.fromSeq === undefined || row.seq >= query.fromSeq) &&
						(query.toSeq === undefined || row.seq <= query.toSeq),
				)
				.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
			return structuredClone(query.limit === undefined ? selected : selected.slice(0, query.limit));
		},
	};
	const commit = async (row: UsageRow) => {
		rows.push(row);
		const event = { type: "usage", lane: "fake", row, totals: row.usage } as HarnessEvent;
		for (const listener of [...listeners]) await listener(structuredClone(event), BACKGROUND_CONTEXT);
	};
	/** Commit and dispatch without awaiting: returns what each listener returned (a promise means backpressure). */
	const emit = (row: UsageRow) => {
		rows.push(row);
		const event = { type: "usage", lane: "fake", row, totals: row.usage } as HarnessEvent;
		return [...listeners].map((listener) => listener(structuredClone(event), BACKGROUND_CONTEXT));
	};
	return {
		source: { events, session } satisfies UsageFeedSourceV0,
		calls,
		removed,
		commit,
		emit,
		listenerCount: () => listeners.size,
		onScan(hook: (call: number) => void | Promise<void>) {
			beforeScan = hook;
		},
	};
}

function row(seq: number, input = seq): UsageRow {
	return { id: `row-${seq}`, seq, adjustment: true, usage: usage(input, 0, 0, 0, input, [0, 0, 0, 0, 0]) };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Usage Feed v0", () => {
	it("attaches to an empty ledger and delivers a later row once", async () => {
		const { lane, source } = await fixture();
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		expect(feed).toMatchObject({ active: true, afterSequence: 0 });
		await record(lane, A);
		expect(seen.usages()).toEqual([A]);
		expect(feed.afterSequence).toBe(seen.rows[0]!.sequence);
		feed.unsubscribe();
	});

	it("replays existing rows oldest-first before going live, and resumes after a cursor", async () => {
		const { session, lane, source } = await fixture();
		await record(lane, A);
		await record(lane, B);
		await record(lane, C);
		const [, bSeq] = await sequences(session);
		const all = collector();
		const feed = await attachUsageFeedV0(source, undefined, all.listener, BACKGROUND_CONTEXT);
		expect(all.usages()).toEqual([A, B, C]);
		const resumed = collector();
		const second = await attachUsageFeedV0(source, { afterSequence: bSeq }, resumed.listener, BACKGROUND_CONTEXT);
		expect(resumed.usages()).toEqual([C]);
		await record(lane, D);
		expect(all.usages()).toEqual([A, B, C, D]);
		expect(resumed.usages()).toEqual([C, D]);
		feed.unsubscribe();
		second.unsubscribe();
	});

	it("tolerates session-global sequence gaps on replay and live paths", async () => {
		const { session, lane, source } = await fixture();
		await record(lane, A);
		await lane.appendMessage({ role: "user", content: "gap", timestamp: 1 }, BACKGROUND_CONTEXT);
		await record(lane, B);
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		await lane.appendMessage({ role: "user", content: "gap", timestamp: 1 }, BACKGROUND_CONTEXT);
		await record(lane, C);
		const seqs = await sequences(session);
		expect(seqs[1]! - seqs[0]!).toBeGreaterThan(1);
		expect(seqs[2]! - seqs[1]!).toBeGreaterThan(1);
		expect(seen.rows.map(({ sequence }) => sequence)).toEqual(seqs);
		feed.unsubscribe();
	});

	it("subscribes before the first ledger read: a row committed right after that read is not lost", async () => {
		const { session, lane, harness } = await fixture();
		let subscribed = false;
		const events: Pick<Events, "on"> = {
			on: ((type: "usage", listener: EventListener<Extract<HarnessEvent, { type: "usage" }>>) => {
				subscribed = true;
				return harness.events.on(type, listener);
			}) as Events["on"],
		};
		const hooked = hookedSession(session, {
			after: async (call) => {
				if (call !== 0) return;
				expect(subscribed).toBe(true);
				await record(lane, B);
			},
		});
		await record(lane, A);
		const seen = collector();
		const feed = await attachUsageFeedV0(
			{ events, session: hooked.session },
			undefined,
			seen.listener,
			BACKGROUND_CONTEXT,
		);
		expect(seen.usages()).toEqual([A, B]);
		feed.unsubscribe();
	});

	it("delivers a row seen by both the high-water scan and the event buffer exactly once", async () => {
		const { session, lane, source } = await fixture();
		await record(lane, A);
		const hooked = hookedSession(session, {
			before: async (call) => {
				if (call === 0) await record(lane, B);
			},
		});
		const seen = collector();
		const feed = await attachUsageFeedV0(
			{ events: source.events, session: hooked.session },
			undefined,
			seen.listener,
			BACKGROUND_CONTEXT,
		);
		expect(seen.usages()).toEqual([A, B]);
		expect(hooked.calls[1]?.toSeq).toBe((await sequences(session))[1]);
		feed.unsubscribe();
	});

	it("delivers a row committed after the high-water mark from the event buffer, after replay", async () => {
		const { session, lane, source } = await fixture();
		await record(lane, A);
		await record(lane, B);
		const highWater = (await sequences(session)).at(-1)!;
		const hooked = hookedSession(session, {
			before: async (call) => {
				if (call === 1) {
					await record(lane, C);
					await record(lane, D);
				}
			},
		});
		const seen = collector();
		const feed = await attachUsageFeedV0(
			{ events: source.events, session: hooked.session },
			undefined,
			seen.listener,
			BACKGROUND_CONTEXT,
		);
		expect(seen.usages()).toEqual([A, B, C, D]);
		expect(hooked.calls.slice(1).every((query) => query.toSeq === highWater)).toBe(true);
		expect(seen.maxInFlight).toBe(1);
		expect(feed.afterSequence).toBe((await sequences(session)).at(-1));
		feed.unsubscribe();
	});

	it("bounds replay at the captured high-water mark even while rows keep arriving", async () => {
		const fake = fakeSource([row(2), row(5), row(9)]);
		let next = 20;
		fake.onScan(async (call) => {
			if (call > 0) await fake.commit(row(next++));
		});
		const seen = collector();
		const feed = await attachUsageFeedV0(fake.source, { pageSize: 1 }, seen.listener, BACKGROUND_CONTEXT);
		const pages = fake.calls.slice(1);
		expect(pages.length).toBeGreaterThan(0);
		expect(pages.every((query) => query.toSeq === 9 && query.order === "asc" && query.limit === 1)).toBe(true);
		expect(pages.map((query) => query.fromSeq)).toEqual([1, 3, 6]);
		expect(seen.rows.map(({ sequence }) => sequence)).toEqual([
			2,
			5,
			9,
			...Array.from({ length: next - 20 }, (_, i) => 20 + i),
		]);
		await fake.commit(row(100));
		expect(seen.rows.at(-1)?.sequence).toBe(100);
		feed.unsubscribe();
	});

	it("freezes one finite handoff batch and goes live before that batch finishes delivering", async () => {
		const fake = fakeSource([row(1), row(2)]);
		fake.onScan(async (call) => {
			// While the first replay page is pending, B commits after the high-water mark and is buffered.
			if (call === 1) await fake.commit(row(5));
		});
		const bEntered = deferred();
		const releaseB = deferred();
		const delivered: number[] = [];
		const attaching = attachUsageFeedV0(
			fake.source,
			undefined,
			async (next) => {
				if (next.sequence === 5) {
					bEntered.resolve();
					await releaseB.promise;
				}
				delivered.push(next.sequence);
			},
			BACKGROUND_CONTEXT,
		);
		await bEntered.promise;
		expect(delivered).toEqual([1, 2]);
		// C arrives while B is blocked. A live feed queues C behind B and backpressures the producer with a
		// pending promise; a feed still catching up would buffer C and return nothing, keeping the finish line moving.
		const [cDelivery] = fake.emit(row(9));
		expect(cDelivery).toBeInstanceOf(Promise);
		expect(delivered).toEqual([1, 2]);
		releaseB.resolve();
		const feed = await attaching;
		await cDelivery;
		expect(delivered).toEqual([1, 2, 5, 9]);
		expect(feed.afterSequence).toBe(9);
		expect(feed.active).toBe(true);
		feed.unsubscribe();
	});

	it("pages multi-page replay with a fixed toSeq and no duplicates", async () => {
		const { session, lane, source } = await fixture();
		for (let index = 0; index < 7; index++) await record(lane, usage(index + 1, 0, 0, 0, index + 1, [0, 0, 0, 0, 0]));
		const seqs = await sequences(session);
		const hooked = hookedSession(session, {});
		const seen = collector();
		const feed = await attachUsageFeedV0(
			{ events: source.events, session: hooked.session },
			{ pageSize: 3 },
			seen.listener,
			BACKGROUND_CONTEXT,
		);
		expect(hooked.calls[0]).toEqual({ order: "desc", limit: 1 });
		expect(hooked.calls.slice(1)).toEqual([
			{ fromSeq: 1, toSeq: seqs[6], order: "asc", limit: 3 },
			{ fromSeq: seqs[2]! + 1, toSeq: seqs[6], order: "asc", limit: 3 },
			{ fromSeq: seqs[5]! + 1, toSeq: seqs[6], order: "asc", limit: 3 },
		]);
		expect(seen.rows.map(({ sequence }) => sequence)).toEqual(seqs);
		expect(feed.afterSequence).toBe(seqs[6]);
		feed.unsubscribe();
	});

	it("delivers live rows sequentially in durable order across lanes, without lane or totals", async () => {
		const { session, harness, lane, faux, reported, source } = await fixture();
		const other = await harness.lane("other", BACKGROUND_CONTEXT);
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		reported.push(A, B);
		await lane.prompt("on main", undefined, BACKGROUND_CONTEXT);
		await other.prompt("on other", undefined, BACKGROUND_CONTEXT);
		await record(other, C);
		expect(seen.usages()).toEqual([A, B, C]);
		expect(seen.rows.map(({ sequence }) => sequence)).toEqual(await sequences(session));
		expect(seen.maxInFlight).toBe(1);
		for (const delivered of seen.rows) {
			expect(delivered).not.toHaveProperty("lane");
			expect(delivered).not.toHaveProperty("totals");
		}
		feed.unsubscribe();
	});

	it("delivers the same payload-minimal rows on replay and live paths as the durable ledger", async () => {
		const { session, lane, source } = await fixture();
		const variants: Array<[Usage, UsageRow["details"] | undefined]> = [
			[C, { sentinel: "private-durable-details" }],
			[usage(0, 0, 0, 0, 0, [0, 0, 0, 0, 0]), undefined],
			[usage(-9, -3, -1, -7, -20, [-1, -2, -4, -8, -15]), undefined],
			[usage(1, 2, 3, 4, 99, [0, 0, 0, 0, 0], { cacheWrite1h: 3, reasoning: 1 }), undefined],
		];
		for (const [value, details] of variants) await record(lane, value, details);
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		for (const [value, details] of variants) {
			await record(lane, value, details === undefined ? undefined : { sentinel: "private-live-details" });
		}
		const replayed = seen.rows.slice(0, variants.length);
		const live = seen.rows.slice(variants.length);
		const strip = ({ id: _id, sequence: _sequence, ...rest }: UsageLedgerRowV0) => rest;
		expect(live.map(strip)).toEqual(replayed.map(strip));
		expect(replayed.map(({ usage: value }) => value)).toEqual(variants.map(([value]) => value));
		expect(replayed[0]?.usage).not.toHaveProperty("cacheWrite1h");
		expect(replayed[3]?.usage).toMatchObject({ cacheWrite1h: 3, reasoning: 1, totalTokens: 99 });
		expect(live[3]?.usage).toMatchObject({ cacheWrite1h: 3, reasoning: 1, totalTokens: 99 });
		expect(seen.rows).toEqual((await readUsageLedgerV0(session, undefined, BACKGROUND_CONTEXT)).rows);
		const serialized = JSON.stringify(seen.rows);
		expect(serialized).not.toMatch(/private-durable-details|private-live-details|details|lane|totals/);
		feed.unsubscribe();
	});

	it("advances the cursor only after the listener succeeds", async () => {
		const { lane, source } = await fixture();
		const entered = deferred();
		const release = deferred();
		let feedRef: { afterSequence: number } | undefined;
		let duringCallback: number | undefined;
		let deliveredSequence: number | undefined;
		const feed = await attachUsageFeedV0(
			source,
			undefined,
			async (delivered) => {
				duringCallback = feedRef?.afterSequence;
				deliveredSequence = delivered.sequence;
				entered.resolve();
				await release.promise;
			},
			BACKGROUND_CONTEXT,
		);
		feedRef = feed;
		const recording = record(lane, A);
		await entered.promise;
		expect(duringCallback).toBe(0);
		expect(feed.afterSequence).toBe(0);
		release.resolve();
		await recording;
		expect(feed.afterSequence).toBe(deliveredSequence);
		feed.unsubscribe();
	});

	it("rejects attachment on a catch-up listener failure, removes the listener, and stops before later rows", async () => {
		const fake = fakeSource([row(1), row(2), row(3)]);
		const delivered: number[] = [];
		const failure = new Error("consumer failed on 2");
		await expect(
			attachUsageFeedV0(
				fake.source,
				undefined,
				(next) => {
					if (next.sequence === 2) throw failure;
					delivered.push(next.sequence);
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toBe(failure);
		expect(delivered).toEqual([1]);
		expect(fake.removed).toHaveBeenCalledOnce();
		expect(fake.listenerCount()).toBe(0);
	});

	it("stops a live feed on listener failure without advancing past the failed row", async () => {
		const { harness, lane, source } = await fixture();
		const errors: string[] = [];
		harness.events.on("handler_error", (event) => {
			errors.push(event.error);
		});
		const delivered: Usage[] = [];
		const feed = await attachUsageFeedV0(
			source,
			undefined,
			(next) => {
				if (next.usage.input === B.input) throw new Error("consumer failed on B");
				delivered.push(next.usage);
			},
			BACKGROUND_CONTEXT,
		);
		await record(lane, A);
		const afterA = feed.afterSequence;
		await record(lane, B);
		await record(lane, C);
		expect(delivered).toEqual([A]);
		expect(feed.active).toBe(false);
		expect(feed.afterSequence).toBe(afterA);
		expect(errors).toEqual(["consumer failed on B"]);
	});

	it("unsubscribe is idempotent and stops future delivery", async () => {
		const { lane, source } = await fixture();
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		await record(lane, A);
		feed.unsubscribe();
		feed.unsubscribe();
		expect(feed.active).toBe(false);
		await record(lane, B);
		expect(seen.usages()).toEqual([A]);
	});

	it("removes the listener and propagates when a durable read fails during attachment", async () => {
		for (const failingCall of [0, 1]) {
			const fake = fakeSource([row(1), row(2)]);
			const failure = new Error(`scan ${failingCall} failed`);
			fake.onScan((call) => {
				if (call === failingCall) {
					expect(fake.listenerCount()).toBe(1);
					throw failure;
				}
			});
			await expect(attachUsageFeedV0(fake.source, undefined, () => {}, BACKGROUND_CONTEXT)).rejects.toBe(failure);
			expect(fake.removed).toHaveBeenCalledOnce();
			expect(fake.listenerCount()).toBe(0);
		}
	});

	it("propagates a closed harness event source without reading the ledger", async () => {
		const { harness, session } = await fixture();
		await harness.close(BACKGROUND_CONTEXT);
		const scanUsage = vi.fn(session.scanUsage.bind(session));
		await expect(
			attachUsageFeedV0({ events: harness.events, session: { scanUsage } }, undefined, () => {}, BACKGROUND_CONTEXT),
		).rejects.toBeInstanceOf(HarnessClosed);
		expect(scanUsage).not.toHaveBeenCalled();
	});

	it("propagates a closed session read and removes the live listener", async () => {
		const { session, harness } = await fixture();
		await session.close(BACKGROUND_CONTEXT);
		const remove = vi.fn();
		const events: Pick<Events, "on"> = {
			on: ((type: "usage", listener: EventListener<Extract<HarnessEvent, { type: "usage" }>>) => {
				const real = harness.events.on(type, listener);
				return () => {
					remove();
					real();
				};
			}) as Events["on"],
		};
		await expect(attachUsageFeedV0({ events, session }, undefined, () => {}, BACKGROUND_CONTEXT)).rejects.toThrow(
			"Session is closed",
		);
		expect(remove).toHaveBeenCalledOnce();
	});

	it("rejects malformed cursors and page sizes before subscribing", async () => {
		const fake = fakeSource();
		const on = vi.spyOn(fake.source.events, "on");
		for (const afterSequence of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				attachUsageFeedV0(fake.source, { afterSequence }, () => {}, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(RangeError);
		}
		for (const pageSize of [0, -1, 1.5, Number.NaN, 10_001]) {
			await expect(
				attachUsageFeedV0(fake.source, { pageSize }, () => {}, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(RangeError);
		}
		expect(on).not.toHaveBeenCalled();
		expect(fake.calls).toEqual([]);
	});

	it("depends only on events.on and session.scanUsage: no watchSession, lanes, watch, or stats", async () => {
		const { session, harness, lane, source } = await fixture();
		const watchSession = vi.spyOn(harness, "watchSession");
		const lanes = vi.spyOn(harness, "lanes");
		const watch = vi.spyOn(lane, "watch");
		const getStats = vi.spyOn(session, "getStats");
		await record(lane, A);
		const seen = collector();
		const feed = await attachUsageFeedV0(source, undefined, seen.listener, BACKGROUND_CONTEXT);
		await record(lane, B);
		expect(seen.usages()).toEqual([A, B]);
		expect(watchSession).not.toHaveBeenCalled();
		expect(lanes).not.toHaveBeenCalled();
		expect(watch).not.toHaveBeenCalled();
		expect(getStats).not.toHaveBeenCalled();
		feed.unsubscribe();

		const fake = fakeSource([row(3)]);
		const fakeSeen = collector();
		const fakeFeed = await attachUsageFeedV0(fake.source, undefined, fakeSeen.listener, BACKGROUND_CONTEXT);
		await fake.commit(row(8));
		expect(fakeSeen.rows.map(({ sequence }) => sequence)).toEqual([3, 8]);
		fakeFeed.unsubscribe();
		expect(fake.listenerCount()).toBe(0);
	});

	it("resumes across a reconnect from a persisted cursor, and redelivers rows past an unpersisted cursor", async () => {
		const { lane, source } = await fixture();
		const first = collector();
		const firstFeed = await attachUsageFeedV0(source, undefined, first.listener, BACKGROUND_CONTEXT);
		await record(lane, A);
		const persisted = firstFeed.afterSequence;
		await record(lane, B);
		// B was applied, but its cursor was never persisted before disconnecting.
		expect(first.usages()).toEqual([A, B]);
		firstFeed.unsubscribe();
		await record(lane, C);

		const second = collector();
		const secondFeed = await attachUsageFeedV0(
			source,
			{ afterSequence: persisted },
			second.listener,
			BACKGROUND_CONTEXT,
		);
		await record(lane, D);
		// At-least-once across reconnects: B is correctly delivered again because its cursor was not persisted.
		expect(second.usages()).toEqual([B, C, D]);
		expect(new Set(second.rows.map(({ id }) => id)).size).toBe(3);
		secondFeed.unsubscribe();
	});
});
