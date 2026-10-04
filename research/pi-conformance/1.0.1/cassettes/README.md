# Pi 1.0.1 cassette recordings

Four real sessions, each recorded through the recording proxy with its cassette, so it can be replayed with the
model's outputs held fixed ([docs/replay.md](../../../../docs/replay.md)).

**Recording conditions:**

- **When:** 2026-10-03.
- **Pi:** Pi 1.0.1, identity in `provenance.json`.
- **Model:** qwen3.8-27b (Q4_K_M) on llama.cpp's OpenAI-compatible server, reasoning on, on Linux.
- **Mapping and key:** `pi-rpc-mapping.4`, in fixture mode under the committed public key `fixture-public`. Every
  digest and blob address here offers no secrecy.

The command:

```sh
node scripts/record-cassette-fixture.ts --pi /usr/bin/pi --upstream http://127.0.0.1:8080 \
  --model qwen3.8-27b --authorize-live-study
```

| Session | What happens | Exchanges (outcome / chunks) |
| :--- | :--- | :--- |
| `completes` | "Reply with the single word: ready", run to `agent_settled` | complete / 24 |
| `stop-mid-turn` | the long counting prompt; STOP once the proxy relayed 16 chunks | client-disconnected / 17 |
| `killed-and-resumed` | the long prompt from a child process, SIGKILLed after 16 chunks; the store and session are reopened, then "Reply with the single word: resumed" | client-disconnected / 17, complete / 170 |
| `tool-use` | the model reads `notes.txt`, edits `draft` to `final`, runs `wc -l notes.txt`, replies "done" | complete / 74, 46, 26, 24 |

In `tool-use`, "tools EXACT" is not vacuous. The trajectory has three tool calls (`read`, `edit`, `bash`), each with a
keyed argument digest and a keyed result digest.

Each session directory holds:

- `session.events.jsonl`: what Pi did, through the attachment.
- `capture.events.jsonl`: the exchanges, the workspace snapshot and the driver's steps.
- `evidence.jsonl`: the capability evidence the session ran under. The live study ran through the same proxy port, so
  it applies to replays.
- `blobs/fixture-public/`: request bodies, response wire bytes, the snapshot archive and the prompts.
- `overview.json`: the reducer's overview of the session events.

`provenance.json` records the file hashes. `tests/trajectory.test.ts` checks them.

These recordings replace `../completes-repeat/`. That was recorded under a scratch key that was later deleted, so it
could never be compared again.

## What the files contain

Before committing, every file was searched, with blobs decoded: request bodies, response wire bytes, snapshot
archives and prompts.

**Absent:** username, hostname, home directories, API keys or bearer tokens, email addresses, LAN addresses. The
Authorization header is recorded as `{name: "authorization", redacted: true}`, and its value appears nowhere. The
scratch `models.json` uses the placeholder key `local`.

**Present:**

- **Paths.**
  - The recorder's scratch path `/tmp/endo-cassette-Yc7dxS/…`. It appears in Pi's system prompt (`<cwd>`) and in the
    events. A replay restores at this path.
  - Pi's install path `/usr/lib/node_modules/@earendil-works/pi-coding-agent/…`, in Pi's system prompt and in the
    evidence.
- **Host details in the recorded request headers:**
  - `user-agent: pi (linux 7.2.6-arch2-1; x64)`, which includes the kernel release;
  - `x-stainless-os: Linux`, `x-stainless-arch: x64`, `x-stainless-runtime-version: v26.10.0` and
    `x-stainless-package-version: 7.19.0`.
- **Server details in the responses:** `Server: llama.cpp`, and llama.cpp's build fingerprint (`b10828-3ad1ba733`)
  and per-request timings in the streamed chunks.
- **Content:** only the scenarios' synthetic prompts and file, Pi's own system prompt, and the model's replies and
  reasoning text about those tasks.

## Replays

`replays.json` holds every replay below, run on 2026-10-03 against the same Pi 1.0.1 with:

```sh
node scripts/replay-cassette-fixtures.ts --pi /usr/bin/pi --times 5 --timings as-recorded,immediate --out replays.json
```

No model was called. Each replay restored the recorded scratch root at its recorded path, served the cassette on the
recorded port, drove a fresh Pi through the recorded steps, and compared the new store with the recording.

| Session | Timing | Runs | lifecycle | tools | outcome | misses / unserved | flags | timing Δ (observer, ms) |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | :--- |
| completes | as-recorded | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | +2, +1, 0, +3, +1 |
| completes | immediate | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | −748, −748, −746, −748, −747 |
| stop-mid-turn | as-recorded | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | 0, 0, +2, +1, +1 |
| stop-mid-turn | immediate | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | −436, −438, −437, −436, −437 |
| killed-and-resumed | as-recorded | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | no total (the killed run has no wall time) |
| killed-and-resumed | immediate | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | no total (the killed run has no wall time) |
| tool-use | as-recorded | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | −13, −13, −14, −15, −14 |
| tool-use | immediate | 5 | EXACT ×5 | EXACT ×5 | EXACT ×5 | 0 / 0 | none | −2583, −2586, −2585, −2587, −2588 |

No replay diverged, so there is no first divergence to explain. Usage under a cassette is the recorded usage, so it is
not informative here. Timing follows the mode: `as-recorded` lands within about 15 ms of the recording, and
`immediate` saves the model's streaming time.

**Negative control (real Pi).** `tool-use` was replayed with `work/notes.txt` changed after the restore and before Pi
started (`tests/pi-real-replay.test.ts`). The replay saw the change:

1. The first exchange (the read call) was served. Pi's `read` returned the changed content, so the tools layer diverged
   at index 0 on `resultDigest` alone: same name, same argument digest, same status.
2. Pi's next request carried that content, so it was an explicit `unexpected-request` miss at exchange 2. Three
   recorded exchanges were never served.
3. The lifecycle diverged at index 5 (turn 2 ended with `error`, not `toolUse`). The outcome diverged as completed vs
   failed, with the cause recorded by reference and classified `server-error` (the 599).

So the EXACT results above are not a comparison that cannot see a difference.

**What this does not establish:** anything about the model, which is held fixed. It also says nothing about tool
effects outside the scratch root, about tools whose output is nondeterministic (`wc -l` on the restored file is
deterministic), or about another machine, Pi release or configuration. See
[docs/replay.md](../../../../docs/replay.md#what-a-replay-establishes-and-what-it-does-not).
