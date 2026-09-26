import { type Context, defineFacet, defineService, type Facet, type ReplicatedState } from "@earendil-works/chord";

export interface KeyedProbe {
	readonly state: ReplicatedState<{ value: string }>;
	replace(value: string, context: Context): Promise<void>;
	wait(context: Context): Promise<void>;
}

export const KeyedProbe = defineService<KeyedProbe>("test.keyed-probe");

export function createKeyedProbeFacet(): Facet {
	return defineFacet({
		id: "@test/keyed-probe",
		setup(env) {
			const probes = env.provideMany(KeyedProbe);
			const spawn = (value: string): void => {
				const state = env.replicatedState({ value });
				let close = (): void => {};
				close = probes.spawn("probe", {
					state,
					async replace(next) {
						close();
						spawn(next);
					},
					async wait(context) {
						const signal = context.abortSignal;
						if (signal === undefined) throw new Error("Probe wait requires cancellation");
						if (signal.aborted) throw abortError(signal);
						await new Promise<void>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
						});
					},
				});
			};
			env.onActivate(() => spawn("first"));
		},
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
