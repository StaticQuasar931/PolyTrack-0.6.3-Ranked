# Release294 Retained Adaptive64 Handoff

## Final Decision and Activation

Conservative adaptive64 is retained behind the exact internal string
CANONICAL_DISCOVERY_BACKPRESSURE='enabled'. An absent/unrecognized value still uses
legacy discovery and 16-ID targets. The worker agent changed no configuration;
the parent's edit of only this internal flag is expected and separately owned.
Local signer, native verification authority, cadence, caps, deployment, commit,
and push were not changed by this work.

This supersedes the earlier rejected-candidate decision. Both quotas matter, but
read pressure is the reported bottleneck. Adaptive64 is explicitly NOT write-neutral.

## Publishable Whole-Burst Comparison

Same 1,136-row paged base, 410 canonical PB improvements, 190 already accepted keyed
IDs, 220 discoveries, current competitive review hold, exact fresh proof checks,
final public generation, queue discharge, and three clean follow-ups:

| Variant | Reads | Writes | Requests | Passes | Maximum Requests Per Pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original / missing flag | 7,270 | 504 | 239 | 15 | 22 |
| Historical fixed-16 backpressure | 1,473 | 825 | 318 | 26 | 12 |
| Historical private adaptive32 | 1,293 | 649 | 186 | 15 | 12 |
| Retained guarded adaptive64 | 1,176 | 537 | 126 | 8 | 16 |

Retained64 avoids 6,094 reads and adds 33 writes per measured 410-update fixture.
It performs zero full canonical/historical-proof scans rather than two 1,136-row
reconstructions. All 410 current proof reads remain. All exact updated time/upload/
replay bindings publish; the matching hold and 726 unaffected verified racers remain.

Requests are 126, not the earlier prototype's 108: canonical fetches are now split
into 16-ID chunks to limit transient payload retention. The extra requests do not
add document reads or writes and remain within the existing 42-work / 45-total
checkpoint reserve. Three clean follow-ups add no writes.

Using only the user's comparison denominators (50,000 reads and 20,000 writes),
max(R/50000,W/20000) for this fixture drops from 0.1454 to 0.02685. This is a
normalized fixture comparison, not billing, live attribution, a daily projection,
or a claim that unrelated backend costs disappear. Native physics verification,
later proof approval, Overall/event assembly, client intake and unrelated maintenance
are not included. Both runs begin at the same durable backlog and canonical records.

## Eligibility and Conservative Fallback

Adaptive selection requires all of the following:

- Exact enabled review flag; at least 64 pending keyed IDs on the selected track.
- Exactly one selected track, no reserved full build and no mixed targeted turn.
- Standard proof collection; current exact track/schema/algorithm identity and CAS
  version; valid complete paged source with 100-row pages, 6 through 32 pages.
- Existing fully sharded proof root, migrationComplete=true, empty legacy slots,
  exact track identity and current version. Unknown or migrating roots retain 16.
- At least 21 existing work requests remaining before preflight. Limits are not raised.
- Current MAX_REPLAY_LENGTH no greater than 10000, unchanged from the original worker.
- At most 4 MiB of estimated UTF-16 JSON retention independently for discovery rows,
  expanded source entries, and missing canonical target rows.

Preflight reuses the same invocation's root, page expansion and queue preimages;
it does not introduce a cross-request authority cache or extra equivalent reads.
Current proof shards are still fetched after canonical input. Matching holds and
proof CAS remain authoritative. Actual network/read failures propagate; they are
not converted into permission to use an unverified stale source.

Canonical target fetches use existing 16-ID units. If metadata exceeds the retention
threshold, the group shrinks to its first 16 IDs, unneeded fetched references are
released and all remaining accepted IDs/bindings stay in the durable job. A capacity
cursor never passes an unaccepted suffix. Downgrade still makes progress; the tests
finish oversized-record work without livelock or a capacity-induced full rebuild.
Small boards, mixed turns, reserved builds, insufficient request headroom, unknown
schema/resources, oversized discovery/source data, and legacy migration stay at 16.
No global input, replay, staging, proof, document, or HTTP cap is increased.

