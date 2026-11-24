import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawCoordinatorTrialV0 } from "../adapters/coordinator/openclaw.ts";
import { coordinatorAnswerRefusalV0 } from "../adapters/coordinator/status.ts";
import type { EndophasiaExternalStatusV0 } from "../integrations/openclaw-endophasia-status/src/status-reader.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoCoordinatorBriefResultV0 } from "../runtime/contracts/coordinator-brief.ts";
import type { BRIEF_FIXTURES } from "./coordinator-brief-fixtures.ts";

interface RawTrial {
	fixture: keyof typeof BRIEF_FIXTURES;
	result: EndoCoordinatorBriefResultV0;
	trial: (Omit<OpenClawCoordinatorTrialV0, "evidence"> & Partial<Pick<OpenClawCoordinatorTrialV0, "evidence">>) | null;
	rubric: (typeof BRIEF_FIXTURES)[keyof typeof BRIEF_FIXTURES];
	manifest: { before: string; after: string };
}

export function coordinatorTrialRowV0(phase: string, raw: RawTrial, unsupportedClaims: string[] | null) {
	const { fixture, result, trial, rubric, manifest } = raw;
	if (manifest.before !== manifest.after || (trial !== null && !trial.recorderClean))
		throw new Error(`incomplete evidence: ${phase}/${fixture}`);
	const view = (trial?.toolOutcome as { status?: EndophasiaExternalStatusV0 } | null | undefined)?.status;
	const last = trial?.wire.responses.at(-1);
	const releaseReplayRefusal =
		last?.finish === "length"
			? "generation-limit"
			: view && trial?.dispatched && trial.wire.statusDelivered && last?.finish === "stop"
				? coordinatorAnswerRefusalV0(last.text, view)
				: result.availability === "unavailable"
					? result.reason
					: "ungrounded";
	return {
		phase,
		fixture,
		promptSha256: trial?.promptSha256 ?? null,
		projectId: result.projectId,
		runtime: result.runtime,
		inference: trial?.wire.inference ?? [],
		toolDefinitions: trial?.wire.toolDefinitions ?? [],
		permittedToolDispatched: trial?.dispatched ?? false,
		statusSubmitted: trial?.wire.statusDelivered ?? false,
		validatedToolOutcome: trial?.toolOutcome ?? null,
		evidence:
			trial?.evidence ??
			(result.availability === "available" ? result.evidence : undefined) ??
			(view
				? {
						readAtMs: view.readAtMs,
						modelViewSha256: sha256HexV0(canonicalEndoJsonV0(view)),
						projectionSha256: null,
					}
				: null),
		responses: trial?.wire.responses.map(({ finish, usage, toolCalled }) => ({ finish, usage, toolCalled })) ?? [],
		finalAnswer: last?.text || null,
		originalAvailability: result.availability,
		originalRefusal: result.availability === "unavailable" ? result.reason : null,
		releaseReplayRefusal,
		latencyMs: trial?.latencyMs ?? null,
		rubric,
		unsupportedClaims,
		manifest,
	};
}

if (import.meta.main) {
	const [annotationsPath, ...inputs] = process.argv.slice(2);
	if (!annotationsPath || inputs.length === 0)
		throw new TypeError(
			"usage: node tests/coordinator-brief-evidence.ts <annotations.jsonl | -> <phase=raw-file-or-directory>...",
		);
	const annotations = new Map<string, string[] | null>();
	if (annotationsPath !== "-")
		for (const line of readFileSync(annotationsPath, "utf8").trim().split("\n")) {
			const { phase, fixture, unsupportedClaims } = JSON.parse(line);
			annotations.set(`${phase}/${fixture}`, unsupportedClaims);
		}
	const seen = new Set<string>();
	for (const input of inputs) {
		const delimiter = input.indexOf("=");
		if (delimiter < 1) throw new TypeError("a trial input must be phase=raw-file-or-directory");
		const phase = input.slice(0, delimiter);
		const path = input.slice(delimiter + 1);
		const files = statSync(path).isDirectory()
			? readdirSync(path)
					.filter((name) => name.endsWith(".json"))
					.sort()
					.map((name) => join(path, name))
			: [path];
		for (const file of files) {
			const raw: RawTrial = JSON.parse(readFileSync(file, "utf8"));
			const key = `${phase}/${raw.fixture}`;
			if (seen.has(key)) throw new TypeError(`duplicate trial: ${key}`);
			seen.add(key);
			process.stdout.write(`${JSON.stringify(coordinatorTrialRowV0(phase, raw, annotations.get(key) ?? null))}\n`);
		}
	}
}
