# Repeated `completes` recordings: a preliminary run-to-run observation

**This is not a variance result.** Two runs are not a sample, and nothing here estimates a noise band. It is one real
check that trajectory comparison (`endo trajectory diff`, docs/trajectory.md) behaves sensibly on fresh data. Measuring
run-to-run variance needs a proper design and N, which is later work.

`run-1/` and `run-2/` each hold one `completes` session: the same short prompt as `../lifecycle/completes`
("Reply with the single word: ready"), recorded on 2026-10-03, about two hours after the committed lifecycle fixture, with:

```sh
ENDO_DIGEST_KEY_FILE=<scratch key> node scripts/record-lifecycle-fixture.ts --pi /usr/bin/pi \
  --base-url http://127.0.0.1:8080/v1 --model qwen3.8-27b --authorize-live-study --sessions completes --out <run-N>
```

Same Pi 1.0.1 installation (identity `f91821fd54dd…`), same llama.cpp server and model (`qwen3.8-27b`, Q4_K_M), same
scratch-configuration recipe. They were recorded under the final `pi-rpc-mapping.3`. Both share one digest domain: a
scratch key, deleted afterwards, whose id (`endo.digest-key.02afbe04…`) is recorded on each attachment. Neither session
called a tool, so no digest was made with it. The committed lifecycle fixture was recorded under `pi-rpc-mapping.2`,
with no mapping or digest domain recorded, so comparisons against it carry the `mapping-differs` and
`digest-domain-differs` flags.

(An earlier pair, recorded under a draft of mapping.3 that recorded no digest domain, was replaced by this one. It
showed the same picture: EXACT on every judged layer, with usage moved by the prompt cache.)

## What the comparison showed

| Pair | lifecycle | tools | outcome | flags | usage Δ (b − a) | timing Δ (observer clock) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| run-1 vs run-2 | EXACT (6) | EXACT (0) | EXACT (1) | none | output +6, total +6 | +5 ms |
| lifecycle/completes vs run-1 | EXACT (6) | EXACT (0) | EXACT (1) | mapping-differs, digest-domain-differs | cacheRead +1476, input −1478, output −43 | −1826 ms |
| lifecycle/completes vs run-2 | EXACT (6) | EXACT (0) | EXACT (1) | mapping-differs, digest-domain-differs | cacheRead +1476, input −1478, output −37 | −1821 ms |

Absolute values per run (Pi-reported tokens; wall time on the observer's clock):

| Recording | input | cacheRead | output | total | wall ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| lifecycle/completes | 1608 | 0 | 72 | 1680 | 2767 |
| completes-repeat/run-1 | 130 | 1476 | 29 | 1635 | 941 |
| completes-repeat/run-2 | 130 | 1476 | 35 | 1641 | 946 |

For this short, tool-free prompt, all three runs share the same trajectory on every judged layer. Usage moves, and
most of the movement has a visible cause rather than being model noise: the two new runs hit llama.cpp's prompt cache
(`cacheRead` 1476), and the committed run did not. Usage and timing deltas are reported, never judged, for exactly
this reason. The output-token spread (72 / 29 / 35) is consistent with sampling differences in the reply. It is not
evidence of a rate. Because no tool was called, "tools EXACT" is vacuous here.

`tests/trajectory.test.ts` pins these comparisons, so a change to the projection or the comparison that alters them
is visible.
