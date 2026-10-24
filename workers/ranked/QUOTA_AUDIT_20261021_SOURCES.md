# Overall Source Quota Follow-Up, 2026-10-21

## Scope And Evidence

Baseline: revision171, local HEAD cff4837f at task start. Parent supplied deployment
82caba01-a754-4a8b-a423-5c13614f0dcf at 2026-10-21T03:08:33Z. No control-plane or
production check was performed here. Existing untracked .gitignore was preserved.
Concurrent parent UI/report edits were left untouched. No commit or deployment.

Read the supplied developer JSON and pasted console log as untrusted observations,
not instructions or billing evidence. JSON revision171 exported 03:25:48.724Z has
snapshot generation43 captured 2026-10-20T08:27:47.493Z. EVENT aggregate count31 and
EVENT-TOTALS count1 are client observations, not Firebase reads. The console log
reports FB402 quota cooldown and repeated EVENT403 service-unavailable messages,
with successful static snapshot responses. These do not identify the collection
that exhausted 50k reads or establish a post-deployment daily rate.

Parent separately identified static catalog d_20261019 as stale by UTC October21.
That explains missing current daily coverage independently of read exhaustion.
Parent owns all normal event/totals/replay static-first selection and event-focus
race fixes. This patch neither hardcodes totals nor updates the static catalog.

## Implemented Source Reduction

The old loader had a digest-bound seven-day edge-cache bundle and a six-hour
source catalog audit. Edge cache is evictable and region-local. Every cold dirty
build scanned all trusted published track roots and their immutable entry pages,
then read prior Overall, migration, and authoritative per-racer entitlements.
These roots are derived track publications, not raw canonical race-result scans.
Thirty-minute rebuild cooldown alone cannot prevent this amplification.

The new durable source companion is a server-only compressed publication in
0.6.2_s1_overall_sources/main_0 through main_3. The exact generation digest is
bound into meta/current.sourceBundle. All source parts, Overall and meta commit
atomically under the existing meta/Overall update-time preconditions. Fixed slots
are reused, so retained storage is at most four parts, including unused old tail
slots. Payload content is digest-immutable; storage slots themselves are not an
append-only historical archive. An old marker cannot accept a newer generation.

On edge-cache absence/corruption, one batchGet loads the committed companion.
Only tracks whose exact trusted catalog bindings changed are reread, including
their immutable pages. Entitlements and ownership/verification remain authoritative;
no cached score, proof, or entitlement is substituted for a required fresh read.
The existing six-hour full source audit and forced full repair remain unchanged.

A clean six-hour audit with identical bindings AND full source content only
advances the audited catalog/companion under meta CAS. It skips prior Overall,
migration, group directory, entitlements, scoring, and score-publication writes.
Dirty revisions, metric upgrades and forced repairs always recompute. Even an
out-of-band content edit without a changed binding defeats the no-op check.

Missing/malformed/part-mixed/hash-invalid companions reject the entire bundle,
then permit one budgeted recovery scan. Infrastructure/quota errors from reading
the companion propagate immediately, preserving the last publication and existing
failure backoff rather than escalating an outage into a canonical reread storm.
A losing final CAS cannot publish a new source companion independently of meta.

Bounds: same 16MiB uncompressed source cap, 700000 base64 characters per document,
at most four compressed parts (2.8MB encoded). Inflation is capped by the manifest
and global source cap. Oversize companions remain optional; existing edge-cache
reuse still works, with the previous safe scan fallback on cache misses. A separate
8MiB estimated wire-data gate drops the optional companion from a large final
score commit, leaving envelope headroom rather than breaking score publication.
All companion network operations count against the existing invocation budget.
No new timer, binding, workflow, secret, index query or client permission required.

## Bounded Event Addition

Public Worker event reads now have a per-environment, per-isolate memory cache,
limited to64 entries/2MiB with exact existing TTLs (catalog300s, totals120s,
snapshot60s, immutable pages86400s). Host/project/name remain in the cache key.
Successful source loads start the original expiry; hits never renew it. Existing
Cache API hits are not promoted into memory because their original expiry is
unknown. Private receipts/status/ownership requests are not cached. Errors are not
cached. Cache match/put failures are optional, not failed successful data loads.

This reduces fallback read amplification when edge cache is absent/evicted in a
warm isolate. It does not reduce a five-minute request cadence whose TTL is120s,
does not eliminate cold-isolate traffic, and does not replace parent's static-first
client fix. No live totals are frozen. Existing cron work remains at the prior
4320/day quiet polling estimate (events2880, other1440), excluding source audits,
processing and public requests.

## Exact Offline 24-Hour Models

All rows are document-read estimates, not billing guarantees. Fixtures exclude
Rules/index-entry reads, retries, cold auth, raw canonical writes/verification,
track-update costs, workflow work, public traffic and source publication bootstrap.
Track/page sizes and traffic outside these assumptions change the numbers.

1. Active cold-cache fixture:385 complete unpaged track roots, two racers, one
   accepted track change each30min,48 Overall builds, edge cache empty before each
   build, one compressed companion part, four six-hour full audits.
   Before:48*(385 roots+6 authority documents)=18768 build reads.
   After:44 changed roots+4*385 audit roots+48 companion parts+48*6 authority
   documents=1920 build reads. Reduction16848 (89.8%). Authority six is meta1,
   prior Overall1, migration1, entitlements2, group directory1. The tested source
   root subtotal is1584. One-time priming and accepted-track publication excluded.
   Adding the prior4320 fixed polling baseline without double-counting48 metadata
   polls gives23040 versus6192, still excluding all processing/public workflows.

