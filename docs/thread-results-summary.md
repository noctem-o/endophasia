# Thread results summary (September – November 2026)

A one-page index of what the work in this project's Amp threads produced, thread by theme, with the
pull request or document that carries each result. This file is only a summary; the linked PRs,
docs and research notes are the records.

## Foundations (September – October)

- **Repository architecture from an empty repo.** The standalone `endophasia` repository was
  designed and scaffolded in threads ("Orb setup for empty repo", "Endophasia standalone
  architecture", "Endophasia PR handoff", "CI exchange and Together fixes"): a TypeScript monorepo
  with `protocol/`, `runtime/`, `cli/`, `storage/`, `adapters/`, `cockpit/`, `studio-ui/` and
  `research/`, Vitest + Biome + typecheck gates, and CI on Ubuntu with a Node 22 floor.
- **First alpha released.** `endo` CLI, doctor, harness attach, trajectory, replay, proxy and
  experiment commands; then Studio and the packaged alpha (`0.1.0-alpha.1`, `0.1.0-alpha.2`,
  accepted against real Pi 1.0.0 with a fake model endpoint).
- **Evidence-first harness hardening.** Pi identified by its runtime files, not only its launcher
  (#112); `agent_settled.aborted` recognized (#113); mislabelled recorded capability lists fixed
  (#114); and a case study assessing an upstream runtime change from recorded evidence only —
  Pi 1.0.4 → 1.4.0 (#111).
- **AA-LIVE-001**, the first live-model study: pre-registered, run behind the capture proxy, with
  the redacted result recorded (#97–#100).

## The DEVELOP workbench (late October – early November)

A governed, evidence-preserving agent workstation, built in slices (#101–#125): Studio session desk;
the governed live Pi workbench; live interventions; a harness-neutral session surface; project and
worktree context; Field; model-provided reasoning in the conversation; a persistent project/task
workspace; a shared workspace service; Oh My Pi saved-session observation and its v0 → v1 upgrade;
durable work attempts with explicit handoff briefs; independent verification receipts; and
requesting a prepared attempt from the paired page.

## Research studies (November)

| Study | Result | PR / where |
| --- | --- | --- |
| MEM-000 | What the recorded evidence permits learning: 143 causal-policy-usable examples from one study; MEM-001 judged **NOT READY**, recommendation to reconsider the objective | #126, `research/evidence-eligibility/RESULTS.md` |
| EVAL-ISO-001 | Protected offline experiment execution: Bubblewrap sandbox verified from inside, submission collected only after the sandbox is confirmed gone, independent evaluator in a second sandbox, sealed per-trial records | #127, `docs/protected-experiments.md` |
| WORK-CYCLE-001A | One real DEVELOP work cycle reconstructed from stored evidence, independently inspectable end to end; answer: yes, for one task on one machine | #128, `research/work-cycle/README.md` |
| WORK-CYCLE-001B | Attempt evidence in one read-only reading, plus the **first human-governed run** (operator approved on the workbench terminal); two bugs found and fixed; a known gap documented: a Pi-started tool process can outlive the workbench | #129, `research/work-cycle/WORK-CYCLE-001B.md` |
| EVIDENCE-INTEGRITY-001 | A damaged authorisation record now reads as `damaged`/`[unknown]`, never as "not authorised"; evidence schema bumped to `endo.develop-attempt-evidence.v1` | #130 |
| REVIEW-PILOT-001 | Review pilot prepared and run on 2026-11-08; question: can the operator decide accept/reject from records and the diff alone? The operator's review is pending | #131, `research/review-pilot/README.md` |
| Workbench command fix | Found by REVIEW-PILOT-001 run 1: a terminal command typed into the page was sent to Pi as chat; one rule now catches `pair`/`attempt` texts on page and terminal | #132 |
| LIVE-PROCESS-CONTAINMENT-001 | A live Pi session's processes are owned: each session runs in its own transient systemd user scope; cleanup is stopped and the cgroup confirmed empty, reported as `confirmed` / `CLEANUP INCOMPLETE` / `UNVERIFIED` — never assumed. Result of the "Mission 01" containment review threads (review A–D) and the minimal correctness patch thread | #133, `docs/live-process-containment.md` |
| EVAL-ISO-002 | Model access for a protected sandbox through one narrow Unix-socket relay: governed admission of only `POST /v1/chat/completions` for the declared model, every admitted exchange recorded as a verifiable cassette; real Pi ran inside the sandbox against a real local model | #134, `docs/protected-model-access.md` |
| EXPERIENCE-DATASET-V1 | Research design (no prototype, deliberately): qualified experience bundles as a derived, versioned projection; protected-trial records are the first full-bundle source; why MEM-000 lacked eligible diversity; EXPERIENCE-DIVERSITY-001 pre-registered experiment proposed | #135, `research/experience-dataset/EXPERIENCE-DATASET-V1.md` |
| COUNTERFACTUAL-REPLAY-001 | Feasibility probed with two measurements on a real model: cassette replay of a real run misses at exchange 2 (environment class: file mtimes); decision reproduction gives four different trajectories from an identical first request, all reaching the same workspace and answer; Pi sends no `seed`/`temperature`. Verdict: counterfactuals feasible at the initial checkpoint now; mid-run needs a pinned clock and prefix-then-live upstream; attribution is distributional only, no causal claims from traces | #136, `research/counterfactual-replay/COUNTERFACTUAL-REPLAY-001.md` |

## Open threads as of this summary

- The REVIEW-PILOT-001 operator review and decision are still pending (#131).
- EVAL-ISO-002 is a mechanism, not yet wired into `endo experiment protected-run` (#134).
- Owner decisions are queued in EXPERIENCE-DATASET-V1 §8 and COUNTERFACTUAL-REPLAY-001 §7.
