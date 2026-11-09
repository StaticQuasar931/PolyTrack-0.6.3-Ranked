# Track Build Deadline Continuation

## Scope And Activation

The existing five-minute cron can advance only 1 initial + 9 * 2 resumed
100-row pages before the strict 50-minute snapshot deadline: 1,900 rows.
Adaptive64 targets keyed PB merges, not these full scans. Increasing its limits
would not solve this deadline.

This patch adds an **explicit operator-driven** bounded continuation path. It
does not silently change cron cadence, add idle reads, initiate builds, or run
global reconciliation. Deployment alone does not start a fast drain. Main must
use an authorized bounded driver for a known queued generation. No deployment,
live request, or database operation was performed during implementation.

POST `/v1/admin/track-build/continue`, with the existing allowed Origin and
`X-Admin-Token` authentication. Maximum body size remains 2,048 bytes. Body fields:

- `trackId`: exact already-queued full-build track.
- `generation`: current private capacity checkpoint generation, not public generation.
- `checkpointVersion`: current capacity document's exact Firestore updateTime.
- `recoverExpired`: optional boolean, default false; only for the one legacy recovery below.

Both pending-track and pending-full markers must exist. A different active full
build, changed generation/version/base, completed checkpoint, invalid clock,
blocked modern generation, or early continuation stops before canonical reads.
There is no fallback to another track, fresh scan, verification bootstrap,
Overall rebuild, or discovery query. Final release metadata is updated only by
the existing track publication transaction; no frontend release metadata is touched.

## Bounded Driver Contract

Start only with an already inspected queued checkpoint. For a legacy expired
block, make the first request with `recoverExpired:true`. Otherwise use false.
For each 200/pending response, replace generation/version with the response
values; wait at least `continueAfterMs` (30,000), then submit the next call with
recovery false. Stop on complete, any non-200, deadline expiry, lost/ambiguous
response, or a local request/time budget. Do not poll idle/completed jobs.

Use a finite budget: at most 26 successful calls for the tested 5,000-row case;
for larger inspected inputs derive a finite allowance from their page count
and the remaining deadline, never an unbounded retry loop. Already-full final
pages need an additional EOF query. A cron pass can race the driver; the stale
version is rejected rather than silently restarting. Inspect deliberately
before issuing a new driver budget after an ambiguous response.

Each invocation retains 100 rows/page, two pages/resumed pass, one page/initial
pass, and the existing 42 work / 45 total Firestore request fence. No pages or
proof work are hidden in background loops. The durable next-continuation time
prevents successful endpoint advances faster than 30 seconds. Normal cron may
also advance the same checkpoint with its original guards.

At 30-second pass intervals, 2,397 records complete in 13 passes / six minutes;
5,000 complete in 26 passes / 12.5 minutes, including EOF. These are offline
schedule results, not a guarantee about platform/network delay. The deadline
remains strict; missed deadlines fail closed. No hard 2,000-racer ceiling is
introduced, and no unlimited-size completion guarantee is claimed.

## One-Time Legacy Recovery

Only an existing `complete:false`, same-public-base, explicitly
`snapshot_expired` blocked checkpoint with a valid expired readTime and no
deadline policy/recovery marker qualifies. An atomic CAS commit:

1. Creates `capacity_track_<track>_deadline_recovery_v1`, create-only, containing
   the exact old checkpoint and its updateTime.
2. Reserves policy 1 recovery on the existing checkpoint, still blocked.

Only that invocation may then obtain a new initial snapshot. A failed query or
normalization after reservation cannot reserve recovery again. If a fresh page
was durably checkpointed, ordinary version-fenced continuation can resume it.
New/fast-policy generations cannot get this recovery. A second expiry on the
same base stays blocked. New-base behavior remains the original policy.

Every old generation part remains unchanged; no deletion, readTime rewriting,
reuse of old parts in the new generation, or silent paid-prefix restart occurs.
Fresh canonical/proof reads use the new fixed point for the entire generation.
Published root, proof/hold handling, final job/root/meta CAS and page assembly
stay on the existing full-build path. Keyed PBs/bindings newer than the read point
stay queued after full-build completion. Sibling work is not discharged.

## Offline Cost And Tests

Real Worker route fixtures use real normalization, replay hashing, proof shards,
part assembly, paged publication and CAS checks. Verified and missing-proof
variants, with and without prior paged boards, cover 2,397 and 5,000 rows.
The 2,397-row legacy recovery starts from 1,900 rows / 19 retained old parts.
A matching competitive hold remains unchanged and unverified.

Observed fast-path maxima: 605 estimated document reads, 205 writes and 20
Firestore HTTP requests per invocation. Tests retain the original <=650
document-read envelope, enforce <=45 requests, <=2 canonical queries and a
260-write regression ceiling covering existing proof preparation and publication.
The 260 ceiling is a test envelope, not a raised production write allowance.
The original 48-document proof commit chunks and existing staging remain unchanged.

For a prior paged board:

| Records / proof state | Total reads | Total writes | Calls |
| --- | ---: | ---: | ---: |
| 2,397 / already verified | 4,906 | 89 | 13 |
| 2,397 / missing proofs | 7,303 | 2,486 | 13 |
| 5,000 / already verified | 10,231 | 181 | 26 |
| 5,000 / missing proofs | 15,231 | 5,181 | 26 |

The one legacy recovery adds exactly two durable writes (archive + reservation)
to its fresh-generation fixture, not a renewal of old parts. These are fixture
totals for this work, not daily billing or live attribution; old paid work is
additional historical cost. Current proofs still require current authority.

Each fast invocation also measures process CPU and asserts a five-CPU-second
offline regression ceiling. Observed focused-fixture maxima were below 0.2 CPU
seconds. This is not a production Worker CPU entitlement or live-isolate SLA.

Tests:

- `test/track-build-continuation.test.js`: authentication, body bounds, scoped
  selection, early/stale/expired rejection, queue CAS, one-shot reservation,
  failed recovery, no idle source work, monotone cursors, request exhaustion,
  and source acquisition clock advancement.
- `test/track-build-expiry.test.js`: existing slow-expiry behavior plus realistic
  fast route, legacy recovery, proof/hold, CPU and per-call resource fixtures.
- `test/scheduled-baseline-cost.test.js`: unchanged exact idle baselines
  (1,536 legacy, 108 four-window, 756 coordinated reads/day; zero writes).

Run `npm run check` in `workers/ranked`. No remote services are needed.

Final verification on the isolated source-355 worktree: `npm run check` passed
1,393 tests, zero failures/skips. `git diff --check` passed. The integrated cohort
includes three Worker source files, four test files, the bounded operator recovery
driver, Worker configuration and this document. Deployment and live recovery are
operator-owned and separate from these offline results.
