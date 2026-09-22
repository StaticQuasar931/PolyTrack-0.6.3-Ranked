# PolyTrack replay verification

## What the check proves
The trusted native physics engine replays the recorded controls on the exact track and checks the exact finish time. A replay checksum alone is never a verified run. This does not prove who drove the replay, rule out tool-assisted input, or make Community Ranked cheat-proof.

Canonical PBs are never deleted by this verifier. Missing track data, unavailable compute, and resource limits leave the run waiting. Native mismatches are recorded privately for review, not treated as a cheating conviction.

## Deployment
1. Publish this directory, its lockfile, and `.github/workflows/verify-runs.yml` to the repository's default branch. Scheduled workflows do not run from a feature branch alone.
2. In GitHub: Settings > Secrets and variables > Actions > New repository secret. Name: `FIREBASE_VERIFIER_SERVICE_ACCOUNT`. Value: the complete private Firebase service-account JSON. Never put this value in a file in this repository or paste it into an issue.
3. Prefer a dedicated service account with only the Firestore data permissions the verifier requires. Protect the default branch and workflow modifications. Anyone able to change a secret-bearing trusted workflow can compromise its credentials.
4. Actions > Verify PolyTrack runs > Run workflow. Inspect its summary, then allow scheduled runs. Verify on a standard public-repository runner; do not select paid larger runners.
5. Deploy the matching Ranked Worker. Engine pins must agree. The job checks them before reading the queue.

No paid service or continuously running player PC is required by this design. GitHub scheduling is delayed/best-effort, not an instant verification promise. Public standard-runner usage is currently free; Firestore still has quotas.

## Limits and recovery
Each selection round considers at most eight due track candidates, attempts at most eight runs per selected track, and performs at most sixteen canonical lookups total. Within that bounded window, current S1 track weight and faster due runs receive priority, while hour-old tracks and least-recently-checked runs receive fairness reservations. The scheduled bounded drain may admit multiple rounds as described below. Served tracks rotate behind older work. The schedule runs every 15 minutes. Empty jobs skip installing the browser. Temporary engine failures retry after one hour without consuming a player's input-attempt counter. Missing tracks/input limits retry daily, then weekly. New PB identity or an engine-version change requeues automatically. Original bytes are required for private/custom tracks; a track hash alone is insufficient.

Replay bounds include five minutes, 10,000 input transitions, and bounded compressed/inflated bytes. Longer valid runs remain eligible for future/manual review; they are not declared illegitimate. Each simulation has independent wall/CPU deadlines and a fresh native validator.

Private Firestore collections: `0.6.2_s1_verification` (active per-track queue) and `0.6.2_s1_verification_audit` (latest verdict for each exact PB binding). Browser clients must not read/write these. The existing default-deny rules protect them. Audits retain reason, identity, time checked, engine digest and attempt count, but no replay payload.

Publication uses guarded atomic queue/audit/rebuild-job writes. The Worker checks the exact account, track, milliseconds, frame field, upload ID, replay hash and engine/version before displaying approval. School clients read server snapshots directly from Firestore; a blocked Worker never blocks PB saving.

## Operator checks
`npm ci --ignore-scripts`
`npm test`
`npx playwright install --with-deps chromium`
`node run.mjs --check`
`node run.mjs`

The last two require the private environment secret. Do not run against production during ordinary tests. Tests use synthetic data; private known-replay fixtures are intentionally excluded.

Changing engine assets requires reviewed repinning with `node pin-engine.cjs ../..`, updating the Worker digest, tests, and redeployment. Do not automatically repin in CI. LF/CRLF differences are normalized before hashing and serving. An actual Linux workflow smoke test remains required before claiming the scheduled service operational.

## Snapshot queue bootstrap
The Ranked Worker seeds existing season-one track snapshots using a separate bootstrap job keyed by bootstrap schema, verifier version and engine digest. Each invocation pages four boards by document name, reads at most four queue documents plus the bootstrap job, and atomically commits queue merges with its cursor. Completion leaves only one job read per invocation. Snapshot entries are provisional bindings, never approval evidence; the runner fetches canonical replay data before verifying. Matching current-engine slots and retry state are preserved, including slots absent from a snapshot. A mismatched snapshot key requeues once per bootstrap version; the runner resolves it against current canonical data. Bootstrap schema v2 also wakes exact legacy-conversion unavailable time_limit/scan_work_limit slots without resetting attempts, but never requeues a verified matching binding. Oversized or malformed boards fail closed without advancing the page. The normal scheduled reconciliation invocation and the admin reconcile endpoint both run this bootstrap; deployment is still required to activate it.

