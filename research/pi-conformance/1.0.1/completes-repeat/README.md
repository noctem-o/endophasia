# Repeated `completes` recordings: a preliminary run-to-run observation

**This is not a variance result.** Two runs are not a sample, and nothing here estimates a noise band. It is one real
check that trajectory comparison (`endo trajectory diff`, docs/trajectory.md) behaves sensibly on fresh data. Measuring
run-to-run variance needs a proper design and N, which is later work.

`run-1/` and `run-2/` each hold one `completes` session: the same short prompt as `../lifecycle/completes`
("Reply with the single word: ready"), recorded on 2026-10-03, about 40 minutes after the committed lifecycle fixture, with:

```sh
node scripts/record-lifecycle-fixture.ts --pi /usr/bin/pi --base-url http://127.0.0.1:8080/v1 \
  --model qwen3.8-27b --authorize-live-study --sessions completes --out <run-N>
```

Same Pi 1.0.1 installation (identity `f91821fd54dd…`), same llama.cpp server and model (`qwen3.8-27b`, Q4_K_M), same
scratch-configuration recipe. They were recorded under `pi-rpc-mapping.3`. The committed lifecycle fixture was recorded
under `pi-rpc-mapping.2`, so comparisons against it carry the `mapping-differs` flag.

## What the comparison showed

| Pair | lifecycle | tools | outcome | flags | usage deltas (b − a) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| run-1 vs run-2 | EXACT (6) | EXACT (0) | EXACT (1) | none | input +3, output −5, total −2, wall +36 ms |
| lifecycle/completes vs run-1 | EXACT (6) | EXACT (0) | EXACT (1) | mapping-differs | cacheRead +1476, input −1479, output −47, wall −2162 ms |
| lifecycle/completes vs run-2 | EXACT (6) | EXACT (0) | EXACT (1) | mapping-differs | cacheRead +1476, input −1476, output −52, wall −2126 ms |

Absolute usage per run (Pi-reported tokens, observer wall time):

| Recording | input | cacheRead | output | total | wall ms |
| :--- | ---: | ---: | ---: | ---: | ---: |
| lifecycle/completes | 1608 | 0 | 72 | 1680 | 2767 |
| completes-repeat/run-1 | 129 | 1476 | 25 | 1630 | 605 |
| completes-repeat/run-2 | 132 | 1476 | 20 | 1628 | 641 |

For this short, tool-free prompt, all three runs share the same trajectory on every judged layer. Usage moves, and
most of the movement has a visible cause rather than being model noise: the two new runs hit llama.cpp's prompt cache
(`cacheRead` 1476), and the committed run did not. Usage deltas are reported, never judged, for exactly this reason.
The output-token spread (72 / 25 / 20) is consistent with sampling differences in the reply. It is not evidence of a
rate.

`tests/trajectory.test.ts` pins these comparisons, so a change to the projection or the comparison that alters them
is visible.
