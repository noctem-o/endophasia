// Browser wire gate for an attempt's provenance (protocol/develop-observations.ts, docs/designs/develop-candidate-provenance.md): what Git
// showed of the working tree around the attempt, and how that relates to the tree now and to the commits its checks ran at. The broker
// computes it; this checks the shape the section reads and that its parts agree (the observations compared are ones listed, of the points
// the basis names; a comparison that claims "same" or "different" is between two complete states; a HEAD move names the commits of the
// observations it moves between), and refuses the whole attempts body otherwise. Words are mirrored here (the page imports only types from
// protocol/); a contract test holds them equal to the protocol's.
import type {
	EndoAttemptProvenanceViewV0,
	EndoHeadMoveV0,
	EndoNotComparedV0,
	EndoObservationPointV0,
	EndoObservationTriggerV0,
	EndoObservationViewV0,
	EndoProvenanceBasisV0,
	EndoProvenanceNoteV0,
	EndoStateComparisonV0,
} from "../../../protocol/develop-provenance.ts";
import { bool, type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type {
	EndoAttemptProvenanceViewV0 as Provenance,
	EndoHeadMoveV0 as HeadMove,
	EndoObservationViewV0 as Observation,
	EndoStateComparisonV0 as Comparison,
} from "../../../protocol/develop-provenance.ts";

export const OBSERVATION_POINT_LABELS: Readonly<Record<EndoObservationPointV0, string>> = {
	"before-send": "Just before the brief was sent",
	"after-run": "When the run had ended",
	operator: "When you asked",
};

export const OBSERVATION_TRIGGER_TEXT: Readonly<Record<EndoObservationTriggerV0, string>> = {
	"send-approved": "the workbench observed it after your approval and before it recorded the send",
	"run-settled": "the workbench observed it after Pi reported the run that followed the send had settled",
	"workbench-closing": "the workbench observed it while closing, with the run that followed the send still open",
	"operator-command": "you ran endo attempt observe",
};

export const NOT_COMPARED_TEXT: Readonly<Record<EndoNotComparedV0, string>> = {
	incomplete: "one of the two states was not fully read (too many changes, a file not read, or hidden index entries)",
	"other-repository": "the two were observed in different repositories",
	"commit-unavailable": "Git no longer has one of the commits",
	"path-not-text": "a path that differs between the commits is not UTF-8 text, so it cannot be compared exactly",
	"too-many-paths": "too many paths differ to compare",
	"git-failed": "Git could not answer",
	unavailable: "one of the two could not be observed",
};

export const PROVENANCE_NOTE_TEXT: Readonly<Record<EndoProvenanceNoteV0, string>> = {
	"authorized-without-before":
		"The attempt was authorised to be sent, but no observation from just before the send is recorded (it failed, or an older build sent it).",
	"no-after-run":
		"No observation was made when the run ended: the run has not ended, or the workbench stopped first. Record one with endo attempt observe.",
	"observation-unavailable": "An observation could not be made: Git could not read the working tree then.",
	"other-send-observations":
		"Some observations name a send other than this attempt's authorisation; they are listed and not used.",
	"frame-elsewhere":
		"The observations were made in a different working tree from the one read now; now is not compared.",
	problems: "Some files in the observations directory are not usable observations.",
};

export const OBSERVATION_LIMITATIONS: readonly string[] = [
	"Git's view at one moment: who or what changed the tree (the agent, you, an editor, a hook, another process) is not known.",
	"Two observations that read the same do not mean nothing changed between them.",
	"Ignored files are not part of a state; their contents were not read.",
	"Content is compared by Git blob id over the raw bytes; Git's line-ending or filter conversion, if the repository uses any, is not applied.",
];

/** The basis of each frame: the points its start and end must be (null: absent). */
export const BASIS_POINTS: Readonly<
	Record<
		EndoProvenanceBasisV0,
		{ start: EndoObservationPointV0 | null; end: readonly (EndoObservationPointV0 | null)[] }
	>
> = {
	"send-and-run": { start: "before-send", end: ["after-run"] },
	"send-only": { start: "before-send", end: [null] },
	"send-and-operator": { start: "before-send", end: ["operator"] },
	"run-only": { start: null, end: ["after-run"] },
	operator: { start: "operator", end: ["operator", null] },
};

export const BASIS_TEXT: Readonly<Record<EndoProvenanceBasisV0, string>> = {
	"send-and-run": "Just before the brief was sent, and when the run had ended",
	"send-only": "Just before the brief was sent; nothing observed since",
	"send-and-operator":
		"Just before the brief was sent, and your latest observation since (none was made when the run ended)",
	"run-only": "When the run had ended; nothing observed before the send",
	operator: "Your own observations; they say nothing about when the work happened",
};

const keys = <T extends string>(r: Readonly<Record<T, unknown>>): T[] => Object.keys(r) as T[];
const UNAVAILABLE = [
	"no-directory",
	"not-a-repository",
	"bare-repository",
	"not-top-level",
	"scope-mismatch",
	"unsafe-config",
	"partial-clone",
	"unborn",
	"ownership",
	"git-not-found",
	"git-timeout",
	"git-failed",
	"output-too-large",
	"other-repository",
	"timed-out",
] as const;
export const OBSERVATION_UNAVAILABLE: readonly string[] = UNAVAILABLE;
const TRIGGERS: Readonly<Record<EndoObservationPointV0, readonly EndoObservationTriggerV0[]>> = {
	"before-send": ["send-approved"],
	"after-run": ["run-settled", "workbench-closing"],
	operator: ["operator-command"],
};

const objectId: Check = (v) => typeof v === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v);
const observationId: Check = (v) => typeof v === "string" && /^endo\.observation\.[0-9a-f]{32}$/.test(v);
const attemptId: Check = (v) => typeof v === "string" && /^endo\.attempt\.[0-9a-f]{32}$/.test(v);
const stamp: Check = (v) => count(v) && v <= 8.64e15;
const distinct = (x: unknown): boolean => new Set(x as unknown[]).size === (x as unknown[]).length;
/** A path relative to the top of the tree, as the protocol allows it. It is shown through `shownPath`, never as markup. */
export const relativePath: Check = (v) =>
	typeof v === "string" &&
	v !== "" &&
	v.length <= 4096 &&
	!v.includes("\0") &&
	v.isWellFormed() &&
	!v.startsWith("/") &&
	!v.split("/").some((part) => part === "" || part === "." || part === "..");
