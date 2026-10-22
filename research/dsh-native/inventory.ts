// Builds the study's provenance and pinned vocabulary from a DSH source checkout. READ-ONLY on the checkout: it reads files and runs
// `git rev-parse`/`git status` (no checkout, build, install or network). Used by the committed `provenance.json` and
// `vocabulary.json`, and by the opt-in test that checks they still describe the checkout (ENDO_DSH_CHECKOUT).
//
//   node research/dsh-native/inventory.ts <dsh-checkout> [--write]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The DSH source files the study's claims rest on. A change to any of them is a reason to re-read the audit. */
export const DSH_AUDITED_FILES = [
	"packages/core/session/src/types.ts",
	"packages/core/session/src/index.ts",
	"packages/core/session/src/known-event-types.ts",
	"packages/core/session/src/repair.ts",
	"packages/core/session/src/fork.ts",
	"packages/core/agent/src/runtime-types.ts",
	"packages/session/session-persistence-jsonl/src/storage.ts",
	"packages/session/session-persistence-jsonl/src/format.ts",
	"packages/session/session-persistence-jsonl/src/lease.ts",
	"packages/bundle/headless/src/json-stream.ts",
	"packages/session-query/session-log-export/src/archive.ts",
	"packages/sdk/server/src/server.ts",
	"packages/sdk/protocol/src/types.ts",
	"packages/acp/acp/src/updates.ts",
	"docs/persistence-schema.json",
	"docs/persistence-catalog.md",
	"docs/session-format-status.md",
	"docs/event-producer-consumer.md",
	// Upstream deterministic fixtures (MIT) the audit cites for ancestry, checkpoints and the retry stream; referenced, not copied.
	"apps/cli/tests/profiles/headless/tests/expected/headless-profile/session.expected.jsonl",
	"apps/cli/tests/profiles/headless/tests/expected/provider-retry/stream-json.expected.jsonl",
	"apps/cli/tests/profiles/headless/tests/expected/semantic-checkpoint/session.expected.jsonl",
	"apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.expected.jsonl",
	"apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/parent.expected.jsonl",
	"apps/cli/tests/profiles/headless/tests/expected/subagent-inheritance/child.replay.v3.jsonl",
] as const;

export interface DshProvenance {
	schemaVersion: "endo.dsh-native-study-provenance.v0";
	dsh: { commit: string; describe: string; version: string; workingTreeClean: boolean; license: string };
	files: Record<string, { sha256: string; bytes: number }>;
}

export interface DshVocabularyFile {
	schemaVersion: "endo.dsh-native-vocabulary.v0";
	source: { file: string; sha256: string };
	sessionFormatVersion: number;
	knownEventTypes: string[];
	/** `docs/persistence-schema.json` roots: the type fingerprints that are the real compatibility contract. */
	roots: { key: string; kind: string; digest: string }[];
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], { encoding: "utf8" }).trim();
}

export function buildProvenance(root: string): DshProvenance {
	const files: DshProvenance["files"] = {};
	for (const file of DSH_AUDITED_FILES) {
		const bytes = readFileSync(join(root, file));
		files[file] = { sha256: sha256(bytes), bytes: bytes.length };
	}
	const manifest = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as { version: string };
	return {
		schemaVersion: "endo.dsh-native-study-provenance.v0",
		dsh: {
			commit: git(root, "rev-parse", "HEAD"),
			describe: git(root, "describe", "--tags", "--always"),
			version: manifest.version,
			workingTreeClean: git(root, "status", "--porcelain") === "",
			license: "MIT",
		},
		files,
	};
}

export function buildVocabulary(root: string): DshVocabularyFile {
	const file = "packages/core/session/src/known-event-types.ts";
	const source = readFileSync(join(root, file), "utf8");
	const block = /KNOWN_SESSION_EVENT_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
	if (block === null) throw new Error("KNOWN_SESSION_EVENT_TYPES was not found");
	const knownEventTypes = [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
	const schema = JSON.parse(readFileSync(join(root, "docs/persistence-schema.json"), "utf8")) as {
		roots: { key: string; kind: string; digest: string }[];
	};
	const status = readFileSync(join(root, "packages/core/session/src/types.ts"), "utf8");
	const version = /SESSION_FORMAT_VERSION = (\d+)/.exec(status);
	if (version === null) throw new Error("SESSION_FORMAT_VERSION was not found");
	return {
		schemaVersion: "endo.dsh-native-vocabulary.v0",
		source: { file, sha256: sha256(source) },
		sessionFormatVersion: Number(version[1]),
		knownEventTypes,
		roots: schema.roots.map(({ key, kind, digest }) => ({ key, kind, digest })),
	};
}

export const PROVENANCE_PATH = join(HERE, "provenance.json");
export const VOCABULARY_PATH = join(HERE, "vocabulary.json");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2];
	if (root === undefined) throw new Error("usage: node research/dsh-native/inventory.ts <dsh-checkout> [--write]");
	const provenance = `${JSON.stringify(buildProvenance(root), null, "\t")}\n`;
	const vocabulary = `${JSON.stringify(buildVocabulary(root), null, "\t")}\n`;
	if (process.argv.includes("--write")) {
		writeFileSync(PROVENANCE_PATH, provenance);
		writeFileSync(VOCABULARY_PATH, vocabulary);
	} else process.stdout.write(`${provenance}${vocabulary}`);
}
