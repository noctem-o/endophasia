// DEVELOP-VERIFY-TRUST-004 Amendment 10: how the installed harness judges an authoritative PASS for IA3 (PROTOCOL.md).
// A PASS is judged by the export digest the verifier sealed into its record, against a truth table keyed by export digest that the
// harness computes by running the oracle on each candidate it knows. Commits do not decide it: an equivalent candidate committed
// elsewhere (the availability request) has another commit and the same export. Every authoritative PASS gets exactly one disposition:
//   correct     its digest is one the truth table judged correct
//   false-pass  its digest is one the truth table judged incorrect
//   uncovered   the truth table has no entry for its digest (or the record names none); visible, counted, and failing IA3
// Origin says whether the record was already present when the harness started (the availability request, an earlier run) or not.

export interface TruthEntry {
	candidate: string;
	correct: boolean;
}

export interface PassRead {
	name: string;
	r: { authoritative: boolean; class: string; record?: Record<string, unknown> | null };
}

export type Disposition = "correct" | "false-pass" | "uncovered";

export interface ClassifiedPass {
	name: string;
	origin: "preexisting" | "this-run";
	commit: string | null;
	exportSha256: string | null;
	candidate: string | null;
	disposition: Disposition;
}

/** The truth table by export digest. Two candidates with one digest must agree; a disagreement is a harness error, not a verdict. */
export function truthByExport(entries: readonly { candidate: string; exportSha256: string; correct: boolean }[]) {
	const table = new Map<string, TruthEntry>();
	for (const e of entries) {
		if (!/^[0-9a-f]{64}$/.test(e.exportSha256)) throw new Error(`truth: ${e.candidate} has no export digest`);
		const was = table.get(e.exportSha256);
		if (was !== undefined && was.correct !== e.correct)
			throw new Error(`truth: ${was.candidate} and ${e.candidate} share export ${e.exportSha256} but disagree`);
		if (was === undefined) table.set(e.exportSha256, { candidate: e.candidate, correct: e.correct });
	}
	return table;
}

export function classifyPasses(
	reads: readonly PassRead[],
	truth: ReadonlyMap<string, TruthEntry>,
	preexisting: ReadonlySet<string>,
) {
	const seen = new Set<string>();
	const passes: ClassifiedPass[] = [];
	for (const { name, r } of reads) {
		if (seen.has(name)) throw new Error(`record ${name} listed twice`);
		seen.add(name);
		if (!r.authoritative || r.class !== "PASS") continue;
		const candidate = (r.record?.candidate ?? null) as { commit?: unknown; exportSha256?: unknown } | null;
		const digest =
			typeof candidate?.exportSha256 === "string" && /^[0-9a-f]{64}$/.test(candidate.exportSha256)
				? candidate.exportSha256
				: null;
		const entry = digest === null ? undefined : truth.get(digest);
		passes.push({
			name,
			origin: preexisting.has(name) ? "preexisting" : "this-run",
			commit: typeof candidate?.commit === "string" ? candidate.commit : null,
			exportSha256: digest,
			candidate: entry?.candidate ?? null,
			disposition: entry === undefined ? "uncovered" : entry.correct ? "correct" : "false-pass",
		});
	}
	const named = (d: Disposition) => passes.filter((p) => p.disposition === d).map((p) => p.name);
	const falsePasses = named("false-pass");
	const uncovered = named("uncovered");
	return { passes, falsePasses, uncovered, ia3: falsePasses.length === 0 && uncovered.length === 0 };
}