const branch: Check = (v) =>
	typeof v === "string" && v.startsWith("refs/") && v.length <= 1024 && v.isWellFormed() && !/[\0-\x1f\x7f]/.test(v);

const REPLACEMENT = String.fromCharCode(0xfffd);
const hidden = (c: number): boolean =>
	c < 0x20 ||
	(c >= 0x7f && c <= 0x9f) ||
	c === 0x2028 ||
	c === 0x2029 ||
	(c >= 0x202a && c <= 0x202e) ||
	(c >= 0x2066 && c <= 0x2069) ||
	c === 0x200e ||
	c === 0x200f ||
	c === 0x061c;
/** A path or branch as shown: control and direction characters replaced, so a name cannot reorder or break the line it is on. */
export const shownPath = (path: string): string =>
	Array.from(path, (ch) => (hidden(ch.codePointAt(0) as number) ? REPLACEMENT : ch)).join("");

const comparison: Check = (v) =>
	shape(v, { relation: one("same") }) ||
	shape(v, { relation: one("not-compared"), reason: one(...keys(NOT_COMPARED_TEXT)) }) ||
	(shape(v, {
		relation: one("different"),
		paths: (p) =>
			list((x) => shape(x, { path: relativePath, change: one("added", "deleted", "modified", "mode") }))(p) &&
			(p as unknown[]).length >= 1 &&
			(p as unknown[]).length <= 200,
		total: count,
	}) &&
		(v as { total: number }).total >= (v as { paths: unknown[] }).paths.length);

const headMove: Check = (v) =>
	shape(v, { from: objectId, to: objectId, ahead: eitherNull(count), descends: eitherNull(bool) });

const observation: Check = (v) =>
	shape(v, {
		id: observationId,
		point: one(...keys(OBSERVATION_POINT_LABELS)),
		trigger: one(...keys(OBSERVATION_TRIGGER_TEXT)),
		startedAtMs: stamp,
		endedAtMs: stamp,
		bound: eitherNull(one("this-send", "other-send")),
		state: one("observed", "unavailable"),
		reason: eitherNull(one(...UNAVAILABLE)),
		commit: eitherNull(objectId),
		branch: eitherNull(branch),
		here: eitherNull(bool),
		changed: count,
		complete: bool,
		truncated: bool,
		paths: (p) =>
			list((x) =>
				shape(x, {
					path: relativePath,
					areas: (a) =>
						list(one("conflicted", "staged", "unstaged", "untracked"))(a) &&
						(a as unknown[]).length >= 1 &&
						distinct(a),
					content: one("file", "absent", "not-read"),
				}),
			)(p) && (p as unknown[]).length <= 100,
	});

