# Ranked Quota Audit

Base: `a84b328b30727fb6386763c12b7418a2a303e485`, revision168.
Local code and offline fixtures only. No production queries, deployment, remote
jobs, credentials inspection, native verification, or snapshot publication were
performed by this Worker task. Other agents own the client, snapshot packaging,
private comparison ledger and verifier entry point. This task also owns the
event verifier coordinator, its discovery helper and the explicitly delegated
public snapshot backup legacy-reuse/admin-capture follow-up.

## Existing Fixes Preserved

Revision168 reuses the finite-total publication checkpoint for Rolling Hills-only
updates, avoids finite scans while the rolling source is unavailable, recovers
missing staged parts, and fences finite/live revisions before publication. These
regression tests still pass. The parent confirmed PB `maxAttempts:1` is already in
revision168; the five-retry log belongs to revision167, not the current code.

## Likely Amplifiers And Bounds

These are code-derived request models, not attribution of the reported 50,000
reads or 7,000 writes. A Firestore HTTP batch can contain many billed documents.
Rules-dependent reads, index-entry charges, failed attempts, multiple regions,
cache eviction and traffic volume prevent these models from being global quotas.

| Path | Prior exposure | Change |
| --- | --- | --- |
| Overall build with incomplete/missing source catalog | `catalogScanDue` bypassed the successful-build cooldown. A five-minute cron could attempt 288 builds/day, each scanning up to 500 source boards plus overflow detection, pages and one entitlement document per computed racer. | Enforce the 30-minute cooldown for invalid catalogs. An exhausted unchanged incomplete revision waits six hours. Dirty revisions, metric upgrades, forced repair and a valid catalog's six-hour reconciliation remain supported. |
| Public ranked board root | 60-second cache. Under sustained demand, one read/key/edge/origin approximately 1,440/day. | 300 seconds, approximately 288/day under the same retained-cache assumptions. |
| Public immutable ranked page | Manifest plus page reread every 60 seconds, approximately 2,880 reads/day/key. | 24-hour immutable caching, approximately 2/day/key if retained. Generation changes use distinct keys. |
| Live event board | Three distinct documents per cold transaction, 15-second cache, approximately 17,280 reads/day/key under sustained demand. | 60 seconds, approximately 4,320/day/key. |
| Published totals / Rolling Hills | 20-second cache; about 4,320 loads/day/key. Rolling Hills may also load paged entries. | 120 seconds; about 720 loads/day/key. |
| Event catalog | 120-second cache, about 720 loads/day/key. | 300 seconds, about 288 loads/day/key. |
| Verified and pending event recordings | No shared public response cache; repeated requests repeat the transaction reads. | Normalized 60-second cache keys and existing single-flight/cold-fill admission. |
| Historical event GETs | Archived board, replay, track and monthly routes could read Firestore on cold requests. | Pre-database `410 event_archive_static_only`, including pages, receipts and status. No auth, rate-limit or cache lookup is needed for this refusal. |
| Verifier event intake | The local drain reserved four native event slots but allowed sixteen receipt admissions first. Each admission can perform two transactions. | Intake is capped at the smaller of requested intake and native allowance: at most four in that drain round. Existing queued jobs can still fill all four slots. |
| Verifier event discovery | After intake, queue discovery reread the inbox cursor and queried inbox/retries even though those results were unused. It could discover work without enough allowance to lease it. | Queue-only post-intake discovery saves two or three calls/reads. Fewer than 160 remaining HTTP slots causes no discovery: reserve 24 for discovery plus 136 for a batch/findings. The standalone due gate still checks receipts/retries. |
| Legacy frozen snapshot reuse | Requiring `complete:true` refetched legacy archives that never contained that field. Parent observed 45 such archives in snapshot42. | Validate immutable legacy data using exact integer racer count, row identity/time validity and any declared totals. No completeness fields are manufactured. Each qualifying saved archive avoids one Worker snapshot fetch per capture; cold Firestore savings depend on cache state. |
| One persistently blocked publication source | Two coordinator turns per five minutes could write the same cursor 576 times/day. | No unchanged cursor transaction/write after its first normalization; source availability is still checked each turn. One duplicate totals-root read per active combined turn is also removed. |
| Direct public Firestore access | Public profile/result collection scans and owner receipt fallbacks remain possible in the prior candidate. | Candidate preserves keyed profile/result gets, denies their list/query operations, and closes direct event inbox/receipt gets. Direct board/archive reads were already closed in this candidate. |

