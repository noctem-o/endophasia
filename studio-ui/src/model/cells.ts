// The small values every view model is made of. Pure, like everything in model/: the components that draw these do no formatting, so a
// value that cannot be presented fails here, where a read can still be refused, and never while a panel is being drawn.
import type { EndoCockpitBasisV0 } from "../../../protocol/cockpit.ts";
import { ALIAS_PATTERN, abbreviated, BASIS, known, presentText, WITHHELD_TEXT } from "./contract.ts";

/** A string from the contract, told apart by what it is: ordinary text, the policy's withheld sentinel, or a generated alias. */
export interface TextModel {
	kind: "text" | "withheld" | "alias";
	/** What is drawn: the (possibly cut) value, the word "withheld", or the start of an alias token. */
	shown: string;
	/** The whole value, for hover. For the withheld sentinel, the policy's sentence. */
	full: string;
	mono: boolean;
}

export function textModel(value: string, options: { mono?: boolean; keep?: number } = {}): TextModel {
	if (typeof value !== "string") throw new TypeError("a text the record should hold is missing");
	const presented = presentText(value);
	const mono = options.mono === true;
	if (presented.kind === "withheld") return { kind: "withheld", shown: "withheld", full: WITHHELD_TEXT, mono };
	if (presented.kind === "alias") {
		const token = ALIAS_PATTERN.exec(value)?.[0] ?? value;
		return { kind: "alias", shown: `${token.slice(0, 17)}…`, full: value, mono };
	}
	return {
		kind: "text",
		shown: options.keep === undefined ? value : abbreviated(value, options.keep),
		full: value,
		mono,
	};
}

/** A contract string as plain text, for where an element cannot go (an option): the withheld sentinel and an alias are named as such. */
export function labelText(value: string): string {
	const model = textModel(value);
	return model.kind === "withheld" ? "withheld" : model.kind === "alias" ? `alias ${model.shown}` : value;
}

/** How a value is known. `unknown` is a basis this build does not know: shown as what it is, never given a meaning. */
export interface BasisMark {
	basis: string;
	/** The three-letter mark, or "?" for a basis this build does not know. */
	short: string;
	label: string;
	meaning: string;
	known: boolean;
}

export function basisMark(basis: EndoCockpitBasisV0 | "unavailable" | string): BasisMark {
	const described = known(BASIS, basis);
	return described === null
		? {
				basis,
				short: "?",
				label: `unknown basis ${basis}`,
				meaning: "A basis this build does not know.",
				known: false,
			}
		: { basis, short: described.short, label: described.label, meaning: described.meaning, known: true };
}

/** What a cell holds. Components switch over this and over nothing else; no component formats a contract value itself. */
export type Cell =
	| { k: "plain"; text: string }
	| { k: "mono"; text: string; title?: string }
	| { k: "dim"; text: string; title?: string }
	| {
			k: "text";
			text: TextModel /** What a copy button would copy, named, for an identifier shown in full: never for a withheld value or an alias. */;
			copy?: string;
	  }
	| { k: "unavailable"; reason: TextModel }
	| { k: "claim"; basis: BasisMark; inner: Cell }
	| { k: "parts"; parts: Cell[] }
	| { k: "list"; items: Cell[] }
	| { k: "disclosure"; summary: string; body: string; title?: string };

export interface Fact {
	label: string;
	cell: Cell;
}

/**
 * A string the record should hold. A value that is not there is an error here, where a read can still be refused, never a blank cell
 * and never the word "undefined": every string built from a record's own field passes through here or through `textModel`.
 */
export function str(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("a text the record should hold is missing");
	return value;
}

export const plain = (text: string): Cell => ({ k: "plain", text: str(text) });
export const mono = (text: string, title?: string): Cell =>
	title === undefined ? { k: "mono", text: str(text) } : { k: "mono", text: str(text), title };
export const dim = (text: string, title?: string): Cell =>
	title === undefined ? { k: "dim", text: str(text) } : { k: "dim", text: str(text), title };
export const textCell = (value: string, options: { mono?: boolean; keep?: number; copy?: string } = {}): Cell => {
	const text = textModel(value, options);
	// Only an ordinary string, as it is presented, can be copied: a withheld sentinel and a generated alias stand in for what is not shown.
	return options.copy !== undefined && text.kind === "text"
		? { k: "text", text, copy: options.copy }
		: { k: "text", text };
};
export const parts = (...items: Cell[]): Cell => ({ k: "parts", parts: items });

/** A value that is not there, with the reason the record gives. Never a blank and never a zero. */
export const unavailableCell = (reason: string): Cell => ({ k: "unavailable", reason: textModel(reason) });

/** A claim: its value with its basis, or the unavailable mark and its reason. */
export function claimCell<T>(
	value: { basis: EndoCockpitBasisV0; value: T } | { basis: "unavailable"; reason: string },
	show: (value: T) => Cell,
): Cell {
	return value.basis === "unavailable"
		? unavailableCell(value.reason)
		: { k: "claim", basis: basisMark(value.basis), inner: show(value.value) };
}
