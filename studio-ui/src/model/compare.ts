import type {
	EndoCockpitCompareCandidatesV0,
	EndoCockpitCompareCandidateV0,
} from "../../../protocol/cockpit-candidates.ts";
import type { EndoCockpitTrajectoryComparisonV0 } from "../../../protocol/cockpit-comparison.ts";
import type { CompareReply } from "./compare-wire.ts";

export type Candidate = EndoCockpitCompareCandidateV0;
export type Pair = { a: Candidate; b: Candidate };
export type CompareRequest =
	| { kind: "discover" }
	| { kind: "more"; cursor: string; generation: string }
	| { kind: "compare"; generation: string; pair: Pair };
export interface CompareState {
	inventory: EndoCockpitCompareCandidatesV0 | null;
	a: Candidate | null;
	b: Candidate | null;
	request: { id: number; read: CompareRequest } | null;
	result: { pair: Pair; record: EndoCockpitTrajectoryComparisonV0 } | null;
	problem: string | null;
	invalid: boolean;
	holdUntil: number;
}
export const initialCompare = (): CompareState => ({
	inventory: null,
	a: null,
	b: null,
	request: null,
	result: null,
	problem: null,
	invalid: false,
	holdUntil: 0,
});
export type CompareAction =
	| { type: "start"; id: number; read: CompareRequest }
	| { type: "finish"; id: number; reply: CompareReply; now: number }
	| { type: "choose"; side: "a" | "b"; value: string }
	| { type: "cancel" }
	| { type: "tick" };
export const candidateValue = (c: Candidate): string => `${c.source}:${c.selector}`;
export function reduceCompare(state: CompareState, action: CompareAction): CompareState {
	if (action.type === "tick") return { ...state };
	if (action.type === "cancel")
		return state.request === null
			? state
			: { ...state, request: null, problem: "Request interrupted. Retry explicitly.", result: null };
	if (action.type === "choose") {
		const candidate =
			state.inventory?.candidates.find(
				(c) => c.eligibility === "selectable" && c.selector !== null && candidateValue(c) === action.value,
			) ?? null;
		return {
			...state,
			[action.side]: candidate,
			request: null,
			result: null,
			problem: state.holdUntil > 0 ? state.problem : null,
		};
	}
	if (action.type === "start")
		return {
			...(action.read.kind === "discover" ? { ...initialCompare(), holdUntil: state.holdUntil } : state),
			request: { id: action.id, read: action.read },
			result: null,
			problem: null,
			invalid: false,
		};
	if (state.request === null || state.request.id !== action.id) return state;
	const { read } = state.request;
	const fail = (message: string, invalid = false): CompareState => ({
		...(invalid ? initialCompare() : state),
		request: null,
		result: null,
		problem: message,
		invalid,
		holdUntil: state.holdUntil,
	});
	const reply = action.reply;
	if (reply.kind === "failure")
		return {
			...fail(reply.message, reply.invalid),
			holdUntil: reply.retrySeconds === null ? state.holdUntil : action.now + reply.retrySeconds * 1000,
		};
	if (reply.kind === "candidates" && read.kind !== "compare") {
		const page = reply.record;
		if (read.kind === "discover" && page.page.offset !== 0)
			return fail("Discovery did not start at the first page. Rediscover recordings.", true);
		if (read.kind === "discover") return { ...state, inventory: page, request: null, problem: null };
		const held = state.inventory;
		if (
			held === null ||
			held.generation !== read.generation ||
			page.generation !== held.generation ||
			page.page.offset !== held.candidates.length ||
			page.page.total !== held.page.total ||
			held.page.nextCursor !== read.cursor
		)
			return fail("Discovery pages do not belong to one verified inventory. Rediscover recordings.", true);
		const combined = [...held.candidates, ...page.candidates];
		const identities = combined.map((c) => `${c.source}:${c.session}`);
		const selectors = combined.filter((c) => c.selector !== null).map(candidateValue);
		if (
			new Set(selectors).size !== selectors.length ||
			new Set(identities).size !== combined.length ||
			identities.some((id, i) => i > 0 && id <= identities[i - 1]!)
		)
			return fail("Discovery continuation repeated or reordered a recording. Rediscover recordings.", true);
		return { ...state, request: null, inventory: { ...page, candidates: combined }, problem: null };
	}
	if (
		reply.kind === "comparison" &&
		read.kind === "compare" &&
		state.inventory?.generation === read.generation &&
		state.a !== null &&
		state.b !== null &&
		candidateValue(state.a) === candidateValue(read.pair.a) &&
		candidateValue(state.b) === candidateValue(read.pair.b) &&
		reply.record.a.session === read.pair.a.session &&
		reply.record.b.session === read.pair.b.session
	)
		return { ...state, request: null, result: { pair: read.pair, record: reply.record }, problem: null };
	return fail("The response does not match the requested recording pair or contract. Rediscover recordings.", true);
}
