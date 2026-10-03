import { describe, expect, it } from "vitest";
import { createEndoExperimentLifecycleV0, replayEndoExperimentLifecycleV0 } from "../evolution/index.ts";
import {
	ENDO_EXPERIMENT_STATE_TRANSITIONS_V0,
	ENDO_EXPERIMENT_STATES_V0,
	type EndoExperimentRecordV0,
	type EndoExperimentStateV0,
	type EndoExperimentTransitionV0,
} from "../protocol/evolution.ts";

function validRecord(): EndoExperimentRecordV0 {
	return {
		schemaVersion: "endo.experiment.v0",
		id: "endo.experiment.exp-1",
		evaluator: "eval-1",
		grader: "grade-1",
	};
}

function transition(
	id: string,
	sequence: number,
	from: EndoExperimentStateV0,
	to: EndoExperimentStateV0,
): EndoExperimentTransitionV0 {
	return {
		schemaVersion: "endo.experiment-transition.v0",
		id,
		experimentId: "endo.experiment.exp-1",
		sequence,
		from,
		to,
		evidence: ["endo.evidence.res-1"],
	};
}

// The full legal spine from "created" to "promoted".
const SPINE: Array<[EndoExperimentStateV0, EndoExperimentStateV0]> = [
	["created", "prepared"],
	["prepared", "running"],
	["running", "evaluated"],
	["evaluated", "compared"],
	["compared", "selected"],
	["selected", "promotion-requested"],
	["promotion-requested", "promoted"],
];

function spineTransitions(): EndoExperimentTransitionV0[] {
	return SPINE.map(([from, to], index) => transition(`endo.evidence.tr-${index + 1}`, index + 1, from, to));
}

describe("createEndoExperimentLifecycleV0", () => {
	it("rejects an invalid record", () => {
		expect(() =>
			createEndoExperimentLifecycleV0({ schemaVersion: "endo.experiment.v0", id: "endo.evidence.exp-1" }),
		).toThrow(TypeError);
		expect(() => createEndoExperimentLifecycleV0("not an object")).toThrow(TypeError);
	});

	it("starts at created with no transitions", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		expect(lifecycle.state).toBe("created");
		expect(lifecycle.transitions).toEqual([]);
		expect(lifecycle.record).toEqual(validRecord());
	});

	it("walks the full legal spine with per-step state and sequence", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		for (const [index, [from, to]] of SPINE.entries()) {
			expect(lifecycle.state).toBe(from);
			lifecycle.transition({ id: `endo.evidence.tr-${index + 1}`, to });
			expect(lifecycle.state).toBe(to);
			expect(lifecycle.transitions).toHaveLength(index + 1);
			expect(lifecycle.transitions[index].sequence).toBe(index + 1);
			expect(lifecycle.transitions[index].from).toBe(from);
			expect(lifecycle.transitions[index].to).toBe(to);
		}
	});

	it("accepts an alternative terminal at compared", () => {
		for (const to of ["selected", "rejected", "inconclusive"] as const) {
			const lifecycle = createEndoExperimentLifecycleV0(validRecord());
			lifecycle.transition({ id: "endo.evidence.tr-1", to: "prepared" });
			lifecycle.transition({ id: "endo.evidence.tr-2", to: "running" });
			lifecycle.transition({ id: "endo.evidence.tr-3", to: "evaluated" });
			lifecycle.transition({ id: "endo.evidence.tr-4", to: "compared" });
			lifecycle.transition({ id: "endo.evidence.tr-5", to });
			expect(lifecycle.state).toBe(to);
		}
	});

	it("rejects a transition from a terminal state", () => {
		for (const terminal of ["selected", "rejected", "inconclusive", "promoted", "denied"] as const) {
			const lifecycle = createEndoExperimentLifecycleV0(validRecord());
			lifecycle.transition({ id: "endo.evidence.tr-1", to: "prepared" });
			lifecycle.transition({ id: "endo.evidence.tr-2", to: "running" });
			lifecycle.transition({ id: "endo.evidence.tr-3", to: "evaluated" });
			lifecycle.transition({ id: "endo.evidence.tr-4", to: "compared" });
			if (terminal === "selected") lifecycle.transition({ id: "endo.evidence.tr-5", to: "selected" });
			if (terminal === "rejected") lifecycle.transition({ id: "endo.evidence.tr-5", to: "rejected" });
			if (terminal === "inconclusive") lifecycle.transition({ id: "endo.evidence.tr-5", to: "inconclusive" });
			if (terminal === "promoted") {
				lifecycle.transition({ id: "endo.evidence.tr-5", to: "selected" });
				lifecycle.transition({ id: "endo.evidence.tr-6", to: "promotion-requested" });
				lifecycle.transition({ id: "endo.evidence.tr-7", to: "promoted" });
			}
			if (terminal === "denied") {
				lifecycle.transition({ id: "endo.evidence.tr-5", to: "selected" });
				lifecycle.transition({ id: "endo.evidence.tr-6", to: "promotion-requested" });
				lifecycle.transition({ id: "endo.evidence.tr-7", to: "denied" });
			}
			expect(lifecycle.state).toBe(terminal);
			expect(() =>
				lifecycle.transition({ id: `endo.evidence.tr-${lifecycle.transitions.length + 1}`, to: "created" }),
			).toThrow(TypeError);
		}
	});

	it("rejects every table-illegal from→to pair", () => {
		for (const from of ENDO_EXPERIMENT_STATES_V0) {
			const allowed = new Set(ENDO_EXPERIMENT_STATE_TRANSITIONS_V0[from]);
			for (const to of ENDO_EXPERIMENT_STATES_V0) {
				if (allowed.has(to)) continue;
				// Drive the lifecycle to "from" along a legal path, then attempt the illegal step.
				const lifecycle = createEndoExperimentLifecycleV0(validRecord());
				const path = legalPathTo(from);
				for (const [index, step] of path.entries()) {
					lifecycle.transition({ id: `endo.evidence.tr-${index + 1}`, to: step });
				}
				expect(lifecycle.state).toBe(from);
				expect(() => lifecycle.transition({ id: `endo.evidence.tr-${path.length + 1}`, to })).toThrow(TypeError);
			}
		}
	});

	it("rejects an unknown state literal", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		expect(() => lifecycle.transition({ id: "endo.evidence.tr-1", to: "paused" as EndoExperimentStateV0 })).toThrow(
			TypeError,
		);
	});

	it("rejects a transition id outside the evidence namespace", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		expect(() => lifecycle.transition({ id: "endo.model.tr-1", to: "prepared" })).toThrow(TypeError);
	});

	it("rejects a duplicate transition id", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		lifecycle.transition({ id: "endo.evidence.tr-1", to: "prepared" });
		lifecycle.transition({ id: "endo.evidence.tr-2", to: "running" });
		expect(() => lifecycle.transition({ id: "endo.evidence.tr-1", to: "evaluated" })).toThrow(TypeError);
	});

	it("rejects evidence outside the evidence namespace", () => {
		const lifecycle = createEndoExperimentLifecycleV0(validRecord());
		expect(() =>
			lifecycle.transition({ id: "endo.evidence.tr-1", to: "prepared", evidence: ["endo.model.res-1"] }),
		).toThrow(TypeError);
	});
});

