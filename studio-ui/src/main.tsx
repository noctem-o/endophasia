// The entry of the Studio frontend foundation (docs/studio-ui-architecture.md). It mounts a shell that says it is an integration
// proof and reads nothing: no request is made, no store is consulted, no recorded fact is shown. The data boundary a later change
// adds is described in that document.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./studio.css";

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
