# DEVELOP: observing Oh My Pi saved sessions

Endophasia can show **Oh My Pi (OMP)** sessions in DEVELOP, read-only, beside its own Pi and DSH sessions. This is its first real
non-Pi session source. It **observes** OMP's saved session files. It does not take ownership of a session, connect to an OMP
process, or control one.

```sh
endo studio ./recordings --omp-sessions ~/.omp/agent/sessions
```

Code:
- [`adapters/omp/`](../adapters/omp/): the reader and the observer.
- [`protocol/omp-observation.ts`](../protocol/omp-observation.ts): the closed records.
- [`studio-ui/src/develop/Omp.tsx`](../studio-ui/src/develop/Omp.tsx): the drawing.
- `presentOmpSaved` in [`studio-ui/src/model/develop-session.ts`](../studio-ui/src/model/develop-session.ts): the neutral surface entry.

## How to use it

1. Find OMP's session directory. On a default installation it is `~/.omp/agent/sessions`.
   - A profile uses `~/.omp/profiles/<name>/agent/sessions`.
   - `omp --session-dir <dir>` and XDG settings can move it.
   - Inside OMP, `/session info` prints the authoritative path.
2. Start Studio with `--omp-sessions <that directory>`. There is no default and nothing is discovered elsewhere. Without the flag, Studio
   shows no OMP group at all.
3. Open **Develop**. The navigator has a group, **Oh My Pi · saved files (n)**, below the recorded sessions. Choose a session. The centre
   column shows its committed activity and the right column shows its inspector.
4. **Read again** re-reads the list or the open session. Nothing is read on its own after the first list.
5. **To stop observing**, stop Studio (Ctrl-C), or start it without `--omp-sessions`. Nothing persists: Endophasia keeps no copy, index or
   cursor of OMP's files.

## What it shows, and what it cannot

| Shown | Never shown or read |
| :-- | :-- |
| OMP's session id, as its key (scope: the `omp-saved` source) | Message text, model reasoning (`thinking`), tool arguments and results |
| A short label from the id's last 8 characters (a label, never a key) | Session titles (the title slot and `title_change` text), the working directory, project directory names |
| The file's state: readable, unsupported format, no header, too large, unstable, unreadable | Compaction and branch summaries, `custom_message` content, `session_init` prompts and tasks |
| Counts: user and assistant messages, tool calls, tool errors, compactions, unknown entry types, malformed lines | `credential_pin` digests, `providerPromptCacheKey`, provider payloads, error message text |
| Committed activity on the current path: entry kinds, the names of OMP's own built-in tools (any other tool, such as an MCP server's, is "(withheld name)"), model names that are plain names (a path, a model file or an odd shape is withheld: local servers can report a file path as a model id), stop reasons, error flags | The `.log`, `.md` and `.json` files OMP keeps beside a session (command output, subagent results): never opened |
| OMP's own exit record (`session_exit`), when it is the last entry and no unfinished write follows it; its reason only from OMP's own closed set | A lineage *path* (shown only as "copied from another saved file") |
| Lineage as OMP recorded it in the header (`parentSession`): a fork or subagent of an id, or a copy of a file | Anything inferred from a file name, a directory or a time |
| The OMP versions the entries record (`runtime.version`); with none recorded, the runtime is *unavailable*, because that the files are OMP's is your statement and a format match | Whether an OMP process is running |

**It is a persisted snapshot.** OMP saves an entry when it completes, so a response that is still streaming is not in the file. Each
request reads the file whole and shows it as it was at that moment (the page gives the read time). It is not token streaming, not a live
transcript and not live reasoning, and the surface says so: `live-status`, `live-transcript` and `live-reasoning` are `unsupported`.

**It cannot control OMP.** Every control action (prompt, steer, queue, stop, resume) is `unsupported`, with the reason. There is no
composer and no stop control for these sessions, and no route that could carry one. The projector hard-codes every control action as
`unsupported`, and the neutral contract's validator, run by the tests, refuses an OMP entry that claims one or the Pi broker's governed
path. (The browser imports the protocol as types only, so that validator does not run in the page.) Endophasia never runs `omp`, never sends it anything, and never
reads a command from its records.

**It cannot tell whether OMP is running.** What the status claims mean:

- **OMP's exit record is the last entry.** The page shows *ended* (or *interrupted* for a signal exit), **reported by OMP**.
- **No exit record is last.** The page shows the turn state at the last saved entry, **as recorded**: a tool call or user message
  still waiting is *active*, an answered turn is *idle*.

