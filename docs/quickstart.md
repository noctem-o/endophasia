# Quick start and guided tour

<a id="quick-start"></a>

This page holds the hands-on material that used to sit in the [README](../README.md): building from source, the five-minute
tour, starting a live workbench, and the other ways into Endophasia. Moved from the README on 28 November 2026 (pinned tree
`d2024ac51`) and otherwise unchanged except where a statement had gone stale; the Coordinator block was rewritten for E1, E2,
M1, S1, S2 and F1. The tour needs no agent and no model; it was re-run in an isolated temporary directory for that refresh.

## Build from source

Requires **Node.js >= 22.19.0** and Git with a configured identity (`user.name` and `user.email`): checks run only at a clean commit.

```sh
git clone https://github.com/noctem-o/endophasia.git
cd endophasia
npm ci
npm run build
alias endo="node $PWD/dist/cli/index.js"
```

The alias runs the CLI built from this checkout ahead of any older global `endo`. Rebuild after pulling source changes.

## Take the five-minute tour

No agent, no model, no cost — you play the agent in a throwaway Git repo and store.

<details open>
<summary><strong>Walk through one bug, one plan, one receipt and one ledger</strong> (6 steps)</summary>

**1. Create a small calculator with an operator-precedence bug.**

```sh
bash                                   # a subshell, so nothing below leaks into your own shell
TOUR=$(mktemp -d) && cd "$TOUR" && export ENDO_STORE_ROOT=$TOUR/store

mkdir calc && cd calc && git init -q
cat > calc.mjs <<'EOF'
// Evaluates left to right, so 2+3*4 comes out as 20.
const tokens = process.argv[2].match(/\d+|[+*]/g);
let total = Number(tokens[0]);
for (let i = 1; i < tokens.length; i += 2)
  total = tokens[i] === "+" ? total + Number(tokens[i + 1]) : total * Number(tokens[i + 1]);
console.log(total);
EOF
git add calc.mjs && git commit -qm "A calculator"
```

**2. Declare what a right answer looks like, before any work begins.**

```sh
cat > ../plan.json <<'EOF'
{
  "checks": [
    {
      "name": "precedence",
      "argv": ["node", "calc.mjs", "2+3*4"],
      "shows": "multiplication binds tighter than addition",
      "expect": { "exitCode": 0, "stdout": "14\n" }
    }
  ],
  "criteria": [{ "text": "2+3*4 is 14", "checks": ["precedence"] }]
}
EOF
```

**3. Register the project, add a task and prepare an attempt.** Each command prints the id the next one takes.

```sh
endo project add --name "Calculator" --path "$PWD"
endo task add --project endo.project.<id> --title "Fix operator precedence"
endo attempt prepare --project endo.project.<id> --task endo.task.<id> \
  --objective "Make multiplication bind tighter than addition" --plan-file ../plan.json
```

Nothing has been sent anywhere. `endo attempt brief --attempt endo.attempt.<id>` prints the plain-text brief, plan included, ready to hand to any coding agent.

**4. Run the check yourself, then read the ledger.**

```sh
endo attempt check --attempt endo.attempt.<id> --keep-output -- node calc.mjs '2+3*4'
endo attempt evidence --attempt endo.attempt.<id>
```

The criterion reads *A planned check failed at HEAD*, as in the excerpt at the top of the [README](../README.md).

**5. Fix it, commit and check again.**

```sh
cat > calc.mjs <<'EOF'
// Multiplication first, then addition.
const terms = process.argv[2].split("+");
const products = terms.map((term) => term.split("*").reduce((a, b) => a * Number(b), 1));
console.log(products.reduce((a, b) => a + b, 0));
EOF
git commit -qam "Multiplication binds tighter"

endo attempt check --attempt endo.attempt.<id> --keep-output -- node calc.mjs '2+3*4'
endo attempt evidence --attempt endo.attempt.<id>
endo attempt observe --attempt endo.attempt.<id>
endo attempt provenance --attempt endo.attempt.<id>
```

The planned check now reads *Passed at HEAD*, followed by *at another commit … failed* — the earlier failure stays on record. `observe` captures what Git shows now, and `provenance` compares it against each checked commit. The task stays `open` until you decide with `endo task status`.

**6. Open it in a browser.**

```sh
endo workspace open --project endo.project.<id>
```

Open the private loopback address it prints, enter the pairing code from the terminal and pick the task. Stop with **Ctrl-C**. Then delete the throwaway directory and leave the subshell, which restores your own environment: `cd / && rm -rf "$TOUR" && exit`.

</details>

## Work with a live agent

