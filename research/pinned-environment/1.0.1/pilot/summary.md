# Experiment endo.experiment.pinned-environment-1.0.1-pilot

Pinned-environment study pilot (research/pinned-environment/1.0.1/DESIGN.md §9): manipulation checks and wall-time estimate

Trials: 36 completed, 0 errored, 0 missing of 36 planned (0 interrupted and rerun). Seed 2532091956 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | a-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 3379 ms |
| tool-use | b-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 3101 ms |
| tool-use | b-c-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 6859 ms |
| tool-use | b-c-u | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 6990 ms |
| fix-failing-test | a-p | 3/3 | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 3/3 pass | 6587 ms |
| fix-failing-test | b-p | 3/3 | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 3/3 pass | 5940 ms |
| fix-failing-test | b-c-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 18519 ms |
| fix-failing-test | b-c-u | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 17707 ms |
| implement-function | a-p | 3/3 | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 2/3 [21-94%]; 2 distinct; pairs 33% [0-100%] | 3/3 pass | 5516 ms |
| implement-function | b-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 6140 ms |
| implement-function | b-c-p | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 10580 ms |
| implement-function | b-c-u | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 1/3 [6-79%]; 3 distinct; pairs 0% [0-0%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 11622 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 187 | 0 |
| M2a | PASS | 36 | 0 |
| M2b | PASS | 187 | 0 |
| M3 | PASS | 18 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: a-p valid, b-c-p valid, b-c-u valid, b-p valid.

Report digest 93733c89d344b82e61333125fd31a5baff66b1cc8ab8d8a953409e1757f6757d. Details: bundle.json.
