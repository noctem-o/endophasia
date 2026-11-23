// The workspaces that are not built yet. Each says plainly what it would need, shows no record and no number, and simulates nothing.
import type { ReactElement } from "react";

const NEEDS: Record<string, { what: string; needs: string }> = {
	research: {
		what: "Research is a planned workspace for structured studies, experimental protocols, comparisons and reproducible analysis across runs.",
		needs: "It is not implemented yet. Before it can appear as a workspace, it needs explicit study and dataset contracts with their own provenance and validation rather than ad-hoc summaries.",
	},
	hardware: {
		what: "Hardware is a planned workspace for inspecting physical and device-level execution targets, measurements and environment boundaries.",
		needs: "It is not implemented yet. It needs explicit device, host and measurement contracts that separate observed hardware facts from declared targets.",
	},
};

export default function Unavailable({ workspace, label }: { workspace: string; label: string }): ReactElement {
	const text = NEEDS[workspace];
	return (
		<section
			className="unavailable-workspace"
			data-testid={`unavailable-${workspace}`}
			aria-labelledby="unavailable-title"
		>
			<p className="unavailable-kicker">Planned workspace · not yet functional</p>
			<h2 id="unavailable-title">{label} is not available yet</h2>
			<p>{text?.what}</p>
			<p>{text?.needs}</p>
			<p className="dim">
				This workspace shows nothing read from a store, and nothing in it is a placeholder for a record.
			</p>
		</section>
	);
}