The every-minute event schedule is not changed. On a quiet steady-state day its
provisioning, empty inbox/retry queries, publication signals and cleanup checks
still cost several thousand reads. Overall rebuilds still read all computed racer
entitlements; a changed source bundle avoids unchanged board reads but does not
make these per-racer reads free. These remain important residual costs.

The existing scheduled verifier has a bounded due gate and serialized execution.
The daily snapshot workflow does one main capture per day plus the weekly catalog
capture. No workflows were changed or dispatched, as requested.

## Archive Contract And Rollout Gates

The Worker does not serve a static artifact itself. `410` explicitly tells the
client to use its published snapshot; it must not retry Firestore on a missing
archive. The guard runs before even an old live-cache hit and uses the provisioners'
UTC daily/weekly IDs and Kodub end-time IDs, including their 24-hour settlement
window. Permanent Rolling Hills remains live. Unknown/custom IDs fail closed;
supporting a new live ID format requires a reviewed policy update.

Before deploying:

1. Coordinate the parent's client static-only handling with the Worker `410`
   contract. An absent archive must remain visibly unavailable, not silently fetch
   Firestore. Fresh public boards may now lag five minutes.
2. Ensure finalized static archives, replay assets and Kodub track assets exist.
   NEW or missing archives need the explicit operator export described below,
   followed by the parent's validated static publication process. The public
   capture script must NOT fall back to live historical reads. Deploy the new
   export route together with the guard, and use the explicit finite capture
   adapter described below. Internal settlement, verification, cleanup and
   explicitly authenticated operator exports can still read historical records;
   the zero-read guarantee is for public historical HTTP GET routing.
3. Deploy the Worker through the parent's normal reviewed release process. No
   secrets, bindings, cron schedules or schema migrations are added here.
4. Review and emulator-test `docs/security/quota-20261018/backend-only-public.rules`
   before applying it separately. It is only a candidate, not verified deployed
   state. Existing clients that query profile/results collections or fall back to
   direct inbox/receipt reads must use keyed/static/Worker paths instead.
5. The current `--full-public` exporter uses an unauthenticated profile query.
   It will be denied by this candidate. Capture any authorized full-profile
   baseline first, or adapt a separate trusted export path before rules rollout.
   `--refresh-replays` uses bounded keyed reads rather than that profile scan.
6. Compare request/scheduled read estimates and successful-write estimates by
   collection against actual billing after rollout. Logs are sampled and the read
   estimate is explicitly not a billing meter. There is no promise of never
   reaching quota.

## Local Operations And Authentication

The latest instruction forbids GitHub workflow dispatch. None was used.

Existing Worker admin endpoints are POST `/v1/admin/rebuild`,
`/v1/admin/reconcile`, `/v1/admin/migrate`, and
`/v1/admin/migrate-extra-queues`. All require a permitted `Origin` and
`X-Admin-Token` equal to `ADMIN_REBUILD_TOKEN`. Rebuild forces overall publication;
reconcile bootstraps queues, processes canonical changes and requests a nonforced
overall build. None runs native verification, exports credentials, mints a scoped
local token, or exposes event-capacity publication as an admin route.

### Explicit Admin Archive Export

The new, not-yet-deployed route is GET-only under
`/v1/events/admin/archive-export`. It requires an allowed `Origin` and
`X-Admin-Token` equal to the existing `ADMIN_REBUILD_TOKEN`. It does not mint
credentials or verify pending runs. It uses the existing event rate limiter with
one dedicated export key; its configured 60/minute allowance is not a global
daily quota. Responses, including errors, are `private, no-store`.

| Suffix | Successful keyed document reads in fixtures |
| --- | --- |
| `/{periodId}/snapshot` | 1 frozen history root |
| `/{periodId}/snapshot/page?generation={64hex}&page={0..99}` | 3: frozen root, manifest, page |
| `/{periodId}/replays/{accountId64hex}` | 4 in archived-proof fixture; up to 5 if existing proof path needs PB state |
| `/{periodId}/track` | 2: frozen root and archived track |
| `/archives/{YYYYMM}` | 1 month index |

Each request has a hard six-document limit and an exact resource allowlist.
There are no queries, batch reads, transactions, commits or Firestore writes.
Boards must already be frozen and past settlement. Pages must match the frozen
generation. Replay and track export preserve existing proof/hash checks.
Only public fields are returned. A missing/unfinalized resource fails closed
instead of reading a live board or invoking verification. Unknown/bulk/private
selectors fail before database access. The `X-Archive-Document-Reads` response
header counts keyed calls, including missing documents, not billed usage.

Example handoff only, NOT executed here. `$AdminToken` must already be securely
loaded without printing it or placing its value on a command line:

