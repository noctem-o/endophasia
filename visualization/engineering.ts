// The Engineering scene v0: the data-dense, explicit projection of the semantic visual state (README
// "Engineering mode"). The v0 state carries the cognition graph, and the renderer emits exactly the
// graph-derived sections of ENDO_ENGINEERING_SECTION_KINDS_V0 — status, graph-inspector, claims-evidence,
// and degraded-states. The remaining engineering-mode panels (session timeline, event stream, usage,
// latency, runtime capabilities, provenance, policy decisions, promotion status, candidate diffs, experiment
// metrics) consume data sources the v0 state does not carry yet; they remain on the migrated cockpit's own
// surfaces. Every unavailable or unrecognized signal renders as an explicit row, never as a missing panel:
// the scene is as honest about what it cannot see as about what it can.

import {
	type EndoEngineeringRowToneV0,
	type EndoEngineeringRowV0,
	type EndoEngineeringSceneV0,
	type EndoEngineeringSectionV0,
	type EndoSemanticVisualStateV0,
	validateEndoSemanticVisualStateV0,
} from "../protocol/visualization.ts";

const ENDO_STANCE_RELATIONS_V0 = new Set(["supports", "contradicts"]);

function rowV0(label: string, value: string, tone: EndoEngineeringRowToneV0): EndoEngineeringRowV0 {
	return { schemaVersion: "endo.engineering-row.v0", label, value, tone };
}

function sectionV0(kind: string, rows: EndoEngineeringRowV0[]): EndoEngineeringSectionV0 {
	return { schemaVersion: "endo.engineering-section.v0", kind, rows };
}

/**
 * The status section: the build coordinates and the projected graph's size. Sequence and size rows are live
 * when they report a non-empty projection; missing nodes and a truncated expansion are warn rows.
 */
function statusSectionV0(state: EndoSemanticVisualStateV0): EndoEngineeringSectionV0 {
	const rows: EndoEngineeringRowV0[] = [
		rowV0("sequence", String(state.source.sequence), "live"),
		rowV0("root", state.source.root ?? "whole store", "idle"),
		rowV0("nodes", String(state.nodes.length), state.nodes.length > 0 ? "live" : "idle"),
		rowV0("edges", String(state.edges.length), state.edges.length > 0 ? "live" : "idle"),
		rowV0("missing", String(state.missing.length), state.missing.length > 0 ? "warn" : "idle"),
	];
	if (state.source.truncated) rows.push(rowV0("truncated", "a budget cut the expansion", "warn"));
	return sectionV0("status", rows);
}

/**
 * The graph-inspector section: every projected node, edge, and missing endpoint as an explicit row. A node
 * row labels the identifier and states its kind and depth; an edge row labels the identifier and states the
 * relation between its endpoints.
 */
function graphInspectorSectionV0(state: EndoSemanticVisualStateV0): EndoEngineeringSectionV0 {
	const rows: EndoEngineeringRowV0[] = [];
	for (const node of state.nodes) rows.push(rowV0(node.id, `kind ${node.kind} · depth ${node.depth}`, "idle"));
	for (const edge of state.edges)
		rows.push(rowV0(edge.id, `${edge.source} --${edge.relation}--> ${edge.target}`, "idle"));
	for (const id of state.missing) rows.push(rowV0(id, "missing", "warn"));
	if (rows.length === 0) rows.push(rowV0("graph", "no nodes or edges projected", "idle"));
	return sectionV0("graph-inspector", rows);
}

/**
 * The claims-evidence section: the projected claim and hypothesis nodes, live when a recorded stance edge
 * (supports / contradicts) touches them, and the recorded stance counts. When no claim or hypothesis node is
 * projected, the section says so with one explicit row.
 */
function claimsEvidenceSectionV0(state: EndoSemanticVisualStateV0): EndoEngineeringSectionV0 {
	const claimNodes = state.nodes.filter((node) => node.kind === "claim" || node.kind === "hypothesis");
	const rows: EndoEngineeringRowV0[] = [];
	if (claimNodes.length === 0) {
		rows.push(rowV0("claims", "no claim or hypothesis nodes projected", "idle"));
	} else {
		for (const node of claimNodes) {
			const stanced = state.edges.some(
				(edge) =>
					ENDO_STANCE_RELATIONS_V0.has(edge.relation) && (edge.source === node.id || edge.target === node.id),
			);
			rows.push(
				rowV0(
					node.id,
					stanced ? `kind ${node.kind} · stance recorded` : `kind ${node.kind}`,
					stanced ? "live" : "idle",
				),
			);
		}
		rows.push(
			rowV0("supports", String(state.edges.filter((edge) => edge.relation === "supports").length), "idle"),
			rowV0("contradicts", String(state.edges.filter((edge) => edge.relation === "contradicts").length), "idle"),
		);
	}
	return sectionV0("claims-evidence", rows);
}

/**
 * The degraded-states section: every unavailable or unrecognized signal across the projected nodes and the
 * scene, as a warn row carrying the recorded reason — the cockpit's "unavailable" vocabulary, applied to the
 * semantic state. When every signal is available, one live row says so.
 */
function degradedStatesSectionV0(state: EndoSemanticVisualStateV0): EndoEngineeringSectionV0 {
	const rows: EndoEngineeringRowV0[] = [];
	for (const node of state.nodes) {
		for (const signal of node.signals) {
			if (signal.availability === "available") continue;
			rows.push(rowV0(`${node.id} ${signal.signal}`, signal.reason ?? "no reason recorded", "warn"));
		}
	}
	for (const signal of state.signals) {
		if (signal.availability === "available") continue;
		rows.push(rowV0(`scene ${signal.signal}`, signal.reason ?? "no reason recorded", "warn"));
	}
	if (rows.length === 0) rows.push(rowV0("availability", "every recorded signal is available", "live"));
	return sectionV0("degraded-states", rows);
}

/**
 * Projects the semantic visual state into the Engineering scene. The input is validated with its own
 * validator (TypeError when invalid); the projection is pure — the same state always produces the same
 * scene. The v0 scene emits exactly the four graph-derived sections, sorted by kind.
 */
export function renderEngineeringSceneV0(state: unknown): EndoEngineeringSceneV0 {
	const checked = validateEndoSemanticVisualStateV0(state);
	if (checked === null) throw new TypeError("Expected state: a valid endo.semantic-visual-state.v0");
	const sections = [
		claimsEvidenceSectionV0(checked),
		degradedStatesSectionV0(checked),
		graphInspectorSectionV0(checked),
		statusSectionV0(checked),
	];
	return {
		schemaVersion: "endo.engineering-scene.v0",
		source: checked.source,
		sections: [...sections].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
	};
}
