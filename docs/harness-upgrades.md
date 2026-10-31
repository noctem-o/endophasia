# Evaluating a new harness version

You update your harnesses yourself. Endophasia never installs, updates, downgrades, patches or rebuilds one. This page
covers what happens after you do: what Endophasia notices, what it stops trusting, and what each kind of evidence can
and cannot tell you about the new version. The mechanism is described in [attachment.md](attachment.md). A worked
example is [Pi 1.0.4 → 1.4.0](pi-1.4.0-upgrade.md).

## The workflow

```sh
endo doctor --root ./recordings                    # observe the installed Pi (runs only --version) against what was recorded
endo harness status ./recordings                   # the upgrade assessment, from recorded state only
endo harness check ./recordings                    # automatic offline checks: no prompt, no provider call
endo harness study ./recordings --authorize-live-study   # only if you want the live capabilities; agent work, may cost money
```

Use `--pi /path/to/pi` to pick an executable other than the `pi` on `PATH`. Several Pi installations can be assessed
side by side, each under its own `--attachment` name.

## What each step establishes

The claims form a ladder. Reaching one rung never implies the next.

| Level | Established by | What it does not say |
| :-- | :-- | :-- |
| Identity observed | `doctor`, `identify`, `check` (a fingerprint: real path, entrypoint digest, package manifest, `--version`) | that the runtime works, or that it is the same program as before when the identity is reduced-confidence |
| Protocol checked | `check`: selected RPC exchanges with an offline Pi that starts no agent run | anything about runs, tools, steering or providers |
| Capability qualified | `check` and `study`: evidence, within its recorded limits, that one capability behaves as its catalogue entry says | that it is permitted. An admitted capability is not an authorisation, and approval stays with the operator |
| Behaviour compared | recorded sessions under each version, compared with `endo trajectory diff` | nothing until you do it. No check compares model outputs, tool choices, compaction, retries, cost or timing between versions |
| Reproducibility established | an experiment's own design and records | never established by harness evidence |

A new version that passes `check` speaks the same protocol for the exchanges tested. Its agent behaviour may still
differ. Runs recorded under different runtime identities are never like for like, and trajectory comparisons say so
(`runtime-fingerprint-differs`).

## Reading `endo harness status`

`harness status` prints the recorded records as JSON on stdout, and an **upstream assessment** on stderr (also in the
JSON as `assessment`). It opens the registry read-only and examines no executable. It says so, because it can only
describe what was recorded.

- **Current / Previous**: the latest recorded observation, and the latest one with a different identity.
- **Changes**: which identity facts differ (`realPath`, `entrypoint`, `package`, `version`, `confidence`), and the version
  order. *Lower* is not treated as safer, and *higher* not as compatible. Both are simply a different runtime.
- **The ladder** above, with what this attachment has reached.
- **Capabilities whose standing differs**, as `previous → now`, with the dependencies that changed: `identity`,
  `confidence`, `adapter`, `mapping`, `suite`, `check-definition`, `configuration`, `extension`. All of them are
  listed, not only the first.
- **To establish …**: what each missing capability needs:
  - the offline `check`;
  - the live study, which needs your explicit `--authorize-live-study` for each run;
  - or a documented-surface review, which exists only for reviewed releases.
- **Comparisons and limits**.

A capability's standing in the report is never stronger than what was recorded. It becomes **unverified** when this
version of Endophasia no longer accepts the evidence behind it (a newer adapter, mapping, suite or check definition).
That case can arise without any harness change, after you update Endophasia itself. **Not derived** means a runtime was
identified but no standing was derived for it yet, for example when `identify` ran and nothing followed. It is not
reported as unverified. **Unidentified** means the latest identification failed (the executable is gone or will not answer): the last
identified runtime is shown as such, and every capability is unverified until the runtime is identified again.

## What evidence does and does not carry over

Evidence applies only while everything it depends on is unchanged ([attachment.md](attachment.md) and the rules in
`adapters/pi/evidence.ts`):

- **A different identity** (version, package, real path, entrypoint bytes): nothing carries over. That includes a
  downgrade, and a reinstall of the same version to another path.
- **A reduced-confidence identity** (no entrypoint digest, or no version): nothing carries across observations, even at
  the same digest.
- **A changed adapter, mapping or suite version**: all evidence that depends on it stops counting.
- **A changed check definition**: only that check's evidence stops counting.
- **A changed configuration** (Pi's settings, models, MCP servers, prompts and extensions; never credentials): the
  evidence of that check kind stops counting.

The report reads recorded state. A configuration change made since the last `check` shows only after the next
`check`, which re-reads it.

## Known limits

- **Inconclusive results.** A check that could not decide (for example `control.model` with no configured model) is
  printed by `check` and `study`, but not recorded. The capability stays unverified, and later reports cannot say why.
- **Entrypoint scope.** The identity's entrypoint digest covers one file. For Pi that file is a small launcher, so a
  same-version change to Pi's other files is not detected ([case study](pi-1.4.0-upgrade.md#compatibility-matrix)).
- **Pi only.** The assessment's logic is runtime-neutral (`runtime/contracts/harness-assessment.ts`). It reads the shared
  `endo.harness-*` and `endo.capability-*` records. Only the Pi adapter records them today. Another adapter needs a
  fingerprint, an evidence rule set and a capability catalogue first ([upstream-boundaries.md](upstream-boundaries.md)).
