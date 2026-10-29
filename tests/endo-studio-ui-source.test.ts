// What the Studio frontend's source is allowed to contain. The frontend shows text from a store, so it must have no way to turn that text
// into markup, a request, a style or a script; it must reach nothing outside the Studio server; and it must run nothing in the
// background. These are facts about the source, held here so a later change that breaks one fails a test rather than a review. (They are
// the rules the page this frontend replaces was held to, carried over, plus the rules that are new with React.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../studio-ui/", import.meta.url));
const sourceDir = join(root, "src");
const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
const files = walk(sourceDir).map((path) => relative(sourceDir, path));
const read = (path: string) => readFileSync(join(sourceDir, path), "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const scripts = files.filter((name) => /\.tsx?$/.test(name));
const sources = Object.fromEntries(scripts.map((name) => [name, code(read(name))]));
const specifiers = (text: string) =>
	[...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map(
		(match) => ({
			typeOnly: match[1] !== undefined,
			specifier: match[2]!,
		}),
	);

describe("the frontend's source", () => {
	it("is these modules, in these directories", () => {
		expect(files.sort()).toEqual(
			[
				"App.tsx",
				"api.ts",
				"assets.d.ts",
				"main.tsx",
				"model/cells.ts",
				"model/compare.ts",
				"model/compare-wire.ts",
				"compare/CompareWorkspace.tsx",
				"compare/Comparison.tsx",
				"use-compare.ts",
				"use-develop.ts",
				"use-workbench.ts",
				"develop/Live.tsx",
				"model/workbench.ts",
				"model/workbench-wire.ts",
				"develop/Activity.tsx",
				"develop/DevelopWorkspace.tsx",
				"develop/Navigator.tsx",
				"develop/SessionInspector.tsx",
				"model/develop.ts",
				"model/develop-wire.ts",
				"model/contract.ts",
				"model/labels.ts",
				"model/detail.ts",
				"model/observe.ts",
				"model/reply.ts",
				"model/state.ts",
				"model/timeline.ts",
				"model/types.ts",
				"model/views.ts",
				"observe/Attention.tsx",
				"observe/Chrome.tsx",
				"observe/EventTable.tsx",
				"observe/Inspector.tsx",
				"observe/ObserveWorkspace.tsx",
				"observe/Overview.tsx",
				"observe/Side.tsx",
				"observe/Unavailable.tsx",
				"studio.css",
				"ui/Panel.tsx",
				"ui/marks.tsx",
				"ui/text.tsx",
				"ui/use-narrow.ts",
				"use-observe.ts",
			].sort(),
		);
	});

	it("imports its own modules, React, and the protocol only as types: nothing of the protocol or the bridge runs in the browser", () => {
		for (const [name, text] of Object.entries(sources)) {
			for (const { typeOnly, specifier } of specifiers(text)) {
				if (specifier.startsWith("./") || specifier.startsWith("../")) {
					if (/protocol\//.test(specifier)) {
						expect(specifier, `${name}: ${specifier}`).toMatch(/^(\.\.\/)+protocol\/[a-z-]+\.ts$/);
						expect(typeOnly, `${name}: ${specifier} must be a type import`).toBe(true);
					} else if (/cockpit-ui\//.test(specifier)) {
						// the pure modules shared with the page this replaces: labels, model, reply (see model/contract.ts)
						expect(name, specifier).toBe("model/contract.ts");
						expect(specifier).toMatch(/^\.\.\/\.\.\/\.\.\/cockpit-ui\/src\/(labels|model|reply)\.ts$/);
					} else {
						expect(specifier, `${name}: ${specifier}`).toMatch(/^(\.\/|\.\.\/)[A-Za-z0-9_./-]+\.(ts|tsx|css)$/);
						expect(specifier, `${name}: ${specifier}`).not.toMatch(
							/(^|\/)(cockpit|cockpit-http|storage|runtime|cli|tests|scripts)\//,
						);
					}
				} else {
					expect(specifier, `${name}: ${specifier}`).toMatch(/^(react|react-dom\/client)$|^\.\/studio\.css$/);
				}
			}
			expect(text, name).not.toMatch(/from "node:|require\(/);
		}
		// One dynamic import, and it is a module of this directory: the placeholder workspaces, loaded on demand.
		const dynamic = Object.entries(sources).flatMap(([name, text]) =>
			[...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => `${name}: ${m[1]}`),
		);
		expect(dynamic).toEqual(["App.tsx: ./observe/Unavailable.tsx"]);
		for (const text of Object.values(sources)) expect(text).not.toMatch(/\bimport\(\s*[^"'\s]/);
	});

	it("has no way to make markup, run code from text, or reach anything outside the page's own server", () => {
		const forbidden: [string, RegExp][] = [
			[
				"an HTML sink",
				/\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|srcdoc|DOMParser)\b/,
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
			["a script-set style attribute", /setAttribute\(\s*["']style|\.style\.|cssText|<style/],
			["logging", /\bconsole\./],
			["an animation or polling loop", /\b(requestAnimationFrame|setInterval|requestIdleCallback)\b/],
			["an absolute address", /https?:\/\//],
			["a raw target attribute that opens something", /\btarget=|\bhref=\{/],
			[
				"telemetry or a hosted service",
				/supabase|analytics|telemetry|posthog|sentry|segment\.com|googletagmanager/i,
			],
		];
		for (const [name, text] of Object.entries(sources))
			for (const [what, pattern] of forbidden) expect(text, `${name}: ${what}`).not.toMatch(pattern);
		// A style prop is set through the CSS object model, which the page policy allows. It is used in two places and no others.
		const styled = Object.entries(sources)
			.filter(([, text]) => /\bstyle=\{/.test(text))
			.map(([name]) => name)
			.sort();
		expect(styled).toEqual(["observe/Overview.tsx"]);
	});

	it("uses fetch in exactly one place, relative to the page, the exact Observe, Compare and Develop routes, with no credentials, no referrer and no redirect", () => {
		const users = Object.entries(sources)
			.filter(([, text]) => /\bfetch\(/.test(text))
			.map(([name]) => name);
		expect(users).toEqual(["api.ts"]);
		const api = sources["api.ts"]!;
		expect(api).toMatch(
			/new URL\(\s*`\.\/api\/v0\/snapshot\?afterSequence=\$\{request\.afterSequence\}&limit=\$\{request\.limit\}`,\s*document\.baseURI/,
		);
		expect(api.match(/\/api\//g)?.length).toBe(11);
		// The workbench routes: one fixed prefix, a closed list; the grant only in one header, never in a URL or the body.
		expect(api.match(/\.\/api\/v0\/workbench\//g)?.length).toBe(6);
		for (const route of ["status", "transcript", "pair", "prompt/propose", "prompt/discard"])
			expect(api).toContain(`./api/v0/workbench/${route}`);
		expect(api).toMatch(/\.\/api\/v0\/workbench\/prompt\/\$\{request\.proposalId\}/);
		expect(api).toContain('"X-Endo-Grant"');
		expect(api).not.toMatch(/grant=|\?grant|localStorage|sessionStorage|document\.cookie/);
		expect(api).toContain("./api/v0/develop/sessions");
		expect(api).toMatch(/\.\/api\/v0\/develop\/session\/\$\{request\.selector\}/);
		expect(api).toMatch(/developSelector/);
		expect(api).toMatch(/activityCursor/);
		expect(api).toMatch(/sessionsCursor/);
		expect(api).toContain("./api/v0/compare/candidates");
		expect(api).toContain("./api/v0/compare/selected/");
		expect(api).not.toMatch(/request\.pair\.[ab]\.session/);
		expect(api).toMatch(/opaqueSelector/);
		expect(api).toMatch(/candidateCursor/);
		expect(api).toMatch(/AbortSignal\.any/);
		for (const pattern of [
			/credentials: "omit"/,
			/referrerPolicy: "no-referrer"/,
			/redirect: "error"/,
			/cache: "no-store"/,
			/method: "GET"/,
		])
			expect(api).toMatch(pattern);
	});

	it("starts one read at a time and never polls: one read at open, one timeout to resume after a 429, nothing else scheduled", () => {
		const hook = sources["use-observe.ts"]!;
		expect(hook.match(/setTimeout\(/g)?.length).toBe(1);
		expect(hook).toMatch(/if \(running\.current \|\| pacedNow\(latest\.current, performance\.now\(\)\)\) return;/);
		expect(hook.match(/load\(\{ afterSequence: 0/g)?.length).toBe(1); // the read at open
		for (const [name, text] of Object.entries(sources))
			if (
				name !== "use-observe.ts" &&
				name !== "use-compare.ts" &&
				name !== "use-develop.ts" &&
				name !== "use-workbench.ts"
			)
				expect(text, name).not.toMatch(/setTimeout|setInterval/);
		// DEVELOP has the same shape as Compare: one request at a time, one timer (the pause), a read at first entry and on action only.
		const develop = sources["use-develop.ts"]!;
		expect(develop.match(/setTimeout\(/g)?.length).toBe(1);
		expect(develop).toContain("if (sequence.current !== id) return;");
		expect(develop).toContain("if (active && !entered.current)");
		expect(develop).toContain("if (paced(latest.current, performance.now())) return;");
		for (const [name, text] of Object.entries(sources))
			if (name !== "api.ts" && name !== "use-develop.ts") expect(text, name).not.toMatch(/fetchDevelop/);
		// The workbench hook: ONE timer, set only after a read ends and only while a prompt waits or Follow is on (opt-in), never while the
		// page is hidden; the only fetch of the workbench is behind it; no interval and no animation frame anywhere.
		const wb = sources["use-workbench.ts"]!;
		expect(wb.match(/setTimeout\(/g)?.length).toBe(1);
		expect(wb).not.toMatch(/setInterval|requestAnimationFrame/);
		expect(wb).toContain("if (running.current) return;");
		expect(wb).toContain("document.hidden");
		expect(wb).toContain("if (!s.follow && !commandOpen(s.command)) return;");
		for (const [name, text] of Object.entries(sources))
			if (name !== "api.ts" && name !== "use-workbench.ts") expect(text, name).not.toMatch(/fetchWorkbench/);
		expect(sources["use-compare.ts"]!.match(/setTimeout\(/g)?.length).toBe(1);
		expect(sources["use-compare.ts"]).toContain("if (sequence.current !== id) return;");
		expect(sources["use-compare.ts"]).toContain("if (active && !entered.current)");
		for (const [name, text] of Object.entries(sources))
			if (name !== "api.ts" && name !== "use-compare.ts") expect(text, name).not.toMatch(/fetchCompare/);
		// Only the hook starts a read; a component calls what the hook returns.
		for (const [name, text] of Object.entries(sources))
			if (name !== "api.ts" && name !== "use-observe.ts") expect(text, name).not.toMatch(/fetchSnapshot/);
	});

	it("keeps model/ free of the browser, the clock and randomness, and keeps the one place that fetches outside it", () => {
		for (const [name, text] of Object.entries(sources)) {
			if (!name.startsWith("model/")) continue;
			expect(text, name).not.toMatch(
				/(?<![\w.])(document|window|navigator)\.[A-Za-z_]|\bfetch\(|\blocalStorage\b|Date\.now|new Date\(\s*\)|Math\.random|\bperformance\.|setTimeout|from "react/,
			);
			// `import type` of the protocol, or its own modules: no module of model/ reaches the components or the hook.
			for (const { specifier } of specifiers(text))
				expect(specifier, `${name}: ${specifier}`).not.toMatch(/^\.\.\/(observe|ui|api|use-observe|App)/);
		}
	});

	it("makes text a React child only: no component builds an element from a record's string", () => {
		for (const [name, text] of Object.entries(sources)) {
			expect(text, name).not.toMatch(/createElement\(\s*[^"'\s]/); // a computed tag name
		}
	});
});

describe("the page, style sheet and icon", () => {
	const html = readFileSync(join(root, "index.html"), "utf8");
	const css = read("studio.css");

	it("is a template of one module script and one style sheet from its own assets, and no inline script", () => {
		const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
		expect(tags.length).toBe(1);
		expect(tags[0]![1]).toMatch(/type="module"/);
		expect(tags[0]![1]).toMatch(/src="\.\/assets\/\{\{SCRIPT\}\}"/);
		expect(tags[0]![2]!.trim()).toBe("");
		for (const match of html.matchAll(/\b(?:href|src|action)="([^"]*)"/g))
			expect(match[1], match[0]).toMatch(/^\.\/assets\/(\{\{STYLE\}\}|\{\{SCRIPT\}\}|icon\.svg)$/);
		expect(html).not.toMatch(/\son[a-z]+=|\sstyle=|<style|<iframe|<object|<embed|<form|<base|javascript:/i);
		expect(html).toMatch(/<title>Endophasia Studio<\/title>/);
	});

	it("uses no external resource: no import, no remote address, and its only urls are the three bundled font files", () => {
		expect(css).not.toMatch(/@import|https?:|\/\/[a-z]/i);
		const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
		expect(urls).toEqual([
			"@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
			"@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
			"@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
		]);
		expect(css.match(/@font-face/g)?.length).toBe(3);
		expect(css).not.toMatch(/data:/);
	});

	it("honours reduced motion, shows focus, states its tokens once and draws hatching with gradients, not images", () => {
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
		expect(css).toMatch(/:focus-visible/);
		expect(css.match(/:root \{/g)?.length).toBe(1);
		expect(css).toMatch(/color-scheme: dark/);
		expect(css).toMatch(/repeating-linear-gradient/);
	});

	it("runs no animation except the loading spinner, which exists only while the first read is running", () => {
		const animations = [...css.matchAll(/animation:[^;]*;/g)].map((match) => match[0]);
		expect(animations).toEqual(["animation: spin 0.9s linear infinite;", "animation: none;"]);
		expect(css.match(/@keyframes/g)?.length).toBe(1);
	});

	it("keeps ivory for selection and focus: no provenance, status or flag colour is the selection colour", () => {
		const select = /--select:\s*(#[0-9a-f]{6});/i.exec(css)![1]!.toLowerCase();
		for (const token of ["--obs", "--rep", "--der", "--na", "--attention", "--fault", "--fg-1", "--fg-2", "--fg-3"]) {
			const value = new RegExp(`${token}:\\s*(#[0-9a-f]{6});`, "i").exec(css)?.[1]?.toLowerCase();
			expect(value, token).not.toBe(select);
		}
		// Mixed marks are drawn in a neutral text colour, never the selection's.
		expect(css).toMatch(/\.mk-mixed \{\s*color: var\(--fg-2\);/);
	});
});