```powershell
Invoke-RestMethod -Method Get -Uri "$WorkerBase/v1/events/admin/archive-export/$PeriodId/snapshot" -Headers @{Origin='https://staticquasar931.github.io';'X-Admin-Token'=$AdminToken}
```

The implemented `createAdminArchiveCaptureFetch` adapter names finite period
selectors and rewrites only their snapshot/page/replay/track GETs. It adds the
token only on that dedicated namespace, rejects other hosts, sets redirect mode
to `error`, requires the six-read response accounting header, and never falls
back through public URLs. `maxRequests` is mandatory-bounded to 1..120, defaults
to 16, and therefore bounds admin keyed reads to at most 6 times that value.
These are additional admin-specific ceilings, not a cap on all ordinary public
capture calls. The wrapper's aggregate request/document counters contain no token.

`runPublicSnapshotBackup` accepts explicit
`archiveExport: {token, periodIds, maxRequests}`. The existing packaging API already
forwards `captureOptions`, so no entry-point change or new CLI flag is required:

```javascript
await updatePublicSnapshot({
  captureOptions: {
    archiveExport: {
      token: process.env.POLYTRACK_ARCHIVE_EXPORT_ADMIN_TOKEN,
      periodIds: ['d_20260913'],
      maxRequests: 16
    }
  }
});
```

This is an operational handoff, NOT executed here. Parent must choose the exact
periods and supply the token securely in memory/environment. Capture still
reuses validated local archives first. The option is off by default; neither a
token file nor environment variable is automatically read by the capture code.
No workflow acquires admin access. Defer/budget failures preserve previous
backups and stop packaging through the existing deferred-capture contract.

Supplying an admin token to a normal public archive URL still returns `410` with
zero Firestore calls. No automatic/background backfill or publication was run.

### Legacy Archive Reuse

`isReusableArchivedEventBackup` first applies the existing public event validator.
It rejects explicit incomplete source/board markers, pending publication,
inconsistent stated totals and invalid or unassembled pagination. Modern
explicitly complete archives remain reusable. Legacy archives lacking `complete`
also require a valid period, exact nonnegative integer `racerCount ===
entries.length`, a valid entrant limit if present, unique valid account IDs and
valid event times. A legacy archive exactly at the 200-entry limit is reusable
only with that exact racer-count evidence. Missing count evidence is not inferred.
The helper does not add `complete` or `totalEntries`, and publication-pending
metadata is preserved in saved public projections to prevent accidental freezing
on the next capture.

### Local Verifier

The existing native queue runner needs `FIREBASE_VERIFIER_SERVICE_ACCOUNT` JSON,
with `project_id: polytrack-052`, `client_email` and an RSA `private_key` authorized
for the required Firestore operations. The Worker admin token is not a substitute.
No credential search or token contents were accessed. Do not put secrets in logs
or command-line arguments.

Commands below were derived by reading the local tools, not executed here.
Use the existing private report path to reuse the snapshot comparison ledger:

```powershell
node tools/verifier/snapshot-audit.mjs --report $PrivateAuditReport --max-jobs 64 --max-batches 8
```

`$PrivateAuditReport` must be the SAME existing private absolute JSON report path,
not a new report on every pass. Its checkpoint is bound to snapshot and engine;
it refuses mismatches. This offline audit can flag replay/name concerns but is not
current pending-queue discovery, proof of cheating, or canonical publication.

Offline engine check and snapshot repackaging:

```powershell
node --input-type=module -e "import {validateEnginePin} from './tools/verifier/run.mjs'; await validateEnginePin();"
node tools/update-public-snapshot.mjs --offline
```

The second command repackages existing local data and does not refresh production
state. Do not combine `--offline` with `--refresh-replays` or `--full-public` if zero
network reads are intended: the exporter still runs for either extra flag.

The parent subsequently found an existing project-matching service credential
and completed a local drain. Do not run another live drain until these quota
changes are reviewed. For a later explicitly approved run, the supported runner
is:

```powershell
node tools/verifier/run.mjs --drain
```

It writes verification results, is NOT read-only, and currently caps one invocation
at four rounds, 64 native attempts, and 400 Firestore HTTP requests. It can stop
earlier. It does not guarantee all pending work is finished. `--catch-up` is
restricted in code to manually dispatched GitHub workflows; do not spoof that
environment to bypass the check. The runner has no offline snapshot flag.

