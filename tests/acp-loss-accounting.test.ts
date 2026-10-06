// The loss accounting is data, versioned and tied to the mapping and the pinned schema; these tests make it
// impossible to add a translated ACP semantic, an event kind, or an optional method without saying what it loses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACP_FIELDS_READ_V0,
	ACP_LOSS_ACCOUNTING_V0,
	ACP_LOSS_ACCOUNTING_VERSION_V0,
	ACP_LOSS_VERDICTS_V0,
	ACP_MAPPING_VERSION,
	ACP_SCHEMA_V0,
	ACP_STABLE_UPDATE_VARIANTS_V0,
	ACP_UNSTABLE_UPDATE_VARIANTS_V0,
	acpLossEntryV0,
	acpUnprojectedFieldsV0,
	readAcpSchemaV0,
} from "../adapters/acp/index.ts";

const adapter = (file: string) => readFileSync(join(import.meta.dirname, "..", "adapters", "acp", file), "utf8");
const entries = ACP_LOSS_ACCOUNTING_V0.entries;
const emitted = new Set(entries.flatMap((entry) => entry.emits));

describe("ACP v1 loss accounting", () => {
	it("is versioned and tied to this mapping and the pinned schema revision", () => {
		expect(ACP_LOSS_ACCOUNTING_V0.schemaVersion).toBe(ACP_LOSS_ACCOUNTING_VERSION_V0);
		expect(ACP_LOSS_ACCOUNTING_V0.mapping).toBe(ACP_MAPPING_VERSION);
		expect(ACP_LOSS_ACCOUNTING_V0.acpSchema).toEqual(ACP_SCHEMA_V0);
		expect(ACP_MAPPING_VERSION).toBe("acp-v1-mapping.2");
	});

	it("uses exactly the four verdicts, each defined, and no entry outside them", () => {
		expect([...ACP_LOSS_VERDICTS_V0]).toEqual(["EXACT", "QUALIFIED", "LOSSY", "UNREPRESENTABLE"]);
		expect(Object.keys(ACP_LOSS_ACCOUNTING_V0.verdicts)).toEqual([...ACP_LOSS_VERDICTS_V0]);
		for (const entry of entries) expect(ACP_LOSS_VERDICTS_V0, entry.id).toContain(entry.verdict);
	});

	it("has unique ids and says what each non-EXACT verdict means for the reader", () => {
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		for (const entry of entries) {
			if (entry.verdict === "EXACT") expect(entry.preserved.length, entry.id).toBeGreaterThan(0);
			else expect(Boolean(entry.qualification) || entry.lost.length > 0, entry.id).toBe(true);
			if (entry.verdict === "QUALIFIED") expect(entry.qualification, entry.id).toBeTruthy();
			// Nothing is emitted for what cannot be represented.
			if (entry.verdict === "UNREPRESENTABLE") {
				expect(entry.emits, entry.id).toEqual([]);
				expect(entry.qualification, entry.id).toBeTruthy();
			}
		}
	});

	it("has a verdict for every stable update variant, and treats unstable and unknown ones as their own cases", () => {
		for (const variant of ACP_STABLE_UPDATE_VARIANTS_V0)
			expect(
				entries.filter((entry) => entry.source === `session/update:${variant}`),
				variant,
			).toHaveLength(1);
		expect(acpLossEntryV0("update.unstable")).toBeDefined();
		expect(acpLossEntryV0("update.unknown")).toBeDefined();
		expect(acpLossEntryV0("update.malformed")).toBeDefined();
		// Nothing claims an unstable variant is translated.
		for (const variant of ACP_UNSTABLE_UPDATE_VARIANTS_V0)
			expect(
				entries.some((entry) => entry.source === `session/update:${variant}`),
				variant,
			).toBe(false);
	});

	it("covers every event kind the adapter source can emit, and no kind it cannot", () => {
		const kinds = new Set<string>();
		// `record("<kind>"`, `derive("<kind>"`, `eventKind: "<kind>"`, and every `"lifecycle.<kind>"` literal. (Capability names such
		// as "session.cancel" are not event kinds and are not matched.)
		for (const file of ["client.ts", "translate.ts"]) {
			const source = adapter(file);
			for (const match of source.matchAll(/\.(?:record|derive)\(\s*"([a-z.-]+)"/g)) kinds.add(match[1] as string);
			for (const match of source.matchAll(/eventKind: "([a-z.-]+)"/g)) kinds.add(match[1] as string);
			for (const match of source.matchAll(/"(lifecycle\.[a-z]+(?:-[a-z]+)*)"/g)) kinds.add(match[1] as string);
		}
		expect([...kinds].filter((kind) => !emitted.has(kind)).sort()).toEqual([]);
		expect([...emitted].filter((kind) => !kinds.has(kind)).sort()).toEqual([]);
	});

	it("covers every optional session method with its capability gate, apart from the conversion verdict", () => {
		for (const [id, capability] of [
			["session.list", "agentCapabilities.sessionCapabilities.list"],
			["session.open.resume", "agentCapabilities.sessionCapabilities.resume"],
			["session.close", "agentCapabilities.sessionCapabilities.close"],
		] as const)
			expect(acpLossEntryV0(id)?.availability, id).toEqual({ kind: "capability-gated", capability });
		// Availability and loss are different facts: a baseline method can still be lossy.
		expect(acpLossEntryV0("permission.request")?.availability.kind).toBe("agent-initiated");
		expect(acpLossEntryV0("permission.request")?.verdict).toBe("LOSSY");
	});

	it("keeps the semantics the brief names at their honest level", () => {
		const verdict = (id: string) => acpLossEntryV0(id)?.verdict;
		expect(verdict("usage.ledger")).toBe("UNREPRESENTABLE");
		expect(verdict("usage.context-window")).toBe("QUALIFIED");
		expect(verdict("tool.contract")).toBe("UNREPRESENTABLE");
		expect(verdict("config.model-identity")).toBe("UNREPRESENTABLE");
		expect(verdict("reasoning.content")).toBe("UNREPRESENTABLE");
		expect(verdict("update.agent_message_chunk")).toBe("LOSSY");
		expect(verdict("process.exit")).toBe("EXACT");
	});

	it("keeps the Windows process-containment qualification", () => {
		const entry = acpLossEntryV0("process.containment");
		expect(entry?.verdict).toBe("QUALIFIED");
		expect(entry?.qualification).toMatch(/Windows.*no job-object containment/);
	});

	it("is documented: every entry id and the schema digest appear in docs/acp-v1-slice.md", () => {
		const doc = readFileSync(join(import.meta.dirname, "..", "docs", "acp-v1-slice.md"), "utf8");
		for (const entry of entries) expect(doc, entry.id).toContain(`| \`${entry.id}\` | ${entry.verdict} |`);
		expect(doc).toContain(ACP_SCHEMA_V0.sha256);
		expect(doc).toContain(ACP_MAPPING_VERSION);
	});

	it("is deeply frozen, so a caller cannot change a verdict globally", () => {
		const entry = acpLossEntryV0("usage.ledger")!;
		expect(Object.isFrozen(entry)).toBe(true);
		expect(Object.isFrozen(entry.emits)).toBe(true);
		expect(Object.isFrozen(entry.availability)).toBe(true);
		expect(() => {
			(entry as { verdict: string }).verdict = "EXACT";
		}).toThrow();
		expect(acpLossEntryV0("usage.ledger")?.verdict).toBe("UNREPRESENTABLE");
	});

	it("does not call optional observations baseline", () => {
		expect(acpLossEntryV0("config.observation")?.availability.kind).toBe("agent-initiated");
	});

	it("accounts for every schema property it does not project, by construction", () => {
		const defs = readAcpSchemaV0().document.$defs as unknown as Record<
			string,
			{ properties?: Record<string, unknown> }
		>;
		for (const entry of entries) {
			for (const [definition, carried] of Object.entries(entry.projects ?? {})) {
				expect(defs[definition], `${entry.id}: ${definition}`).toBeDefined();
				// An entry cannot claim to carry a field the adapter does not read.
				for (const property of carried)
					expect(ACP_FIELDS_READ_V0[definition] ?? [], `${entry.id}: ${definition}.${property}`).toContain(
						property,
					);
				for (const property of Object.keys(defs[definition]!.properties ?? {})) {
					if (property === "_meta" || carried.includes(property)) continue;
					expect(entry.lost, `${entry.id}`).toContain(`${definition}.${property}`);
				}
			}
		}
		// The cases review found by hand, now structural.
		expect(acpLossEntryV0("permission.request")?.lost).toEqual(
			expect.arrayContaining([
				"ToolCallUpdate.kind",
				"ToolCallUpdate.status",
				"ToolCallUpdate.locations",
				"ToolCallUpdate.rawOutput",
				"PermissionOption.name",
			]),
		);
		expect(acpLossEntryV0("config.observation")?.lost).toEqual(
			expect.arrayContaining(["SessionMode.id", "SessionMode.name", "SessionMode.description"]),
		);
		expect(acpLossEntryV0("capability.advertisement")?.lost).toEqual(
			expect.arrayContaining(["Implementation.title", "AuthMethodAgent.name"]),
		);
		expect(acpUnprojectedFieldsV0({ projects: { Cost: ["amount"] } })).toEqual(["Cost.currency"]);
	});
});
