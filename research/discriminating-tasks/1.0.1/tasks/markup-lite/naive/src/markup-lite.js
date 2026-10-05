// A plausible wrong solution: escape, then regex replacements with no flanking rules and no code protection.
export function render(text) {
	if (typeof text !== "string") throw new TypeError("string");
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(/`(.+?)`/g, "<code>$1</code>")
		.replace(/\*(.+?)\*/g, "<b>$1</b>")
		.replace(/_(.+?)_/g, "<i>$1</i>");
}
