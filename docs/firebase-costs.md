# Firebase Cost Boundaries

This is an engineering cost model, not a report of billed production usage.

## What Can Cost Reads

| Action | Firestore impact |
| --- | --- |
| Browse, search, filter or recalculate a published snapshot | No document request in snapshot-only mode |
| Read a static snapshot, image or replay from the CDN | No Firestore document read |
| Submit or repair a PB | Ownership/binding checks, transactions and later publication can read documents |
| Submit an event inbox entry through the SDK | The deployed validation rules read the period and public profile: two unique dependent documents, in addition to the write |
| Publish a leaderboard | Reads canonical results, exact-bound proofs, identities and publication state; writes derived pages/checkpoints |
| Multiplayer signaling | Live session/message reads and listeners, writes and cleanup deletes |
| Capture a changed snapshot | Bounded capture reads; reuse unchanged boards and finalized archives |
| Verify already captured replays offline | No Firestore access; publishing server verdicts is a separate operation |

An HTTP request is not a document read. One batch request can read many documents.
An empty query can still have a minimum read charge. Rules using `get`, `exists`
or `getAfter` can add dependent-document reads. A write does not inherently
require two reads, but its rules or application transaction may do so.

## Measured Regression Fixtures

- Sixty concurrent distinct cold misses with a ten-probe client allowance:
  60 reads before, 10 after; excess attempts return 429 before storage. This
  breaker is isolate-local, not a global defense against distributed abuse.
- A 1,001-row PB merge: 19 HTTP requests before, 9 after; the same 16 estimated
  document reads and 15 writes. Do not describe this as a document-quota saving.
- Identity publication for that fixture: 15 requests before, 5 after; the same
  13 estimated document reads and 14 writes.
- An infrastructure failure during event intake: 20 reads and 3 writes before,
  15 reads and no writes after. The receipt stays queued rather than rejected.
- A concurrent newer PB during replay repair: the transaction retries, observes
  the changed binding and performs no stale write. This can use one extra read
  on conflict; correctness takes priority over a stale, cheaper write.

For example, ten equivalent miss bursts save 500 estimated document reads, not
80% of a day's total. These fixture frequencies are not known production rates.
Cached public routes may not execute at all in capture-only deployment mode.

## Remaining Limits

Large canonical rebuilds and identity/cosmetic invalidation remain expensive.
Current exact-binding and compare-and-swap checks must not be removed just to
reduce counts. Multiplayer and legacy SDK clients are outside ranked Worker
request accounting. Origin/CORS checks alone do not stop direct SDK access.

Without production monitoring access and per-path invocation counts, daily
before/after totals cannot be attributed honestly from Analytics users or the
Firebase usage chart. Client telemetry measures observed requests, not billing.
Never query collections just to diagnose quota when management metrics suffice.

## Release Checklist

Use [the manual release checklist](manual-release-checklist.md) and
[the complete Worker path inventory](../workers/ranked/CLOUD_PATHS.md).
Check complete deferred publication costs, no-op paths, quota failures, account
switches, concurrent PBs, and replay/proof bindings before deploying a change.
Keep snapshots private until package consistency and coverage checks pass.

References: [Firestore pricing](https://firebase.google.com/docs/firestore/pricing)
and [Firestore quotas](https://firebase.google.com/docs/firestore/quotas).
