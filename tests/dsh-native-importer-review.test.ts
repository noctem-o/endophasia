// SYNTHETIC adversaries derived from the study's sanitised runtime fixtures. No active DSH session is read or changed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type DshSessionHeader,
	dshEndoSessionIdV0,
	importDshSessionBytesV0,
	projectDshTrajectoryV0,
	readDshLog,
} from "../adapters/dsh-native/index.ts";
import { encodeRaw, forkChild } from "../research/dsh-native/synthetic.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

const fixtures = fileURLToPath(new URL("../research/dsh-native/fixtures/real/", import.meta.url));
const read = readDshLog(readFileSync(`${fixtures}tool-read.events.jsonl`));
const header = read.header!;
const rows = read.events;
const options = {
	digestKey: endoDigestKeyV0(Buffer.alloc(32, 0x61), "review-test"),
	now: () => "2026-10-23T00:00:00Z",
};
const store = () => createEndoEventStoreV0();
type Store = ReturnType<typeof store>;
const all = (target: Store) => target.page({ limit: 10000 }).events;
const importBytes = (target: Store, bytes: Uint8Array) => importDshSessionBytesV0(bytes, target, options);
const encodeHeader = (value: unknown) =>
	Buffer.from(`${[value, ...rows].map((row) => JSON.stringify(row)).join("\n")}\n`);

describe("complete pinned header validation before import", () => {
	it.each([
		["nonboolean isSeeded", { isSeeded: 1 }],
		["missing isSeeded", { isSeeded: undefined }],
		["missing createdAt", { createdAt: undefined }],
		["fractional createdAt", { createdAt: 0.5 }],
		["negative createdAt", { createdAt: -1 }],
		["unsafe createdAt", { createdAt: Number.MAX_SAFE_INTEGER + 1 }],
		["null createdAt", { createdAt: null }],
		["missing depth", { delegationDepth: undefined }],
		["fractional depth", { delegationDepth: 0.5 }],
		["negative depth", { delegationDepth: -1 }],
		["unsafe depth", { delegationDepth: Number.MAX_SAFE_INTEGER + 1 }],
		["string depth", { delegationDepth: "0" }],
		["empty id", { id: "" }],
		["numeric id", { id: 2 }],
		["relative cwd", { cwd: "private/workspace" }],
		["numeric cwd", { cwd: 2 }],
		["nonstring parent", { parentSession: 2 }],
		["unknown origin", { origin: "agent" }],
		["nonstring preset", { agentPreset: {} }],
		["retired policy", { approvalPolicy: "always" }],
		["unknown header key", { unknown: true }],
	] as const)("refuses %s without appending", (_name, change) => {
		for (const populated of [false, true]) {
			const target = store();
			if (populated) expect(importBytes(target, encodeRaw(header, rows)).status).toBe("imported");
			const before = canonicalEndoJsonV0(all(target));
			const result = importBytes(target, encodeHeader({ ...header, ...change }));
			expect(result.status).toBe("refused");
			expect(result.refusals.map((item) => item.code)).toContain("invalid-log");
			expect(canonicalEndoJsonV0(all(target))).toBe(before);
		}
	});
	it.each(["createdAt", "delegationDepth"])("refuses encoded negative-zero %s", (field) => {
		const bytes = encodeHeader({ ...header, [field]: 0 })
			.toString("utf8")
			.replace(`"${field}":0`, `"${field}":-0`);
		const target = store();
		expect(importBytes(target, Buffer.from(bytes)).status).toBe("refused");
		expect(all(target)).toEqual([]);
	});
	it("refuses truthy seeded metadata even with a valid inherited marker", () => {
		const child = forkChild(header, rows, 9, rows.slice(9, 14));
		const target = store();
		const invalid = { ...child.header, isSeeded: 1 } as unknown as DshSessionHeader;
		expect(importBytes(target, encodeRaw(invalid, child.events)).status).toBe("refused");
		expect(all(target)).toEqual([]);
	});
	it("accepts zero boundaries, absent optional fields and valid optional metadata", () => {
		const { cwd: _cwd, ...required } = header;
		for (const metadata of [
			{ ...required, createdAt: 0, delegationDepth: 0 },
			{ ...header, origin: "subagent" as const, parentSession: "parent", agentPreset: "preset" },
		])
			expect(importBytes(store(), encodeRaw(metadata, rows)).status).toBe("imported");
	});
});

