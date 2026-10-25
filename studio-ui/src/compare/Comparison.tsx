import type { ReactElement } from "react";
import type { EndoCockpitTrajectoryComparisonV0 } from "../../../protocol/cockpit-comparison.ts";
import { Panel } from "../ui/Panel.tsx";

const labels: Record<string, string> = {
	args: "Argument digest",
	result: "Result digest",
	stopReason: "Stop reason",
	stopRequested: "Stop requested",
	recognized: "Recognized by source",
	wallMs: "Wall time (ms)",
	keyId: "Digest domain",
	omitted: "Omitted facts",
	omittedToken: "Omitted evidence token",
	firstDivergentResult: "First differing tool result",
	firstDivergentCall: "First differing tool call",
	callsIdenticalUpToFirstDivergentInput: "Calls identical up to first differing input",
};

/** Only validated presentation fields reach this text-only detail renderer. No computed tags, HTML, links or authority. */
export function Evidence({ value }: { value: unknown }): ReactElement {
	if (value === null) return <span className="dim">Not reported / not applicable</span>;
	if (typeof value !== "object") return <span>{String(value)}</span>;
	if (Array.isArray(value))
		return (
			<ol className="compare-list">
				{value.map((v, i) => (
					<li key={String(i)}>
						<Evidence value={v} />
					</li>
				))}
			</ol>
		);
	const v = value as Record<string, unknown>;
	if (v.kind === "text") return <span>{String(v.text)}</span>;
	if (v.kind === "withheld" || v.kind === "token")
		return (
			<details className="withheld">
				<summary>{v.kind === "withheld" ? "Withheld text" : "Keyed evidence token"}</summary>
				<code>{String(v.token)}</code>
			</details>
		);
	if (v.status === "UNAVAILABLE")
		return (
			<div className="unavailable">
				UNAVAILABLE
				{v.reason ? (
					<>
						<span> — </span>
						<Evidence value={v.reason} />
					</>
				) : null}
				{v.sides ? <SideReasons value={v.sides as { a: unknown; b: unknown }} /> : null}
			</div>
		);
	if (v.status === "reported")
		return (
			<div>
				<span className="dim">Reported: </span>
				{v.keyId ? (
					<>
						<code>{String(v.keyId)}</code>
						<details>
							<summary>Recorded keyed digest</summary>
							<code>{String(v.value)}</code>
						</details>
					</>
				) : (
					<Evidence value={v.value} />
				)}
			</div>
		);
	if (v.status === "withheld")
		return (
			<details className="withheld">
				<summary>Withheld digest</summary>
				<code>{String(v.token)}</code>
			</details>
		);
	if (v.status === "DELTA") return <span>{String(v.value)}</span>;
	if ("present" in v && typeof v.present === "boolean")
		return v.present ? (
			<Evidence value={v.entry} />
		) : (
			<p className="dim">No entry at this position (this side is shorter).</p>
		);
	if ("items" in v && Array.isArray(v.items))
		return (
			<>
				<dl className="compare-facts">
					{v.items.map((item) => {
						const f = item as { path: string; value: unknown };
						return (
							<div key={f.path}>
								<dt>{f.path}</dt>
								<dd>{f.value === null ? "Reported null" : <Evidence value={f.value} />}</dd>
							</div>
						);
					})}
				</dl>
				{Number(v.omitted) > 0 ? (
					<div>
						{String(v.omitted)} facts omitted. <Evidence value={{ kind: "token", token: v.omittedToken }} />
					</div>
				) : null}
			</>
		);
	return (
		<dl className="compare-facts">
			{Object.entries(v).map(([name, item]) => (
				<div key={name}>
					<dt>{labels[name] ?? name}</dt>
					<dd>
						<Evidence value={item} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function SideReasons({ value }: { value: { a: unknown; b: unknown } }): ReactElement {
	return (
		<dl className="compare-facts">
			{(["a", "b"] as const).map((side) => (
				<div key={side}>
					<dt>{side.toUpperCase()}</dt>
					<dd>
						{value[side] === null ? (
							"This side reported the layer; verification may still be unavailable."
						) : (
							<Evidence value={value[side]} />
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

const layerNames = {
	lifecycle: "Lifecycle",
	toolCalls: "Tool calls",
	toolResults: "Tool results",
	outcome: "Outcome",
} as const;
const reasons: Record<string, string> = {
	"calls-unavailable": "Tool calls are unavailable on a side.",
	"calls-identical": "Tool calls are identical throughout the recorded layer.",
	"calls-unverified": "Some calls could not be verified.",
	"results-unavailable-or-unverified": "Results are unavailable or unverifiable; a divergent input cannot be located.",
	"calls-diverged-results-identical": "Calls differ while every recorded tool result was identical.",
	"order-unknown": "A run or turn is unknown, so order cannot be established.",
	"call-in-later-turn-than-divergent-result":
		"The first differing call was in a later turn than the first differing result.",
	"call-not-after-divergent-result": "A differing call was made no later than the first differing result's turn.",
};

export function Comparison({ record }: { record: EndoCockpitTrajectoryComparisonV0 }): ReactElement {
	return (
		<section id="compare-result" aria-label="Authoritative comparison">
			<p className="note">
				Each layer is aligned by its own positions. There is no overall verdict, global first divergence, or
				event-to-event pairing. A match does not establish controlled experimental equivalence.
			</p>
			<div className="compare-layers">
				{(Object.keys(layerNames) as (keyof typeof layerNames)[]).map((name) => {
					const layer = record.layers[name];
					return (
						<Panel
							id={`compare-${name}`}
							key={name}
							title={layerNames[name]}
							subtitle={
								name === "toolCalls"
									? "What was requested; a DSH request does not prove execution."
									: name === "outcome"
										? "DSH recovery-written closers do not establish observed interruptions."
										: undefined
							}
						>
							<p className={`compare-verdict verdict-${layer.status}`}>{layer.status}</p>
							{layer.status === "EXACT" ? (
								<p>{layer.length} recorded entries agree within this layer.</p>
							) : layer.status === "DIVERGED" ? (
								<>
									<p>
										First differing index: {layer.index} (zero-based). Common prefix: {layer.commonPrefix}.
										Side lengths: A {layer.lengths.a}, B {layer.lengths.b}.
									</p>
									<div className="compare-sides">
										<section aria-label="A entry">
											<h3>A</h3>
											<Evidence value={layer.a} />
										</section>
										<section aria-label="B entry">
											<h3>B</h3>
											<Evidence value={layer.b} />
										</section>
									</div>
								</>
							) : (
								<>
									<SideReasons value={layer.sides} />
									<Evidence value={{ unverified: layer.unverified, lengths: layer.lengths }} />
								</>
							)}
						</Panel>
					);
				})}
			</div>
			<Panel
				id="compare-flags"
				title="Comparison qualifications"
				subtitle="Differences in runtime, configuration, mapping or digest domain remain qualifications; missing evidence is not equivalence."
			>
				{record.flags.length === 0 ? (
					<p>
						No differences were established among the listed facets. Facets neither side recorded were not
						compared.
					</p>
				) : (
					record.flags.map((flag) => (
						<details key={flag.kind}>
							<summary>{flag.kind}</summary>
							<div className="compare-sides">
								<section>
									<h3>A</h3>
									<Evidence value={flag.a} />
								</section>
								<section>
									<h3>B</h3>
									<Evidence value={flag.b} />
								</section>
							</div>
						</details>
					))
				)}
			</Panel>
			<Panel
				id="compare-order"
				title="Tool calls against inputs"
				subtitle="Ordering does not establish causation or explain a later difference."
			>
				<p>{reasons[record.toolCallsAgainstInputs.reason]}</p>
				<Evidence
					value={{
						firstDivergentCall: record.toolCallsAgainstInputs.firstDivergentCall,
						firstDivergentResult: record.toolCallsAgainstInputs.firstDivergentResult,
						callsIdenticalUpToFirstDivergentInput:
							record.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput,
					}}
				/>
			</Panel>
			<div className="compare-layers">
				<Panel
					id="compare-usage"
					title="Usage deltas"
					subtitle="Runtime-reported; B minus A. Missing values are UNAVAILABLE, never inferred as zero."
				>
					<Evidence value={record.layers.usage} />
				</Panel>
				<Panel
					id="compare-timing"
					title="Timing deltas"
					subtitle="Observer-measured; B minus A, in milliseconds. No duration is inferred from a DSH import clock."
				>
					<Evidence value={record.layers.timing} />
				</Panel>
			</div>
		</section>
	);
}