If live snapshot capture is separately approved, the efficient incremental command
is `node tools/update-public-snapshot.mjs --refresh-replays`: it captures published
boards and fetches at most 100 changed/missing normal replay documents, preserving
the private retry ledger in staging. It reads production and writes local files;
it does not itself verify pending runs or force publication. Parent owns that code
and the archived recheck policy.

## Completed Drain Interpretation

Parent-reported output: three rounds, 13 normal processed, four event checked,
nine verified, four unavailable, 26 normal queue documents returned, 364 HTTP
requests and 186 seconds; stopped at `request_reserve`. First round reported nine
event receipts consumed despite only four event native slots. These observations
are not a production trace collected by this task.

`firestoreRequests` is cumulative HTTP calls, not reads or writes. A document GET
is one call, a transaction start/commit/rollback is another, and a commit can
contain many writes. `normalQueueReturnedDocuments` excludes event intake,
canonical checks, audit documents and empty-query minimum charges. The normal
selection queries are bounded; the event verifier does not scan public board
pages. Receipt admission plus checkpointing uses two multi-document transactions,
and each event verdict has a separate proof-fenced completion transaction.
Therefore the 294/364 totals cannot be equated with leaderboard scans or
reconstructed exactly from the summary alone.

The event changes bound future admission to native allowance, eliminate unused
inbox discovery, and avoid discovery when completion cannot fit. Admission
reserves are not billing limits or guarantees against read retries exhausting
the hard HTTP budget. They do not remove canonical state rereads after native
execution or publication proof fences. `runner.mjs` already caches selected queue
preimages and reconciliation state, uses bounded conflict retries and rereads
canonical state for safe publication; no speculative cache weakening was made.

Parent-owned follow-up: the runner's infrastructure-stop pattern did not match
`startupwall_deadline` during this audit. Review that stop condition before
another live drain so a native startup infrastructure failure cannot merely
continue into another expensive round.

## Verification And Changed Paths

Offline syntax check: `node --check workers/ranked/src/index.js`.
Full Worker suite: `node --test --test-concurrency=2 workers/ranked/test/*.test.js`.
Result: 441 tests passed, zero failures. Verifier regression selection:
`node --test --test-concurrency=2 tools/verifier/events.test.mjs tools/verifier/firestore.test.mjs tools/verifier/runner.test.mjs tools/verifier/runner-shards.test.mjs tools/verifier/run.test.mjs tools/verifier/throughput.test.mjs`
passed 98 tests, zero failures. Targeted archive/coordinator/discovery run passed
114 tests (overlapping the larger suites). Snapshot backup, packaging, page
assembly and quota-recovery selection passed 57 tests, including 34 snapshot
backup tests. `git diff --check` passed. An offline
esbuild Worker bundle passed with one existing duplicate-key warning in unchanged
`public-name-policy.js`; no Wrangler deployment command was run.
The suite covers cutoff boundaries, historical cache bypass, zero storage/auth
calls for archives, live receipts and replay contracts, delayed incomplete
rebuilds, forced recovery, immutable-page expiry/generation isolation, cursor
no-op writes, revision168 publication races and candidate rule structure. New
tests prove GET-only explicit admin export auth/origin/rate admission, sanitized
public responses, private/no-store handling, frozen generation binding, exact
keyed read counts, anonymous zero-read `410`, capped intake, no under-budget
discovery, preserved standalone due detection and transactional conflict recovery.

Rule emulator decisions are NOT tested: the local rules emulator dependencies are
not installed. Structural tests do not replace emulator validation.

Changed implementation:

- `workers/ranked/src/event-read-policy.js`
- `workers/ranked/src/event-archive-export.js`
- `workers/ranked/src/events-worker.js`
- `workers/ranked/src/events-runtime.js`
- `workers/ranked/src/event-publication.js`
- `workers/ranked/src/index.js`
- `docs/security/quota-20261018/backend-only-public.rules`
- `tools/verifier/events.mjs`
- `tools/public-snapshot-backup.mjs`

Changed tests and report:

- `workers/ranked/test/event-read-policy.test.js`
- `workers/ranked/test/event-archive-export.test.js`
- `workers/ranked/test/events.test.js`
- `workers/ranked/test/overall-cooldown-cost.test.js`
- `workers/ranked/test/quota-rules-candidate.test.js`
- `workers/ranked/test/status-cache.test.js`
- `workers/ranked/test/event-capacity.test.js`
- `workers/ranked/test/events-routes.test.js`
- `workers/ranked/QUOTA_AUDIT_20261020.md`
- `tools/verifier/events.test.mjs`
- `tools/public-snapshot-backup.test.mjs`

Untracked `.gitignore` and other agents' changes are preserved. No commit was made.
