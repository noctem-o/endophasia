# Experiment endo.experiment.variance-1.0.1

Variance study main run (research/variance/1.0.1/DESIGN.md)

Trials: 180 completed, 0 errored, 0 missing of 180 planned (0 interrupted and rerun). Seed 581305836 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tools | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | ---: |
| tool-use | a | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 12/20 [39-78%]; 2 distinct; pairs 49% [44-65%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 3825 ms |
| tool-use | b | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 3608.5 ms |
| tool-use | b-c | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 8111 ms |
| fix-failing-test | a | 20/20 | 12/20 [39-78%]; 3 distinct; pairs 43% [29-64%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 12/20 [39-78%]; 3 distinct; pairs 43% [29-64%] | 20/20 pass | 8031 ms |
| fix-failing-test | b | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 8823.5 ms |
| fix-failing-test | b-c | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 14637 ms |
| implement-function | a | 20/20 | 16/20 [58-92%]; 3 distinct; pairs 64% [39-90%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 16/20 [58-92%]; 3 distinct; pairs 64% [39-90%] | 20/20 pass | 6106.5 ms |
| implement-function | b | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 5884 ms |
| implement-function | b-c | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 10875.5 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 914 | 0 |
| M2a | PASS | 180 | 0 |
| M2b | PASS | 914 | 0 |
| M3 | PASS | 60 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: a valid, b valid, b-c valid.

Report digest d89e37997af77b098da5dc2e1e2ca737ad85236fe4029d2f1df5526f9bb5606e. Details: bundle.json.
