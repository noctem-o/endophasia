// The v2 loss accounting is data, versioned and tied to the v2 mapping and the vendored baseline; these tests make it
// impossible to add a translated ACP v2 semantic, an event kind, or a read field without saying what it loses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACP_LOSS_VERDICTS_V0,
	ACP_SCHEMA_V2,
	ACP_V2_BASELINE_UPDATE_VARIANTS_V0,
	ACP_V2_FIELDS_READ_V0,
	ACP_V2_LOSS_ACCOUNTING_V0,
	ACP_V2_LOSS_ACCOUNTING_VERSION_V0,
	ACP_V2_MAPPING_VERSION,
	ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0,
	acpV2LossEntryV0,
	acpV2UnprojectedFieldsV0,
	readAcpBaselineSchemaV2,
} from "../adapters/acp/v2.ts";

const root = join(import.meta.dirname, "..");
const source = (file: string) => readFileSync(join(root, "adapters", "acp", file), "utf8");
const entries = ACP_V2_LOSS_ACCOUNTING_V0.entries;
const emitted = new Set(entries.flatMap((entry) => entry.emits));

describe("ACP v2 loss accounting", () => {
	it("is versioned, Draft, and tied to this mapping and the pinned schema revision", () => {
		expect(ACP_V2_LOSS_ACCOUNTING_V0.schemaVersion).toBe(ACP_V2_LOSS_ACCOUNTING_VERSION_V0);
		expect(ACP_V2_LOSS_ACCOUNTING_V0.mapping).toBe(ACP_V2_MAPPING_VERSION);
		expect(ACP_V2_LOSS_ACCOUNTING_V0.acpSchema).toEqual(ACP_SCHEMA_V2);
		expect(ACP_V2_LOSS_ACCOUNTING_V0.status).toBe("Draft");
		expect(ACP_V2_MAPPING_VERSION).toBe("acp-v2-mapping.0");
	});

	it("uses exactly the four verdicts, each defined, and no entry outside them", () => {
		expect(Object.keys(ACP_V2_LOSS_ACCOUNTING_V0.verdicts)).toEqual([...ACP_LOSS_VERDICTS_V0]);
		for (const entry of entries) expect(ACP_LOSS_VERDICTS_V0, entry.id).toContain(entry.verdict);
	});

	it("has unique ids and says what each non-EXACT verdict means for the reader", () => {
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		for (const entry of entries) {
			if (entry.verdict === "EXACT") expect(entry.preserved.length, entry.id).toBeGreaterThan(0);
			else expect(Boolean(entry.qualification) || entry.lost.length > 0, entry.id).toBe(true);
			if (entry.verdict === "QUALIFIED") expect(entry.qualification, entry.id).toBeTruthy();
			if (entry.verdict === "UNREPRESENTABLE") {
				expect(entry.emits, entry.id).toEqual([]);
				expect(entry.qualification, entry.id).toBeTruthy();
			}
		}
	});

	it("has exactly one entry for every baseline update variant, and none that treats an unstable variant as translated", () => {
		for (const variant of ACP_V2_BASELINE_UPDATE_VARIANTS_V0)
			expect(
				entries.filter((entry) => entry.source === `session/update:${variant}`),
				variant,
			).toHaveLength(1);
		for (const variant of ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0)
			expect(
				entries.some((entry) => entry.source === `session/update:${variant}`),
				variant,
			).toBe(false);
		expect(acpV2LossEntryV0("update.unrecognized")?.verdict).toBe("LOSSY");
		expect(acpV2LossEntryV0("update.malformed")?.verdict).toBe("LOSSY");
	});

	it("covers every event kind the v2 sources can emit, and no kind they cannot", () => {
		const kinds = new Set<string>();
		for (const file of ["client-v2.ts", "translate-v2.ts"]) {
			const text = source(file);
			for (const match of text.matchAll(/\.(?:record|derive)\(\s*"([a-z.-]+)"/g)) kinds.add(match[1] as string);
			for (const match of text.matchAll(/\.(?:record|derive)\(\s*\n?\s*"([a-z.-]+)"/g))
				kinds.add(match[1] as string);
			for (const match of text.matchAll(/eventKind: "([a-z.-]+)"/g)) kinds.add(match[1] as string);
			for (const match of text.matchAll(/"(lifecycle\\.[a-z]+(?:-[a-z]+)*)"/g)) kinds.add(match[1] as string);
		}
		// Chosen by lifecycleEndForStopReasonV0 (shared with v1: the same stop-reason table), not named in v2 source.
		for (const shared of ["lifecycle.run-completed", "lifecycle.run-aborted"]) kinds.add(shared);
		expect([...kinds].filter((kind) => !emitted.has(kind)).sort()).toEqual([]);
		expect([...emitted].filter((kind) => !kinds.has(kind)).sort()).toEqual([]);
	});

	it("keeps the semantics the brief names at their honest level", () => {
		const verdict = (id: string) => acpV2LossEntryV0(id)?.verdict;
		// Acceptance is not completion: qualified, with the words that say so.
		expect(verdict("prompt.accepted")).toBe("QUALIFIED");
		expect(acpV2LossEntryV0("prompt.accepted")?.qualification).toMatch(/NOT completion/);
		expect(acpV2LossEntryV0("prompt.accepted")?.emits).not.toEqual(expect.arrayContaining(["lifecycle.run-started"]));
		expect(verdict("run.lifecycle")).toBe("QUALIFIED");
		// A state_update has no message id: attribution is not representable.
		expect(verdict("run.attribution")).toBe("UNREPRESENTABLE");
		expect(verdict("conversation.reconstruction")).toBe("QUALIFIED");
		expect(verdict("replay.equivalence")).toBe("QUALIFIED");
		// Permission subjects: tool_call and command are lossy, anything not understood is not represented, never approved.
		expect(verdict("permission.subject.tool_call")).toBe("LOSSY");
		expect(verdict("permission.subject.command")).toBe("LOSSY");
		expect(verdict("permission.subject.unrecognized")).toBe("UNREPRESENTABLE");
		expect(verdict("permission.subject.malformed")).toBe("UNREPRESENTABLE");
		expect(acpV2LossEntryV0("permission.subject.command")?.qualification).toMatch(/never executes/);
		expect(verdict("permission.outcome-cancelled")).toBe("QUALIFIED");
		// Terminals are display-only and nothing of them is kept.
		expect(verdict("update.terminal_update")).toBe("LOSSY");
		expect(verdict("update.agent_message_chunk")).toBe("LOSSY");
		expect(verdict("update.usage_update")).toBe("QUALIFIED");
		expect(verdict("process.exit")).toBe("EXACT");
	});

	it("keeps the Windows process-containment qualification", () => {
		expect(acpV2LossEntryV0("process.containment")?.qualification).toMatch(/Windows.*no job-object containment/);
	});

	it("is documented: every entry id and the pins appear in docs/acp-v2-study.md", () => {
		const doc = readFileSync(join(root, "docs", "acp-v2-study.md"), "utf8");
		for (const entry of entries) expect(doc, entry.id).toContain(`| \`${entry.id}\` | ${entry.verdict} |`);
		for (const pin of [
			ACP_SCHEMA_V2.baseline.sha256,
			ACP_SCHEMA_V2.sdkUnstable.sha256,
			ACP_SCHEMA_V2.upstream.commit,
			ACP_V2_MAPPING_VERSION,
			ACP_SCHEMA_V2.packageVersion,
		])
			expect(doc, pin).toContain(pin);
		for (const item of ACP_V2_LOSS_ACCOUNTING_V0.unsupported) expect(doc, item.id).toContain(item.id);
	});

	it("is deeply frozen, so a caller cannot change a verdict globally", () => {
		const entry = acpV2LossEntryV0("run.attribution")!;
		expect(Object.isFrozen(entry)).toBe(true);
		expect(Object.isFrozen(entry.emits)).toBe(true);
		expect(() => {
			(entry as { verdict: string }).verdict = "EXACT";
		}).toThrow();
		expect(acpV2LossEntryV0("run.attribution")?.verdict).toBe("UNREPRESENTABLE");
	});

	it("accounts for every baseline property it does not project, by construction", () => {
		const defs = readAcpBaselineSchemaV2().document.$defs as unknown as Record<
			string,
			{ properties?: Record<string, unknown> }
		>;
		for (const entry of entries) {
			for (const [definition, carried] of Object.entries(entry.projects ?? {})) {
				expect(defs[definition], `${entry.id}: ${definition}`).toBeDefined();
				for (const property of carried)
					expect(ACP_V2_FIELDS_READ_V0[definition] ?? [], `${entry.id}: ${definition}.${property}`).toContain(
						property,
					);
				for (const property of Object.keys(defs[definition]!.properties ?? {})) {
					if (property === "_meta" || carried.includes(property)) continue;
					expect(entry.lost, entry.id).toContain(`${definition}.${property}`);
				}
			}
		}
		// Every definition the client reads is accounted for by some entry, so a new read cannot go unlisted.
		const projected = new Set(entries.flatMap((entry) => Object.keys(entry.projects ?? {})));
		expect(Object.keys(ACP_V2_FIELDS_READ_V0).filter((definition) => !projected.has(definition))).toEqual([]);
		expect(acpV2UnprojectedFieldsV0({ projects: { Cost: ["amount"] } })).toEqual(["Cost.currency"]);
		// The cases that are v2-specific and easy to carry over from v1 by mistake.
		expect(acpV2LossEntryV0("permission.request")?.lost).toEqual(
			expect.arrayContaining(["RequestPermissionRequest.title", "PermissionOption.name"]),
		);
		expect(acpV2LossEntryV0("update.tool_call_update")?.lost).toContain("ToolCallUpdate.title");
		expect(acpV2LossEntryV0("update.config_option_update")?.projects?.SessionConfigOption).toContain("configId");
		expect(acpV2LossEntryV0("negotiation.initialize")?.projects?.AuthMethodAgent).toEqual(["methodId"]);
	});

	it("declares what session/list hands the caller but the durable record omits", () => {
		const entry = acpV2LossEntryV0("session.list")!;
		for (const item of [
			"session ids",
			"working directories",
			"additional directories",
			"titles",
			"update times",
			"the cursor",
		])
			expect(entry.lost).toContain(item);
		expect(entry.returnedToCaller).toHaveLength(6);
	});
});
