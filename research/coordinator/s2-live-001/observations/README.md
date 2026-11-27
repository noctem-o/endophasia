# S2-LIVE-001 Structured Observations Ledger

Raw structured per-turn and per-tick observations captured from authorized live runs against `http://127.0.0.1:8091` (`Inkling-2-Mini-Uncensored-AD-Q4_K`):

- `phase-b-smoke.jsonl` — Phase B-1 (cold load, partial store, protective refusal) and Phase B-2 (warm, complete store, published briefing) + repeat-tick no-replay verification.
- `phase-c-run1.jsonl` — Phase C Run 1 (`W0–W5`: initial turn + ungrounded proposal refusal, idle skips, blocked task + grounded proposal, co-due digest window + 15 s grace `missed-skipped` finding).
- `phase-c-controlled.jsonl` — Phase C Run 2 (complete 12-window live controlled run: idle windows, task block/unblock, controller-observed FAIL & PASS verification receipts, HEAD advance, active coordination assignment, proposal ack & staleness, multi-task backstop collision on W8–W10, and isolated closed-port outage test on `127.0.0.1:18099`).
- `phase-d-naturalistic.jsonl` — Not yet created (Phase D not activated; awaiting separate operator approval naming the scoped project/store).

No simulated data is mixed into these files. S2's synthetic simulation (`scripts/s2-simulate-24h.ts`) is strictly separate from live measurements.
