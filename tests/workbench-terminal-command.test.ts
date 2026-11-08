// A message whose whole text is the workbench terminal's own command (REVIEW-PILOT-001, run 1): the protocol's rule and the page's mirror.
import { describe, expect, it } from "vitest";
import { endoWorkbenchTerminalCommandInV0 } from "../protocol/workbench.ts";
import { terminalCommandIn, terminalCommandWords } from "../studio-ui/src/model/workbench.ts";

const ID = `endo.attempt.${"a".repeat(32)}`;
const CASES: [string, { command: "attempt" | "pair"; argument: string | null } | null][] = [
	[`attempt ${ID}`, { command: "attempt", argument: ID }],
	[`  attempt   ${ID}\n`, { command: "attempt", argument: ID }],
	["attempt endo.attempt.588db0", { command: "attempt", argument: "endo.attempt.588db0" }],
	["attempt", { command: "attempt", argument: null }],
	["pair", { command: "pair", argument: null }],
	[" pair \n", { command: "pair", argument: null }],
	["attempt it", null],
	["attempt it again, carefully", null],
	[`attempt ${ID} now`, null],
	["Attempt the fix", null],
	["pair programming, please", null],
	["please attempt endo.attempt.x", null],
	["", null],
	["Count to forty", null],
];

describe("the workbench terminal's own command, found in a message", () => {
	it.each(CASES)("%j", (text, expected) => {
		expect(endoWorkbenchTerminalCommandInV0(text)).toEqual(expected);
		// The page decides the same: it keeps its own copy, as it does for every wire rule.
		expect(terminalCommandIn(text)).toEqual(expected);
	});

	it("the page says where each command goes instead", () => {
		expect(terminalCommandWords({ command: "attempt" })).toContain("Type it at the attached terminal");
		expect(terminalCommandWords({ command: "attempt" })).toContain("would not send the attempt's brief");
		expect(terminalCommandWords({ command: "pair" })).toContain("`pair`");
	});
});
