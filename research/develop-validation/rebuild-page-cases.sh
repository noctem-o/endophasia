#!/usr/bin/env bash
# DEVELOP-VALIDATION-001: rebuild the three page cases in a new disposable directory and capture the page for each.
#   U   seeded Roman numerals, only the 1994 check (exit 0, wrong output): the overview's missed failure (U1)
#   F   seeded Roman numerals, 1994 under an environment hook, then the correct exit-2 refusal: F1 and the overview's false alarm
#   T2U durations, the planted repeated-d regression, every planned check: the Task view against the CLI
# Usage (from the repository root, after npm run build): research/develop-validation/rebuild-page-cases.sh <empty-dir>
# Needs a Git identity and Chromium. Stops every host it starts.
set -euo pipefail
W=$(realpath "$1"); R=$(realpath "$(dirname "$0")/../..")
V="$R/research/develop-validation"
endo() { node "$R/dist/cli/index.js" "$@"; }
id() { grep -o "endo\.$1\.[0-9a-f]\{32\}" | head -1; }
setup() { # <name> <repo> <plan> -> "project task attempt" (runs in a subshell: every caller passes --root itself)
	export ENDO_STORE_ROOT="$W/$1/store"
	local P T A
	P=$(endo project add --name "$1" --path "$2" 2>/dev/null | id project)
	T=$(endo task add --project "$P" --title "$1 task" 2>/dev/null | id task)
	A=$(endo attempt prepare --project "$P" --task "$T" --objective "validation case $1" --plan-file "$3" 2>/dev/null | id attempt)
	echo "$P $T $A"
}
capture() { # <name> <project>
	mkdir -p "$W/out/$1"
	(cd "$R" && node research/develop-validation/browser-read.ts "$W/$1/store" "$2" "$1 task" "$W/out/$1")
	(cd "$W/$1/repo" && endo attempt evidence --root "$W/$1/store" --attempt "$3" 2>&1 >/dev/null) > "$W/out/$1/cli-evidence.txt"
}
roman() { mkdir -p "$W/$1/repo" && cp "$V/fixtures/roman/roman.mjs" "$W/$1/repo/" && (cd "$W/$1/repo" && git init -q && git add . && git commit -qm seeded); }

C=U; roman U; read -r P T A < <(setup U "$W/U/repo" "$V/fixtures/roman/plan.json")
(cd "$W/U/repo" && endo attempt check --root "$W/$C/store" --attempt "$A" --keep-output -- node roman.mjs 1994 >/dev/null 2>&1 || true)
capture U "$P" "$A"

C=F; roman F; read -r P T A < <(setup F "$W/F/repo" "$V/fixtures/roman/plan.json")
(cd "$W/F/repo" && NODE_OPTIONS="--import=$V/fixtures/env-hook.mjs" endo attempt check --root "$W/$C/store" --attempt "$A" --keep-output -- node roman.mjs 1994 >/dev/null 2>&1 || true)
(cd "$W/F/repo" && endo attempt check --root "$W/$C/store" --attempt "$A" --keep-output -- node roman.mjs 0 >/dev/null 2>&1 || true)
capture F "$P" "$A"

mkdir -p "$W/T2U/repo" && cp -r "$R/research/review-pilot/fixture/." "$W/T2U/repo/"
cd "$W/T2U/repo" && git init -q && git add . && git commit -qm fixture
node -e '
const fs = require("node:fs");
let s = fs.readFileSync("src/duration.mjs", "utf8");
s = s.replace("const UNITS = [\n\t[\"h\", 3600],", "const UNITS = [\n\t[\"d\", 86400],\n\t[\"h\", 3600],").replace("/^(?:(\\d+)h)?", "/^(?:(\\d+)d)*(?:(\\d+)h)?");
fs.writeFileSync("src/duration.mjs", s);
let r = fs.readFileSync("README.md", "utf8");
fs.writeFileSync("README.md", r.replace("| `h` | hours | 3600 |", "| `d` | days | 86400 |\n| `h` | hours | 3600 |"));'
git commit -qam "add days"
node "$V/oracles/duration.mjs" . | grep -q "ORACLE FAIL" || { echo "T2U: expected the oracle to fail" >&2; exit 1; }
C=T2U; read -r P T A < <(setup T2U "$W/T2U/repo" "$V/fixtures/duration-plan/plan.json")
python3 -c "import json,sys,shlex;[print(shlex.join(c['argv'])) for c in json.load(open(sys.argv[1]))['checks']]" "$V/fixtures/duration-plan/plan.json" |
	while read -r line; do eval "set -- $line"; endo attempt check --root "$W/$C/store" --attempt "$A" --keep-output -- "$@" >/dev/null 2>&1 < /dev/null || true; done
capture T2U "$P" "$A"
echo "captured: $W/out"
