// Read-only observer of recorded representation capture files (`endo.observe-representation-capture.v0`)
// under one directory named by the operator (`endo studio --representations <dir>`) or under `<store>/representations`
// when that directory already exists.
//
// Security & provenance boundaries (matching adapters/omp/observer.ts):
// - Read-only: never creates, writes, or modifies any file or directory.
// - Flat directory scan of plain regular `*.json` files only: symlinks and non-regular files are counted and skipped.
// - File size is checked from the inode before bytes are read into memory.
// - Selectors (`r1-<32 hex>`) are keyed digests under Studio's dedicated cockpit key over file place, inode identity,
//   size, birth time and SHA-256 of bytes: replacing or modifying a file invalidates any held selector (404).
// - No local filesystem path, raw exception, or unvalidated content is ever returned to the browser.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { projectEndoObserveRepresentationSceneV0 } from "../../cockpit/projections/representation-scene.ts";
import {
	ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
	ENDO_OBSERVE_REPRESENTATION_LIMITS_V0,
	ENDO_OBSERVE_REPRESENTATION_SELECTOR_PATTERN_V0,
	ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0,
	type EndoObserveRepresentationCaptureV0,
	type EndoObserveRepresentationObserverV0,
	type EndoObserveRepresentationSceneV0,
	type EndoObserveRepresentationSummaryV0,
	type EndoObserveRepresentationsIndexV0,
	endoObserveRepresentationCaptureProblemV0,
} from "../../protocol/observe-representation.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";

const SELECTOR_PURPOSE = "endo.observe-representation-selector.v0";

export interface ObserveRepresentationObserverOptionsV0 {
	/** Directory containing recorded `*.json` representation capture files. Must be an existing directory. */
	root: string;
	/** Studio's dedicated comparison key: opaque selectors are bound to it. */
	key: EndoDigestKeyV0;
}

interface DiscoveredFile {
	path: string;
	relative: string;
	dev: bigint;
	ino: bigint;
	size: bigint;
	born: bigint;
}

/** Resolve an operator-named `--representations` directory, or throw a TypeError if unusable. */
export function resolveObserveRepresentationsRootV0(given: string): string {
	let root: string;
	try {
		root = realpathSync(given);
	} catch {
		throw new TypeError("--representations must name an existing directory");
	}
	if (!lstatSync(root).isDirectory()) throw new TypeError("--representations must name an existing directory");
	return root;
}

/**
 * Check read-only whether `<storeRoot>/representations` already exists as a plain (non-symlink) directory.
 * Returns its resolved path when present and usable, otherwise null. Never creates anything.
 */
