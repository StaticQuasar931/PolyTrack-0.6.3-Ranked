# November 1 Quota Follow-Up

## Confirmed Findings

- The deployed Worker used capture-only public reads, but had no background maintenance mode binding. Closing public reads did not stop internal cron discovery, aggregation, identity publication, or event processing.
- Recent verification workflows failed in an offline contract test before credentials or database operations. The test expected an obsolete condition string; the stricter authority and due-work conditions are retained.
- Unchanged client profile POSTs performed a profile transaction read. Concurrent moderation requests could duplicate the same cold lookup.
- A short live Wrangler log sample observed failing Firebase operations, not a complete historical billing breakdown. The user's 46,000 reads and 2,300 writes cannot be attributed precisely from that sample.

## Changes

Production uses `BACKGROUND_MAINTENANCE_MODE=coordinated`. Discovery/bootstrap is grouped into the existing four capture windows. Overall aggregation, repair checks, and event maintenance use those windows. Canonical and identity publication keep their original continuation cadence, including outside the windows: pausing a fixed-read-time build until the next window could otherwise expire it permanently. Queued work, rate limits, admission limits, proof checks, and compare-and-set conditions remain intact.

The client shares concurrent moderation lookups. An exact acknowledged identity can be reused for at most one minute in the same live account/session. Changed identity, another transaction, expiry, failed saves, and account/session changes invalidate reuse. Local state and snapshots are not upload acknowledgements. PB authoritative reads are deliberately unchanged.

## Reproducible Estimates

These are mocked document-operation estimates, not billed production totals. They exclude active work, index/rules charges, retries, client uploads, multiplayer, and captures.

| Quiet 24-hour maintenance | Before | Coordinated |
| --- | ---: | ---: |
| Non-event | 1,440 reads | 660 reads |
| Events | 2,880 reads | 360 reads |
| Total | 4,320 reads | 1,020 reads |
| Heartbeat writes | 0 | 0 |

The saving is 3,300 quiet maintenance reads/day (76.4%), not 76.4% of total project usage. Active rebuilds can still dominate cost. No infinite-user quota guarantee is possible.

Tests: `maintenance-windows.test.js`, `scheduled-baseline-cost.test.js`, `events-scheduled-cost.test.js`, `maintenance-quota.test.js`, and `tools/client-idle-read-budget.test.cjs`. The latter covers 100 unchanged profile calls sharing one profile read and 100 concurrent moderation calls sharing one moderation read, plus failures, concurrency, ownership, expiry, and session changes.

No bulk capture or production document inspection was performed for this investigation. Current snapshots remain available; fixed workflow contracts allow the existing scheduled bounded pipeline to resume. Do not retry capture or verification merely to recover a CDN publication failure.
