// Removes the scratch digest-key directory vitest.config.ts creates for the run.
import { rmSync } from "node:fs";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		digestKeyDirectory: string;
	}
}

export default function setup(project: TestProject): () => void {
	const directory = project.config.provide?.digestKeyDirectory;
	return () => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	};
}
