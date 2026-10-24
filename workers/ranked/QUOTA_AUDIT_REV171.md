# Revision171 Worker Quota Audit

## Parent Rollout Confirmation

After this scoped audit, the user authorized deployment. The parent deployed the
combined Worker fixes on 2026-10-21 UTC after 449/449 Worker tests passed. Active
version `82caba01-a754-4a8b-a423-5c13614f0dcf` was confirmed at 100 percent traffic.
The previous latest deployment was 2026-10-17T20:35:33.83712Z, version
`25925641-02ee-4e7e-88a8-70b684983b42`. A public allowed-origin OPTIONS check
returned 204 without accessing Firebase. The local-only statements below describe
the scoped agent audit, not the later parent rollout. No Firebase rules were deployed.

Base: ae30fad1 (revision170). Local changes only. No deployment, rules apply,
workflow dispatch, production data query, service-account use, live verification,
or snapshot recapture was performed. Expected shared client edits and the
untracked .gitignore were preserved.

## Pinned Firebase Compat Finding

Inspected the official public artifact:
https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js

SHA-256: 25133ac64bef210c19384ed72eafdec440c27c02a6b48e9d2b6b48bf7b00ad04.

The compat implementation is:
`runTransaction(t){return Lh(this._delegate,e=>t(new Gh(this,e)))}`.
It ignores the caller's second argument. The internal default is
`const Nh={maxAttempts:5}`. Therefore compat calls with `{maxAttempts:1}`
still use five attempts.

The internal retry classifier begins
`if("FirebaseError"!==e.name)return!1`. It retries aborted, failed-precondition,
already-exists, and errors classified as nonpermanent. Resource-exhausted is
nonpermanent. This is a string-name check, not instanceof.

An offline extraction test ran the actual artifact's compat forwarding method,
transaction runner, and permanent-error classifier with an in-memory scheduler:

| Failure | Callback attempts |
| --- | ---: |
| FirebaseError/resource-exhausted, default options | 5 |
| FirebaseError/resource-exhausted, internal maxAttempts 1 | 1 |
| Ordinary Error with resource-exhausted code, default options | 1 |

Parent's proposed callback wrapper is appropriate for the observed BatchGet
failure: create an ordinary Error, explicitly preserve code and cause, and retain
quota handling. Do not copy the original name or blindly Object.assign the error.
Wrap inside the transaction callback, not only around runTransaction. This does
NOT cap commit-side retries, because commits happen after the callback returns.
Preserve transaction atomicity and existing contention behavior outside the
targeted callback failure. A supported modular migration is an alternative only
with tested same-SDK interop; do not use private _delegate internals or rewrite
transactions with REST. No client code was changed by this task.

Local reproducible evidence is in
`C:/Users/Static/Documents/Codexstorage/ranked-quota-171/check-firebase-compat.cjs`.
The five HTTP attempts do not by themselves prove five billed document reads.

## Implemented Worker Changes

- Event intake records processedAt in its EXISTING guarded scan-cursor write.
  No extra write or heartbeat is introduced. Non-guaranteed intake slots read
  that one cursor, but skip the inbox and retry queries after five idle minutes.
- Phase3 of each five-minute window always polls. Missing, old, malformed or
  future activity hints cannot suppress that poll. Successful processing of an
  old receipt records current processing time and wakes the other intake slots.
- Existing fresh-admission throughput remains up to four bounded intake slots
  per five-minute window, subject to cleanup/publication priority. Idle discovery
  may take five minutes. Retry-only backlogs without recent normal intake also
  rely on the five-minute unconditional poll. Standalone verifier intake does
  not opt into this Worker gate.
- Provisioning probes existing daily/weekly/Kodub periods every fifteen minutes
  instead of five. Other provisioning slots exit before any I/O. One regular
  period per invocation and verified-target requirements are unchanged. At a
  weekly rollover the second missing regular period can wait until the next
  fifteen-minute provision slot; unavailable targets retry at that cadence.
- Cleanup remains one bounded page per five minutes, preserving retention
  throughput. Publication still checks its durable pending signal twice per
  five minutes. Invalid maintenance timestamps fail closed before storage access.
- Profile maintenance requests one active job instead of reading five and
  discarding four. It still processes at most one job, with the same selection.
- Scheduled diagnostics include scheduledTime and
  quotaPolicy=rev171-event-activity, alongside existing read/write estimates.

## Measured Offline Baselines

These are document-read estimates including empty-query minimums, NOT billing
metrics or daily guarantees. Fixtures have existing daily/weekly/Kodub periods,
no admissions/retries/publication/cleanup work, completed migrations/bootstrap,
and a clean overall source catalog. Overall rescans/builds are measured separately
from this fixed polling overhead. Kodub is a non-soft-target fixture.

| Quiet work, 24 hours | Before this patch | After |
| --- | ---: | ---: |
| Daily/weekly/Kodub existing-period probes | 864 | 288 |
| Cleanup catalog checks | 288 | 288 |
| Publication signal checks | 576 | 576 |
| Intake cursor plus empty inbox/retry checks | 3456 | 1728 |
| Event subtotal | 5184 | 2880 |
| Other scheduled polling | 1440 | 1440 |
| Worker polling baseline | 6624 | 4320 |