The live workbench attaches to [Pi](https://github.com/earendil-works/pi) (reference runtime) or **Codex** (local App Server), which you install and configure separately; Endophasia never installs, updates or patches either harness. It requires **Linux with `/proc` and a controlling terminal** — stdin and stderr must both be that terminal, and piped or redirected approval input is refused.

```sh
endo doctor
cd /path/to/project
endo develop                        # live Pi workbench (reference runtime)
endo develop --harness codex        # live Codex workbench (Strict-only; alias: endo codex session --workbench)
```

For Pi, `endo develop` is `endo harness attach --control --workbench` in one word, without `--prompt` (every prompt is requested from the page and authorised on the terminal). For Codex, `endo develop --harness codex` (or `endo codex session --workbench`) starts an isolated local Codex App Server (`CODEX_HOME` with inherited MCP servers disabled at startup) behind the same paired workbench surface. A session needs neither a registered project nor a task; when you want tasks, attempts and receipts beside the conversation, register once and name it:

```sh
endo project add --name "My project" --path /path/to/project
endo develop --project endo.project.<id>
endo develop --harness codex --project endo.project.<id> --model <model-id>
```

| Harness | Modes | Live controls | Current boundaries |
| :--- | :--- | :--- | :--- |
| **Pi** (`endo develop`) | Requests **Everyday** (narrow attested sandbox only); otherwise **Strict** | `PROMPT`, `STEER`, `QUEUE`, `STOP`, prepared-attempt send (`attempt <id>`) | Terminal approval governs dispatch, not Pi's tools |
| **Codex** (`endo develop --harness codex`) | **Strict-only** (no Everyday grants; `--mode everyday\|protected` refused) | `PROMPT`, targeted `turn/interrupt` (`STOP`), read-only pending native approval banner | Native Codex tool and file approvals are answered on the terminal: allowed once (`ALLOW ONCE`), cancelled or declined; never session-wide; over-long or unsupported requests are declined, and any requested widening of scope or permissions is withheld; no `STEER`, `QUEUE` or prepared-attempt dispatch yet; shares a single-writer event-store lock with Pi |

**Modes** ([DEVELOP-UX-002](../research/develop-ux/DEVELOP-UX-002.md)). On Pi, `endo develop` *requests* **Everyday**: one terminal authorisation grants bounded page-driven prompts, steers, queues and stops in one workspace (the control grant defaults to 30 minutes and 200 sends) — *only* while Endophasia verifies an enforced sandboxed session. Today that attested configuration is narrow: stock Pi 1.5.2 with local `Ornith-1.5-9B-Q8_0` through the governed relay, no tools, ephemeral session, read-only workspace snapshot, no credentials and no unrestricted network. Its recording relay admits one model exchange of at most 128 completion tokens, and passing `--project` skips Everyday preparation entirely. Everywhere else — and always on Codex — the workbench runs in **Strict** (each request approved on the terminal) and states why. Use `--mode strict` to ask for Strict outright, `--mode protected` to refuse to start where protection cannot be enforced, or `--confirm short` to approve non-attempt Strict requests with a four-character code shown on the terminal.

1. Open the private loopback URL printed in the terminal (it lands directly on **Develop**) and pair it with the one-time code. Type `pair` in the terminal for a fresh code.
2. Draft a **Prompt** when idle, or request **Steer** / **Queue** (Pi) or **Request stop** during an open run whenever the broker offers them.
3. In Strict mode, approve on the controlling terminal (e.g. `APPROVE PROMPT <digest>`). **The page can ask; only the terminal approves.** When Codex emits a native tool or file approval request, the page shows an unmistakable read-only pending banner while the controlling terminal handles it fail-closed.
4. On Pi, send a prepared attempt via `attempt <id>` on the terminal or from the **Task** view — its full brief is shown and requires its own `APPROVE ATTEMPT` phrase, at most once per attempt.
5. Watch the conversation, folded model-provided reasoning (with explicit `Reasoning summary` vs raw-thinking provenance on Codex), **Course** gauges, live usage and Git worktree changes in **Conversation | Changes**. **Follow** starts on (bounded, paused when hidden, toggleable off), or click **Read session** for an explicit read. Stop with **Ctrl-C**.

Choose Pi's provider, model or binary with `--provider`, `--model` and `--pi`; choose Codex's model, reasoning effort, sandbox mode or binary with `--model`, `--effort`, `--sandbox` and `--executable`. Approved dispatches perform real agent work and may incur provider costs.

> [!WARNING]
> Terminal approval governs *dispatch*. It **does not sandbox the tools Pi or Codex runs** (Codex's own `--sandbox` flag
> is native to the Codex runtime, separate from Endophasia's dispatch gate). Likewise, `endo attempt check`
> runs your command with your permissions, and a repository's test suite is that repository's code.

Guides: [live workbench](develop-workbench.md) · [adapter contract](designs/develop-adapter-contract.md) · [Codex live](designs/develop-codex-live.md) · [Codex in Studio](designs/develop-codex-studio.md) · [projects and tasks](develop-tasks.md) · [sending an attempt](designs/develop-attempt-workbench.md) · [private activity](private-activity.md) · [process containment](live-process-containment.md).

## More ways in

<details>
<summary><strong>Record and inspect a Pi session from the CLI</strong></summary>

```sh
endo harness check ./recordings       # local protocol checks; no model call
endo harness attach ./recordings --cwd /path/to/project --prompt "Summarise this project"
endo harness status ./recordings
endo harness overview ./recordings
endo trajectory show ./recordings <session-id>
endo studio ./recordings
```

`--cwd` is Pi's project directory; `./recordings` is the separate evidence store. Omitting the store resolves `$ENDO_STORE_ROOT`, then `$XDG_DATA_HOME/endophasia/store`, then `~/.local/share/endophasia/store`.

</details>

<details>
<summary><strong>Check and run a live Codex session from the CLI</strong></summary>

```sh
endo codex check ./recordings --cwd /path/to/project              # offline App Server protocol check; zero model turns
endo codex session ./recordings --cwd /path/to/project --model <id> --effort low
endo codex session ./recordings --cwd /path/to/project --workbench # same Strict-only browser workbench as endo develop --harness codex
```

Spawns a local Codex App Server in an isolated conservative `CODEX_HOME` (inherited MCP servers disabled before startup, preserving read-only local auth). Every prompt, targeted `turn/interrupt` and native Codex approval request is confirmed on the controlling terminal; the terminal can allow a supported native request once, unsupported requests are declined, and any requested widening of scope is withheld. See [Codex live integration](designs/develop-codex-live.md) and [Codex in Studio](designs/develop-codex-studio.md).

</details>

<details>
<summary><strong>Coordinate from the CLI</strong> (status, intent, schedules, advisory)</summary>

```sh
# Deterministic projections: read-only, no model
endo coordinator status ./recordings [--project endo.project.<id>]
endo coordinator coordination ./recordings --project endo.project.<id>

# Operator intent (E1/E2): records only; nothing is dispatched, prompted or stopped
endo assign <create|supersede|revoke|close|bind|unbind|link|reconfirm|clear-hazard|list|show> --root ./recordings ...
endo dep <add|decide|withdraw-decision|remove|list> --root ./recordings ...
endo candidate <declare|declare-protected|select|list> --root ./recordings ...
endo worktree <register|unregister|list> --root ./recordings ...
endo review <record|list|show> --root ./recordings ...

# S1: zero-token observations and a durable schedule ledger (no timer installed; add --disabled to create a schedule disabled)
endo schedule <add|list|enable|disable|remove> --root ./recordings ...
endo scheduler tick --root ./recordings [--pool pool.json]
endo scheduler print-systemd-unit --root ./recordings      # prints an example timer; installs nothing
endo resource <declare-window|list> --root ./recordings ...

# M1 model pool and an on-demand briefing (one local model, advisory only)
endo coordinator pool check --pool pool.json
endo coordinator brief ./recordings --project endo.project.<id> [--pool pool.json [--member <id>]]

# S2: scheduled advisory turns, disabled until enabled and authorised for that exact revision
endo advisory <add|enable|disable|remove|authorize|revoke|tick|list|fires|briefings|proposals|ack|dismiss> --root ./recordings ...
```

Three levels of contact are worth telling apart. Most commands above make **no HTTP contact** with any model endpoint.
`coordinator pool check` (with or without `--pool`) and an S1 `scheduler tick` that claims a health action send **zero-token `GET` requests**
(`/health`, `/props`, and `/models` or `/v1/models` where those apply) to the local endpoints named, and nothing else. Only two commands
can run **inference**. `coordinator brief`
runs one sandboxed OpenClaw turn against one local model. `advisory tick` does the same only for an enabled schedule holding a
current, unexpired grant, within its turn, token and wall-clock ceilings. Run any of the endpoint-contacting commands only against an endpoint you intend to use. S2 briefings and proposals are stored as untrusted model interpretation (an on-demand `coordinator brief` only prints its result).
They grant nothing: no Coordinator command dispatches a harness, claims an attempt route, moves a task or merges anything.

An assignment records who is *intended* to do a task. It is not an authorisation. E2 adds a governed dispatcher for
assignment-linked attempts, but on `main` it is reachable only as a library (no CLI or Studio command calls it). The live Pi
workbench and the protected runner refuse assignment-linked attempts (`assignment-required`).

See [Coordinator status](designs/coordinator-status.md), [coordination metadata (E1)](designs/coordinator-assignment-implementation.md),
[governed assignment (E2)](designs/coordinator-assignment-e2-implementation.md), [model pool (M1)](designs/coordinator-model-pool-m1-implementation.md),
[scheduler and observations (S1)](designs/coordinator-automation-s1-implementation.md) and
[scheduled advisory intelligence (S2)](designs/coordinator-automation-s2-implementation.md).

</details>

<details>
<summary><strong>Browse the interface with demo fixtures</strong> (no Pi, no model)</summary>

```sh
node scripts/seed-cockpit-demo.ts ./demo-store
endo studio ./demo-store
```

Seeds a new or empty directory with fake-Pi lifecycle fixtures and a recorded Pi 1.0.0 conformance specimen.

</details>

<details>
<summary><strong>Explore offline model activation captures</strong> (Observe → Representation Explorer)</summary>

```sh
endo studio ./recordings --representations /path/to/captures
```

Loads validated offline TransformerLens 4.x `TransformerBridge` captures (`endo.observe-representation-capture.v0`) read-only, computes a deterministic 2D PCA slice on the server, and renders observed stats, derived coordinates, isolated interpretations and explicit `UNAVAILABLE` gaps — with zero Python, PyTorch or GPU requirement in Studio itself. See [Representation Explorer](designs/observe-representation-explorer.md).

</details>

<details>
<summary><strong>Import a saved DeepSeek Harness (DSH) session</strong></summary>

```sh
endo dsh import --root ./recordings /path/to/session-directory
endo dsh loss-accounting
endo studio ./recordings
```

Pass one persisted **Session format-4 directory**. Import leaves the source untouched and writes validated evidence with explicit mapping losses; it never starts, watches or controls DSH. See [DSH native importer](dsh-native-importer.md).

</details>

<details>
<summary><strong>Read Oh My Pi saved sessions in place</strong></summary>

```sh
endo studio ./recordings --omp-sessions /path/to/omp/sessions
```

Read-only metadata from OMP's own format-3 files (counts, kinds, built-in tool names, model names, exit records) — no message text, no live view, no control. Link a saved session to a task with `endo task link`. See [OMP observer](develop-omp-observer.md).

</details>

<details>
<summary><strong>Run a sandboxed experiment</strong> (Linux, Bubblewrap)</summary>

```sh
endo experiment protected-run <spec.json> --out <dir>
endo experiment protected-report <dir>
```

An untrusted agent works on a disposable tree inside a Bubblewrap sandbox verified from the inside before execution starts. Submissions — either fixed paths (spec `v0`/`v1`) or opt-in arbitrary multi-file **staged change sets** verified against a controller-pinned baseline (`v2`/`v3`) — are collected only after agent processes are confirmed ended, then graded inside a separate evaluator sandbox from hidden cases. Model-connected runs (`v1`/`v3`) reach one declared local endpoint through a recording relay and can opt into capability-consistent Pi runtime prompting ([runtime-prompt.ts](../adapters/sandbox/runtime-prompt.ts)). Refuses rather than run unprotected. See [protected experiments](protected-experiments.md), [protected model access](protected-model-access.md) and [staged change sets](designs/protected-staged-changeset.md).

</details>

<details>
<summary><strong>Install the earlier packaged alpha</strong></summary>

```sh
npm install -g endophasia@0.1.0-alpha.2
endo doctor
endo studio
```

Name the version explicitly: npm's `latest` tag pointed to the CLI-only `0.1.0-alpha.1` when checked on 28 November 2026 (`alpha` → `0.1.0-alpha.2`). `0.1.0-alpha.2` contains the earlier read-only browser page without the DEVELOP features above. See [docs/install.md](install.md).

</details>

## Access, privacy and retention boundaries


- Keep the loopback Studio URL private: anyone holding it can read presented evidence. `endo studio` writes nothing to the store (first launch may create its own comparison digest key).
- Workspace and workbench require separate one-time pairing and an expiring in-memory grant; the URL alone grants no write or request authority.
- Live transcripts carry user/assistant text, structured model-provided reasoning where the harness emits it (preserving Pi's structured `thinking` blocks and Codex's explicit `Reasoning summary` vs raw-thinking provenance), and structured private activity (`tool`, `file-change`, `activity` rows) with policy-bounded previews and an explicit non-authorising capability descriptor (*"A description, not a permission"*). Literal `<think>` tags are never treated as authenticated reasoning. See [docs/private-activity.md](private-activity.md) and [docs/develop-reasoning.md](develop-reasoning.md).
- Live transcript, reasoning and pending native Codex approval summaries stay bounded in process memory, are excluded from canonical evidence and the read-only Studio API, and clear immediately when the session ends or tears down. Pi's own session files and Codex's isolated `CODEX_HOME` are separate from the canonical event store.
- Receipts store a SHA-256 of stdout when the stream was read completely (an incomplete stream records no digest and an inconclusive result); `--keep-output` additionally retains the first 8 KiB as text for behavioural diffs when it is valid UTF-8, so avoid it on commands that print secrets.
- DEVELOP records are local, unsigned files under `<root>/develop/` — anything able to write the store can modify them.

See [docs/studio.md](studio.md).

