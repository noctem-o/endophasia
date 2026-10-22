// The workspaces that are not built yet. Each says plainly what it would need, shows no record and no number, and simulates nothing.
import type { ReactElement } from "react";

const NEEDS: Record<string, { what: string; needs: string }> = {
	compare: {
		what: "Compare lines two recorded trajectories up against each other.",
		needs: "It needs a projection that pairs events of two sessions and states how the correspondence was made. No such projection exists yet, so Studio cannot draw one without inventing it.",
	},
	capabilities: {
		what: "Capabilities sets what a runtime declares against what has been observed of it.",
		needs: "It needs a projection of the declared surface beside the observed evidence. The Observe workspace already shows each capability's recorded status and the limits on it; a declared-versus-observed matrix needs more than that.",
	},
	evolve: {
		what: "Evolve is the laboratory: lineage, experiments, candidates and checkpoints.",
		needs: "It needs projections of lineage, experiments and candidates, each with its own version and validator, before a workspace can show them. A promotion record confers no authority, and this page offers no action.",
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
			<h2 id="unavailable-title">{label} is not available yet</h2>
			<p>{text?.what}</p>
			<p>{text?.needs}</p>
			<p className="dim">
				Nothing on this page was read from a store, and nothing here is a placeholder for a record.
			</p>
		</section>
	);
}
