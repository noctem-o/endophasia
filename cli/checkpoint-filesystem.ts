// Internal POSIX directory checks shared by initial-checkpoint filesystem consumers. No runtime execution.
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { piCassetteScriptV0 } from "./cassette-session.ts";

export type DirectoryIdentity = { dev: number; ino: number };
export const identity = (path: string): DirectoryIdentity | null => {
	try {
		const info = lstatSync(path);
		return info.isDirectory() && !info.isSymbolicLink() ? { dev: info.dev, ino: info.ino } : null;
	} catch {
		return null;
	}
};
export const sameIdentity = (path: string, expected: DirectoryIdentity): boolean => {
	const current = identity(path);
	return current !== null && current.dev === expected.dev && current.ino === expected.ino;
};
export const within = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}${sep}`);

/** Resolve even a missing recorded root through its nearest existing ancestor; refuse broken links. */
function physicalProspectivePath(path: string): string | null {
	let ancestor = resolve(path);
	const missing: string[] = [];
	for (;;) {
		try {
			lstatSync(ancestor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const upper = dirname(ancestor);
			if (upper === ancestor) return null;
			missing.unshift(basename(ancestor));
			ancestor = upper;
			continue;
		}
		try {
			return resolve(realpathSync(ancestor), ...missing);
		} catch {
			return null;
		}
	}
}

/** Refuse path aliases and symlinked/shared-writable parents before allocating a private child. */
export function safeOutputParent(path: string): { path: string; identity: DirectoryIdentity } | null {
	const uid = process.getuid?.();
	if (uid === undefined || !isAbsolute(path) || path.includes("\0")) return null;
	const normalized = resolve(path);
	if (normalized !== path || path.split(sep).some((part) => part === "." || part === "..")) return null;
	const root = parse(path).root;
	let current = root;
	const parts = path.slice(root.length).split(sep).filter(Boolean);
	for (const [index, part] of parts.entries()) {
		current = join(current, part);
		let info: Stats;
		try {
			info = lstatSync(current);
		} catch {
			return null;
		}
		if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0)) return null;
		if (index === parts.length - 1) {
			// The archived scratch may contain sensitive files; the selected parent must be private and operator-owned.
			if (info.uid !== uid || (info.mode & 0o077) !== 0 || (info.mode & 0o300) !== 0o300) return null;
		} else if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) {
			return null;
		}
	}
	if (parts.length === 0) return null;
	try {
		if (realpathSync(path) !== path) return null;
	} catch {
		return null;
	}
	const found = identity(path);
	return found === null ? null : { path, identity: found };
}

/** Apply the materializer's protected-source checks before any consumer creates staging state. */
export function checkpointOutputParent(source: string, replay: string, outputParent: string) {
	const parent = safeOutputParent(outputParent);
	if (parent === null) return { ok: false as const, reason: "unsafe-output-parent" as const };
	try {
		const recordedScratch = resolve(piCassetteScriptV0(readEndoCaptureEventsV0(source)).snapshot.scratchRoot);
		const physicalRecordedScratch = physicalProspectivePath(recordedScratch);
		if (physicalRecordedScratch === null) return { ok: false as const, reason: "unsafe-recorded-path" as const };
		for (const path of [realpathSync(source), realpathSync(replay), recordedScratch, physicalRecordedScratch])
			if (within(path, parent.path)) return { ok: false as const, reason: "unsafe-output-parent" as const };
		return { ok: true as const, ...parent, recordedScratch, physicalRecordedScratch };
	} catch {
		return { ok: false as const, reason: "unsafe-output-parent" as const };
	}
}
