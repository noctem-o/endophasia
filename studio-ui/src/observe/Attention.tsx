// The sources that are not simply readable, each with what its condition means and what the projection recorded about it. Shown in the
// shell at every width, and again inside the inspector dialog, which makes the rest of the page inert: a degraded, absent or unopenable
// source is never out of sight because an inspector is open.
import type { ReactElement } from "react";
import type { AttentionItem } from "../model/observe.ts";
import { ConditionTag } from "../ui/text.tsx";

export function Attention({ items, testid }: { items: readonly AttentionItem[]; testid: string }): ReactElement | null {
	if (items.length === 0) return null;
	return (
		<section className="attention" aria-label="Sources that need attention" data-testid={testid}>
			{items.map((item) => (
				<p key={item.id} className="attention-item" data-state={item.condition.state}>
					<ConditionTag
						state={item.condition.state}
						label={item.condition.label}
						meaning={item.condition.meaning}
					/>{" "}
					<strong>{item.title}</strong> <span>{item.text}</span>
				</p>
			))}
		</section>
	);
}
