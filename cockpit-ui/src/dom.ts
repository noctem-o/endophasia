// The only way this page makes elements. Text goes in as text nodes and attributes through `setAttribute` from a short fixed
// list, so a string from the API (an event kind, a reason, a name) can never become markup, a URL, a style or a handler. There is no
// innerHTML, no outerHTML and no insertAdjacentHTML anywhere in the page (tests/endo-cockpit-ui-source.test.ts holds that, and the
// page's Trusted Types policy would make any such sink throw).

/** What may stand as a child: nothing (`null`, `false`) is skipped; `undefined` is not a child but a value that is missing (see `append`). */
export type Child = Node | string | number | null | false;

export interface Props {
	class?: string;
	id?: string;
	title?: string;
	type?: "button" | "checkbox" | "search";
	/** Only the attributes of this list can be set: names and roles for accessibility, form state, table spans. */
	attrs?: Partial<Record<(typeof ATTRIBUTES)[number], string>>;
	on?: {
		[E in "click" | "input" | "change" | "keydown" | "compositionend"]?: (event: HTMLElementEventMap[E]) => void;
	};
}

const ATTRIBUTES = [
	"role",
	"aria-label",
	"aria-pressed",
	"aria-selected",
	"aria-current",
	"aria-live",
	"aria-busy",
	"aria-describedby",
	"aria-labelledby",
	"aria-expanded",
	"aria-hidden",
	"aria-sort",
	"data-state",
	"data-status",
	"data-basis",
	"data-seq",
	"data-key",
	"data-focus",
	"for",
	"value",
	"placeholder",
	"disabled",
	"checked",
	"selected",
	"tabindex",
	"scope",
	"colspan",
	"name",
	"open",
	"alt",
	"width",
	"height",
] as const;

function append(parent: Node, children: readonly Child[]): void {
	for (const child of children as readonly (Child | undefined)[]) {
		// A value a record should hold and does not arrives as `undefined`. Skipping it would draw a blank where a value belongs, and
		// "missing" must never look like "empty": it is an error here, which the dry run of a snapshot turns into a refused read.
		if (child === undefined) throw new TypeError("a value the record should hold is missing");
		if (child === null || child === false) continue;
		parent.appendChild(
			typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child,
		);
	}
}

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Props = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (props.class !== undefined) element.className = props.class;
	if (props.id !== undefined) element.id = props.id;
	if (props.title !== undefined) element.title = props.title;
	if (props.type !== undefined) element.setAttribute("type", props.type);
	for (const [name, value] of Object.entries(props.attrs ?? {}))
		if (value !== undefined) element.setAttribute(name, value);
	for (const [type, handler] of Object.entries(props.on ?? {}))
		element.addEventListener(type, handler as EventListener);
	append(element, children);
	return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_ATTRIBUTES =
	/^(viewBox|d|cx|cy|r|x|y|x1|y1|x2|y2|width|height|fill|stroke|stroke-width|stroke-dasharray|stroke-linecap|stroke-linejoin|transform|class|points|rx|aria-hidden|focusable)$/;

/** An SVG element from a fixed attribute vocabulary (no `href`, no `style`, no handlers). */
export function svg(tag: string, attrs: Record<string, string>, ...children: Node[]): SVGElement {
	const element = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (!SVG_ATTRIBUTES.test(name)) throw new TypeError(`svg attribute ${name} is not allowed`);
		element.setAttribute(name, value);
	}
	append(element, children);
	return element;
}

/** Replace a container's content. */
export function show(container: Element, ...children: Child[]): void {
	container.replaceChildren();
	append(container, children);
}
