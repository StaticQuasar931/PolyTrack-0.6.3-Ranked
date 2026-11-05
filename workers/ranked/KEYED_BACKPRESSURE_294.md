# Release294 Keyed Canonical Discovery Backpressure

## Current Decision: Retained Guarded Adaptive64

The exact CANONICAL_DISCOVERY_BACKPRESSURE='enabled' flag now enables capacity
backpressure plus conservative adaptive64 on known-safe, fully sharded, single-track
paged pressure. Otherwise targets remain 16. Missing flag retains legacy behavior.
Parent's edit of only this internal flag is expected; no other configuration was
changed by the worker agent. Full final contract and memory/resource evidence are
in ADAPTIVE_TARGET_BATCH_294.md. Retained complete cost is 1,176R / 537W versus
7,270R / 504W: 6,094 reads avoided for 33 extra writes, not write-neutral and not
a daily projection. Older fixed-16 tables below are historical, not the final mode.

## Freeze Handoff

Worker source, tests, and docs frozen after this handoff. No production calls,
configuration changes, authority/cadence flag flips, deployment, commits, or edits
to parent-owned runner/workflow/night code. Source-audit and capture-auth fixes were
not changed by this work. Final full-suite verification may finish after the freeze;
its result belongs in private evidence, not another source change.

## Correctness Change

Canonical discovery previously sized its query by free queued TRACK slots, not free
keyed result IDs. A single busy track with 190 accepted IDs could fetch 50 more,
hit the 200-ID limit, discard accepted IDs, and request full reconstruction of an
otherwise current 1,136-racer base. Repeated discovery during that reconstruction
could cause another full reconstruction.

When the review flag is enabled, discovery takes the minimum of the existing query/track budget and remaining
keyed-ID capacity. At 200 IDs it performs no modern discovery query and drains the
existing accepted keys. It neither rereads the same discovery page at saturation
nor creates a full-rebuild request merely because new PBs exceed queue capacity.
A defensive overflow guard accepts only a contiguous prefix, preserving every
previously queued ID. No cursor can pass an unaccepted suffix. Accepted duplicates
do not consume another ID slot. Cursor, remaining IDs, and existing binding markers
retain their existing job CAS. A concurrent binding/job change rejects the old
checkpoint; it cannot advance the cursor or erase the newer marker.

The source query's existing trusted ingestedAt/document-name ordering is unchanged.
Structurally invalid rows retain the existing policy of being consumed/skipped;
the new prefix fence prevents loss of any capacity-rejected valid row.

Legacy backfill has a separate existing budget and still runs when keyed discovery
is saturated. Explicit full requests, active fixed-readTime continuation, genuine
missing/incomplete/obsolete-base fallbacks, existing over-capacity legacy-state
recovery, and legacy force-all requests remain. The normal discovery path cannot
create such an over-capacity state. The 200-ID bound, 42-request work budget and
45-request checkpoint reserve, proof/hold checks, and ownership policy are unchanged.
No new queue, schedule, checkpoint type, or extra per-pass bookkeeping write exists.

## Complete Busy-Burst Evidence

Real reconcileCanonicalChanges entry point with a cursor-aware Firestore double,
atomic CAS, actual publication staging, immutable page loading, fresh current proof
reads, and network forbidden. Same existing 1,136-row complete paged base in both
runs; 410 canonical PB improvements, of which 190 were already durably queued and
220 awaited discovery. One updated binding has a current matching competitive
review hold. All 410 updates must publish their exact time, upload and replay hash
without accepting their old proof. The 726 unaffected racers remain verified.

The baseline imports the isolated pre-change Worker index saved as
index-before-keyed-backpressure.js in private evidence. It does not revert or edit
the shared repository. Both runs finish all accepted/discovered PBs, including every
publication and durable queue discharge, then perform three clean follow-ups.
Both final public fields contain every 1,136 racer and have no pending keyed work.

| Complete Burst | Before | Backpressure |
| --- | ---: | ---: |
| Reads | 7,270 | 1,473 |
| Writes | 504 | 825 |
| Firestore requests | 239 | 318 |
| Passes through publication | 15 | 26 |
| Clean follow-ups, included | 3 | 3 |
| Full canonical rows read | 2,272 | 0 |
| Historical proof reads | 2,272 | 0 |
| Fresh current proof reads | 2,280 | 410 |
| Full canonical page queries | 24 | 0 |
| Discovery queries, including empty follow-ups | 18 | 29 |
| Maximum requests in one work/checkpoint pass | 22 | 12 |

Read reduction is 5,797 / 79.7%. This is NOT a write-neutral optimization: writes
increase by 321 / 63.7%, requests increase by 79, and completion needs 11 more passes.
The existing 16-ID targeted batch publishes more immutable page generations rather
than paying for two population-wide reconstructions. No extra write TYPE is added,
but total publication and checkpoint writes do increase. A strict requirement of
no extra TOTAL writes is therefore not satisfied by this measured scenario. Parent
must review that tradeoff; no deployment or configuration activation was performed.

The three clean follow-ups add no writes. Reads are removed, not merely hidden in
an unmeasured deferred reconstruction. Fixed-snapshot and current proof work remain
mandatory whenever a genuinely necessary full build is requested. First-time
publication, native physics verification of new PBs, later approval publications,
Overall/event assembly, unrelated maintenance, and canonical client intake are not
part of this reconciliation-burst fixture. Both runs start from the same durable
backlog/canonical records. These are not full-day production billing or attribution
figures, and no live monitoring or production access was used.

## Regression Coverage

Seven targeted tests passed before freeze:

- All 410 PB updates complete, every final racer is present, holds are preserved,
  changed bindings cannot reuse old approval, and unchanged racers remain verified.
- A full 200-ID queue skips discovery, drains 16 IDs, retains remaining bindings,
  and discovers the waiting PB once capacity becomes free.
- Ten free IDs produce a limit-10 query and a cursor covering exactly those rows.
- An oversized adapter response cannot acknowledge an unaccepted suffix.
- Job CAS loss cannot advance the cursor or erase a concurrent binding marker.
- Already accepted duplicate IDs advance the cursor without double-counting capacity.
- Independent legacy backfill still requests authoritative reconstruction at saturation.

Existing targeted canonical/backoff/publication/authority tests also passed before
the new burst regressions. Final full-suite execution is recorded after the boundary.
The query double compares real timestamp/name cursor tuples rather than destructively
popping rows, so retries and repeated pages are actually charged. Its existing proof
commit bound was corrected to permit the real 48-write proof batches (up to 49 for
migration with its root), matching the other existing quota fixture. Non-proof
publication staging retains its 32-write bound. Production proof limits did not change.

## Private Evidence

Directory:
C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-05/cloud-readiness-294

- keyed-before-backpressure.log: complete pre-change baseline, all outcome checks.
- keyed-backpressure.log: seven targeted tests and complete post-change cost.
- index-before-keyed-backpressure.js: isolated baseline source, never deployed.
- worker-check-keyed-backpressure.log: complete Worker verification after this change.
- keyed-backpressure-results.json: machine-readable bounded cost/freeze handoff.

Run npm --prefix workers/ranked run check for final verification. Approval questions
for verification authority, cadence, and other parent configuration remain pending.