Runner selection attempts at most eight canonical lookups per track and sixteen per round, including missing records. Selection conflicts defer only that track. Publication retries conflicts three times with fresh reads, then counts that result as deferred and continues; non-conflict failures still fail the invocation. Publication adds at most 48 further canonical reads per round (sixteen results times three attempts), additionally constrained by drain request reservations. Deferred work stays queued for a later invocation.

## Kodub weekly trusted asset
Normal queue verification offers the checked-in current weekly Kodub track only to jobs with its exact track ID. The descriptor must point to a SHA-256-named asset whose bytes match that hash; the native decoder must also confirm the expected ID and start transform. Tracks above the default part cap require an exact reviewed ID, hash, native part count, and X/Z span in `track-geometry.json`. The current La Riviera asset is reviewed at 42,781 parts and spans 607 by 588. This does not raise global limits, and a later weekly track does not inherit the exception. The weekly sync updates `events/kodub/**`, not the verifier geometry review.

## Planner bundle wire
The overall snapshot optionally includes resultBundle (base64 gzip string), resultBundleVersion: 1, and resultBundleEncoding: "gzip-base64-json-v1". Inflate using DecompressionStream('gzip') and parse JSON to obtain {resultTracks: [trackId, ...], entries: [{userId, resultData}, ...]}. Each resultData is a JSON string of [trackIndex, rank, fieldSize, weight, competition, timeMs, pbAt] tuples. The dictionary is sorted; every eligible finish for each published racer is retained losslessly. Legacy summaries remain unchanged; full temporary resultSamples arrays are stripped before Firestore serialization. No per-racer writes are added.

resultBundleComplete is true only when the entire fetched baseline is included. resultBundleStatus is complete, sidecar, size_limit, invalid_results, or compression_unavailable. On omission there is no resultBundle, no partial tuple set, and no stale prior bundle; clients must use their partial legacy fallback without claiming full coverage. The 900,000-byte guard includes the existing snapshot, bundle metadata, base64 payload, and a conservative document-name allowance. The guard does not shrink an already-large legacy snapshot.

Coverage is explicitly scoped by resultCoverage: "snapshot_boards", resultBoardCount, resultBoardLimit: 100, and resultBoardLimitReached. The existing overall query reads at most 100 boards without pagination. At 100, additional boards may exist; complete bundle coverage is NOT a claim of collection-wide completeness. Verification bootstrap itself pages beyond 100. The meta plannerBundleVersion marker requests one rebuild when introducing this wire.

Three deterministic high-entropy 200-racer/78-track fixtures measured legacy base storage estimates of 916,832-916,841 bytes, gzip payloads of 236,908-237,571 bytes, base64 payloads of 315,880-316,764 bytes, and combined estimates of 1,232,954-1,233,835 bytes. These fixtures publish the complete bundle in one main_results sidecar instead of overfilling main. Small snapshots round-trip all tuples and retain every legacy field.

## Native-gated legacy timing repair
Selection recognizes only positive integer raw frames with timeMs exactly equal to round(frames * 1000 / 60), differing from frames, and no disagreement between supplied frame fields. It simulates at raw frames while retaining the original queue key and generating an internal correction candidate. Stored candidate flags are never trusted.

Publication revalidates the original canonical/queue key, conversion, result track/replay/time binding, and pinned engine. Only a verified native result can atomically publish the corrected key, audit and rebuild job together with a canonical update of timeMs and timingVersion: 2. The canonical write uses its exact updateTime precondition and a two-field update mask, preserving all statistics, identity, replay data and timestamp precision. Unavailable or mismatch never corrects canonical data. An alternate-frame mismatch is published as unavailable with reason legacy_time_unconfirmed and nativeReason retained, never as a terminal mismatch against the untested original claim; a verified verdict is never published under the old converted-time key. Conflicts retry with fresh reads and then defer. Structured ABORTED/FAILED_PRECONDITION/ALREADY_EXISTS errors are recognized without exposing backend error messages.

