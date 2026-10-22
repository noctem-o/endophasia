import { lazy, Suspense } from "react";

// A module loaded on demand, so the build's handling of a dynamic import (a separate file under the same capability-prefixed
// assets path) is exercised by every build and every browser run, not first met in a later change.
const LazyProof = lazy(() => import("./LazyProof.tsx"));

export function App() {
	return (
		<>
			<a className="skip" href="#main">
				Skip to the content
			</a>
			<header className="topbar">
				<span className="wordmark">ENDOPHASIA</span>
				<span
					className="chip"
					title="This page only reads. It cannot change a store, steer a runtime or start anything."
				>
					Read-only
				</span>
			</header>
			<main id="main" className="proof" data-studio-ui="ready">
				<p className="banner" role="note" data-testid="integration-proof">
					Integration proof. This is not an observation: no store is read and nothing on this page was recorded.
				</p>
				<h1>Studio frontend foundation</h1>
				<p>
					This page shows that the compiled frontend is served by the Endophasia server under its per-launch
					address, with the same policy as the existing page. Nothing here is evidence.
				</p>
				{/* An inline style set through the style object is applied by the CSS object model, which the page policy allows. */}
				<p className="meter" style={{ ["--proof-level" as string]: "3" }} data-testid="style-prop">
					Style set from script
				</p>
				<p className="plex" data-testid="font-sample">
					Bundled typeface sample
				</p>
				<img className="mark" src="./assets/icon.svg" width="28" height="20" alt="" data-testid="icon-image" />
				<Suspense fallback={<p data-testid="lazy-pending">Loading a deferred module</p>}>
					<LazyProof />
				</Suspense>
			</main>
		</>
	);
}
