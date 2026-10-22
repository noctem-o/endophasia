// The entry of the Studio frontend (docs/studio-ui-architecture.md): it mounts the shell, which reads the one snapshot the server
// offers and shows what the Observe workspace can establish from it.
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
