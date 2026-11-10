#!/usr/bin/env bash
# DEVELOP-VALIDATION-002: rebuild every attention case in a new disposable directory, and capture, for each, the page's overview, its
# Task view and `endo attempt evidence`, from the same store. The fixtures, hook and plans are DEVELOP-VALIDATION-001's.
#   U    one 1994 check: exit 0, wrong output                          M    1994 passes under the hook, then fails: disagreement at HEAD
#   F    1994 under the hook, then the declared exit-2 refusal          S    1994 fails, then an unrelated commit: a failure, now stale
#   S2   1994 passes under the hook, then an unrelated commit           D    1994 passes under the hook, then roman.mjs is edited (dirty)
#   N    prepared, never checked                                        X    the refusal passes, then a receipt file is damaged
#   P    an attempt without a plan: 1994 exits 0 (exit-status reading)  TWO  one argv, two attempts: one with the plan, one without
# Usage (from the repository root, after npm run build): research/develop-validation/rebuild-attention-cases.sh <empty-dir>
# Needs a Git identity and Chromium. Stops every host it starts.
set -euo pipefail
W=$(realpath "$1")
R=$(realpath "$(dirname "$0")/../..")
V="$R/research/develop-validation"
PLAN="$V/fixtures/roman/verification-plan.json"
HOOK="$V/fixtures/env-hook.mjs"
endo() { node "$R/dist/cli/index.js" "$@"; }
id() { grep -o "endo\.$1\.[0-9a-f]\{32\}" | head -1; }
repo() { # <case>: a seeded Roman-numerals repository
	mkdir -p "$W/$1/repo" && cp "$V/fixtures/roman/roman.mjs" "$W/$1/repo/"
	(cd "$W/$1/repo" && git init -q && git add . && git commit -qm seeded)
}
project() { # <case> -> project id (the store is <case>/store)
	endo project add --root "$W/$1/store" --name "$1" --path "$W/$1/repo" 2>/dev/null | id project
}
attempt() { # <case> <project> <task> [plan] -> attempt id
	endo attempt prepare --root "$W/$1/store" --project "$2" --task "$3" --objective "validation case $1" \
		${4:+--plan-file "$4"} 2>/dev/null | id attempt
}
task() { endo task add --root "$W/$1/store" --project "$2" --title "$1 task" 2>/dev/null | id task; }
check() { # <case> <attempt> [env...] -- argv
	local c=$1 a=$2
	shift 2
	local envs=()
	while [ "$1" != "--" ]; do envs+=("$1"); shift; done
	shift
	(cd "$W/$c/repo" && env "${envs[@]}" node "$R/dist/cli/index.js" attempt check --root "$W/$c/store" --attempt "$a" --keep-output -- "$@" >/dev/null 2>&1 || true)
}
capture() { # <case> <project> <attempt> [no-plan]
	mkdir -p "$W/out/$1"
	(cd "$R" && node research/develop-validation/browser-read.ts "$W/$1/store" "$2" "$1 task" "$W/out/$1" ${4:-})
	(cd "$W/$1/repo" && endo attempt evidence --root "$W/$1/store" --attempt "$3" 2>&1 >/dev/null) > "$W/out/$1/cli-evidence.txt"
}
setup() { repo "$1"; P=$(project "$1"); T=$(task "$1" "$P"); A=$(attempt "$1" "$P" "$T" "$PLAN"); }
unrelated() { (cd "$W/$1/repo" && echo note > NOTES.md && git add NOTES.md && git commit -qm "unrelated"); }

setup U; check U "$A" -- node roman.mjs 1994; capture U "$P" "$A"
setup F; check F "$A" "NODE_OPTIONS=--import=$HOOK" -- node roman.mjs 1994; check F "$A" -- node roman.mjs 0; capture F "$P" "$A"
setup M; check M "$A" "NODE_OPTIONS=--import=$HOOK" -- node roman.mjs 1994; check M "$A" -- node roman.mjs 1994; capture M "$P" "$A"
setup S; check S "$A" -- node roman.mjs 1994; unrelated S; capture S "$P" "$A"
setup S2; check S2 "$A" "NODE_OPTIONS=--import=$HOOK" -- node roman.mjs 1994; unrelated S2; capture S2 "$P" "$A"
setup D; check D "$A" "NODE_OPTIONS=--import=$HOOK" -- node roman.mjs 1994; echo "// edited" >> "$W/D/repo/roman.mjs"; capture D "$P" "$A"
setup N; capture N "$P" "$A"
setup X; check X "$A" -- node roman.mjs 0
printf '{not json' > "$W/X/store/develop/receipts/$A/endo.receipt.ffffffffffffffffffffffffffffffff.json"; capture X "$P" "$A"
repo P; P=$(project P); T=$(task P "$P"); A=$(attempt P "$P" "$T"); check P "$A" -- node roman.mjs 1994; capture P "$P" "$A" no-plan
repo TWO; P=$(project TWO); T=$(task TWO "$P"); A=$(attempt TWO "$P" "$T" "$PLAN"); B=$(attempt TWO "$P" "$T")
check TWO "$A" -- node roman.mjs 0; check TWO "$B" -- node roman.mjs 0; capture TWO "$P" "$A"
echo "captured: $W/out"