describe("session selectors have an explicit interpretation", () => {
	it.each(["session-1", "endo.session.pi.other", "endo.session.dsh."])(
		"refuses invalid explicit coordinate %s",
		(session) => {
			expect(() => projectDshTrajectoryV0([], { session, sessionKind: "endo-coordinate", store: "test" })).toThrow(
				/coordinate/,
			);
		},
	);
	it("does not fall back from an absent raw ID to a coordinate that happens to exist", () => {
		const target = store();
		importBytes(target, encodeRaw({ ...header, id: "foo" }, rows));
		expect(() => projectDshTrajectoryV0(all(target), { session: "endo.session.dsh.foo", store: "test" })).toThrow(
			/no DSH session/,
		);
	});
	it.each(["session-1", "endo.session.foo", "endo.session.dsh.foo", "a b/c", "sha256-lookalike"])(
		"projects raw id %s and its explicitly selected coordinate identically",
		(id) => {
			const target = store();
			expect(importBytes(target, encodeRaw({ ...header, id }, rows)).status).toBe("imported");
			const raw = projectDshTrajectoryV0(all(target), { session: id, store: "test" });
			const coordinate = projectDshTrajectoryV0(all(target), {
				session: dshEndoSessionIdV0(id),
				sessionKind: "endo-coordinate",
				store: "test",
			});
			expect(raw.source.session).toBe(dshEndoSessionIdV0(id));
			expect(coordinate.digest).toBe(raw.digest);
		},
	);
	it("does not choose another imported session when a raw id looks exactly like its coordinate", () => {
		const target = store();
		for (const id of ["foo", "endo.session.dsh.foo"]) importBytes(target, encodeRaw({ ...header, id }, rows));
		expect(
			projectDshTrajectoryV0(all(target), { session: "endo.session.dsh.foo", store: "test" }).source.session,
		).toBe(dshEndoSessionIdV0("endo.session.dsh.foo"));
		expect(
			projectDshTrajectoryV0(all(target), {
				session: "endo.session.dsh.foo",
				sessionKind: "endo-coordinate",
				store: "test",
			}).source.session,
		).toBe(dshEndoSessionIdV0("foo"));
	});
});

describe("source identity is not silently substituted or copied as a path", () => {
	it.each(["/private/PRIVATE-ID/session", "C:\\Users\\PRIVATE-ID\\session", "PRIVATE-ID with spaces"])(
		"withholds unsafe raw identifier %s while keeping its stable coordinate",
		(id) => {
			const target = store();
			const result = importBytes(target, encodeRaw({ ...header, id }, rows));
			expect(result.status).toBe("imported");
			expect(result.session).toBe(dshEndoSessionIdV0(id));
			const projected = projectDshTrajectoryV0(all(target), { session: id, store: "test" });
			expect(projected.source.runtimeSessionId).toMatchObject({
				status: "UNAVAILABLE",
				reason: expect.stringMatching(/withheld/),
			});
			for (const text of [JSON.stringify(all(target)), JSON.stringify(projected), JSON.stringify(result)])
				expect(text).not.toContain("PRIVATE-ID");
		},
	);
});

describe("open outcomes preserve measured progress", () => {
	it.each([0, 1, 2])("reports %i started steps on an open run", (count) => {
		const starts = rows.flatMap((row, index) => (row.type === "step/start" ? [index] : []));
		const end =
			count === 0 ? starts[0]! : count === 1 ? starts[1]! : rows.findIndex((row) => row.type === "turn/end");
		const target = store();
		expect(importBytes(target, encodeRaw(header, rows.slice(0, end))).status).toBe("imported");
		const t = projectDshTrajectoryV0(all(target), { session: header.id, store: "test" });
		expect(t.layers.outcome).toMatchObject({ status: "reported", entries: [{ outcome: "open", turns: count }] });
	});
	it("resets the count after a closed run instead of counting earlier turns again", () => {
		const recovered = readDshLog(readFileSync(`${fixtures}crash-resumed.events.jsonl`));
		const target = store();
		expect(importBytes(target, encodeRaw(recovered.header!, recovered.events.slice(0, -1))).status).toBe("imported");
		const t = projectDshTrajectoryV0(all(target), { session: header.id, store: "test" });
		expect(t.layers.outcome).toMatchObject({
			status: "reported",
			entries: [
				{ outcome: "unclassified", turns: 1 },
				{ outcome: "open", turns: 1 },
			],
		});
	});
});

describe("a partial seeded import commits to its fork cut", () => {
	it.each([false, true])("header-only retry with changed cut=%s", (changed) => {
		const first = forkChild(header, rows, 9, rows.slice(9, 14));
		const later = changed ? forkChild(header, rows, 10, rows.slice(10, 14)) : first;
		const full = store();
		expect(importBytes(full, encodeRaw(first.header, first.events)).status).toBe("imported");
		const target = store();
		target.ingest(all(full).find((event) => event.kind === "dsh.session-imported")!);
		const before = canonicalEndoJsonV0(all(target));
		const result = importBytes(target, encodeRaw(later.header, later.events));
		if (changed) {
			expect(result.status).toBe("refused");
			expect(result.refusals.map((item) => item.code)).toContain("history-changed");
			expect(canonicalEndoJsonV0(all(target))).toBe(before);
		} else {
			expect(result.status).toBe("imported");
			expect(importBytes(target, encodeRaw(first.header, first.events)).status).toBe("unchanged");
		}
	});
});

describe("content kind counts are safe for arbitrary classification tokens", () => {
	it.each(["constructor", "toString", "__proto__"])("preserves numeric %s counts through import", (type) => {
		const changed = rows.map((row) => {
			if (row.type !== "assistant/message") return row;
			const data = row.data as Record<string, unknown>;
			return { ...row, data: { ...data, message: { ...(data.message as object), content: [{ type }, { type }] } } };
		});
		const target = store();
		expect(importBytes(target, encodeRaw(header, changed)).status).toBe("imported");
		for (const row of all(target).filter((event) => event.kind === "dsh.assistant-recorded")) {
			const payload = row.payload as { blocks: Record<string, number> };
			expect(payload.blocks[type]).toBe(2);
			expect(JSON.parse(JSON.stringify(payload.blocks))[type]).toBe(2);
		}
	});
});
