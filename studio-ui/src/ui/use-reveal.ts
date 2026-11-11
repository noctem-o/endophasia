// A gentle reveal for text that is still being written (the assistant message and its model-provided reasoning, as of the last read).
// The page reads the broker every second or so, so new text arrives in blocks; drawing each block at once makes the trace jump. This
// shows the text that grew since the last read over a short time instead. It never shows text that has not been read, never reorders or
// changes it, and draws the whole text at once when it is not an extension of what was shown (replaced, completed, folded), when the
// reader prefers reduced motion, or when the block is large (a long jump is not worth replaying). Display only: nothing it does is
// recorded, and every label still says "as of the last read".
import { useEffect, useRef, useState } from "react";
import { PER_MS, revealFrom, safeCut } from "../model/reveal.ts";

const REDUCED = "(prefers-reduced-motion: reduce)";
/**
 * The part of `text` to draw now. `active`: the text is still being written (a partial message); otherwise it is drawn whole at once.
 */
export function useRevealed(text: string, active: boolean): string {
	const [length, setLength] = useState(text.length);
	const shownText = useRef(text);
	const shownLength = useRef(text.length);
	useEffect(() => {
		const previous = shownText.current;
		shownText.current = text;
		const reduced = typeof window !== "undefined" && window.matchMedia?.(REDUCED).matches === true;
		const from = revealFrom(previous, shownLength.current, text, active, reduced);
		if (from === null) {
			shownLength.current = text.length;
			setLength(text.length);
			return;
		}
		const start = performance.now();
		const to = text.length;
		let frame = 0;
		const step = (now: number) => {
			const t = Math.min(1, (now - start) * PER_MS);
			const n = safeCut(text, Math.round(from + (to - from) * t));
			shownLength.current = n;
			setLength(n);
			if (t < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [text, active]);
	return active ? text.slice(0, safeCut(text, Math.min(length, text.length))) : text;
}
