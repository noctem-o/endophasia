// The rule of the reasoning reveal (ui/use-reveal.ts), without the browser: whether newly read text is revealed gradually or drawn at once,
// and where a cut may fall. Pure, so it can be tested on its own.

/** How long a block of new text takes to appear: about one read interval, so the next block arrives as this one finishes. */
export const REVEAL_MS = 900;
/**
 * The share of a reveal one millisecond is. Multiplied, not divided: a `/` right after `)` in the bundle is the ambiguous slash the frontend
 * loader's import scan reads both ways (cockpit-http/studio-ui.ts), and a reading that takes it for a regular expression is avoided.
 */
export const PER_MS = 1 / REVEAL_MS;
/** A block longer than this is drawn at once. */
const MAX_REVEAL_CHARS = 4000;

/** The index `n` moved back off a lone high surrogate, so a cut never splits a character. */
export function safeCut(text: string, n: number): number {
	if (n <= 0 || n >= text.length) return Math.max(0, Math.min(n, text.length));
	const c = text.charCodeAt(n - 1);
	return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
}

/**
 * Where a reveal of `text` starts, or null to draw it whole at once: only when it is still being written, motion is allowed, it extends
 * what was shown (`previous`, of which `shown` characters were drawn), and the new block is not too long.
 */
export function revealFrom(
	previous: string,
	shown: number,
	text: string,
	active: boolean,
	reduced: boolean,
): number | null {
	if (!active || reduced) return null;
	if (text.length <= shown || !text.startsWith(previous.slice(0, shown))) return null;
	if (text.length - shown > MAX_REVEAL_CHARS) return null;
	return shown;
}