export const provenance_: Check = (v) =>
	shape(v, {
		state: one("observed", "none", "unreadable"),
		observations: (x) => list(observation)(x) && (x as unknown[]).length <= 50,
		basis: eitherNull(one(...keys(BASIS_TEXT))),
		start: eitherNull(observationId),
		end: eitherNull(observationId),
		head: eitherNull(headMove),
		span: eitherNull(comparison),
		now: eitherNull((n) =>
			shape(n, { observedAtMs: stamp, commit: eitherNull(objectId), head: eitherNull(headMove), comparison }),
		),
		checked: (x) =>
			list((c) => shape(c, { commit: objectId, receipts: (r) => count(r) && r >= 1, comparison }))(x) &&
			(x as unknown[]).length <= 4,
		overlaps: (x) => list(attemptId)(x) && distinct(x),
		notes: (x) => list(one(...keys(PROVENANCE_NOTE_TEXT)))(x) && distinct(x),
	});

function observationCoherent(o: EndoObservationViewV0): boolean {
	if (o.endedAtMs < o.startedAtMs) return false;
	if (!TRIGGERS[o.point].includes(o.trigger)) return false;
	if ((o.point === "operator") !== (o.bound === null)) return false;
	if (o.state === "unavailable")
		return (
			o.reason !== null &&
			o.commit === null &&
			o.branch === null &&
			o.here === null &&
			o.changed === 0 &&
			!o.complete &&
			!o.truncated &&
			o.paths.length === 0
		);
	if (o.reason !== null || o.commit === null) return false;
	if (o.paths.length !== Math.min(o.changed, 100)) return false;
	if (o.complete && (o.truncated || o.paths.some((p) => p.content === "not-read"))) return false;
	return true;
}

/** A comparison that claims an answer is between two complete states. */
const answered = (c: EndoStateComparisonV0): boolean => c.relation !== "not-compared";

/** Whether an attempt's provenance agrees with itself. */
export function provenanceCoherent(p: EndoAttemptProvenanceViewV0): boolean {
	if (p.state !== "observed")
		return (
			p.observations.length === 0 &&
			p.basis === null &&
			p.start === null &&
			p.end === null &&
			p.head === null &&
			p.span === null &&
			p.now === null &&
			p.checked.length === 0 &&
			p.overlaps.length === 0
		);
	if (new Set(p.observations.map((o) => o.id)).size !== p.observations.length) return false;
	if (!p.observations.every(observationCoherent)) return false;
	for (let i = 1; i < p.observations.length; i++)
		if (
			(p.observations[i] as EndoObservationViewV0).startedAtMs <
			(p.observations[i - 1] as EndoObservationViewV0).startedAtMs
		)
			return false;
	const find = (id: string | null): EndoObservationViewV0 | null | undefined =>
		id === null ? null : p.observations.find((o) => o.id === id);
	const start = find(p.start);
	const end = find(p.end);
	if (start === undefined || end === undefined) return false;
	if (p.basis === null) {
		if (
			start !== null ||
			end !== null ||
			p.head !== null ||
			p.span !== null ||
			p.now !== null ||
			p.checked.length > 0
		)
			return false;
		return p.overlaps.length === 0;
	}
	const need = BASIS_POINTS[p.basis];
	if ((start?.point ?? null) !== need.start || !need.end.includes(end?.point ?? null)) return false;
	for (const o of [start, end]) if (o !== null && (o.state !== "observed" || o.bound === "other-send")) return false;
	if (start !== null && end !== null && end.startedAtMs < start.endedAtMs) return false;
	const both = start !== null && end !== null;
	if ((p.head !== null) !== both || (p.span !== null) !== both) return false;
	if (p.head !== null && !(start !== null && end !== null && moves(p.head, start.commit, end.commit))) return false;
	if (p.span !== null && answered(p.span) && !(start?.complete && end?.complete)) return false;
	const latest = end ?? start;
	if (latest === null) return false;
	if (p.now !== null) {
		if (p.now.commit === null && (p.now.head !== null || answered(p.now.comparison))) return false;
		if (p.now.head !== null && !moves(p.now.head, latest.commit, p.now.commit)) return false;
		if (answered(p.now.comparison) && !latest.complete) return false;
	}
	if (!distinct(p.checked.map((c) => c.commit))) return false;
	if (p.checked.some((c) => answered(c.comparison) && !latest.complete)) return false;
	if (p.overlaps.length > 0 && !both) return false;
	return true;
}

function moves(h: EndoHeadMoveV0, from: string | null, to: string | null): boolean {
	if (h.from !== from || h.to !== to) return false;
	return h.from !== h.to || (h.ahead === 0 && h.descends === true);
}
