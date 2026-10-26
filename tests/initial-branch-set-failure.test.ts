// Failure injection stays in this isolated test module and operates on synthetic fixture directories only.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareVerifiedInitialBranchPairV0, readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import { verifiedInitialCheckpointFixtureV0 } from "./fixtures/verified-initial-checkpoint.ts";

const fault = vi.hoisted(() => ({
	mode: "none",
	count: 0,
	source: "",
	target: "",
	originalArea: "",
	published: false,
}));
vi.mock("../cli/checkpoint-materialization.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../cli/checkpoint-materialization.ts")>();
	const fs = await import("node:fs");
	const path = await import("node:path");
	return {
		...original,
		materializeVerifiedInitialCheckpointV0(
			...args: Parameters<typeof original.materializeVerifiedInitialCheckpointV0>
		) {
			fault.count++;
			if (fault.mode === "second-child" && fault.count === 2)
				return { status: "refused", reason: "materialization-failed" };
			if (fault.mode === "first-child") return { status: "refused", reason: "materialization-failed" };
			const result = original.materializeVerifiedInitialCheckpointV0(...args);
			if (fault.count === 2 && fault.mode === "parent-mutation")
				fs.appendFileSync(path.join(fault.source, "capture", "events", "events.log"), Buffer.from([1]));
			if (fault.count === 1 && fault.mode === "area-substitution") {
				fault.originalArea = `${args[3]}-original`;
				fs.renameSync(args[3], fault.originalArea);
				fs.symlinkSync(fault.target, args[3]);
			}
			return result;
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const path = await import("node:path");
	return {
		...fs,
		linkSync(existing: string, target: string) {
			if (target.endsWith("/branch-set.json")) {
				if (fault.mode === "publication") throw new Error("synthetic publication refusal");
				fs.linkSync(existing, target);
				fault.published = true;
				if (fault.mode === "final-parent")
					fs.appendFileSync(path.join(fault.source, "capture", "events", "events.log"), Buffer.from([1]));
				if (fault.mode === "final-child") {
					const m = JSON.parse(fs.readFileSync(target, "utf8"));
					fs.writeFileSync(
						path.join(path.dirname(target), m.children.alternative.directory, "work", "endophasia-study.txt"),
						"changed before final pass",
					);
				}
				return;
			}
			fs.linkSync(existing, target);
		},
	};
});
let fixture: Awaited<ReturnType<typeof verifiedInitialCheckpointFixtureV0>>;
beforeAll(async () => {
	fixture = await verifiedInitialCheckpointFixtureV0();
}, 120_000);
afterAll(() => {
	fault.mode = "none";
	fixture?.pi.remove();
	if (fixture) rmSync(fixture.base, { recursive: true, force: true });
});
const baseline = { id: "baseline", description: "original" };
const alternative = { id: "alternative", description: "planned", settings: { thinkingLevel: "high" } };

describe("sibling preparation publication and cleanup", () => {
	it.each(["first-child", "second-child", "parent-mutation", "publication", "final-parent", "final-child"])(
		"refuses %s without leaving a committed set or deleting unrelated state",
		(mode) => {
			const parent = mkdtempSync(join(fixture.base, "output-"));
			const sentinel = join(parent, "unrelated.txt");
			writeFileSync(sentinel, "keep me");
			const source = join(mkdtempSync(join(fixture.base, "source-copy-")), "source");
			cpSync(fixture.source, source, { recursive: true });
			fault.count = 0;
			fault.mode = mode;
			fault.source = source;
			fault.published = false;
			try {
				const result = prepareVerifiedInitialBranchPairV0(
					source,
					fixture.replay,
					fixture.key,
					parent,
					baseline,
					alternative,
				);
				expect(result.status).toBe("refused");
				expect(result).not.toHaveProperty("children");
				expect(readdirSync(parent)).toEqual(["unrelated.txt"]);
				expect(readFileSync(sentinel, "utf8")).toBe("keep me");
				if (mode.startsWith("final")) expect(fault.published).toBe(true);
				if (mode === "publication") expect(fault.published).toBe(false);
			} finally {
				fault.mode = "none";
			}
		},
	);
	it("retains substituted staging for inspection and never follows it during cleanup", () => {
		const parent = mkdtempSync(join(fixture.base, "output-"));
		const target = mkdtempSync(join(fixture.base, "unrelated-target-"));
		mkdirSync(join(target, "nested"));
		writeFileSync(join(target, "nested", "sentinel"), "keep target");
		fault.count = 0;
		fault.mode = "area-substitution";
		fault.target = target;
		try {
			const result = prepareVerifiedInitialBranchPairV0(
				fixture.source,
				fixture.replay,
				fixture.key,
				parent,
				baseline,
				alternative,
			);
			expect(result).toMatchObject({ status: "refused", reason: "cleanup-unsafe" });
			if (result.status !== "refused") return;
			expect(result.retainedPaths?.length).toBe(1);
			expect(existsSync(fault.originalArea)).toBe(true);
			expect(readFileSync(join(target, "nested", "sentinel"), "utf8")).toBe("keep target");
			expect(readdirSync(target)).toEqual(["nested"]);
			expect(
				readVerifiedInitialBranchSetV0(
					fixture.source,
					fixture.replay,
					fixture.key,
					parent,
					result.retainedPaths![0]!.split("/").at(-1)!,
				).status,
			).toBe("refused");
		} finally {
			fault.mode = "none";
		}
	});
});
