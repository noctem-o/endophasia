// The Pi projection of the upstream-change assessment (runtime/contracts/harness-assessment.ts): the adapter's
// current versions and check definitions, its capability catalogue, and the commands that re-establish evidence.
// Reads a registry; writes nothing. Open the registry read-only to call it.

import {
	assessEndoHarnessUpgradeV0,
	type EndoHarnessAssessmentV0,
	type EndoReestablishV0,
} from "../../runtime/contracts/harness-assessment.ts";
import type { EndoHarnessRegistryV0 } from "../../storage/harness-registry.ts";
import { PI_CAPABILITIES_V0 } from "./capabilities.ts";
import { PI_CHECK_DEFINITIONS_V0 } from "./checks.ts";
import { piCheckDefinitionDigestV0 } from "./evidence.ts";
import { PI_ADAPTER_VERSION, PI_MAPPING_VERSION, PI_SUITE_VERSION, piVersionStandingV0 } from "./version.ts";

export const PI_BUILD_V0 = {
	adapterVersion: PI_ADAPTER_VERSION,
	mappingVersion: PI_MAPPING_VERSION,
	suiteVersion: PI_SUITE_VERSION,
	definitionDigest(checkName: string): string | null {
		const definition = PI_CHECK_DEFINITIONS_V0.get(checkName);
		return definition === undefined ? null : piCheckDefinitionDigestV0(definition);
	},
};

/** The assessment of one Pi attachment, from its registry's records. */
export function piAssessmentV0(registry: Pick<EndoHarnessRegistryV0, "attachment" | "list">): EndoHarnessAssessmentV0 {
	return assessEndoHarnessUpgradeV0({
		attachment: registry.attachment,
		capabilities: PI_CAPABILITIES_V0,
		fingerprints: registry.list("fingerprint"),
		changes: registry.list("change"),
		evidence: registry.list("evidence"),
		states: registry.list("state"),
		build: PI_BUILD_V0,
	});
}

const HOW: Record<EndoReestablishV0, string> = {
	"identify-runtime":
		"make the selected Pi identifiable again (endo doctor shows why it is not), then endo harness check",
	"offline-check": "endo harness check (offline; no prompt, no provider call)",
	"live-study-with-consent": "endo harness study --authorize-live-study (agent work; may cost provider usage)",
	"release-review-or-live-study":
		"a documented-surface review exists only for reviewed releases; otherwise the authorized live study",
};

/** The operator's reading of an assessment, as plain text lines (for stderr; the JSON carries the same facts). */
export function renderPiAssessmentV0(assessment: EndoHarnessAssessmentV0): string[] {
	const lines: string[] = [];
	const describe = (o: EndoHarnessAssessmentV0["current"]) =>
		o === null
			? "nothing recorded"
			: `${o.version ?? "version unknown"} (${piVersionStandingV0(o.version)}) / fingerprint ${o.identityDigest.slice(0, 12)}, ${o.confidence} identity, observed ${o.observedAt}`;
	lines.push(
		`Upstream assessment for ${assessment.attachment} (from recorded state; the installed Pi was not examined)`,
	);
	lines.push(
		assessment.unidentified === null
			? `  Current:  ${describe(assessment.current)}`
			: `  Current:  UNIDENTIFIED since ${assessment.unidentified.at}: ${assessment.unidentified.failure}`,
	);
	if (assessment.previous !== null) {
		lines.push(
			`  ${assessment.unidentified === null ? "Previous:" : "Last identified:"} ${describe(assessment.previous)}`,
		);
		if (assessment.unidentified === null)
			lines.push(
				assessment.change === null
					? "  Changes:  no change record links the two"
					: `  Changes:  ${assessment.change.differences.join(", ")}; version order ${assessment.change.versionOrder} (a lower version is not assumed safer, nor a higher one compatible)`,
			);
	}
	for (const level of assessment.levels)
		lines.push(`  ${level.reached ? "[x]" : "[ ]"} ${level.level}: ${level.detail}`);
	// Against the previous runtime only when there is one; against the recorded standing always (a rebuilt Endophasia).
	const moved = assessment.capabilities.filter(
		(entry) =>
			(assessment.previous !== null && entry.previous !== entry.effective) ||
			(entry.recorded !== null && entry.recorded !== entry.effective),
	);
	if (moved.length > 0) {
		lines.push("  Capabilities whose standing differs from the previous runtime or from what was recorded:");
		for (const entry of moved)
			lines.push(
				`    ${entry.capability}: ${entry.previous ?? "-"} -> ${entry.effective}${entry.changed.length > 0 ? ` (changed: ${entry.changed.join(", ")})` : ""}`,
			);
	}
	const missing = assessment.capabilities.filter((entry) => entry.reestablish !== null);
	for (const how of [
		"identify-runtime",
		"offline-check",
		"live-study-with-consent",
		"release-review-or-live-study",
	] as const) {
		const names = missing.filter((entry) => entry.reestablish === how).map((entry) => entry.capability);
		if (names.length > 0) lines.push(`  To establish ${names.join(", ")}: ${HOW[how]}`);
	}
	lines.push(`  Comparisons: ${assessment.comparisons.detail}`);
	for (const limitation of assessment.limitations) lines.push(`  Limit: ${limitation}`);
	lines.push(
		"  An admitted capability is supported by evidence; it is not a permission. Approval stays with the operator.",
	);
	return lines;
}