Neither is a process state. A session resumed after its exit no longer counts as ended. No file modification time is read as a status,
and the inspector's "process now" says *not established*.

### How this differs from Pi's live workbench

| | Pi workbench (`harness attach --workbench`) | OMP saved-session observer |
| :-- | :-- | :-- |
| Owner of the session | The attached Endophasia process (`direct`) | OMP (`external`) |
| Observation | Live: a connected broker | Recorded: OMP's saved file, read on request |
| Transcript | Bounded live conversation (paired page only) | None: counts and kinds only |
| Control | Prompt, steer, queue, stop, through the broker, approved at the terminal | None |
| Access | A paired page, behind the pairing grant | The read-only Studio address, metadata only |

## Storage and privacy

- **Read-only.** Files are opened read-only with `O_NOFOLLOW`. Each file's identity (device, inode, size, change times) is compared before
  and after the read, and the path is checked to still name the same file. A change during the read is retried once, then reported as
  `unstable` with nothing used.
- **Links and special files.**
  - A link is never followed, to a file or a directory: it is counted and skipped.
  - Each directory walked, and each file's directory before it is read, must resolve to itself. A directory swapped for a link after
    the walk looked at it is therefore refused. This is a check, not an atomic guarantee: the window between it and the open is small,
    and the open refuses a link in the last component (`O_NOFOLLOW`).
  - A FIFO or other special file is never read. It is skipped by its type, and one swapped in later is opened non-blocking and refused.
  - A directory that cannot be read is counted as not readable and the rest is still listed.
- **Depth and bounds.** Three directory levels are looked into: the root, project groups, and a session's artifact directory. The bounds
  are:

  | Bound | Limit |
  | :-- | :-- |
  | Per file | 96 MiB and 400 000 lines (memory and time grow with the lines, so both are bounded) |
  | Files per listing | 200 |
  | Bytes per listing | 512 MiB, charged by the bytes actually read |
  | Activity entries shown | 60 |

  The largest real local session was 34.5 MB, with a longest line of 195 KB. Reads are synchronous: a listing at the bounds blocks
  Studio's process while it runs, and each one is charged to Studio's existing read budget, so repeated requests are refused with
  a 429.
- **What a test proves.** It takes a manifest of the whole directory before and after many reads, and requires no change in any byte,
  modification or change time, inode or mode.
- **What Endophasia writes.** Nothing under the OMP directory. Studio refuses to start if its key file would go there, or if the OMP
  directory and the store overlap.
- **The privacy rule is an allowlist.** The reader keeps only the fields listed above, and the protocol validator refuses any member it
  does not know.
  - A test plants a canary in every withheld field (messages, thinking, tool arguments and output, titles, paths, summaries, prompts,
    the credential digest, the cache key, the side files). It then fetches every Studio route the page uses, and the whole rendered page
    in both appearances at desktop and phone width. The canary never appears.
- **Who can see it.** The read-only Studio address is its access capability, as for recorded sessions. Anyone holding that address can
  read this metadata (ids, counts, tool and model names, times) for the named directory, so keep it private. Studio sends nothing
  anywhere.
- **OMP's own file permissions.** OMP writes these files `0644`, inside `~/.omp/agent`, which is `0700`. Protect that directory as OMP
  asks: the files themselves hold prompts, source excerpts and command output.

## When something is wrong

