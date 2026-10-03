# Pi 1.0.0: session-lifecycle acceptance fixture (not yet recorded)

This directory holds three real sessions recorded against a real Pi and a real model:

| Session | What happens |
| :--- | :--- |
| `completes` | A short prompt runs to `agent_settled`. |
| `stop-mid-turn` | A long prompt; once Pi streams, a STOP through `steering.stop`. |
| `killed-and-resumed` | A long prompt in a child process that is SIGKILLed mid-turn. The same store and Pi session are then reopened: the interruption and the resume are recorded, and a short prompt runs. |

Until `provenance.json` exists, the real-fixture block in `tests/pi-lifecycle-fixtures.test.ts` is skipped. That
block refuses a recording whose Pi entrypoint is the deterministic suite's fake.

## Recording it

Use your own Pi and a model you serve through an OpenAI-compatible endpoint:

```sh
node scripts/record-lifecycle-fixture.ts --pi "$(command -v pi)" \
  --base-url http://127.0.0.1:8080/v1 --model <model-id> --authorize-live-study
# add --api-key-env NAME if the endpoint needs a key
```

Pi runs with a scratch `HOME` and a scratch `PI_CODING_AGENT_DIR` whose `models.json` names only your endpoint. Your
Pi installation, configuration, sessions and credentials are never read or changed.

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

The API key is never written.
