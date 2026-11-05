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

## Release 275 (Historical): Bounded Event Generations And Atomic Reconcile Handoff

Coordinated Worker maintenance coalesces NEW active-period display generations only for fields with at least 200 accepted racers for at most fifteen minutes after the preceding successful build. The deadline is anchored to that build and cannot be extended by later PBs. Small fields, first builds, active fixed-snapshot continuations, archived periods, and periods within fifteen minutes of ending are not held by this gate. Authoritative accepted PB/replay writes remain immediate; dirty and incomplete indicators are retained. This is not a verification shortcut or permission to call the inline top 200 a complete field. Existing retry reservations, source-revision CAS and fifty-minute expiry fences remain.

In the stationary 1,136-racer ten-update publication fixture, immediate generation costs 11,720 estimated document reads and 320 writes; coalesced generation plus its gate/control work costs 1,196 reads and 33 writes. These are publication-only fixture results, not daily production attribution. Fields below 200 retain the original costs. A single isolated large-field update can add bounded gate polling and one cursor write, with up to fifteen minutes of derived display delay; it does not earn the burst saving. No new schedule, service or database collection is added.

A full normal rebuild initiated by canonical reconciliation now publishes its mutable track/manifest/build/meta state and discharges the corresponding reconciliation checkpoint in one guarded commit. A failed final commit retains the fixed-snapshot build for retry; a lost successful response cannot leave a separately stale full-rebuild request that rescans the field. Concurrent queue/root/meta changes are conflicts, not authority to overwrite a newer preimage. Queued result IDs and bindings are retained for a fresh keyed merge because they may postdate the fixed snapshot. Unprocessed sibling work stays queued. Historical proof reads are not reused as fresh queue CAS preimages.

At release 275, cosmetic-change invalidation could still restart a build. That historical limitation is addressed for live, owned paged builds in coordinated mode by the release 293 primary fix below; other modes and nonqualifying builds retain the original fences and behavior. Project-wide read attribution still needs accessible monitoring/logs. Do not present these fixes as a guaranteed daily quota reduction.

## Release 293 Audit: Cheap Event Publication Gates Before Full Source Reads

### Primary Fix: Preserve Paid Normal Builds During Cosmetic Fanout

In coordinated mode only, a paged identity update checks for a live build on
the exact published base, with an unexpired fixed snapshot and the matching
active canonical continuation. If found, it returns pending without changing
the board or build. The existing durable profile job retains that track and
applies its identity after the build finishes. Expired, blocked, completed,
unowned and base-changed builds do not qualify. This preserves every final
root/meta/queue fence rather than accepting a stale build after a cosmetic write.

The 1,136-racer Summer1-sized mock with identity fanout after 900 scanned rows
measures **6,215 reads / 163 requests / 74 writes before**, versus **3,490 reads /
102 requests / 56 writes after**, including the eventual identity application.
Canonical, historical-proof and current-proof reads each fall from 2,036 to
1,136 because the discarded prefix is not scanned again. These are fixture
counts, not production attribution. Two repeated scheduled deferrals cost
eight reads and zero writes, preserving the original durable identity job.

Tradeoff: paged identity checks add one build-job read when no live build
qualifies, plus a coordinator read when checking a live build. Display identity
may lag until completion or expiry is observed by a later normal profile turn.
The existing fifty-minute eligibility deadline is never renewed. Nonpaged
boards, including the retained 155-racer Rolling Hills field, do not use this
gate. Coordinated profile work shares a 42-request work budget with the final
job checkpoint reserved separately; budget failure leaves unfinished tracks
queued. Ownership, review holds, current proof checks and PB intake are unchanged.

### Secondary Fix And Measured Idle Costs

Under the checked-in `capture-only` / `coordinated` modes, the every-minute
event cron is allowed only at minutes 00 through 44 in UTC hours 00, 08, 12
and 20 (180 allowed invocations per day, not 1,440). Phase 0 provisions only
every fifteen minutes; phase 1 cleans up, phases 2/4 attempt publication,
and phase 3 guarantees inbox polling. Other intake phases use the existing
five-minute activity hint. Canonical and identity continuations still run
every five minutes throughout the day so fixed-snapshot builds can finish.
No cron, mode, window, rate limit or capacity was changed by this fix.

Combined event-total publication previously loaded the entire paged Rolling
Hills field before discovering a finite-total coalescing gate, changed source
revision, or expired unfinished checkpoint. Those cheap gates now run first.
An eligible build still reads and validates the complete live source before
any finite source scan or saved-part assembly. Its final transaction still
checks the live source revision/signature, job, roots and manifest. Nothing
is cached across invocations, and accepted PBs/replays are not changed here.

Mock REST measurements with 1,136 Rolling Hills racers (root plus twelve pages):

| Path | Before reads / requests | After reads / requests | Writes before / after |
| --- | --- | --- | --- |
| First finite-total coalescing deferral | 18 / 20 | 5 / 7 | 1 / 1 |
| Changed or expired unfinished checkpoint | 19 / 23 | 6 / 10 | 2 / 2 |
| Eight additional polls during durable backoff | 16 / 16 | 16 / 16 | 0 / 0 |
| Idle publication signal | 1 / 1 | 1 / 1 | 0 / 0 |
| Healthy saved-part publication | 25 / 31 | 25 / 31 | 18 / 18 |
| Missing live source, no cheap deferral | 5 / 7 | 6 / 8 | 1 / 1 |
| Job read failure, including 429 | unknown / 17 | unknown / 4 | 0 / 0 |

