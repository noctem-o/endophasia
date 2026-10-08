import { describe, expect, it } from "vitest";
import { attachSummaryV0, shellWordV0 } from "../cli/loop-hints.ts";

const base = { root: "/data/store", attachment: undefined, piSessionId: "endo-pi-default-abc", waitMs: 1000 } as const;

describe("attachSummaryV0", () => {
	it("names the recorded session and the read-only commands that inspect it", () => {
		const text = attachSummaryV0({ ...base, prompt: { disposition: "started", settled: true } }).join("\n");
		expect(text).toContain("Pi session id: endo-pi-default-abc");
		expect(text).toContain("endo harness status --root /data/store");
		expect(text).toContain("endo harness overview --root /data/store");
		expect(text).toContain("endo trajectory show --root /data/store endo-pi-default-abc");
	});

	it("separates acceptance from settling and never claims success", () => {
		const settled = attachSummaryV0({ ...base, prompt: { disposition: "started", settled: true } }).join("\n");
		expect(settled).toMatch(/accepted the prompt \(acceptance is not completion\)/);
		expect(settled).toMatch(/reported the run settled/);
		expect(settled).not.toMatch(/succe/i);
		const unsettled = attachSummaryV0({ ...base, prompt: { disposition: "started", settled: false } }).join("\n");
		expect(unsettled).toMatch(/not seen to settle within 1000 ms/);
		const other = attachSummaryV0({ ...base, prompt: { disposition: "queued", settled: null } }).join("\n");
		expect(other).toContain('disposition "queued"');
		expect(other).not.toMatch(/settle/);
	});

	it("says so when no prompt was sent, and invents no session id when Pi reported none", () => {
		const text = attachSummaryV0({ ...base, piSessionId: null, prompt: null }).join("\n");
		expect(text).toMatch(/no prompt was sent/);
		expect(text).toMatch(/no session id/);
		expect(text).not.toContain("trajectory show");
	});

	it("repeats a non-default attachment and quotes awkward paths", () => {
		const text = attachSummaryV0({ ...base, root: "/my data/it's", attachment: "pi.two", prompt: null }).join("\n");
		expect(text).toContain("--root '/my data/it'\\''s' --attachment pi.two");
		expect(shellWordV0("plain/path-1")).toBe("plain/path-1");
	});
});
