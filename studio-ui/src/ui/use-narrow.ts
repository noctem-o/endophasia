import { useEffect, useState } from "react";

/** Below this width the inspector is a modal dialog and the page is one column. */
export const NARROW_QUERY = "(max-width: 1023.98px)";

/** Whether the viewport is narrow. Follows the media query's own change event: no polling, no resize loop. */
export function useNarrow(): boolean {
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
	useEffect(() => {
		const query = window.matchMedia(NARROW_QUERY);
		const change = () => setNarrow(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	return narrow;
}
