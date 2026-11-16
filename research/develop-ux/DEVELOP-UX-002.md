# DEVELOP-UX-002: everyday development and bounded session authority

**Status: implemented as specified, with one outcome that must be read first.** The broker's bounded session authority is built and
tested. **Everyday is not in effect on any host**, because no execution boundary around Pi exists in this build and the broker refuses
to issue a grant without one (§5.3). On a real workstation `endo develop` therefore runs Strict and says why. What reduces friction
today is the opt-in short confirmation (§6). §1 to §8 were written and committed before any authority-changing edit (`cfc1318`) and
are unchanged except where §12 says so; results are in §9 onward.

- **Base:** `main` at `25308f5` (PR #150 merged).
- **Read first:** [develop-workbench.md](../../docs/develop-workbench.md) §3, §13 and §14;
  [DEVELOP-UX-001](DEVELOP-UX-001.md) §5.3; [DEVELOP-VERIFY-TRUST-002](../develop-verify-trust-002/THREAT-MODEL.md) §2, §4 and §6 and its
  [FOLLOW-UP](../develop-verify-trust-002/FOLLOW-UP.md) answer 2.
- **Build host for this change:** a disposable Linux container, uid 0, Node 22.23.4, **no bubblewrap, no systemd user manager, no Pi**.
  Installing bubblewrap was not permitted there. Nothing in this document is evidence of containment on any host.

## 1. Where authority lives on `main` (audited in the code, not the documents)

| Concern | Component | What it does |
| :-- | :-- | :-- |
| Transport guards | `cockpit-http/server.ts` | Host, Origin (exact, required on POST), Fetch Metadata, `application/json`, bounded body. Forwards the `x-endo-grant` header and the parsed body, nothing else |
| Pairing | `runtime/contracts/workbench-pairing.ts` (`EndoPairingV0`) | One code at a time, shown on the terminal only; single use, 10 minutes, five tries. One grant at a time (256 bits, 1 hour, memory); a new pairing replaces it |
| Request authorisation | `cli/workbench.ts` (`approver`, `ask`) | One readline on the controlling terminal; the exact phrase `APPROVE <OP> <16 hex of the proposal digest>` allows, anything else declines; one question at a time |
| Broker dispatch, prompts | `adapters/pi/workbench.ts` (`#open`, `#run`) | Records proposed, asks, records authorised, re-checks the gate (session, grant, idle), records dispatched, sends, records accepted or refused |
| Broker dispatch, interventions | `adapters/pi/workbench-interventions.ts` (`propose`, `#drive`) over `PiInterventionDeskV0` | The existing chain; STOP supersedes an unapproved steer or queue |
| Runtime acceptance | `PiSessionAttachmentV0.prompt`, the desk's `apply` | Pi's reply. Acceptance, never completion or consumption |
| Revocation | `EndoPairingV0.revoke/clear`, `WorkbenchBrokerV0.endSession/dispose/beginClose` | Session end, disposal and re-pairing drop the grant; a waiting approval is withdrawn |
| Session identity | `piSessionId` → `endo.session.pi.<id>`, `attachment`, `launchId` (64 random bits per broker) | A proposal names its session and attachment; the gate refuses another session at send time |

Two facts the documents understate:

1. **The pairing grant is authority to read private text and to ask. It is not authority to send.** Every send is gated by a line typed
   on the controlling terminal. That line is the only thing between a script holding the grant and the agent.
2. **Nothing constrains the agent.** Pi is started with the operator's whole environment (`piSessionEnvironmentV0`), as the operator's uid,
   in the operator's session, with the network. The only wrapper is a systemd scope for *cleanup* (`liveScopeV0`), which is not a
   filesystem, network or privilege boundary.

## 2. The distinction this change must not blur

| Question | Answered by | Not answered by |
| :-- | :-- | :-- |
| *May this message be sent?* (authority to send) | the terminal phrase today; a session grant, if one is added | a sandbox |
| *What can the agent do after it receives a message?* (execution boundary) | an OS or broker-owned boundary around the agent's processes | a phrase, a pairing, a token, a tool-name list, a prompt |

A terminal phrase bounds a **compromised page**: it can ask, and cannot cause. Remove the phrase and a compromised page can send any
text, and the agent will run whatever that text asks, **as the operator**. So a session grant converts "page compromise" into "code
execution as the operator" unless the agent's effects are independently bounded. That is why Everyday needs an execution boundary and
Strict does not: Strict's authorisation is per message, by a channel the page cannot reach.

## 3. Threat model

### 3.1 Principals

| Principal | Identity | Trusted for |
| :-- | :-- | :-- |
| Operator | the workstation user, at the controlling terminal | every authorisation |
| Controlling terminal | the tty of the `endo develop` process | being the operator's channel (see R1) |
| Broker | the `endo develop` process | enforcing every rule in §4 and §5; it is the trusted computing base, with the kernel |
| Paired page | the browser tab holding the pairing grant in memory | **nothing**. It displays and asks. It may be compromised (an extension, a browser bug, another program driving the browser) |
| Agent | Pi and everything it starts: tools, shell subprocesses, extensions, MCP servers | nothing. Today it has the operator's uid |
| Other local users | other uids | nothing; they cannot read the capability, the grant or the terminal |

### 3.2 Attacker capabilities considered

- **A compromised page**: holds whatever the page holds (read capability, pairing grant, and under Everyday the standing of the session
  grant's holder); sends any request the transport guards admit, in any order and number, replays earlier ones, races them.
- **A request forger without the grant**: another origin, another local uid, a DNS rebinder. Unchanged from develop-workbench §3.
- **The agent**: runs any code the operator's uid can (today), or any code inside the boundary (with one). It may try to obtain or use
  session authority, widen its scope, or outlive it.

### 3.3 What a session grant changes, row by row

| Threat | Strict (today) | Everyday without an execution boundary | Everyday with one |
| :-- | :-- | :-- | :-- |
| Compromised page sends arbitrary prompts | cannot: asks only | **arbitrary code as the operator** | arbitrary code **inside the boundary**, for at most the grant's life and budget |
| Compromised page widens its authority | cannot | cannot (§4: no request field selects a mode, scope or lifetime) | cannot |
| Compromised page keeps authority after reload, revoke, expiry | n/a | cannot (§4) | cannot |
| Agent causes effects outside the workspace | yes: unsandboxed | yes | no, to the extent the boundary holds (§5) |
| Agent grants itself session authority | n/a | it would need the grant token, which lives in broker and page memory; an unsandboxed same-uid agent can try the routes in R1–R3 | the boundary must hide the terminal and the broker's memory (§5.2) |
| Operator approves without reading (fatigue) | present | removed for covered operations | removed |

### 3.4 Residual risks that exist on `main` and are not changed here

- **R1. The terminal is not unforgeable to a same-uid agent.** Pi is in the terminal's session. Where the kernel allows `TIOCSTI`
  (`dev.tty.legacy_tiocsti=1`, the default before Linux 6.2), a process of that session can inject input into the terminal, including an
  approval phrase. The phrase's digest prefix is not secret from the page, but an agent would have to learn it. Not exercised here.
- **R2. A same-uid agent can change Endophasia itself** (the checkout or the installed package, `~/.config`, the browser profile, shell
  startup files) and so the next launch. DEVELOP-VERIFY-TRUST-002 §4.
- **R3. `docker` and `libvirt` group membership is root-equivalent** on the operator's workstation (TRUST-002 §6, H0). Any boundary that
  shares those sockets with the agent is void.
- **R4. The broker reads the launch directory with Git as the operator.** `GitProjectInspectorV0` uses a hardened prefix and
  `--no-ext-diff --no-textconv`, but agent-written repository configuration reaching an unsandboxed Git is the escape TRUST-002 names for
  arrangement C. It has not been tested against an adversarial repository as a sandbox escape.

Strict's guarantee is therefore "a page cannot send"; it was never "the agent cannot make the terminal say yes".

## 4. Bounded session authority: specification

### 4.1 Modes

| Mode | Who authorises a send | Requires | If the requirement fails |
| :-- | :-- | :-- | :-- |
| **Strict** | the terminal, per request (phrase) | a controlling terminal | n/a |
| **Everyday** | a session grant, for the operations it lists; the terminal for everything else | execution protection **observed as enforced**, level `workspace` or stronger, for this session and this workspace | **Strict is in effect**, and the terminal and the page say which limitation prevented Everyday |
| **Protected** | as Everyday | execution protection observed as enforced at level `restricted` | **the launch is refused before Pi starts.** Falling back to Strict would silently give an unrestricted agent to someone who asked for a restricted one |

The mode is chosen on the command line of the attached process (`endo develop [--mode everyday|protected|strict]`; `endo develop`
*requests* Everyday, `endo harness attach --workbench` stays Strict). **No request field, header, route or page state selects, raises or
describes a mode to the broker.** The request bodies are the ones on `main` (one optional member is added, a replay nonce, §4.5).
Whether a given request is authorised by the grant or must wait for the terminal is decided by the broker alone, per request.

### 4.2 The session-control grant

A separate object from the pairing grant, held only in the broker's memory (`runtime/contracts/session-control.ts`):

| Field | Value | Checked |
| :-- | :-- | :-- |
| `grantId` | random; public (it appears in records and in the status) | — |
| holder | the pairing grant token of the page that redeemed the control-carrying code | every use, constant time |
| `launchId` | this broker's | every use |
| `session`, `attachment` | the exact `endo.session.pi.<id>` and attachment connected at issue | every use, against what is connected now |
| `workspaceRoot` | the canonical (real) path of the launch directory | every use, against the broker's and against the root the protection reports confining |
| `operations` | a subset of `prompt`, `steer`, `queue`, `stop` | every use |
| `issuedAtMs`, `expiresAtMs` | fixed at issue; **30 minutes**, never extended | every use |
| `sendsLeft` | a count of authorised sends (default 200) | every use |
| protection | the level and mechanism observed at issue | re-observed at every use |

**Issue.** Only at the moment a pairing code that the terminal marked as carrying control is redeemed. The terminal marks a code in two
cases: the first code of an Everyday launch whose protection is enforced, and the terminal command `control`. Each time the terminal
says what is being granted (operations, workspace, lifetime, how to revoke). The terminal command `pair` issues a plain code.
There is no route that issues, extends or describes a grant.

**End.** A grant ends permanently, with a recorded reason, on: expiry; the budget reaching zero; `revoke` typed on the terminal; the
page's own `session-control/revoke`; any new pairing (the holder is replaced); the connected session or attachment differing from the
grant's; the workspace differing; the protection no longer observed as enforced, or weaker, or for another session or root; the session
closing or the broker being disposed. An ended grant is never revived: **re-pairing with a plain code yields a paired page with no
control**, a reload loses the holder token (page memory) and so the control, and a restarted process has no grants at all.

**Use.** For a `prompt`, `steer`, `queue` or `stop` from the holder while the grant holds and covers the operation, the broker records
the authorisation as made **by the session grant** and dispatches without asking the terminal. In every other case the request takes
the Strict path, unchanged: it waits for its phrase.

**Not covered, ever.** Sending a work attempt's brief (`attempt/propose`, `attempt <id>`), which writes the attempt's one authorisation
record: terminal phrase, as on `main`. Verification, promotion and task decisions are not broker commands and are untouched.

### 4.3 Why 30 minutes

The grant's life bounds how long a page compromise stays useful and how stale the operator's decision can be. The pairing grant lives
one hour; a control grant should be shorter than the thing that carries it. Fifteen minutes interrupts a normal working stretch; an hour
or "until exit" makes the terminal act a formality. Thirty minutes with a fixed end and a send budget is the proposal; both numbers are
broker options, not page inputs, and neither renews on use.

### 4.4 Records: what was authorised, and how

The five states stay distinct: **proposed, authorised, dispatched, runtime-accepted, completed/consumed**. Under a grant the first three
happen within one request, and each is still recorded as its own event, in order.

| Record | Change |
| :-- | :-- |
| `workbench.prompt-authorized` | `confirmation` is `terminal` (the phrase, as today), or `session-grant` with a `sessionGrant` member naming the grant. Never `terminal` for a send nobody typed |
| `intervention.authorization` | `authority.confirmation` gains `session-grant` (with the grant's id) beside `terminal-phrase` |
| `workbench.session-control-granted` (new, authority-decision) | the grant: id, session, attachment, launch, mode, operations, the workspace root **as a keyed digest**, the protection's level and mechanism, issue and expiry times, budget, and that it was issued on a terminal pairing code |
| `workbench.session-control-ended` (new, policy-conclusion) | the grant's id, a closed reason, the time and the number of sends it authorised |

No record holds a prompt's text, a path in clear, a pairing code, a grant token or a credential. No record says "verified", "approved by
the operator" for a grant-authorised send, or anything about what the agent did. These are the same canonical store and the same
chains: no second ledger.

### 4.5 Replay and duplicates

Under Strict a duplicate request produces a second question the operator declines. Under a grant it would produce a second send. So
`prompt/propose` and `intervention/propose` accept one optional member, `nonce` (16 to 64 URL-safe characters, chosen by the page per
user action). A nonce the broker has seen in this launch returns the request it already made and does nothing else. A duplicate STOP
already returns the one in flight. A nonce changes no authority: a page that wants two sends can ask twice.

### 4.6 STOP

Under a grant that covers `stop`, a STOP is authorised and dispatched in its own request: it waits for no question and no other
request, including a steer still being sent to Pi and a prompt or steer that is waiting for the terminal (an unapproved steer or queue is
superseded exactly as in develop-workbench §14.3, then the STOP is sent). Without a grant STOP behaves as on `main`. Ctrl-C on the
terminal is untouched in every mode: it is the terminal's own signal path and needs no grant, page or broker route.

## 5. The execution boundary

### 5.1 Mechanisms evaluated

| Mechanism | Kind | Verdict for Everyday |
| :-- | :-- | :-- |
| Bubblewrap user, mount, PID, IPC namespaces around Pi, workspace writable, everything else absent or read-only (`adapters/sandbox/bubblewrap.ts`, proven for experiments) | **OS-enforced** | The right mechanism. Hides `/run` (docker, libvirt, the user manager, D-Bus), the home directory, the terminal (`--new-session`), and other processes. **Not built for a live session** (§5.3) |
| A separate Unix uid for the agent | OS-enforced | Needs root to create and H0 (TRUST-002). Not available without privileged host changes, which this change must not make |
| systemd user scope (`liveScopeV0`) | OS-enforced, **for cleanup only** | No filesystem, network or privilege view. Not a boundary |
| Landlock, seccomp | OS-enforced | Node exposes neither; would need a native helper. A useful second layer inside a namespace sandbox, not a first slice |
| Pi's `--tools` list, `--no-tools`, `--no-extensions` | **runtime-enforced by the agent's own process**: advisory from the broker's side | A tool list does not bound what an allowed shell tool runs; a tool-free Pi is contained but is not a development agent |
| Shell-command filtering, prompt instructions | advisory | Rejected |
| The terminal phrase, the pairing, the grant | **authority to send**, not a boundary | Not a control on execution at all |
| The separate-principal verifier (TRUST-002) | protects the *verifier* from the agent | Says nothing about the agent's reach |

### 5.2 What a provider must enforce before the broker will call Everyday available

The broker depends on one interface (`runtime/contracts/execution-protection.ts`): `observe()` returns the state (`enforced`,
`not-enforced`, `unknown`), the level, the mechanism, the session and the workspace root the boundary was observed around, and a list of
limitations. `unknown` and a throwing provider are treated as not enforced. For level `workspace` the provider must have **observed from
inside the boundary**, not inferred from its own arguments, that the agent's processes:

1. cannot write outside the workspace root, Pi's session directory and private scratch space;
2. cannot read the operator's home outside the workspace (keys, tokens, browser profiles, shell history, Endophasia's stores);
3. cannot reach the Docker, libvirt, D-Bus or user-manager sockets, nor any setuid route (no new privileges, no further user namespaces);
4. have no controlling terminal and cannot open the operator's (R1);
5. cannot signal, trace or read the memory of processes outside the boundary, the broker included;
6. are all inside it: the Pi the broker talks to is the process that was placed there, and nothing it starts leaves.

Level `restricted` (Protected) adds: no network except a declared model route, a declared tool set mediated outside the agent, and a
read-only view of everything but a chosen worktree. Untrusted extensions and MCP servers are inside the boundary or not loaded.

### 5.3 What this change can and cannot establish

**No provider in this change reports `enforced`.** The live Pi launcher runs Pi unsandboxed, and building the live-session sandbox
profile was not done here for stated reasons, not for lack of intent:

- it could not be executed even once on the build host (no bubblewrap, and installing it was not permitted), and a boundary that was
  never run is an assumption, which §5.2 forbids the broker to act on;
- it has open design questions that need the real runtime: where Pi keeps credentials and whether it must rewrite them (a writable
  credential directory lets the agent plant an extension that runs unsandboxed at the next ordinary launch); how a cloud model is reached
  without sharing the host's network namespace (which also shares loopback services and abstract sockets); R4.

Consequently, on every host today, the production provider (`cli/execution-protection.ts`) reports `not-enforced` and names what it
observed (that Pi is not placed in a boundary; and, where present, a usable Docker or libvirt socket, uid 0, an injectable terminal).
`endo develop` then says Everyday was requested and is not in effect, and runs Strict. `--mode protected` refuses to start.

What *is* established here is the other half: every authority rule of §4, against a stand-in provider that the tests construct in
process. A stand-in proves the broker's checks. It proves nothing about containment, and no test in this change is counted as doing so.

## 6. What reduces friction today, without moving authority: a short confirmation

Because Everyday cannot be in effect yet, the per-message cost of DEVELOP-UX-001 (29 to 31 typed characters) would be unchanged. The
fallback DEVELOP-UX-001 §5.3 asked to be studied is built, opt-in, as `--confirm short`:

- The terminal shows the request exactly as today, then a **four-character code** drawn at random for that question, and accepts the
  code or the full phrase. Anything else declines.
- **Authority does not move.** The code is generated in the attached process, written only to the terminal, and never sent to the page
  or recorded. Only a line typed on the controlling terminal matches it.
- **Binding to one request.** A code belongs to one question and dies with it. A line typed for an earlier question matches the next
  one's code with probability 30⁻⁴ (about 1 in 810 000), and cannot be steered there: unlike the phrase's digest prefix, the page never
  sees the code and cannot choose it. A cancelled question still discards the half-typed line.
- **The read-back is kept**, multi-line prompts included: the text is displayed before the code.
- **What it costs.** A four-character answer is easier to give without reading than a 31-character one. That is fatigue, and it is the
  operator's choice to accept; hence opt-in, and hence recorded as what it was: `confirmation: "terminal-code"`, never `terminal`.
- **Not for attempts.** `APPROVE ATTEMPT …` keeps its phrase.

The terminal-typed prompt (`say <text>`, DEVELOP-UX-001 D1) is not built: it drops the read-back, is single-line, and competes with
approvals for the one input line.

## 7. Components this change touches

```
cli/harness.ts            --mode, --confirm; Protected refused before Pi starts
cli/execution-protection.ts   the production provider: what this host enforces (today: nothing), and why
cli/workbench.ts          terminal: mode banner, control-carrying codes, `control`, `revoke`, the short code
runtime/contracts/execution-protection.ts   the provider interface and the levels
runtime/contracts/session-control.ts        the grant: arm, issue, use, end
adapters/pi/workbench.ts                    prompts: grant path beside the terminal path; status; nonce; revoke route
adapters/pi/workbench-interventions.ts      steer, queue, stop: the same
protocol/workbench.ts, protocol/intervention.ts   the record changes of §4.4
studio-ui/src/…           mode, protection, grant state and expiry; "authorised by the session grant"; revoke
```

No second broker, no new listener, no shell or raw RPC route, no storage in the page, no token in a URL, cookie or local storage.

## 8. Tests planned (the brief's twelve)

| # | Property | Where |
| :-- | :-- | :-- |
| 1 | Everyday: ten prompts after one authorisation, no phrase | broker unit; HTTP + fake Pi |
| 2 | Strict: ten prompts, ten phrases, records unchanged | broker unit; the existing suites untouched |
| 3 | Wrong session or attachment refused | broker unit |
| 4 | Wrong workspace or scope (operation not granted) refused | broker unit |
| 5 | Expired or revoked grant refused **before dispatch** | broker unit |
| 6 | Replay and duplicates: one send | broker unit |
| 7 | Reload and re-pairing: no renewal | broker unit; real browser |
| 8 | Concurrency and STOP preemption | broker unit |
| 9 | Compromised page cannot widen authority | broker unit; HTTP |
| 10 | No protection, protection lost, privileged host: fails closed | provider unit; broker unit; CLI under a pseudo-terminal |
| 11 | `endo studio` has no command surface | existing tests, plus the new route |
| 12 | Records: no text, path, code or token; no invented claim | broker unit; store scan |

## 9. What was built

| Part | Where | State |
| :-- | :-- | :-- |
| The grant: arm, issue, use, end | `runtime/contracts/session-control.ts` | implemented; 47 tests at the broker's boundary |
| The provider interface, and the rule that only a well-formed observation for the exact session and workspace counts | `runtime/contracts/execution-protection.ts` | implemented |
| The production provider | `cli/execution-protection.ts` | implemented; **never reports `enforced`** |
| Prompts and interventions under a grant, the status, the nonce, the revoke route | `adapters/pi/workbench.ts`, `workbench-interventions.ts` | implemented |
| Records | `protocol/workbench.ts`, `protocol/intervention.ts` | implemented (§4.4) |
| Terminal: `--mode`, `--confirm`, the banner, `control`, `revoke`, the short code | `cli/harness.ts`, `cli/workbench.ts` | implemented |
| Page: the mode and session-control strip, grant-aware wording, give up | `studio-ui/src/develop/Live.tsx` and the wire gate | implemented |
| A launcher that places Pi inside an execution boundary | — | **not built** (§5.3, §13) |

Two rules were added during the adversarial pass (§12) and are part of the specification: a grant's end is measured on a monotonic
clock as well as the wall clock; and an armed code grants only for the session, attachment and workspace that were connected when the
terminal described it.

## 10. Usability, against DEVELOP-UX-001

The same session as DEVELOP-UX-001 §6: start, ten messages (eight prompts, one steer, one stop), read the diff, finish. Counts are from
the code and the tests, not timed with a person. No human pilot was run.

| | UX-001 (Strict, `main`) | This change, on a real host today (Everyday requested, Strict in effect) | With `--confirm short` | Everyday in effect (**reachable only in tests**) |
| :-- | :-- | :-- | :-- | :-- |
| Commands to start | 1 | 1 | 1 (one flag) | 1 |
| Pairing | 9 characters, once | the same | the same | the same; the code also grants control, and the terminal says so |
| Terminal approvals for ten messages | 10 | 10 | 10 | **0** |
| Typed approval characters | 307 | 307 | **40** (4 each) | 0 |
| Context switches for ten messages | 20 | 20 | 20 | 0 |
| Operator must read the terminal before each send | yes | yes | yes (the text is shown first) | no |
| STOP waits behind another question | behind a prompt's, yes; it supersedes a steer or queue | the same | the same | never |
| Authority renewal | n/a | n/a | n/a | a new terminal act every 30 minutes or 200 sends, and after any reload |
| What a compromised page can cause | nothing: it asks | nothing | nothing | sends inside the boundary, for the grant's life |

Read plainly: **for an operator on a real workstation, this change alone removes 267 of 307 typed characters, and only if they opt
in. It removes no context switch and no approval.** The zero-approval column is real code with real tests, waiting for a boundary.

U9 of DEVELOP-UX-001 (per-message cost) is therefore *partly* improved (typing), and U10 (a human finds it pleasant) is still not
established.

## 11. Security properties: proven, assumed, not achieved

**Proven by tests in this change** (at the broker, over the real HTTP guards, in a real browser, under a real pseudo-terminal, and over a
real fake-Pi attachment and store; the fake Pi is a real process speaking Pi's RPC, not Pi):

1. A grant is issued only when a pairing code the terminal armed is redeemed. No route, header or request member issues, arms, extends,
   widens or describes one; an unknown member refuses the request whole.
2. A grant is issued and used only while the provider's observation is well formed, `enforced`, at the level the mode needs, and for
   exactly the connected session and workspace. Absent, unknown, throwing, malformed, weaker, or about something else: no grant.
3. The observation is taken again at every use. A boundary lost mid-session ends the grant before the next send, for every operation,
   and its return does not revive it.
4. Every use checks the holder (constant time), the launch, the session, the attachment, the workspace, the operation, the time (on a
   clock that cannot be set back) and the budget. Failing any, the request is not sent under the grant; it waits for the terminal.
5. An ended grant stays ended: re-pairing, reloading, the session returning, the boundary returning and the clock moving do not revive
   it. A new grant has a new id, a new end and a new budget.
6. A repeated nonce causes one send. A duplicate STOP is the one in flight.
7. Under a grant a STOP is dispatched in its own request: not behind a steer waiting for Pi, a steer waiting for the terminal (which
   it supersedes), or a prompt waiting for the terminal.
8. An attempt's brief is never covered by a grant.
9. Every grant-authorised send is recorded `session-grant` with the grant's id, never `terminal`; a short code is recorded
   `terminal-code`. The grant's records carry no path, text, token or code. Endophasia's own files hold no prompt text, pairing code or
   token (scanned on disk).
10. Strict is unchanged: the existing suites pass unmodified in behaviour (fixtures gained the new status fields), ten prompts take ten
    phrases, and a Strict launch records no grant.
11. The production provider never reports an enforced boundary; `endo develop` then runs Strict and says why; `--mode protected` exits
    before Pi is looked for, with no store and no listener.
12. The short code: made per question in the attached process, never in a reply to the page, declined when wrong or stale, not offered
    for an attempt; multi-line text is shown before it; STOP preemption holds with it.
13. `endo studio` gains nothing: the read-only server has no workbench handler, so the new route is refused there like every POST
    (the existing tests of that server pass).

**Assumed, not tested here:**

- The kernel, Node, and the broker process are not compromised; the terminal is the operator's (R1 qualifies this).
- A provider that says `enforced` is telling the truth. The broker checks the *form* and the *subject* of an observation. It cannot
  check its truth. That is the provider's burden (§5.2), and no provider exists.
- The session identity Pi reports identifies the process the boundary was built around. A provider must bind to the process, not only
  to the id.
- A person who sees an armed pairing code on the terminal and can reach the page's address can take session control. The same was true
  of pairing; the stakes are higher.

**Not achieved:**

- **Any containment of the agent.** Pi, its tools, its subprocesses, its extensions and MCP servers run as the operator, with the
  operator's credentials, on a workstation whose `docker` and `libvirt` groups are root-equivalent. Nothing in this change alters that,
  in any mode.
- **Everyday in effect on a real host.**
- **Protected mode** as anything but a refusal.
- R1 to R4 (§3.4) are open, and they limit Strict too.
- An independent adversarial review (§12).
- A run against real Pi or a model, and `npm run test:acceptance`.

## 12. Review

**No independent review was obtained.** The operator asked that no sub-agents be used, so the adversarial pass below was made by the
author of the code, which is not independence. The draft pull request is where an independent reviewer should start, and §11's list
is written to be attacked.

The author's pass over the authority-changing code, and what came of it:

| # | Finding | Disposition |
| :-- | :-- | :-- |
| A1 | A request with `nonce: null` was treated as having no nonce instead of being refused | **fixed** (found by the test written for it) |
| A2 | A grant's expiry used the wall clock: setting it back lengthened the grant | **fixed**: the end is also measured on a monotonic clock; tested |
| A3 | A code armed for one session would have issued a grant for whatever session was connected at redemption | **fixed**: the armed code keeps the subject the terminal described; tested |
| A4 | An unpaired caller of `status` was told that a control-carrying code was waiting | **fixed**: said only to a paired page |
| A5 | The budget is spent by a send the gate then refuses (a run opened meanwhile) | accepted: it errs toward less authority |
| A6 | A covered STOP whose grant ends during the microtask in which it waits for a superseded steer falls to the terminal and may queue behind a prompt's question | accepted: that is `main`'s behaviour, reached only in that window |
| A7 | A grant's `ended` record cannot be written if the store closes first | accepted and documented: a reader treats a grant with no end record as ended at its `expiresAt` at the latest |
| A8 | The same nonce used for a prompt and for a steer is two requests | accepted: a nonce carries no authority |
| A9 | The page's words (`Send`, `Stop`) can be stale by one read after a revoke | accepted and tested: the broker decides; the request then waits for the terminal and the card says so |
| A10 | A short code is easier to approve without reading | accepted as the stated cost of an opt-in (§6) |

## 13. Follow-up: the execution boundary (Protected, and so Everyday)

What prevents full Everyday is exactly one thing: **a launcher that runs the live Pi inside an OS-enforced boundary, and a provider that
observes it from inside.** In order:

1. **DEVELOP-ISOLATE-001: a live-session sandbox profile**, on the operator's workstation, where Bubblewrap, the user manager and Pi
   exist. Reuse `detectBubblewrapV0`, the trusted-file rules and the `ProcessScopeV0.wrap` seam (the keeper already starts inside a
   wrapper). Decide, with the real runtime: Pi's installation and credential paths, read-only (a writable credential or extension
   directory is an escape at the next unsandboxed launch); the network (an isolated namespace with the recording proxy as the only
   route, as EVAL-ISO-002 does for a local model, or a shared namespace with its loopback and abstract-socket exposure stated);
   `--new-session` so the agent has no terminal (R1); no `/run`, so no Docker, libvirt, D-Bus or user-manager socket (R3).
2. **Probes run inside the profile before the grant is armed**, in the manner of `adapters/sandbox/preflight.ts`, one per requirement of
   §5.2, each shown to fail when its restriction is removed. The provider reports `enforced` only from those results and from the
   live process's namespaces, never from its arguments.
3. **R4**: run the project inspector's Git inside the same boundary, or prove its hardening against an adversarial repository.
4. **Extensions and MCP servers**: inside the boundary or not loaded; tested with a hostile extension.
5. Only then: a pilot of Everyday by the operator, on a real Pi, with their approval for the model's cost.
6. **Protected** adds a declared network route, a mediated tool set and a read-only view outside a chosen worktree, on the same
   mechanism. It should not be attempted before 1 to 4 hold.

None of these needs root. All of them need the operator's host, which this change did not have.

## 14. Verification run for this change

On the build host of the header (a container: uid 0, no Bubblewrap, no user manager, no Pi; Chromium and `script` present).

| Check | Result |
| :-- | :-- |
| `npm run typecheck` | passes |
| `npm run lint` | no errors; one warning that is on `main` (`tests/endo-cockpit-eighteenth-review.test.ts`) |
| `npm run build` | passes |
| New tests | 61 in four files, all passing: `develop-ux-002-session-control` (47, the broker and the contracts), `-browser` (6, real Chromium over the real HTTP guards), `-cli` (7, a real pseudo-terminal and the fake Pi), `-live` (1, a real fake-Pi attachment, desk and store). None is skipped on this host |
| Existing workbench, Studio and DEVELOP suites | pass. Changed only in fixtures (hand-built statuses and views gained the new members), the count of the page's routes, and one added assertion that the read-only server refuses the new route |
| Full suite (`npm test`) | 13 files and 78 tests fail, **the same 13 files and 78 tests that fail on `main` at `25308f5` in a clean worktree on this host** (compared by file and count). They need what this host lacks: a non-root uid, a user manager, a complete Git history. One run of the full suite also failed the new `-live` test, on a wait that could miss a fast run; the wait was replaced by one on the broker's transcript, and the test then passed alone three times and with every workbench, Studio and DEVELOP suite in parallel |
| Real isolation | **not exercised: none is available on this host, and none exists in this build.** No test is counted as evidence of containment |
| Real Pi, a model, `npm run test:acceptance` | not run |
