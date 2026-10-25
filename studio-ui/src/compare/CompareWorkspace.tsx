import type { ReactElement } from "react";
import { candidateValue } from "../model/compare.ts";
import { Panel } from "../ui/Panel.tsx";
import { Note } from "../ui/text.tsx";
import type { useCompare } from "../use-compare.ts";
import { Comparison } from "./Comparison.tsx";

export function CompareWorkspace({ compare }: { compare: ReturnType<typeof useCompare> }): ReactElement {
	const { state, paced } = compare;
	const busy = state.request !== null;
	const inventory = state.inventory;
	return (
		<div id="compare-workspace" data-busy={String(busy)} aria-busy={busy}>
			<Panel
				id="compare-recordings"
				title="Compare recorded trajectories"
				subtitle="Read-only evidence from one configured store. Select two recordings; each layer keeps its authoritative judgment."
				tools={
					<button
						className="btn"
						type="button"
						id="rediscover"
						disabled={busy || paced}
						onClick={compare.rediscover}
					>
						Rediscover recordings
					</button>
				}
			>
				<output aria-live="polite">
					{busy
						? state.request?.read.kind === "compare"
							? "Reading comparison…"
							: "Discovering recordings…"
						: inventory
							? `${inventory.candidates.length} of ${inventory.page.total} candidates loaded${inventory.page.hasMore ? "; more remain" : "; inventory complete"}.`
							: "No verified inventory loaded."}
				</output>
				{busy ? (
					<button type="button" className="btn" onClick={compare.cancel}>
						Cancel request
					</button>
				) : null}
				{state.problem !== null ? (
					<Note tone="error">
						{state.problem}
						{paced ? " Controls will resume after the server's pause; nothing retries automatically." : ""}
					</Note>
				) : null}
				{inventory?.page.total === 0 ? (
					<Note>
						No recording candidates were found in this verified store. An empty inventory is not evidence of a run
						or its outcome.
					</Note>
				) : null}
				<div className="compare-selection">
					{(["a", "b"] as const).map((side) => (
						<div key={side}>
							<label htmlFor={`recording-${side}`}>Recording {side.toUpperCase()}</label>
							<select
								id={`recording-${side}`}
								value={state[side] ? candidateValue(state[side]!) : ""}
								disabled={!inventory || state.invalid}
								onChange={(event) => compare.choose(side, event.target.value)}
							>
								<option value="">Choose a recording</option>
								{inventory?.candidates.map((row) => (
									<option
										key={`${row.source}:${row.session}`}
										value={row.selector === null ? `${row.source}:${row.session}` : candidateValue(row)}
										disabled={row.eligibility !== "selectable"}
									>
										{row.label} · {row.session}
										{row.eligibility === "ambiguous"
											? " — ambiguous attachments"
											: row.eligibility === "insufficient"
												? " — insufficient evidence"
												: ""}
									</option>
								))}
							</select>
							{state[side] ? (
								<p className="mono compare-identity">
									{state[side]!.label} · {state[side]!.session}
								</p>
							) : null}
						</div>
					))}
				</div>
				<p className="dim">
					Ambiguous recordings have several Pi attachments. Insufficient recordings lack the required verified
					native import evidence. They cannot be selected. Display identities may be keyed aliases; only the
					server's opaque selectors are used.
				</p>
				{state.a && state.b && candidateValue(state.a) === candidateValue(state.b) ? (
					<Note tone="warn">
						Self-comparison is permitted. The two selections are the same recording; they are not independent
						observations.
					</Note>
				) : null}
				<div className="compare-actions">
					<button
						type="button"
						className="btn primary"
						id="compare-run"
						disabled={busy || paced || !state.a || !state.b || state.invalid}
						onClick={compare.compare}
					>
						Compare recordings
					</button>
					{inventory?.page.hasMore ? (
						<button
							type="button"
							className="btn"
							id="compare-more"
							disabled={busy || paced}
							onClick={compare.more}
						>
							Load next candidate page
						</button>
					) : null}
				</div>
			</Panel>
			{state.result ? (
				<>
					<p className="compare-result-pair">
						A: {state.result.pair.a.label} · {state.result.pair.a.session}
						<br />
						B: {state.result.pair.b.label} · {state.result.pair.b.session}
					</p>
					<Comparison record={state.result.record} />
				</>
			) : null}
		</div>
	);
}
