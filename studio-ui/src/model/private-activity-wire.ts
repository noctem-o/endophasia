// Browser wire gate for private activity (protocol/private-activity.ts). Closed shapes: an unknown member, a field a kind cannot carry, or
// a reference a kind does not have refuses the whole transcript page.
import type { ActivityDescriptor, PrivateActivity } from "../../../protocol/private-activity.ts";
import { type Check, count, eitherNull, one, shape } from "./compare-wire.ts";

const labels = [
	"Command",
	"Directory",
	"Timeout",
	"Path",
	"Offset",
	"Limit",
	"Edits",
	"Content",
	"Arguments",
	"Exit code",
	"Output",
] as const;
/** The fields a non-tool report may carry: no command, no output, no exit status. */
const REPORT_LABELS: Readonly<Record<"file-change" | "activity", readonly string[]>> = {
	"file-change": ["Path", "Edits"],
	activity: ["Path", "Arguments"],
};

const field: Check = (v) => {
	if (shape(v, { label: one(...labels), state: one("unavailable", "withheld") })) return true;
	if (
		!shape(v, {
			label: one(...labels),
			state: one("counted", "truncated", "reported"),
			text: (x) => typeof x === "string" && x.length <= 512 && new TextEncoder().encode(x).length <= 512,
		})
	)
		return false;
	if (v.label === "Edits") return v.state === "counted" && /^\d{1,10}$/.test(v.text as string);
	if (v.state === "counted" || v.label === "Arguments" || v.label === "Content") return false;
	return v.state !== "truncated" || v.label === "Output";
};

const basis = one("assessed", "observed", "advertised", "unavailable", "unknown");
const all = (keys: readonly string[]): Record<string, Check> => Object.fromEntries(keys.map((k) => [k, basis]));
export const validActivityDescriptor = (v: unknown): v is ActivityDescriptor =>
	shape(v, {
		observation: (o) =>
			shape(
				o,
				all([
					"nativeSessionIdentity",
					"stableCallIdentity",
					"toolBoundaries",
					"argumentPreview",
					"resultPreview",
					"fileChanges",
					"subagents",
				]),
			),
		providerControls: (c) => shape(c, all(["interrupt", "steer", "approvals", "toolCancellation", "resume"])),
	});

const ref = eitherNull((x) => typeof x === "string" && /^[a-zA-Z0-9_.:|-]{1,128}$/.test(x));
const name = (x: unknown) =>
	x === "name unavailable" ||
	x === "name withheld" ||
	(typeof x === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(x));
const common: Record<string, Check> = {
	seq: (n) => count(n) && n >= 1,
	occurrence: (n) => count(n) && n >= 1,
	source: (x) => typeof x === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(x),
	category: one("command", "file-read", "file-change", "retrieval", "external", "other"),
	turn: eitherNull((n) => count(n) && n > 0),
	fields: (x) =>
		Array.isArray(x) && x.length <= 3 && x.every(field) && new Set(x.map((f) => f.label)).size === x.length,
};
const reported = one("reported", "in-progress", "completed", "failed", "declined", "unknown");

export function isPrivateActivity(v: unknown): v is PrivateActivity {
	if (
		!shape(v, {
			...common,
			kind: one("tool"),
			name,
			callId: ref,
			status: one("requested", "running", "completed", "failed", "unknown"),
		}) &&
		!shape(v, { ...common, kind: one("file-change"), nativeRef: ref, status: reported }) &&
		!shape(v, { ...common, kind: one("activity"), name, nativeRef: ref, status: reported })
	)
		return false;
	const i = v as unknown as PrivateActivity;
	// An open state (or a lone report) is a first observation; a later one names an earlier occurrence.
	const first = i.status === "requested" || i.status === "reported" || i.status === "in-progress";
	if (i.occurrence > i.seq || (first && i.occurrence !== i.seq)) return false;
	if (i.kind === "tool")
		return !(
			(i.status === "running" || i.status === "requested") &&
			i.fields.some((f) => f.label === "Output" || f.label === "Exit code")
		);
	return i.fields.every((f) => REPORT_LABELS[i.kind].includes(f.label));
}
