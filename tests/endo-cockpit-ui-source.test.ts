// What the page's source is allowed to contain. The page shows text from a store, so it must have no way to turn that text into
// markup, a request, a style or a script; it must reach nothing outside the cockpit server; and it must run nothing in the
// background. These are facts about the source, held here so a later change that breaks one fails a test rather than a review.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../cockpit-ui/", import.meta.url));
const sourceDir = join(root, "src");
const names = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"));
const read = (path: string) => readFileSync(path, "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const sources = Object.fromEntries(names.map((name) => [name, code(read(join(sourceDir, name)))]));
const specifiers = (text: string) =>
	[...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map(
		(match) => ({
			typeOnly: match[1] !== undefined,
			specifier: match[2]!,
		}),
	);

describe("the page's source", () => {
	it("has the modules the design names, flat, in one directory", () => {
		expect(names.sort()).toEqual(
			[
				"api.ts",
				"dom.ts",
				"icons.ts",
				"labels.ts",
				"main.ts",
				"model.ts",
				"render-capabilities.ts",
				"render-chrome.ts",
				"render-inspector.ts",
				"render-runtime.ts",
				"render-sources.ts",
				"render-timeline.ts",
				"reply.ts",
				"state.ts",
				"widgets.ts",
			].sort(),
		);
	});

	it("imports its own modules, and the protocol only as types: nothing of the protocol or the bridge runs in the browser", () => {
		for (const [name, text] of Object.entries(sources))
			for (const { typeOnly, specifier } of specifiers(text)) {
				if (specifier.startsWith("./")) continue;
				expect(specifier, `${name}: ${specifier}`).toMatch(/^\.\.\/\.\.\/protocol\/[a-z-]+\.ts$/);
				expect(typeOnly, `${name}: ${specifier} must be a type import`).toBe(true);
			}
		for (const [name, text] of Object.entries(sources)) {
			expect(text, name).not.toMatch(/from "node:|require\(|\bimport\(/);
		}
	});

	it("has no way to make markup, run code from text, or reach anything outside the page's own server", () => {
		const forbidden: [string, RegExp][] = [
			[
				"an HTML sink",
				/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|srcdoc|DOMParser)\b/,
			],
			["dynamic code", /\b(eval|Function)\s*\(|\bnew\s+Function\b|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/],
			[
				"a request channel other than fetch",
				/\b(XMLHttpRequest|EventSource|WebSocket|sendBeacon|postMessage|BroadcastChannel|SharedWorker|Worker\(|serviceWorker)\b/,
			],
			["storage", /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches\b)/],
			[
				"the page's own address",
				/\b(window\.location|document\.location|location\.(href|search|hash|pathname|origin|assign|replace|reload)|history\.(push|replace|go|back)|document\.URL|document\.referrer|window\.name)/,
			],
			[
				"navigation or a loaded script",
				/\.(href|src|action|formAction)\s*=|createElement\(\s*["'](script|iframe|link|object|embed|form|base)["']\)/,
			],
			["inline style", /setAttribute\(\s*["']style|\.style\.|cssText/],
			["logging", /\bconsole\./],
			["an animation or polling loop", /\b(requestAnimationFrame|setInterval|requestIdleCallback)\b/],
			["an absolute address", /https?:\/\//],
		];
		for (const [name, text] of Object.entries(sources)) {
			const checked = name === "dom.ts" ? text.replace('"http://www.w3.org/2000/svg"', '""') : text; // the SVG namespace is a name, not a request
			for (const [what, pattern] of forbidden) expect(checked, `${name}: ${what}`).not.toMatch(pattern);
		}
	});

	it("uses fetch in exactly one place, relative to the page, with no credentials, no referrer and no redirect", () => {
		const users = Object.entries(sources)
			.filter(([, text]) => /\bfetch\(/.test(text))
			.map(([name]) => name);
		expect(users).toEqual(["api.ts"]);
		const api = sources["api.ts"]!;
		expect(api).toMatch(
			/new URL\(\s*`\.\/api\/v0\/snapshot\?afterSequence=\$\{request\.afterSequence\}&limit=\$\{request\.limit\}`,\s*document\.baseURI/,
		);
		expect(api).toMatch(/credentials: "omit"/);
		expect(api).toMatch(/referrerPolicy: "no-referrer"/);
		expect(api).toMatch(/redirect: "error"/);
		expect(api).toMatch(/cache: "no-store"/);
		expect(api).toMatch(/method: "GET"/);
	});

	it("starts one read at a time and never polls: one read at open, one timeout to resume after a 429, nothing else scheduled", () => {
		const main = sources["main.ts"]!;
		expect(main.match(/setTimeout\(/g)?.length).toBe(1);
		expect(main.match(/actions\.refresh\(\);/g)?.length).toBeGreaterThanOrEqual(1);
		expect(main).toMatch(/if \(state\.busy \|\| pacedNow\(state\)\) return;/);
		for (const [name, text] of Object.entries(sources))
			if (name !== "main.ts") expect(text, name).not.toMatch(/setTimeout|setInterval/);
	});

	it("keeps the pure modules free of the browser, the clock and randomness", () => {
		for (const name of ["model.ts", "reply.ts", "labels.ts"])
			expect(sources[name], name).not.toMatch(
				/(?<![\w.])(document|window|navigator)\.|\bfetch\(|\blocalStorage\b|\bDate\b|Math\.random|\bperformance\./,
			);
	});

	it("allows only a short list of attributes on the elements it makes, and none that loads or runs anything", () => {
		const dom = read(join(sourceDir, "dom.ts"));
		const list = /const ATTRIBUTES = \[([\s\S]*?)\] as const;/.exec(dom)![1]!;
		for (const name of list.matchAll(/"([^"]+)"/g))
			expect(name[1], name[1]).not.toMatch(/^on|^style$|^href$|^src$|srcdoc|action|xlink|formaction/i);
	});
});

describe("the page, style sheet and icon", () => {
	const html = read(join(root, "index.html"));
	const css = read(join(root, "cockpit.css"));

	it("loads only its own files, by relative address, and runs no inline script", () => {
		const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
		expect(scripts.length).toBe(1);
		expect(scripts[0]![1]).toMatch(/type="module"/);
		expect(scripts[0]![1]).toMatch(/src="\.\/assets\/main\.js"/);
		expect(scripts[0]![2].trim()).toBe("");
		for (const match of html.matchAll(/\b(?:href|src|action)="([^"]*)"/g))
			expect(match[1], match[0]).toMatch(/^(\.\/assets\/[a-z.-]+|#[a-z]+)$/);
		expect(html).not.toMatch(/\son[a-z]+=|\sstyle=|<style|<iframe|<object|<embed|<form|<base|javascript:/i);
	});

	it("uses no external resource: no import, font, image address or remote reference in the style sheet", () => {
		expect(css).not.toMatch(/@import|@font-face|url\(|https?:|\/\/[a-z]/i);
	});

	it("honours reduced motion, shows focus, and states its tokens once", () => {
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
		expect(css).toMatch(/:focus-visible/);
		expect(css.match(/:root \{/g)?.length).toBe(1);
		expect(css).toMatch(/color-scheme: dark/);
	});

	it("runs no animation except the reading bar, which is off unless a read is in flight", () => {
		const animations = [...css.matchAll(/animation:[^;]*;/g)].map((match) => match[0]);
		expect(animations.length).toBe(2); // the declaration and its reduced-motion override
		expect(css).toMatch(/body\[data-busy="true"\] \.topbar::after \{[^}]*animation: reading/);
	});
});