Tradeoff: an unavailable-source attempt without a cheap deferral reads the job
once earlier, adding one read/request; existing durable backoff still applies.
Failed read billing is unknown, not zero. At the coalescing deadline a missing
page still prevents publication and keeps the previous complete generation.
Recovery performs a fresh full-source load and final transaction fence.
The existing continuous blocked-source day fixture increases from 1,299 to
1,348 reads (49 due attempts, each adding that one job read), with the same
49 retry writes. That fixture runs outside the coordinated production windows.

The completed, quiet 24-hour fixtures measure 360 event reads / 384 requests
and, separately, 660 non-event reads / 660 requests, both with zero writes.
They exclude active builds, legacy hydration, fresh six-hour source audits,
intake/verification traffic, capture tools, direct clients and other services.
These counts do not establish the production cause of a 49,000-read day.
Large full-field generation/hydration remains material: the existing synthetic
10,000-row legacy totals fixture alone costs 20,372 estimated reads across
fourteen turns. That is a stress fixture, not evidence of production field size.

The normal full-build query selects at most 100 canonical documents per page
for one `trackId`, ordered by document name at a fixed `readTime`. Each row
can also need one historical proof plus one fresh current proof. The latter
is still necessary to preserve newer competitive-review holds and current
queue CAS preimages. The 1,136-row stationary mock measures 3,472 reads in
93 requests; one resumed turn with two pages measures 606 reads in just
15 requests. A cosmetic write after 900 scanned rows invalidates the mutable
base: that fixture totals 6,215 reads / 163 requests rather than 3,472 / 93.
These are pre-fix restart measurements, not a remaining defect in the
qualifying coordinated path. The primary release 293 fix above prevents that
identity-triggered interruption; the separate cheap event gate does not.
Other modes and nonqualifying builds retain the base fence. A query `select` projection
alone reduces payload bytes, not documents returned. Fresh proof
checks must not be replaced with historical or cached authority to save quota.

### Retained Rolling Hills Size And PB Scope

The paged 1,136-racer Rolling Hills fixture above is deliberately a stress
case, not the retained production field size. For an inline 155-racer source,
the same first coalescing check changes from 6 reads / 8 requests to 5 / 7;
changed/expired checkpoint handling changes from 7 / 11 to 6 / 10. Healthy
single-part publication stays 13 / 19 with eight writes. Missing-source
handling stays bounded but increases from 5 / 7 to 6 / 8, as disclosed above.

PB coalescing remains scoped to Summer1. An immediate PB on a current inline
155-racer Rolling Hills board costs five Worker reads/four writes in the
newer-PB mock, with zero canonical field queries. Ten improvements cost 50
reads/40 writes; explicitly opting into coalescing plus drain costs 26/15.
A single improvement would instead increase from 5/4 to 8/6, so this audit
does not widen the allowlist. Canonical client writes and later verification,
Overall, event-total generation and capture are additional separate work.

Ten rolling-only ERP generations with 155 inline Rolling Hills racers plus
1,000 named finite-total racers cost 170 reads / 190 requests / 180 writes.
They read fifty saved finite parts and twenty Rolling Hills roots (including
final fences), but **zero public profiles and zero finite source queries**.
The finite revision stays unchanged; each changed Rolling revision is still
published. Legacy unfinished hydration is a separate, existing checkpointed
path, not a per-update full-profile join. Identical normal snapshot signatures
return before dirtying ERP; changed Rolling time/proof/identity remains meaningful.

Evidence: `test/event-publication-preflight-cost.test.js` compares the same
REST mock with an optional `EVENT_PUBLICATION_PREFLIGHT_BASELINE` source file;
`test/events-scheduled-cost.test.js` and `test/scheduled-baseline-cost.test.js`
pin the current quiet cron counts. Request counts include transaction control
calls; read estimates do not include index-entry or security-rule charges.

## Release 295: Client Retry Loops And Capture Reuse

- A confirmed cosmetic commit now keeps a bounded account/session/draft receipt
  when its local acknowledgement cannot be stored. Later attempts retry only
  that acknowledgement with backoff. In the two-drain failed-storage fixture,
  profile reads fall from 8 to 1, profile writes from 8 to 1, job writes from 8
  to 1, and Worker posts from 8 to 1. Backend effects of those posts are separate.
  A reload or a different auth session still requires fresh cloud authority.
- Two simultaneous exact PB submissions share only their cloud operation. The
  already-current PB fixture falls from two transactions/four reads to one/two,
  with zero writes in either case. Local finish accounting remains per call.
  Changed replay hashes, timing, identity or account/session do not share work;
  failures release the slot and cannot create a successful acknowledgement.
- A fresh pending board can reuse the exact saved recording/canonical pair after
  local byte-hash, structure and binding validation. Its projection is pending,
  not verified; trusted ingestion dates survive but old verdict fields do not.
  A status-only transition now needs zero payload reads rather than a refetch.
- Only explicit projection-size failures retain independently validated frozen
  source boards. They do not retain the failed projection or invent current
  source confirmation. Corruption and binding/baseline errors still fail closed.

The complete first-five synthetic player fixture remains 75 reads/52 writes
(14/14 direct SDK, 61/38 Worker), excluding verdicts, scheduled aggregation and
rules/index/SDK retry charges. Static browsing within it remains 0/0. This healthy
sequential workload does not trigger the two client bugs above, so no reduction
is claimed for it. The current quiet fixture floor is 1,020 reads/day (360 event
plus 660 non-event), excluding active work and actual source/entitlement audits.
Neither figure attributes the reported daily usage to a particular cause.

Evidence: `tools/client-cosmetic-publish-cost.test.cjs`,
`tools/client-pb-inflight-cost.test.cjs`,
`tools/public-profile-replay-export.test.mjs`,
`tools/capture-overall-projection.test.mjs` and
`tools/new-account-five-track-cost.test.mjs`. No routine capture cap, schedule,
verification authority, security rule or admission policy changes are included.
