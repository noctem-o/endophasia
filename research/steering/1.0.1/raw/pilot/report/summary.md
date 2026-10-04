# Experiment endo.experiment.steering-1.0.1-pilot

Steering study pilot (research/steering/1.0.1/DESIGN.md)

Trials: 18 completed, 0 errored, 0 missing of 18 planned (0 interrupted and rerun). Seed 3312024923 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 7254 ms |
| tool-use | steer | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 11335 ms |
| tool-use | queue | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 10997 ms |
| implement-function | base | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 10563 ms |
| implement-function | steer | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 12477 ms |
| implement-function | queue | 3/3 | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 [44-100%]; 1 distinct; pairs 100% [100-100%] | 3/3 pass | 15656 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 93 | 0 |
| M2a | PASS | 18 | 0 |
| M2b | PASS | 93 | 0 |
| M3 | PASS | 18 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 43e0a84ef6e5f0b9d82e6363ce94d049204ed97e416a09873b11356b7b50129e. Details: bundle.json.
