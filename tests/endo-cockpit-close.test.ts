// The reader closes the durable event store on every path out of a read, including a failure after it opened. The store is
// wrapped, not replaced: reads still go through the real read-only open.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";

const seen = vi.hoisted(() => ({ opened: 0, closed: 0, failPage: false, options: [] as unknown[] }));

vi.mock("../storage/event-store.ts", async (importActual) => {
	const actual = await importActual<typeof import("../storage/event-store.ts")>();
	return {
		...actual,
		createEndoDurableEventStoreV0: (root: string, options?: { readOnly?: boolean }) => {
			const store = actual.createEndoDurableEventStoreV0(root, options);
			seen.opened += 1;
			seen.options.push(options);
			return new Proxy(store, {
				get(target, property) {
					if (property === "close")
						return () => {
							seen.closed += 1;
							target.close();
						};
					if (property === "page" && seen.failPage)
						return () => {
							throw new Error("page failed after the store opened");
						};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as EndoDurableEventStoreV0;
		},
	};
});

import { checkEndoCockpitSourceFreshnessV0, readEndoCockpitEventLogV0 } from "../cockpit/reader.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

describe("resource handling", () => {
	it("opens read-only and closes after a successful read", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		seen.opened = 0;
		seen.closed = 0;
		seen.options.length = 0;
		readEndoCockpitEventLogV0(root);
		expect(seen).toMatchObject({ opened: 1, closed: 1 });
		expect(seen.options).toEqual([{ readOnly: true }]);
	});

	it("closes when a read fails after the store opened", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		seen.opened = 0;
		seen.closed = 0;
		seen.failPage = true;
		try {
			expect(() => readEndoCockpitEventLogV0(root)).toThrow("page failed after the store opened");
			expect(seen).toMatchObject({ opened: 1, closed: 1 });
		} finally {
			seen.failPage = false;
		}
	});

	it("closes after the freshness check, which opens the log more than once", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started"), event("tool.finished")]);
		const source = readEndoCockpitEventLogV0(root).source;
		seen.opened = 0;
		seen.closed = 0;
		expect(checkEndoCockpitSourceFreshnessV0(root, source)).toBe("unchanged");
		expect(seen.opened).toBeGreaterThan(0);
		expect(seen.closed).toBe(seen.opened);
	});
});