The new code's two 24-hour fixture tests measure 2880 and 1440 directly. The
before column follows the prior source's schedule. Both new fixtures write zero
documents. Event HTTP calls are 3072: 96 read-only transactions add begin/commit
calls, not document writes. Kodub metadata HTTP fetches fall from 288 to 96/day.
An already-claimed soft target adds one keyed read per provisioning invocation.
Active profile queues save up to four discarded job reads per maintenance turn,
at most 384/day at the existing fifteen-minute profile-job cadence.

The 4320 baseline is about 90 reads per half hour, excluding active work. It does
not explain the user's 5000 reads/559 writes per half hour. No production graph
attribution is made without collection-level measurements.

## Remaining Amplification And Workflow Review

- The earlier undeployed incomplete-overall cooldown fix remains essential.
  Before that fix, an incomplete catalog could trigger 288 builds/day. Each
  build can read up to 500 board roots plus overflow checks, immutable pages,
  the prior overall publication, and one authoritative entitlement per racer.
  The prior fix bounds ordinary successful retries to thirty minutes, and
  exhausted unchanged incomplete revisions to six hours; forced repair differs.
- A real overall rebuild still reads N racer entitlements even with a warm
  source bundle. Unchanged entitlements already avoid writes using stable
  comparison. Their serverIssued achievements include computed casual RP, so
  changed placement/weight metrics can rewrite many entitlements even when
  visible cosmetic choices are unchanged. These are plausible write sources,
  not measured attribution. Removing those fields requires a coordinated
  entitlement/client contract change, not an unsafe stale-authority cache.
- Clean six-hour authoritative scans still cost root/page/racer reads and
  publication writes. The 4320 baseline excludes these, new periods, all public
  cache misses, active ingestion, migration/repair and verification work.
- The GitHub verifier already has a fifteen-minute due gate, projected one-doc
  scheduled samples per normal lane, and skips event discovery if normal work
  is due. An empty normal gate costs two minimum reads. With no normal work,
  event discovery adds catalog + at most16 queue docs + cursor + two empty
  queries: up to22 estimated reads per check, or2112/day at96 checks. Actual
  processing adds its own bounded costs. Public snapshots are not reliable
  negative evidence for private pending work, so no snapshot-only due gate was
  introduced and no workflow was dispatched.
- Snapshot workflows already hydrate saved captures and cache sanitized private
  retry evidence. Legacy validated frozen archives are reusable in revision170.
  Parent owns further snapshot/UI changes. No snapshot tools or workflows were
  edited here; no broad archive or canonical scan was run.
- Existing historical public GET410 guards and explicit bounded admin archive
  export remain unchanged. Public archive requests still must not fall back to
  Firebase. A missing static export is an operational backfill issue, not grounds
  to reopen anonymous historical reads.

## Deployment Evidence And Rollout

Read-only `wrangler deployments list --json` could not authenticate in this
execution context. No login, temporary deployment, token search, or credential
changes were attempted. A bounded local-log inspection found a successful
deployment recorded in wrangler-2026-10-17_20-35-35_854.log:
`25925641-02ee-4e7e-88a8-70b684983b42`.
This is historical evidence, not confirmation of the currently deployed version
or its source SHA. Parent states prior169 Worker fixes were not deployed.

Parent rollout requirements:

1. Review and deploy the combined prior fixes plus these Worker changes through
   the existing authorized release process. Nothing here takes effect merely by
   publishing client revision171. No new secret, index, binding or cron entry is
   required. Existing minute and other Wrangler triggers remain unchanged.
2. Coordinate parent's compat callback wrapper separately; it bounds callback
   read failures only. Recheck delayed/missing archive coverage before enabling
   prior historical410 behavior. Keep admin export explicit and bounded.
3. Apply prior candidate rules only after separate review/emulator testing and
   authorization. This task changes no rules and has not applied any.
4. Confirm deployed version through an authorized control-plane check. New
   sampled scheduled logs can identify this policy and split work by phase.
   Compare document and successful-write estimates by collection with billing;
   HTTP count is not billed documents. Sampling/index/Rules reads limit accuracy.

## Offline Validation

Run from the repository root:

`node --check workers/ranked/src/index.js`

`node --test --test-concurrency=2 workers/ranked/test/*.test.js`

`node --test --test-concurrency=2 tools/verifier/events.test.mjs tools/verifier/firestore.test.mjs tools/verifier/runner.test.mjs tools/verifier/runner-shards.test.mjs tools/verifier/run.test.mjs tools/verifier/throughput.test.mjs`

The full Worker suite passed 449 tests; the selected verifier suite passed 98.
All eight new quota regressions passed, including both 24-hour cost fixtures.
Syntax and scoped git diff whitespace checks passed. Offline bundle validation
is recorded in the task handoff. No live verifier command is recommended or run
as part of this change.

Changed implementation: src/events-runtime.js, src/events-worker.js, src/index.js.
Changed/new tests: test/events-clock.test.js, test/events-scheduled-cost.test.js,
test/profile-maintenance-cost.test.js, test/scheduled-baseline-cost.test.js.
All these paths are relative to workers/ranked. This audit is the only new
documentation file. No commit was made by this task.
