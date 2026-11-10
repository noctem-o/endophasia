# Reproducing DEVELOP-VALIDATION-001

Everything here runs on disposable repositories and a disposable store. Nothing starts an agent or a model, and nothing needs
approval. Use a scratch directory, not a real project.

```sh
npm ci && npm run build
alias endo="node $PWD/dist/cli/index.js"
V=$PWD/research/develop-validation
W=$(mktemp -d) && export ENDO_STORE_ROOT=$W/store
git config --global user.name >/dev/null || echo "set a Git identity first (finding A1)"
```

## T1: exit 0 and wrong (the H2 case and the U1 overview case)

```sh
mkdir $W/roman && cp $V/fixtures/roman/roman.mjs $W/roman/ && cd $W/roman && git init -q && git add . && git commit -qm seeded
$V/oracles/roman.sh .                         # ORACLE FAIL: 4 → IIII, 1994 → MDCCCCLXXXXIIII
endo project add --name Roman --path "$PWD"
endo task add --project endo.project.<id> --title "Roman numerals use subtractive notation"
endo attempt prepare --project endo.project.<id> --task endo.task.<id> --objective "Make roman.mjs subtractive" \
  --plan-file $V/fixtures/roman/verification-plan.json
endo attempt check --attempt endo.attempt.<id> --keep-output -- node roman.mjs 1994   # exits 0: "Observed check passed" (B1)
endo attempt evidence --attempt endo.attempt.<id>   # criterion 1: "A planned check failed at HEAD"
endo workspace open --project endo.project.<id>     # pair; the overview says "Needs your attention (0)": the missed failure (U1)
# Stop the workspace, then run the second check. Run it after opening the overview, or the overview shows (1) for it instead:
endo attempt check --attempt endo.attempt.<id> --keep-output -- node roman.mjs 0      # exits 3: "Observed check failed" (B1)
endo attempt evidence --attempt endo.attempt.<id>   # criterion 2: passed. The overview now flags it "Check failed": the false alarm
```

All three page cases (the missed failure, the false alarm with F1, and T2U's agreement) can also be rebuilt and captured in one step:

```sh
research/develop-validation/rebuild-page-cases.sh "$(mktemp -d)"
```

## T2 and T2U: identical ledgers for a correct and an incorrect candidate (B2)

```sh
mkdir $W/dur && cp -r research/review-pilot/fixture/. $W/dur/ && cd $W/dur && git init -q && git add . && git commit -qm fixture
# Prepare an attempt with --plan-file $V/fixtures/duration-plan/verification-plan.json, then run each planned argv with attempt check.
# T2U: in src/duration.mjs add ["d", 86400] first in UNITS, change the pattern's start to (?:(\d+)d)* , add a README row, commit.
node $V/oracles/duration.mjs .                # ORACLE FAIL: reject "1d1d" -> 86400
# Run every planned check again: all pass, and every check-covered criterion reads "Planned checks passed at HEAD".
```

## C: freshness and integrity

`prog.mjs` from [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) scenario C prints `ok`, or `not ok` / 10 000 bytes depending on an ignored
`mode.txt`. Check once, then: commit an unrelated file (C1); make the tree dirty (C2); write `bad` to `mode.txt` and check again (C3);
check without `--keep-output` (C4); write `big` (C5); create 1 200 files and `attempt observe` (C6); replace one receipt file with
`{not json` (C7); in a copy of the store, set each failing receipt's `output.stdout.sha256` to SHA-256 of `ok\n` (C8).

## F1: an environment-dependent pass

```sh
cd <the seeded roman repo>      # unchanged, clean, prints MDCCCCLXXXXIIII for 1994
NODE_OPTIONS="--import=$V/fixtures/env-hook.mjs" endo attempt check --attempt endo.attempt.<id> --keep-output -- node roman.mjs 1994
endo attempt evidence --attempt endo.attempt.<id>   # criterion 1: "Planned checks passed at HEAD", no gap
```

## The browser

```sh
node research/develop-validation/browser-read.ts "$ENDO_STORE_ROOT" endo.project.<id> "<task title>" <out-dir>
```

It starts `endo workspace open`, pairs with the code the host prints, waits for the overview's checks to be read, and saves the page's
text and screenshots. It needs Chromium (`CHROME_BIN` or `chromium` on `PATH`), and it stops the host when done.