export function findStoreRepresentationsRootV0(storeRoot: string): string | null {
	const candidate = join(storeRoot, "representations");
	try {
		const info = lstatSync(candidate);
		if (info.isSymbolicLink() || !info.isDirectory()) return null;
		const resolved = realpathSync(candidate);
		return lstatSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

export class ObserveRepresentationObserverV0 implements EndoObserveRepresentationObserverV0 {
	readonly #root: string;
	readonly #key: EndoDigestKeyV0;

	constructor(options: ObserveRepresentationObserverOptionsV0) {
		this.#root = resolveObserveRepresentationsRootV0(options.root);
		this.#key = options.key;
	}

	#discover(): {
		files: DiscoveredFile[];
		skipped: EndoObserveRepresentationsIndexV0["skipped"];
	} {
		const skipped = { links: 0, notRegular: 0, overLimit: 0, unreadable: 0 };
		const files: DiscoveredFile[] = [];
		let names: string[];
		try {
			if (realpathSync(this.#root) !== this.#root) {
				skipped.links += 1;
				return { files, skipped };
			}
			names = readdirSync(this.#root).sort();
		} catch {
			skipped.unreadable += 1;
			return { files, skipped };
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const fullPath = join(this.#root, name);
			let stat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; size: bigint; birthtimeNs: bigint };
			try {
				const raw = lstatSync(fullPath, { bigint: true, throwIfNoEntry: false });
				if (raw === undefined) continue;
				stat = raw as typeof stat;
			} catch {
				skipped.unreadable += 1;
				continue;
			}
			if (stat.isSymbolicLink()) {
				skipped.links += 1;
				continue;
			}
			if (!stat.isFile()) {
				skipped.notRegular += 1;
				continue;
			}
			if (files.length >= ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxFiles) {
				skipped.overLimit += 1;
				continue;
			}
			files.push({
				path: fullPath,
				relative: relative(this.#root, fullPath),
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				born: stat.birthtimeNs,
			});
		}
		return { files, skipped };
	}

	#selectorFor(file: DiscoveredFile, sha256: string | null): string {
		return `r1-${this.#key
			.digest({
				purpose: SELECTOR_PURPOSE,
				path: file.relative,
				dev: String(file.dev),
				ino: String(file.ino),
				size: String(file.size),
				born: String(file.born),
				sha256: sha256 ?? "unread",
			})
			.value.slice(0, 32)}`;
	}

	#inspect(file: DiscoveredFile): {
		summary: EndoObserveRepresentationSummaryV0;
		capture: EndoObserveRepresentationCaptureV0 | null;
		artifactSha256: string | null;
	} {
		const unreadable = (
			state: EndoObserveRepresentationSummaryV0["state"],
			reason: string,
			sha256: string | null = null,
		) => ({
			summary: {
				selector: this.#selectorFor(file, sha256),
				state,
				reason,
				artifactId: null,
				artifactSha256: sha256,
				capturedAt: null,
				executionRole: null,
				modelId: null,
				weightDtype: null,
				backendLabel: null,
				hookPoint: null,
				pointCount: 0,
				dimensions: null,
			},
			capture: null,
			artifactSha256: sha256,
		});

		if (file.size > BigInt(ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxFileBytes)) {
			return unreadable("too-large", "Artifact file exceeds the 16 MiB bounded read limit.");
		}

		let bytes: Buffer;
		try {
			const before = lstatSync(file.path, { bigint: true });
			if (before.isSymbolicLink() || !before.isFile() || before.dev !== file.dev || before.ino !== file.ino) {
				return unreadable("unreadable", "Artifact file changed or is not a plain regular file.");
			}
			bytes = readFileSync(file.path);
			const after = lstatSync(file.path, { bigint: true });
			if (after.dev !== file.dev || after.ino !== file.ino || after.size !== BigInt(bytes.length)) {
				return unreadable("unreadable", "Artifact file changed while being read.");
			}
		} catch {
			return unreadable("unreadable", "Artifact file could not be read.");
		}

		const sha256 = createHash("sha256").update(bytes).digest("hex");
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return unreadable("invalid", "Artifact file is not valid UTF-8 JSON.", sha256);
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			typeof (parsed as { schemaVersion?: unknown }).schemaVersion === "string" &&
			(parsed as { schemaVersion: string }).schemaVersion !== ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0
		) {
			return unreadable("unsupported-schema", "Artifact declares an unsupported schema version.", sha256);
		}

		const problem = endoObserveRepresentationCaptureProblemV0(parsed);
		if (problem !== null) {
			return unreadable("invalid", `Artifact failed contract validation (${problem}).`, sha256);
		}

		const capture = parsed as EndoObserveRepresentationCaptureV0;
		const selector = this.#selectorFor(file, sha256);
		const backendLabel =
			`${capture.subject.backend.framework} ${capture.subject.backend.frameworkVersion} · ${capture.subject.backend.driver}`.slice(
				0,
				128,
			);
		return {
			summary: {
				selector,
				state: "readable",
				reason: null,
				artifactId: capture.artifact.artifactId,
				artifactSha256: sha256,
				capturedAt: capture.artifact.capturedAt,
				executionRole: capture.subject.executionRole,
				modelId: capture.subject.model.modelId,
				weightDtype: capture.subject.model.weightDtype,
				backendLabel,
				hookPoint: capture.subject.captureLocation.hookPoint,
				pointCount: capture.points.length,
				dimensions: capture.dimensions,
			},
			capture,
			artifactSha256: sha256,
		};
	}

	list(): EndoObserveRepresentationsIndexV0 {
		const { files, skipped } = this.#discover();
		const artifacts = files.map((file) => this.#inspect(file).summary);
		return {
			schemaVersion: ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0,
			available: true,
			artifacts,
			skipped,
		};
	}

	scene(selector: string, options?: { layer?: number | "all" }): EndoObserveRepresentationSceneV0 | null {
		if (!ENDO_OBSERVE_REPRESENTATION_SELECTOR_PATTERN_V0.test(selector)) return null;
		const { files } = this.#discover();
		for (const file of files) {
			const inspected = this.#inspect(file);
			if (inspected.summary.selector !== selector) continue;
			if (inspected.capture === null || inspected.artifactSha256 === null) return null;
			return projectEndoObserveRepresentationSceneV0({
				capture: inspected.capture,
				selector,
				artifactSha256: inspected.artifactSha256,
				...(options?.layer === undefined ? {} : { layer: options.layer }),
			});
		}
		return null;
	}
}