The recovery cron has a tested worst-case request path of bootstrap 7 + four-track reconciliation 28 + overall rebuild 5 + cold token acquisition 1 = 41 subrequests. Compression adds no network requests. Optional maintenance remains in its separate cron invocation.


## Overflow sidecar
When the inline snapshot would reach the 900,000-byte target, packPlannerResults returns the complete bundle with status sidecar. rebuildOverall moves the bundle into 0.6.2_s1_leaderboards_overall/main_results and writes main with resultBundleLocation: "main_results", resultBundleStatus: "sidecar", and no inline bundle. The sidecar has resultBundleVersion: 1 and exactly matching sourceRevision, builtRevision, updatedAt and algorithmVersion. It is written in the SAME atomic commit as guarded main and release metadata; no extra Worker read or per-racer write is needed. A publication-version marker requests a rebuild when enabling overflow support.

Clients read main_results once only when main references it and lacks an inline bundle. Require exact equality of all four binding fields before merging resultBundle/resultBundleVersion and inflating. On missing or mismatched sidecar data, retain the partial legacy fallback and do not mix cached bundles from another snapshot. Inline refreshes remove the location; any unreferenced older sidecar is harmless and need not be fetched. The sidecar must fit the 900,000-byte target independently. An already-large legacy main may exceed the target but is never written at or above the guarded 1 MiB cap. No tuple truncation or removal of legacy summaries is used.


## Audited geometry and replay work limits
At engine digest 503903036ae715673284f6d1b2b121034a666410e5effb9521d7d60f1c4e4597 the native catalog contains 79 unique tracks. All 17 official tracks fit the unchanged 20,000-part and 2,048-span limits (official maximum: 3,392 parts). Twenty-one community tracks exceed the part cap; Winterfell has 74,711 parts. All catalog spans fit; the maximum is 1,264. Geometry uses max-minus-min in the native two-dimensional X/Z bounds, not absolute coordinates.

track-geometry.json records measured identities, canonical source hashes, part counts and spans. Only an exact engine digest, source path/hash, native track ID and geometry match can bypass the default part count. The general part cap and span cap are unchanged. Changed or unknown oversized geometry fails closed. The reviewed policy is included in the verifier fingerprint; native engine assets and engine digest are unchanged. All exceptions must be re-audited when their source or native engine changes.

Replay work counts the pinned Recording.getFrame linear lookup's actual list-element visits across simulation ticks, plus five channel-call units per tick. The old frames*(transitions+5) estimate charged transitions before their predecessors could be reached. The closed-form estimate is checked against the actual pinned lookup with instrumented arrays. Late transitions can now fit the SAME 30,000,000-work budget; expensive early scans remain deferred. No scan optimization alters input bytes, transitions, native lookup, or physics.

Time is in native 1 ms ticks (Time.time returns frames/1000), so 300,000 remains five minutes. The replay byte/decompression/transition limits, 20-second CPU budget and 45-second per-operation wall deadline are unchanged. A genuine longer run remains unavailable, not invalid. Existing queue backoffs are unchanged; these resource improvements do not reset production queues.

Offline regression suite: npm test. Explicit local/native suite after installing Chromium: npm run test:native-limits. The native suite uses only generated recordings, checks all 21 reviewed community exceptions plus 17 official tracks, the five-minute cap on the largest geometry, and a late-transition recording. It requires no service-account credentials and makes no production requests. Deadline checks remain outside Chromium and WASM. Local smoke results do not replace a Linux Actions smoke test on the deployment runner.

## Bounded adaptive throughput
The scheduled workflow now runs `node tools/verifier/run.mjs --drain`. Direct `node run.mjs` retains one-round behavior for operators and existing callers. Preflight, credentials, pinned engine, browser sandbox, per-replay resource limits, exact native finish checks, queue bindings, conflict checks, and event quotas are unchanged.

Twelve normal jobs was a scheduling allocation, not a physics limit: sixteen native jobs per round minus at least four event slots. Drain mode gives events that opportunity FIRST on every round, then lends only their unused slots to already-selected normal jobs. At most eight due track queues are considered and sixteen canonical lookups are attempted per round. One existing overall-summary document read supplies track-weight hints; missing priority metadata falls back to original age order. The next round rereads due queues, so existing served-track rotation applies. No bulk reset, extra workers, simultaneous browsers, or reduced validation is introduced.

