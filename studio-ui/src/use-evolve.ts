// Read-only state hook for Evolve's Protected Experiment Inspector (EVOLVE-INSPECT-001).
// Reads the run list ONCE on first entry into Evolve (never on initial Observe/Compare/Develop load),
// and fetches one selected run's independently verified detail on explicit operator action.
// One read at a time, no timers, no automatic polling.

import { useCallback, useEffect, useRef, useState } from "react";
import { type EvolveRequest, fetchEvolveExperiments } from "./api.ts";
import type { EvolveExperimentDetail, EvolveExperimentsIndex } from "./model/protected-experiment-wire.ts";

export interface EvolveState {
	index: EvolveExperimentsIndex | null;
	selectedSelector: string | null;
	detail: EvolveExperimentDetail | null;
	reading: boolean;
	problem: string | null;
}

export interface EvolveApi {
	state: EvolveState;
	refreshList(): void;
	retryDetail(): void;
	selectRun(selector: string | null): void;
}

export function useEvolve(active: boolean): EvolveApi {
	const [state, setState] = useState<EvolveState>({
		index: null,
		selectedSelector: null,
		detail: null,
		reading: false,
		problem: null,
	});
	const latest = useRef(state);
	latest.current = state;
	const running = useRef(false);
	const entered = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const queued = useRef<EvolveRequest | null>(null);

	const read = useCallback(async (request: EvolveRequest): Promise<void> => {
		if (running.current) {
			queued.current = request;
			return;
		}
		running.current = true;
		controller.current = new AbortController();
		setState((s) => ({ ...s, reading: true, problem: null }));
		const reply = await fetchEvolveExperiments(request, controller.current.signal);
		running.current = false;

		let autoSelect: string | null = null;
		if (reply.kind === "list") {
			const runs = reply.record.available ? reply.record.runs : [];
			const prevSelected = latest.current.selectedSelector;
			const stillReadable =
				prevSelected !== null && runs.some((r) => r.selector === prevSelected && r.state === "readable");
			if (stillReadable) {
				// Always re-read selected run on explicit list refresh so trial records reflect current verified state on disk.
				autoSelect = prevSelected;
			} else {
				autoSelect = runs.find((r) => r.state === "readable")?.selector ?? null;
			}
		}

		setState((s) => {
			if (reply.kind === "list") {
				const runs = reply.record.available ? reply.record.runs : [];
				const stillReadable =
					s.selectedSelector !== null &&
					runs.some((r) => r.selector === s.selectedSelector && r.state === "readable");
				if (stillReadable) {
					return { ...s, index: reply.record, reading: false };
				}
				const firstReadable = runs.find((r) => r.state === "readable")?.selector ?? null;
				return {
					...s,
					index: reply.record,
					selectedSelector: firstReadable,
					detail: null,
					reading: false,
				};
			}
			if (reply.kind === "detail") {
				return reply.record.selector === s.selectedSelector
					? { ...s, detail: reply.record, reading: false }
					: { ...s, reading: false };
			}
			return {
				...s,
				reading: false,
				problem: reply.message,
				...(reply.stale && request.kind === "detail" ? { detail: null } : {}),
			};
		});

		const next = queued.current ?? (autoSelect !== null ? { kind: "detail", selector: autoSelect } : null);
		queued.current = null;
		if (next !== null) await read(next);
	}, []);

	useEffect(() => {
		if (active && !entered.current) {
			entered.current = true;
			void read({ kind: "list" });
		}
	}, [active, read]);

	useEffect(() => () => controller.current?.abort(), []);

	const refreshList = useCallback(() => void read({ kind: "list" }), [read]);

	const retryDetail = useCallback(() => {
		const selector = latest.current.selectedSelector;
		if (selector !== null) void read({ kind: "detail", selector });
	}, [read]);

	const selectRun = useCallback(
		(selector: string | null) => {
			setState((s) => ({ ...s, selectedSelector: selector, detail: null, problem: null }));
			if (selector !== null) void read({ kind: "detail", selector });
		},
		[read],
	);

	return { state, refreshList, retryDetail, selectRun };
}