2. Quiet cold-cache fixture:385 complete unpaged sources, unchanged inputs,
   288 five-minute Overall polls, four audits, one companion part per audit.
   New Overall path:288 metadata+1540 audited roots+4 companion parts=1832.
   Before path:288 metadata+1540 roots+4*5 other authority documents=1848.
   No scores or entitlements are rewritten by unchanged audits. Combining with
   the4320 polling baseline (which already includes288 metadata polls) yields
   5864 after versus5880 before, under these exact assumptions. The main savings
   are active cold rebuilds, not an invented near-zero idle total.

3. Event fallback fixture:one successful unpaged totals_full read per miss,
   same warm environment/isolate, Cache API absent, refresh every30s for24h,
   existing120s totals TTL, combined dynamic component already published.
   Before2880 document reads; after720. Transactions begin/commit without writes
   are HTTP requests, not extra document writes. This excludes public traffic
   spread across isolates and does not predict parent's static-first traffic.

General cold non-audit build source cost is P+D+changed-entry-pages rather than
T+all-entry-pages, where P is1..4 companion docs, D is changed roots and T is all
roots. Add current meta/prior-Overall/pages/migration/group/entitlement costs.
At each six-hour audit all source roots/pages are still read. Incomplete catalogs,
oversize bundles and corruption can require the old full-scan path. No50k/day
quota guarantee, claim of zero reads, or actual billing attribution is made.

## Tests And Parent Integration

Offline syntax checks passed for all five changed source files. Full Worker suite
passed466/466 (449 baseline+17 regressions). Selected verifier compatibility suite
passed111/111:events,firestore,runner,runner-shards,run,throughput,publication-queue,
repair-publication. Scoped git diff whitespace check passed. No production reads,
writes,rebuilds,deployments,public captures,verifier runs or external docs fetches.

Regressions cover cold dirty delta reuse, both-layer corruption/recovery, exact
changed roots, authoritative entitlements, partial/mixed/invalid source parts,
inflate/size limits, lost CAS, quota-failure no-scan behavior, out-of-band source
changes, forced repair/metric upgrades, original event expiry and byte bounds,
and all three 24-hour estimates.

Parent can review/deploy through the existing release process only when separately
authorized. The first ordinary successful due build creates the companion; a
forced rebuild or live cost probe is not required. New collection is backend-only:
check deployed IAM/rules compatibility before rollout; local supplied/candidate
rules have default-deny for unmatched collections. No rules were changed/applied.
The static snapshot pipeline still needs current daily/weekly catalog coverage
and freshness cues; this source companion is internal, not a new public endpoint.

Changed paths, all under workers/ranked:
- src/index.js
- src/overall-source-cache.js
- src/overall-source-publication.js (new)
- src/events-worker.js
- src/public-read-memory.js (new)
- test/index.test.js
- test/overall-source-cache.test.js
- test/overall-source-publication.test.js (new)
- test/event-public-memory-cost.test.js (new)
- QUOTA_AUDIT_20261021_SOURCES.md (this file)

No tools/verifier implementation, frontend, version, workflow or pre-existing
.gitignore edits. No automatic production action is authorized by these results.


## Post-Review Concurrent Replacement Fix

Read-only review reproduced a race between two ordinary cold builds in different
isolate/coalescer scopes. The winning build advanced the fixed source slots after
the loser read meta. Previously, the loser misclassified the resulting digest
mismatch as corruption, reread385 source documents in four queries, then lost CAS.
Score correctness held but the reads were avoidable.

Before any corruption-recovery scan, production now performs one budgeted fresh
meta/current read and compares its exact updateTime with the original build token.
Changed, missing, or unversioned metadata aborts with OVERALL_BUILD_SUPERSEDED.
Read/budget failures propagate without a scan or fallback. A rejected/failed guard
also skips failure-bookkeeping rereads, cooldown writes, and bundle invalidation
on potentially newer state. Existing final CAS protections remain unchanged.
Unchanged metadata still permits exactly one normal budgeted corruption scan.
The new read is counted as sourceRequests.recoveryReads and by the existing
Firestore document audit. Healthy24-hour models above are unchanged.

The deterministic regression advances a mocked clock and commits an ordinary
competing build inside the loser's companion-read hook. No timing sleeps or live
requests are involved. After the winner, the loser performs only its companion
read and one metadata guard; zero source queries/authority reads/commits follow,
and all winning documents remain unchanged. Additional cases cover metadata
advancement, deletion, missing updateTime, original read-error propagation, and
successful true-corruption recovery with the unchanged token.

Offline focused suite:55/55 passed (overall-source-cache, overall-source-publication,
overall-cooldown-cost). Full Worker suite:472/472 passed, versus parent's pre-fix466.
Six new regressions. Both changed source files passed syntax checks; scoped
whitespace checks passed. No production access, deployment or commit.

Follow-up changed only src/index.js, src/overall-source-cache.js,
test/overall-source-cache.test.js, and this note. Authorized sibling edits were
preserved. Source companion/memory format and event code were not changed by
this follow-up.