The invocation admits at most four rounds / sixty-four total native attempts. It stops on no progress, infrastructure failure, insufficient request reserve, or insufficient estimated time. An authenticated connection and engine validation are reused across rounds. The monotonic time admission window is six minutes; admission requires the longest observed round (at least thirty seconds) plus sixty seconds finish reserve. This is an estimate, not a deadline guarantee. The workflow processing step has a hard ten-minute timeout within the unchanged fifteen-minute job timeout. GitHub's nominal fifteen-minute schedule remains best-effort; no queue completion ETA is promised.

A hard cap of four hundred Firestore HTTP requests applies to processing, including failed requests and all queries, document gets, transactions and commits. Authentication and the separate preflight are outside that counter. A new round needs at least 128 requests remaining. Intake reserves discovery and one leased event batch; event batches reserve before leasing, and normal simulation reserves fifteen requests per selected job for worst-case three-attempt publication. Deferred work remains queued. If the hard cap nevertheless interrupts a round, completed atomic writes remain valid and the drain summary labels its publication counts incomplete. No simulated approval is synthesized. `verified` in the drain summary counts only completed-round normal publications; `eventChecked` is not a count of event approvals.

The request cap is NOT a billed-document quota or a free-tier guarantee: queries can return multiple documents, commits can contain multiple writes, and other Workers/clients share project quotas. Native jobs are a maximum, not a target to fill regardless of cost. A deterministic in-memory 64-run backlog using the real selector, publisher and idle event coordinator processed 43 normal jobs in three rounds and 287 requests, left 21 waiting, and stopped at the reserve. This is a test fixture, not measured production throughput. Additional conflict retries, event work, or slow physics reduce throughput safely.

## Private diagnostics sidecar

`node tools/verifier/diagnose.mjs` is a bounded, read-only admin report. With `FIREBASE_VERIFIER_SERVICE_ACCOUNT` already set in the process environment, `node tools/verifier/diagnose.mjs --html=verifier-report.html` writes a readable local table with search. It reads at most eight pending queue documents, 64 recent normal audit records, and 32 recent event runs by default, with hard maximums of 16 queue documents, 128 audit records, and 64 event runs. Use `--track-id` for one exact queue plus track-filtered history, `--due-only` for currently due work, `--history-limit` or `--event-limit` to tune bounded history, `--summary=<path>` to explain a saved drain summary, and `--json` for parent tooling. The report joins actual run submission time, private audit checked time, event received time, and existing leaderboard snapshots to show people, runs, tracks, verified state, published place where available, wait age, and verification latency. It never reads default credential files and never emits replay data, hashes, UIDs, names, credentials, or proof payloads. HTML output stays local and is not added to GitHub job summaries, public routes, or the events UI.

The report also makes the scheduler diagnosis explicit: four event native slots are attempted first, normal selection has twelve reserved slots, and only unused event slots can be borrowed. A historical `budgetDeferred` plus `no_progress` result is identified as the old misleading stop classification; current drains use `budget_deferred` when budget exhaustion is the reason to stop.

## Restart the existing workflow after this update

This is not another migration. Do not reset queues, player data, event periods, or season scores.

1. Publish the reviewed static game and matching ranked Worker first. The verifier engine manifest and Worker digest must match.
2. Keep the old repository's verifier disabled if it still shares this database. Use only the active repository.
3. In that repository, open Settings > Secrets and variables > Actions. Confirm the secret FIREBASE_VERIFIER_SERVICE_ACCOUNT exists. Never paste it into chat or commit it.
4. In the Variables tab, set POLYTRACK_VERIFIER_ENABLED to the exact value true.
5. In Actions, select Verify PolyTrack runs and choose Enable workflow if GitHub shows that option. Then Run workflow on the repository default branch. The workflow intentionally rejects other branches.
6. Check the cheap due-work preflight and bounded drain summary. No due work may correctly skip the browser step. Pending runs keep their queue position; do not mass-reset them.
7. If engine checks fail, disable the variable and fix the matching deployment. Do not repin automatically or disable verification checks.

Scheduled runs are best-effort at minutes 7, 22, 37, and 52 each hour. Enabling the workflow does not guarantee that every pending replay finishes in one run.
