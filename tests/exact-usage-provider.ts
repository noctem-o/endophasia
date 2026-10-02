import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type fauxProvider,
	type Provider,
	type Usage,
} from "@earendil-works/pi-ai";

/** Faux provider whose settled responses report the next queued usage instead of the faux token estimate. */
export function exactUsageProvider(faux: ReturnType<typeof fauxProvider>, queue: Usage[]): Provider {
	const patch = (inner: AssistantMessageEventStream): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					const reported = queue.shift();
					if (reported === undefined) throw new Error("Unexpected provider request without queued usage");
					if (event.type === "done") outer.push({ ...event, message: { ...event.message, usage: reported } });
					else outer.push({ ...event, error: { ...event.error, usage: reported } });
				} else {
					outer.push(event);
				}
			}
			outer.end();
		})();
		return outer;
	};
	return createProvider({
		id: faux.provider.id,
		auth: faux.provider.auth,
		models: faux.models,
		api: {
			stream: (model, context, options) => patch(faux.provider.stream(model, context, options)),
			streamSimple: (model, context, options) => patch(faux.provider.streamSimple(model, context, options)),
		},
	});
}

/** Build a Usage; costs should be exact binary fractions so sums compare exactly. */
export function usage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	totalTokens: number,
	cost: [number, number, number, number, number],
	extra: { cacheWrite1h?: number; reasoning?: number } = {},
): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...extra,
		totalTokens,
		cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3], total: cost[4] },
	};
}