The old 64 prototype could migrate unrelated legacy slots and require a 49-write
migration commit. This variant refuses adaptive64 for any nonempty/incomplete legacy
root. Existing 16-ID migration behavior and existing 48-write proof batch boundaries
remain unchanged. Fresh64 proof preparation uses existing 48/16 batches only after
the fully-sharded guard. A full build still reserves its original targeted allowance.

## Memory Sanity Under the Existing 128 MiB Worker Budget

The actual code limit is MAX_REPLAY_LENGTH=10000 UTF-16 code units, with accepted
length strictly below that limit. It is NOT 262144. No replay allowance was raised;
a future increase above 10000 automatically disables adaptive64 pending review.

At most 50 discovery rows and 64 targets coexist. The canonical map and row arrays
hold references, not deep copies of replay strings. In the pessimistic no-overlap
case, 114 * 9999 * 2 is about 2.18 MiB of replay UTF-16 content. Full integrity
hashing can concurrently encode at most 64 * 9999 * 3 UTF-8 bytes, about 1.83 MiB;
allowing a second native digest copy makes that about 3.67 MiB. Replays are never
removed or masked before integrity validation.

The byte gate uses JSON.length*2 (a conservative UTF-16 string estimate), not UTF-8
wire size or a claim to measure all object overhead. Three separate retained JSON
windows total at most 12 MiB before object/runtime overhead. A rough working-set
allowance including object/normalization copies, serializer transients, and digest
buffers is tens of MiB, approximately 30-60 MiB for the admitted path, below 128 MiB.
This is a rough envelope, not a measured live-isolate heap guarantee. Source page
loading is the existing bounded loader; no larger source expansion is introduced.
An oversized chunk uses only the pre-existing 16-document fetch size before fallback,
not a new 64-document giant response. Arbitrarily malformed upstream payloads retain
the existing failure behavior rather than obtaining a larger adaptive allowance.

The large-payload regression executes all 410 updates with distinct 9,999-unit
replays containing 9,990 Euro characters plus a 9-character suffix: 29,979 UTF-8
bytes each. It also corrupts one replay while retaining its asserted hash; that row
correctly fails integrity, while valid rows pass and the hold stays intact.
Measured complete result: 1,176R / 537W / 126 requests / eight passes, plus the same
three included follow-ups. Largest canonical fetch is 16 IDs; largest observed wire
JSON is 1,394,411 characters; concurrent digest input peaks at 1,918,656 bytes.
The test observes encoded buffers, not total process RSS, and makes no live heap claim.

## Tests, Scanner and Freeze

Twenty-four focused adaptive/backpressure tests passed, covering complete default/
enabled bursts, exact flag matching, cursor/capacity, concurrent binding CAS, review
holds, small/migrating/mixed/reserved/budget-limited fallbacks, source/discovery byte
gates, canonical byte downgrade, no livelock, hard 42-request exhaustion and recovery,
and full near-limit replay hashing. Existing suites cover proof/page/meta CAS and
ownership. Full-suite count is recorded after the final freeze in private evidence.

The synthetic admin fixture now uses the same offline-fixture-only variable token
pattern as existing tests. No real secret was added. tools/release-check.mjs was NOT
modified. The unchanged local release checker passed after the fixture replacement.

Worker source/tests/docs are frozen before the final suite. Only final tests and
private evidence may finish afterward; parent configuration edits remain expected.

Private evidence directory:
C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-05/cloud-readiness-294

- retained64-tests.log: 24 focused tests and exact large-replay resource/cost counters.
- release-check-retained64.log: unchanged local release checker passed.
- worker-check-retained64-final.log: complete Worker suite after final source freeze.
- retained64-final-freeze-hashes.json: source/test/doc freeze hashes.
- retained64-results.json: final machine-readable costs, test outcome and freeze result.

Earlier adaptive-32/64 experiment logs remain available as historical evidence.
