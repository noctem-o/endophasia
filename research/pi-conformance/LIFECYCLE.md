# Pi session-lifecycle acceptance fixtures

Each `<pi version>/lifecycle/` directory holds three real sessions recorded against that Pi release and a real model.
`provenance.json` names the mapping each was recorded under. The 1.0.1 recording predates `pi-rpc-mapping.3`, so its
tool events carry no argument digest and its attachments record no mapping version or digest domain. The recorder
records in fixture mode under the committed public key `fixture-public` (`research/fixture-keys/`), never the
installation key: its digests offer no secrecy, so a recording must hold only synthetic scratch content.
`scripts/record-lifecycle-fixture.ts` files a recording under the version the Pi it ran reports. It refuses an
`--out` that names another version's `lifecycle/`. `tests/pi-lifecycle-fixtures.test.ts` replays every recording it
finds and checks that the directory matches the recorded version.

The files directly in `1.0.0/` are a separate specimen and are immutable: the `pi-rpc-mapping.1` attachment recording.
`tests/pi-conformance-specimen.test.ts` pins every one of them by digest. Under `pi-rpc-mapping.2`, their evidence no
longer applies to a current attachment (evidence rule 4). They are never rewritten.

Each recording holds these sessions:

| Session | What happens |
| :--- | :--- |
| `completes` | A short prompt runs to `agent_settled`. |
| `stop-mid-turn` | A long prompt; once Pi streams, a STOP through `steering.stop`. |
| `killed-and-resumed` | A long prompt in a child process that is SIGKILLed mid-turn. The same store and Pi session are then reopened: the interruption and the resume are recorded, and a short prompt runs. |

While no recording exists, the real-fixture check in `tests/pi-lifecycle-fixtures.test.ts` is skipped. It refuses a
recording whose Pi entrypoint is the deterministic suite's fake.

## Recording it

Use your own Pi and a model you serve through an OpenAI-compatible endpoint:

```sh
node scripts/record-lifecycle-fixture.ts --pi "$(command -v pi)" \
  --base-url http://127.0.0.1:8080/v1 --model <model-id> --authorize-live-study
# add --api-key-env NAME if the endpoint needs a key
```

Pi runs with a scratch `HOME` and a scratch `PI_CODING_AGENT_DIR` whose `models.json` names only your endpoint. Your
Pi installation, configuration, sessions and credentials are never read or changed.

`--sessions completes[,…]` records a subset. A subset is refused for a `<version>/lifecycle/` directory, so it can
never replace the three-session fixture: give it its own `--out`.

The same three sessions, plus a tool-using one, are also recorded with their cassettes by
`scripts/record-cassette-fixture.ts` into `<version>/cassettes/`, so they can be replayed (docs/replay.md). The
earlier `1.0.1/completes-repeat/` recordings, made under a scratch key that was deleted, were retired in favour of
them.

`--authorize-live-study` is needed because STOP is offered only when the live study admits `steering.stop`. The
study sends prompts to your model. Without that admission, `stop-mid-turn` is recorded as skipped, with the reason.

## What the recorder writes

- `<session>.events.jsonl`: the recorded event stream, one canonical-JSON event per line.
- `<session>.overview.json`: the reducer's overview of that stream.
- `provenance.json`, which records:
  - the Pi fingerprint;
  - the model and provider as configured;
  - the endpoint URL without credentials;
  - the model ids the endpoint's `/models` reports;
  - the `provider/model` pairs Pi reported on its assistant messages;
  - the Endophasia versions;
  - each session's status and notes.

The API key is never written. Failure causes appear only as references (sha256, length, classification); their text
stays in the recording's scratch store and is deleted with it.

## Normalization

Before writing, the recorder replaces its own scratch directory with `<recorder-scratch>`. It matches that directory
as created and as its real path, as a whole path component only. Every other path is kept as recorded.
`provenance.json` records the rule (`normalization.scratchRoot`) and, per session, the number of strings changed
(`scratchRootReplacements`). `eventsSha256` is computed over the normalized file.
