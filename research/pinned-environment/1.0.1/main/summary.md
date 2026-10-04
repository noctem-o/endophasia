# Experiment endo.experiment.pinned-environment-1.0.1

Pinned-environment study main run (research/pinned-environment/1.0.1/DESIGN.md)

Trials: 240 completed, 0 errored, 0 missing of 240 planned (0 interrupted and rerun). Seed 3619119635 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | a-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 10/20 [30-70%]; 2 distinct; pairs 47% [43-58%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 3701.5 ms |
| tool-use | b-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 3382 ms |
| tool-use | b-c-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 7603.5 ms |
| tool-use | b-c-u | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 7566 ms |
| fix-failing-test | a-p | 20/20 | 8/20 [22-61%]; 5 distinct; pairs 26% [16-39%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 8/20 [22-61%]; 5 distinct; pairs 26% [16-40%] | 20/20 pass | 7772 ms |
| fix-failing-test | b-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 5370.5 ms |
| fix-failing-test | b-c-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 18110 ms |
| fix-failing-test | b-c-u | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 10/20 [30-70%]; 5 distinct; pairs 32% [18-51%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 18204 ms |
| implement-function | a-p | 20/20 | 18/20 [70-97%]; 3 distinct; pairs 81% [55-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 2/20 [3-30%]; 19 distinct; pairs 1% [0-3%] | 18/20 [70-97%]; 3 distinct; pairs 81% [55-100%] | 20/20 pass | 6301 ms |
| implement-function | b-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 5859.5 ms |
| implement-function | b-c-p | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 11956.5 ms |
| implement-function | b-c-u | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 16/20 [58-92%]; 5 distinct; pairs 63% [35-90%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 11711.5 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 1242 | 0 |
| M2a | PASS | 240 | 0 |
| M2b | PASS | 1242 | 0 |
| M3 | PASS | 120 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: a-p valid, b-c-p valid, b-c-u valid, b-p valid.

Report digest dd9a2a7c5f0f1bbdde3226b6d58c8e55f0e23d9471cda6d5d514320733c9b1e6. Details: bundle.json.
