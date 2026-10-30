# Native Verification Authority

## Status

`snapshot-native` is an opt-in authority path, not a claim that every live feature
already supports external proofs. **Event queue ACK activation remains OFF.**
Queue-only compaction and passing helper tests do not establish full compatibility.
This document does not enable a mode, deploy a service, or attest that outstanding
work is implemented.

## Modes and Defaults

### Stored Proof Overlay

A committed `verification-ledger-current.json` can add already-audited native
proofs to snapshots while the configured backend authority remains `firestore`.
This is a read-only publication layer, not the backend cutover below. Capture
finishes first, then exact stored bindings and current holds are reapplied locally.
It runs no new physics, creates no verdicts, drains no queue, and writes nothing to
Firebase. A changed PB cannot inherit an old proof by name, time, or track alone.
New or uncovered runs continue through the existing server verifier.

The overlay rebuilds public RP and profiles from accepted snapshot proofs. Server
receipts and cosmetic permissions still follow genuine server processing; a public
proof must not invent a Firebase upload receipt or grant. Existing server queue
processing remains enabled, so the pure-cutover queue/grant blockers below do not
prevent publishing this overlay. Future captures must retain its pinned proofs and
replay bindings, and conflicting bot pushes defer rather than silently rebase.

- `firestore`: the existing verifier publishes server verdicts and completion
  transactions; live consumers use the corresponding Firebase-derived state.
- `snapshot-native`: trusted captured inputs are verified and reviewed locally;
  durable ledger proofs drive compiled public snapshots instead of bulk server
  verdict writeback. Browser consumers use compiled flags and statistics, not the
  ledger or private receipts.

Authority selection is implemented in
`tools/verifier/local-snapshot-verification.mjs`. An explicit nonempty override
(`POLYTRACK_VERIFICATION_AUTHORITY` or the workflow's selected override) takes
precedence; otherwise the selector reads `tools/verification-authority.json`.
With neither configuration nor a native ledger marker, the default is
**`firestore`**. Invalid configuration fails rather than silently selecting a mode.
The existing selector also rejects a native ledger pointer without an explicit
repository authority config, preventing accidental downgrade of native authority.
No activation config is introduced by this documentation.

## What Actually Uses Zero Firebase

Native physics, replay hashing, completed review, ledger operations and snapshot
compilation against already captured inputs require **zero Firebase reads and zero
Firebase writes**. Keep Firebase credentials out of those steps.

This is not a zero-Firebase application claim. Source discovery/capture, account
ownership, new canonical PB submissions, event admission and necessary
housekeeping remain separate online operations. Git publication and any remote
publication check are also separate from offline computation.

The public root ledger is `verification-ledger/`, pinned by
`verification-ledger-current.json`. Ledger files are content hashed and bounded to
2 MiB each. They are not embedded in packed user payloads or required by browser
CDN assets. A physics-cache hit alone is not completed review or public authority;
exact bindings, current policy, sticky holds and a real final-review timestamp
remain mandatory.

## Compatibility Blockers

### Event Admission and Queue Drain

The live event service appends pending runs to a finite queue, capped at 512 slots
and a period replay-byte budget. External proof publication does not execute
server completion, so queues fill unless approved housekeeping drains them.

Before activation, all of these must work together:

- A trusted published snapshot/ledger generation, retained replay assets and exact
  private raw-pending ACK candidates.
- Accepted-best admission lookup used by submit, no-improvement and previous-time
  handling, while preserving legitimate normal canonical improvements.
- Exact duplicate-attempt and own-status resolution without inventing Firebase
  completion or `cloudConfirmed` acknowledgements.
- Fresh hold/source mutation fencing and safe handling of active server leases.
- A capture merge that retains externally accepted native PBs, RP and archives
  when fresh Firebase boards omit them. Absence is not revocation; explicit holds
  and exclusions still override acceptance.

`tools/acknowledge-native-event-queues.mjs` implements only the narrow queue
housekeeping portion. It does not implement the other compatibility features.
Do not assert their prerequisite flags simply to run the helper.

### Cosmetic Authorization and Achievements

Live Worker cosmetic checks use Firebase metrics. The inspected private captured
Firestore rules also require server-issued per-account cosmetic entitlement
allowlists for direct profile design saves. Snapshot-only unlocks therefore do not
automatically authorize cloud saves, even when previews or public metrics look
correct. Preserve ownership, beta evidence, grant/revocation and supersession
checks; do not bypass rules or trust client-supplied unlock claims.

Offline Overall rebuilding must retain/recompute achievement evidence and Casual
RP as well as normal scores. Verified board flags alone are insufficient. This
integration is parent-owned and must pass final-candidate checks; availability of
the pure scoring helper does not establish consumer compatibility.

## Necessary Bounded Online Costs

Avoid thousands of per-verdict writes, but do not hide required online costs:

- Queue housekeeping core: at most four period queue reads and four masked CAS
  queue writes per helper round; configured ceilings are 16 read attempts and
  eight write attempts. Only `slots` and `replayBytes` change. Lifetime admission,
  entrant, subject and retention counters remain intact. Source/hold fences or
  other compatibility lookups add their actual costs and must fit the whole-step
  budget. There is no empty commit or immediate conflict retry; 429 and unknown
  commit outcomes stop the round.
- Cosmetic compatibility: if existing rules remain, changed-account entitlement
  publication costs approximately one grant write per changed account plus the
  required metadata/cache-invalidation writes and CAS reads. Measure the bounded
  batch; this is not three verdict writes per verified run. Alternatively a
  separately reviewed authenticated snapshot-aware save route must enforce the
  same ownership and entitlement policy. Neither alternative is presumed active.
- Capture/discovery and ordinary player submissions have separate read/write
  budgets. Reserve player headroom before admitting maintenance work; batching
  HTTP requests does not eliminate document-operation costs.

ACK credentials belong only in a separately approved post-publication housekeeping
step. Require exact protected default-branch remote publication, not an unpublished
candidate or a successful earlier push. Unknown commits are not successful ACKs.

## Activation Review

1. Validate the complete candidate: proofs, real decision timestamps, numeric
   verification states, scores, achievements, Casual/Event RP and replay coverage.
2. Test accepted-best admission, duplicate/status handling, concurrent holds,
   leases, queue accounting, CAS conflicts and idempotent unknown-outcome recovery.
3. Test a fresh capture and archive cycle after ACK without losing native-accepted
   progress, and test newly unlocked cosmetic saves against actual authorization.
4. Budget source capture, queue housekeeping and changed grants independently;
   preserve existing pending work and retain canonical discovery.
5. Parent explicitly approves activation only after those results. Helper tests,
   config strings and prerequisite assertions are not substitutes for completion.
