// Read-only state hook for Observe's Representation Explorer.
// Reads the artifact index ONCE on first entry into Representation Explorer (never on initial Timeline load),
// and projects one selected artifact/layer on explicit operator action. One read at a time, no timers, no polling.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EndoObserveRepresentationSceneV0 } from "../../protocol/observe-representation.ts";
import { fetchRepresentations, type RepresentationRequest } from "./api.ts";
import type { RepresentationIndex } from "./model/representation-wire.ts";

export interface RepresentationsState {
	index: RepresentationIndex | null;
	selectedSelector: string | null;
	scene: EndoObserveRepresentationSceneV0 | null;
	reading: boolean;
	problem: string | null;
}

export interface RepresentationsApi {
	state: RepresentationsState;
	refreshList(): void;
	retryScene(): void;
	selectArtifact(selector: string | null): void;
	selectLayer(layer: number | "all"): void;
}

export function useRepresentations(active: boolean): RepresentationsApi {
	const [state, setState] = useState<RepresentationsState>({
		index: null,
		selectedSelector: null,
		scene: null,
		reading: false,
		problem: null,
	});
	const latest = useRef(state);
	latest.current = state;
	const running = useRef(false);
	const entered = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const again = useRef<RepresentationRequest | null>(null);

	const read = useCallback(async (request: RepresentationRequest): Promise<void> => {
		if (running.current) {
			again.current = request;
			return;
		}
		running.current = true;
		controller.current = new AbortController();
		setState((s) => ({ ...s, reading: true, problem: null }));
		const reply = await fetchRepresentations(request, controller.current.signal);
		running.current = false;

		let autoSelect: string | null = null;
		if (reply.kind === "list") {
			const artifacts = reply.record.available ? reply.record.artifacts : [];
			const prevSelected = latest.current.selectedSelector;
			const stillReadable =
				prevSelected !== null && artifacts.some((a) => a.selector === prevSelected && a.state === "readable");
			if (stillReadable) {
				// If the retained selection has no loaded scene (e.g. after a transient 429 or network failure), retry it.
				if (latest.current.scene === null || latest.current.scene.selector !== prevSelected) {
					autoSelect = prevSelected;
				}
			} else {
				autoSelect = artifacts.find((a) => a.state === "readable")?.selector ?? null;
			}
		}

		setState((s) => {
			if (reply.kind === "list") {
				const artifacts = reply.record.available ? reply.record.artifacts : [];
				const stillReadable =
					s.selectedSelector !== null &&
					artifacts.some((a) => a.selector === s.selectedSelector && a.state === "readable");
				if (stillReadable) {
					return { ...s, index: reply.record, reading: false };
				}
				const firstReadable = artifacts.find((a) => a.state === "readable")?.selector ?? null;
				return {
					...s,
					index: reply.record,
					selectedSelector: firstReadable,
					scene: null,
					reading: false,
				};
			}
			if (reply.kind === "scene") {
				return reply.record.selector === s.selectedSelector
					? { ...s, scene: reply.record, reading: false }
					: { ...s, reading: false };
			}
			return {
				...s,
				reading: false,
				problem: reply.message,
				...(reply.stale && request.kind === "scene" ? { scene: null } : {}),
			};
		});

		const next = again.current ?? (autoSelect !== null ? { kind: "scene", selector: autoSelect } : null);
		again.current = null;
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

	const retryScene = useCallback(() => {
		const selector = latest.current.selectedSelector;
		if (selector !== null) void read({ kind: "scene", selector });
	}, [read]);

	const selectArtifact = useCallback(
		(selector: string | null) => {
			setState((s) => ({ ...s, selectedSelector: selector, scene: null, problem: null }));
			if (selector !== null) void read({ kind: "scene", selector });
		},
		[read],
	);

	const selectLayer = useCallback(
		(layer: number | "all") => {
			const selector = latest.current.selectedSelector;
			if (selector === null) return;
			void read({ kind: "scene", selector, layer });
		},
		[read],
	);

	return { state, refreshList, retryScene, selectArtifact, selectLayer };
}