| Situation | What DEVELOP shows |
| :-- | :-- |
| The directory is missing | Studio refuses to start: `--omp-sessions must name an existing directory` |
| A session file is damaged (no header, not JSON) | `not readable`: no key, no status, lifecycle and activity `unavailable` with the reason |
| A malformed line in the middle | Counted as a malformed line and skipped, as OMP's own reader skips it |
| The last line is unfinished (a write in progress, or a crash) | Left out, with "an entry OMP had not finished writing"; read in full once it is complete. It never damages the session |
| An entry type this version does not know | Counted as unknown, shown as `other entry`, never treated as damage (OMP documents extension records) |
| OMP upgraded its session format (header `version` is not 3, or a title slot of a version other than 1) | `format not read`: nothing else is read from the file, never read as the version it resembles |
| The file was rewritten in place (OMP's title slot always is; maintenance can rewrite more) | The next read shows it as it now is. There is no tail offset, so nothing from an earlier read is merged |
| The file was replaced by another (a new inode) | It gets a new selector, made from the path, the device, the inode and the file's birth time, so a later file that reuses the inode number is not mistaken for it (on a filesystem without birth times, inode reuse remains possible). A page holding the old one is told the session is no longer where it was, never shown the new file under the old name |
| Two files carry one session id (a copy) | Neither has a key ("Two saved files … carry this session id") and neither has a label. The ids are counted from the same full reads that build the rows, and the list's validator refuses two rows with one established key |
| The session tree is damaged (repeated ids, missing parents, cycles) | Counted and shown; the path follows the last entry back as far as it can |

## Decision record

### The installed agents (audited 1 November 2026, read-only)

Probed with `--version` or `--help` only. Session stores were inspected by **structure** (names, counts, record types and keys), never
by content. No agent was started, no prompt sent, no configuration changed.

| Agent | Executable and version | Session data | Observe a running session without touching it? | Endophasia code |
| :-- | :-- | :-- | :-- | :-- |
| **Oh My Pi** | `~/.local/bin/omp` (compiled Bun binary), `omp/18.14.1` | Documented, versioned JSONL: title slot `v1`, header `version 3`, tree entries; its own `session_exit` and `tool_execution_start` records | Its **saved file**: yes, read-only. Its process: no (RPC and ACP host a session; they do not attach to one) | ACP v1 client tested against OMP (a host, option C) |
| Claude Code | `~/.local/bin/claude`, 2.1.316 | JSONL under `~/.claude/projects` (`0700`), an internal format | Hooks are documented, but need a configuration change and give hook-event shapes, not a session format | None |
| Codex | `/usr/bin/codex`, codex-cli 0.166.0 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst` (zstd) | Compressed rollouts; the format is not a published contract | Mapping and shapes library (`adapters/codex`), not wired |
| Amp | `~/.amp/bin/amp`, 0.0.1793534443 | Whole-file JSON per thread beside `secrets.json`; threads sync to a service | Rewritten whole; credentials stored beside them | None |
| Hermes Agent | `~/.local/bin/hermes` (Python, git install), v0.21.3 | SQLite `state.db` beside a running gateway daemon; hooks need `--accept-hooks` | A live database under another process's lock and WAL | None |
| opencode | `/usr/bin/opencode`, v2.2.3 | SQLite `opencode.db` beside `auth.json` | As Hermes | None |
| goose | `~/.local/bin/goose`, 1.49.0 | No session store found | n/a | None |

OMP's local files matched its published format (omp.sh/docs/session-format) in every respect checked:
- all 41 local files have a 256-byte title slot (`v: 1`) and a `version: 3` header;
- every file ends with a newline;
- entries record `runtime.version` 18.13.3 or 18.14.1;
- the files hold 39 of OMP's own exit records (`normal/manual`, `normal/dispose`, `signal/sighup`);
- 13 headers carry `parentSession` lineage.

The docs also say a final line may be incomplete and the file may be rewritten in place. This reader is built for both.

### The choice: A, a saved-session observer, for OMP

| Criterion | A: OMP saved files | B: hooks (Claude Code, Hermes) | C: OMP RPC/ACP host |
| :-- | :-- | :-- | :-- |
| Read-only observation of a real existing session | Yes | Needs a configuration change and consent | No: it starts and owns a session |
| Identity and lifecycle | OMP's own id; its own exit records | Hook payloads; authenticity to establish | Ours, not the existing session's |
| Structured data | Complete committed entries | Event-shaped | Complete, but for a session we own |
| Reuse | The neutral surface and the Develop UI | None | The ACP client |
| Privacy and authority risk | Low with an allowlist; no authority | Hook code runs in the agent | Execution authority |
| Upstream maintenance | A published, versioned format; unknown versions refused | Hook APIs | Protocol drift |
| Real local evidence without a prompt | Yes: existing disposable sessions | Needs a run | Needs a run |

A is the strongest by every criterion that matters for this slice.

It was **not built as an append-only tailer**. OMP rewrites its title slot in place by design and may rewrite the rest, so a tail offset
could silently splice two generations together. Each request instead reads the whole file afresh. The cost is a full re-read per request:
about 0.2 s for all 41 local files.

### What was not done, deliberately

- No change to `endo.develop-session-surface.v0`. The existing contract represents a saved OMP session exactly:
  - `harness`, ownership `external`, observation `recorded`, connection `not-applicable`;
  - a `recorded` turn claim, or OMP's `reported` exit;
  - all control `unsupported`.
- No change to `endo.develop-tasks.v0`. An OMP session cannot be linked to a task: the workspace service refuses a host of source
  `omp-saved` (`unsupported-source`), and nothing joins one by a directory, a branch, a time or a title. (Since Slice D an OMP session can be
  linked from the CLI, explicitly, in a v1 file: see [develop-tasks.md](develop-tasks.md#oh-my-pi-saved-references). A launch host of source
  `omp-saved` is still refused.)
- No server-side surface. The surface is still built in the browser. The server serves only the closed observation records, which are
  registered in the cockpit version table, so a malformed one is never sent.
- No watcher, polling, daemon, OMP SDK (it targets Bun, not Node), OMP process, hook or configuration change.

### Real-source evidence

The source was **the existing saved sessions in the local OMP directory** (OMP 18.14.1 is installed): disposable ones left by Endophasia's earlier ACP and probe test
runs, read in place.

Run: the real `endo studio` process, with its key and an empty store in a scratch directory, and `--omp-sessions` naming each disposable
session directory in turn. Two sessions were read over HTTP:
- one ending with OMP's `session_exit` record (`normal/manual`);
- one ending without one.

Both were `readable`, format 3 with a title slot, keyed by their OMP ids. Their activity was model change, a bookkeeping entry (shown as
`other`), thinking change, user message, assistant message (`stop`, `openai-codex/…`), another bookkeeping entry and, in the first,
OMP's exit record.

Neither file records `runtime.version`, and the page says "none recorded in the entries". The observer was also run over the whole
directory (41 files), with aggregates only:

| Measure | Result |
| :-- | :-- |
| Readable | 41 of 41 |
| Keyed | 41 |
| Labelled | 41 |
| Final exit records | 21 manual, 13 dispose, 3 sighup |
| No final exit record | 4 |
| Open turns | 5 |
| Unknown entry types | 0 |
| Malformed lines | 0 |
| Validator failures | 0 |

A manifest of the whole directory (92 files: size, modification and change times, inode, mode, SHA-256) was identical before and after
every run. The first labelling attempt used the id's first 8 characters. Those collided, because OMP's ids are UUIDv7 and begin with a
timestamp, and only 19 of 41 got a label. The label now uses the last 8.

**No OMP process was running. None was started, no model was called, and no tool ran.** What this establishes:
- the observer reads real OMP 18.x format-3 files correctly, safely and without changing them. 18.14.1 is covered by the aggregate pass
  (entries in 4 files record it, 1 records 18.13.3); the two sessions read through the CLI do not record which version wrote them;
- the real CLI and HTTP path serves them;
- they appear in DEVELOP with the right attribution and no authority.

What it does **not** establish:
- observation of a session while an OMP process is writing it (not exercised against a real process; synthetic tests cover partial
  lines, rewrites and replacement);
- other OMP versions or profiles;
- anything about OMP's behaviour.

### Independent review (Opus) and what changed

The review found no control path, no live claim and no route that could reach OMP. It also found these, all fixed before the PR:

| Finding | Fix |
| :-- | :-- |
| **Material:** duplicate ids were counted by a cheap header-only pass that could disagree with the full reader, so two files with one id could both keep it | Ids are counted from the same full reads that build the rows; the list validator refuses repeated keys and labels |
| **Material:** a model name could be a file path (`llama.cpp//home/…/x.gguf`), and a tool name could be an MCP server's own name | Model names are withheld unless they are plain names; tool names are OMP's built-ins only; exit reasons come from a closed set; canary tests for each |
| Memory grew with the line count (a 96 MiB file of tiny lines reached 2.3 GB) | Lines are scanned in place and capped at 400 000; the listing budget is charged by the bytes actually read |
| One unreadable directory made the whole listing fail | Skipped and counted |
| A directory swapped for a link could be walked | Each directory must resolve to itself |
| A reused inode could revive an old selector | The selector includes the birth time |
| "Oh My Pi" was claimed as a recorded runtime with no version recorded | The runtime is unavailable then |
| A title slot of another version was reported as damage | Reported as an unsupported format |
| A session chosen during a read was dropped | The latest request is queued |
| An unknown exit kind was shown as a signal; an exit followed by an unfinished write was still "ended"; a final developer message was "settled" | An end; not claimed; open |

## Next step

Done in Slice D: explicit, source-aware task links (`endo.develop-tasks.v1`, an operator-visible upgrade, a closed second source with its own
`via`, and source-aware idempotence), so an OMP saved session can be linked to a task without ever becoming current or controllable. See
[develop-tasks.md](develop-tasks.md#oh-my-pi-saved-references). `OmpSavedSessionObserverV0.resolve` is the observer's one addition: it says
whether an id is established in the named directory, from the same reads and counting as the list.
