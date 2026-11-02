# Cloud Cost And Correctness Map

This is a code-path audit, not a complete Firebase billing attribution. Never add unrelated fixture percentage savings together or extrapolate them into a guaranteed daily total.

## Paths And Boundaries

| Action | Data source and unavoidable work | Main safeguards / remaining costs |
| --- | --- | --- |
| Browse tracks, boards, archives, profiles, popularity, planner | Static public snapshot/CDN assets and local state | Public Worker Firestore reads require capture authentication, not just a claimed Origin. These public views must not crawl canonical race documents. CDN bandwidth is not a Firestore document read. |
| Submit a normal PB | Owned canonical race plus profile transaction | Existing path reads both records and writes both on a new PB, before optional name-claim, streak, preview, or publication work. Ownership, exact replay binding, and durable acknowledgement are not optional. No claim that a normal PB costs one write. |
| Notify leaderboard publication | Worker rereads authoritative canonical binding; immediate or scoped coalesced publication | Scope coalescing to busy tracks. A single sparse PB can cost an extra queue write; front-door savings do not equal whole-pipeline savings. Current production batching scope is Summer 1. |
| Retry a local PB after cloud failure | Persisted exact local binding and owner-scoped reconcile state, then bounded server checks | Local save is not a cloud receipt. Permission/quota backoff and exact acknowledgement are retained; failed uploads remain local. |
| Change profile / cosmetics | Owned profile, entitlement/hold checks, and derived propagation | Profile discovery requests track IDs only, pages beyond 100, and checkpoints progress. An older identity job cannot overwrite a newer published identity. Large changed board generations can still require many page reads/writes. |
| Submit daily / weekly / Kodub event | Durable submitted replay and bounded intake / admission / verification | Public event browsing stays static. Submission, intake, accepted-best proofs, archive publication, and rate/admission limits remain separate operations. A cached public row is not an admission proof. |
| Sunday Kodub / daily / weekly rotation | Scheduled period provisioning and upstream Kodub metadata | Upstream HTTP requests are not Firebase reads. Only changed/provisioned period state needs document writes. Existing periods and proofs remain guarded; rotation and quota-reset time zones are distinct. |
| Event publication retry | Durable cursor/retry reservation, immutable saved parts and generation staging | Reservation must precede saved-part reads as well as new source scans. Failed restaging cannot justify minute-by-minute full reassembly. Preserve the previous complete generation until replacement succeeds. |
| Capture public snapshot | Privileged bounded discovery plus changed/missing replay export | Reuse exact-bound retained artifacts; never treat unavailable source as empty. Export write failure must not advance past the unwritten profile or prune a valid old profile. A fresh capture is not free. |
| Native verification | Local physics/track/replay checks | Simulation itself does not read Firebase. Current Firestore-authority publication still performs fresh binding/hold checks and writes queue/audit/reconciliation state. The checked-in stored-proof overlay is not equivalent to enabling snapshot-native authority. |
| Multiplayer | Firestore signaling messages/listeners plus peer traffic | Genuine live feature, not a snapshot candidate. Listener lifetime and query bounds matter. Do not disable signaling or pretend cached matchmaking is live. |
| Diagnostics | Local counters and optional Worker log sample | No automatic Firebase polling. Client counters omit other devices/backend/rules/index charges. Failed-operation costs are unknown, never zero. |

## Local Audit Tool

Profile discovery uses a field projection to reduce transferred replay data, not to claim fewer billed documents per returned row. Cursor ordering follows Firestore's document-name ordering. See the official [StructuredQuery reference](https://cloud.google.com/firestore/docs/reference/rest/v1/StructuredQuery) and [index ordering documentation](https://firebase.google.com/docs/firestore/query-data/index-overview).

`node tools/cloud-cost-audit.mjs local-wrangler-log.jsonl` consumes normal Wrangler tail output, including pretty-printed events. It can also read a pipe on stdin. It aggregates individual transport records only, avoiding double counting overlapping request/background summaries. It deliberately discards headers, URLs, account IDs, document IDs, raw exceptions, and replay contents. Oversized/truncated events and unknown costs remain explicit. It makes no network requests and does not extract credentials.

This reports only operations present in that sample. It cannot reconstruct historical billing totals, observe direct client SDK activity, or prove that no other deployment consumes quota. Collect representative successful traffic after reset before claiming project-wide savings.

## Missing-Data Cooldowns

Exact public `snapshot_not_ready` responses now share the existing bounded
isolate-memory cache for at most ten seconds, even if edge cache writes fail.
The authorization gate still runs before cache access. Other 404 bodies,
authentication failures, quota errors and server failures are not cached here.
Successful publication retires the memory scope so an older in-flight miss
cannot refill it. The existing 64-entry/2 MiB limits remain unchanged.

In the mocked repeated-miss test, eight identical requests require one document
lookup instead of eight during that cache window. This is a path-specific test,
not an estimate of total daily Firebase savings. It adds no Firestore writes.

A missing static full-package index shares a thirty-second client cooldown
across track lookups. Changing package generation clears the cooldown. This
reduces repeated CDN requests, not demonstrated Firestore document reads.

These fixes do not revoke direct Firestore access from an old copied client.
Current canonical-list rules must be audited separately from Worker caches;
a historical export is not proof of today's deployed rules.

## Remaining Boundaries

Client caching is not an abuse boundary: modified clients can bypass their own local suppression. Existing ownership rules, capture authentication and Worker rate limits remain essential, but legitimate owner-scoped direct SDK access is still a nonzero quota surface. Preventing all quota exhaustion under arbitrary traffic requires a separately designed trusted admission/budget boundary, not an Origin check or a hidden API key. This follow-up does not claim denial-of-service immunity or provision another service.

Firestore verification authority and per-board identity fanout remain material costs. Moving all authority to an offline snapshot requires tested queue admission, accepted-best, fresh hold/version fences, entitlement grants, capture entry-point compatibility, and consistent full-field publication. Do not flip the authority setting merely because a public proof ledger exists. No such cutover or weakening of verification/rules is part of this follow-up.
