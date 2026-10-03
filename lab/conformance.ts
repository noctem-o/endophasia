// The conformance half of the lab: a single study and the suite that runs them in the order the study
// declared. The suite supplies the discipline — declared scenario order (never capture order), one study per
// scenario, every study naming the suite's subject and version — while the consumer supplies the readings.
// Every classification, including UNAVAILABLE, is a first-class result: "nothing matched exactly" is a useful
// scientific result, not an error.

import {
	type EndoConformanceStudyV0,
	type EndoConformanceSuiteV0,
	validateEndoConformanceStudyV0,
} from "../protocol/evaluation.ts";

/**
 * Record one conformance study. The study is the strict door: it must be a valid endo.conformance-study.v0,
 * with every input named (subject, version, scenario, decoder, predicate, expected, observed), the
 * classification inside the closed five-way, the evidence as digests or endo.evidence.* references, and every
 * limitation written down. Returns the validated study unchanged. Throws TypeError when invalid.
 */
export function studyEndoConformanceV0(input: unknown): EndoConformanceStudyV0 {
	const study = validateEndoConformanceStudyV0(input);
	if (study === null) throw new TypeError("not a valid endo.conformance-study.v0 study");
	return study;
}

/**
 * Run a conformance suite: one study per declared scenario, in declared order. The scenarios must be a
 * non-empty array of unique non-empty strings; the study function is called once per scenario and its reading
 * must be a valid study naming the suite's subject, version, and the scenario it was asked about. A suite is
 * not re-sorted: the order the study declared is the order the record carries. Throws TypeError when the
 * subject, the version, the scenario list, or a study reading is invalid.
 */
export function runEndoConformanceSuiteV0(args: {
	subject: unknown;
	version: unknown;
	scenarios: unknown;
	study: (scenario: string) => unknown;
}): EndoConformanceSuiteV0 {
	if (typeof args.subject !== "string" || args.subject.length < 1 || args.subject.length > 256) {
		throw new TypeError("subject must be a non-empty string of at most 256 characters");
	}
	if (typeof args.version !== "string" || args.version.length < 1 || args.version.length > 256) {
		throw new TypeError("version must be a non-empty string of at most 256 characters");
	}
	if (!Array.isArray(args.scenarios) || args.scenarios.length === 0) {
		throw new TypeError("scenarios must be a non-empty array");
	}
	const scenarios: string[] = [];
	for (const scenario of args.scenarios) {
		if (typeof scenario !== "string" || scenario.length < 1 || scenario.length > 256) {
			throw new TypeError("each scenario must be a non-empty string of at most 256 characters");
		}
		if (scenarios.includes(scenario)) throw new TypeError(`duplicate scenario ${scenario}`);
		scenarios.push(scenario);
	}
	const studies: EndoConformanceStudyV0[] = [];
	for (const scenario of scenarios) {
		const study = validateEndoConformanceStudyV0(args.study(scenario));
		if (study === null) throw new TypeError(`scenario ${scenario} did not produce a valid endo.conformance-study.v0`);
		if (study.subject !== args.subject)
			throw new TypeError(`scenario ${scenario} study names subject ${study.subject}`);
		if (study.version !== args.version)
			throw new TypeError(`scenario ${scenario} study names version ${study.version}`);
		if (study.scenario !== scenario)
			throw new TypeError(`scenario ${scenario} study reports scenario ${study.scenario}`);
		studies.push(study);
	}
	return { schemaVersion: "endo.conformance-suite.v0", subject: args.subject, version: args.version, studies };
}