// A legal path from "created" to every non-created state.
function legalPathTo(state: EndoExperimentStateV0): EndoExperimentStateV0[] {
	const paths: Record<EndoExperimentStateV0, EndoExperimentStateV0[]> = {
		created: [],
		prepared: ["prepared"],
		running: ["prepared", "running"],
		evaluated: ["prepared", "running", "evaluated"],
		compared: ["prepared", "running", "evaluated", "compared"],
		selected: ["prepared", "running", "evaluated", "compared", "selected"],
		rejected: ["prepared", "running", "evaluated", "compared", "rejected"],
		inconclusive: ["prepared", "running", "evaluated", "compared", "inconclusive"],
		"promotion-requested": ["prepared", "running", "evaluated", "compared", "selected", "promotion-requested"],
		promoted: ["prepared", "running", "evaluated", "compared", "selected", "promotion-requested", "promoted"],
		denied: ["prepared", "running", "evaluated", "compared", "selected", "promotion-requested", "denied"],
	};
	return paths[state];
}

describe("replayEndoExperimentLifecycleV0", () => {
	it("reconstructs a full chain to promoted", () => {
		const transitions = spineTransitions();
		const replayed = replayEndoExperimentLifecycleV0(validRecord(), transitions);
		expect(replayed.state).toBe("promoted");
		expect(replayed.transitions).toEqual(transitions);
	});

	it("reconstructs a zero-transition lifecycle at created", () => {
		const replayed = replayEndoExperimentLifecycleV0(validRecord(), []);
		expect(replayed.state).toBe("created");
		expect(replayed.transitions).toEqual([]);
	});

	it("replays a partial chain to a terminal state", () => {
		const transitions = spineTransitions().slice(0, 5);
		const replayed = replayEndoExperimentLifecycleV0(validRecord(), transitions);
		expect(replayed.state).toBe("selected");
	});

	it("rejects an invalid record", () => {
		expect(() =>
			replayEndoExperimentLifecycleV0({ schemaVersion: "endo.experiment.v0", id: "endo.evidence.exp-1" }, []),
		).toThrow(TypeError);
	});

	it("rejects a non-array transition list", () => {
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), "none")).toThrow(TypeError);
	});

	it("rejects a sequence gap", () => {
		const transitions = spineTransitions();
		transitions[1].sequence = 3;
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), transitions)).toThrow(TypeError);
	});

	it("rejects a transition whose from does not follow the previous to", () => {
		// prepared→prepared is table-illegal as well, so also use a legal-pair mismatch:
		// keep the spine legal but renumber: running→evaluated must follow running.
		const mismatch = [
			transition("endo.evidence.tr-1", 1, "created", "prepared"),
			transition("endo.evidence.tr-2", 2, "running", "evaluated"), // from=running, current=prepared
		];
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), mismatch)).toThrow(TypeError);
	});

	it("rejects a wrong experiment id", () => {
		const transitions = spineTransitions();
		transitions[0] = { ...transitions[0], experimentId: "endo.experiment.exp-2" };
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), transitions)).toThrow(TypeError);
	});

	it("rejects a duplicate transition id", () => {
		const transitions = spineTransitions();
		transitions[1] = { ...transitions[1], id: transitions[0].id };
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), transitions)).toThrow(TypeError);
	});

	it("rejects a table-illegal from→to pair", () => {
		const transitions = [transition("endo.evidence.tr-1", 1, "created", "running")];
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), transitions)).toThrow(TypeError);
	});

	it("rejects an invalid nested transition", () => {
		const transitions = spineTransitions();
		transitions[0] = { ...transitions[0], id: "endo.model.tr-1" };
		expect(() => replayEndoExperimentLifecycleV0(validRecord(), transitions)).toThrow(TypeError);
	});
});
