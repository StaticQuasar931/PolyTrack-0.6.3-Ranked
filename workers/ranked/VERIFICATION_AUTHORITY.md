# Worker Scheduler Verification Authority

## Dormant String Contract

Only the exact primitive string `VERIFICATION_AUTHORITY='snapshot-native'` disables
scheduler-selected `bootstrapSnapshotVerification`. Missing, `firestore`, empty,
unrecognized, differently cased, and whitespace-padded values retain legacy behavior.
This setting is trusted Worker environment configuration, not a request parameter.
No Worker configuration, secret, production authority, or deployment was changed.
Parent must obtain approval before activation.

The gate applies when constructing automatic reconciliation tasks. It works both
inside coordinated capture windows and in non-coordinated forks. Capture-only read
routing is independent and unchanged. Existing coordinated canonical continuation
wakes outside capture windows remain enabled.

## What Changes

Scheduled snapshot-to-legacy-proof-queue bootstrap is not called. Consequently it
performs no bootstrap job lookups, track-bootstrap queries, snapshot-page expansion,
legacy slot seeding, or bootstrap cursor writes. Existing proof queues and bootstrap
checkpoints are retained, not deleted or rewritten by the gate. Returning to legacy
configuration can resume the existing bootstrap checkpoint.

## What Does Not Change

- Canonical PB discovery, dirty-result queues, continuation, and normal publication.
- Exact current private proof checks, matching review holds, replay integrity,
  account ownership admission, current CAS, and retry after publication conflicts.
- Explicit authenticated admin repair. `/v1/admin/reconcile` still runs bootstrap;
  its existing admin token check remains required even in snapshot-native mode.
- Other scheduler lanes, queue migrations, event maintenance, Overall, and source
  audits. The release294 immutable-page source fix is frozen and untouched here.
- Snapshot-native verifier runners, Firebase backwrites by external tools, and the
  parent-owned legacy four-times-daily drain. This Worker gate does not stop those
  processes and does not establish a complete no-Firebase-backwrites policy.

In particular, canonical PB reconciliation still reads current proofs and can
create the existing pending slot for a newly discovered canonical PB. This gate
must not be represented as disabling every proof-queue write or all Firestore work.
It suppresses automatic snapshot-based legacy seeding only.

## Complete Reconciliation-Lane Cost Comparison

Offline real `worker.scheduled` entry point, capture-only reads, coordinated mode,
100 existing unpaged track snapshots, one existing current private proof queue,
and a previously absent bootstrap checkpoint. A new canonical PB and a matching
current review hold are discovered together on the first eligible scan. Atomic
Firestore double enforces every CAS and forbids deletes. Network is forbidden.

Every day includes all 288 five-minute reconciliation wakes, including the 256
outside-window continuations and all 32 in-window discovery queries. Thus bootstrap
and subsequent reconciliation costs are included, not just the selected task.
This is the complete reconciliation lane, not every cron lane or a billing export.

| First Day | Reads | Writes | Bootstrap Queries | Bootstrap Job Reads | Discovery Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unset | 557 | 130 | 26 | 32 | 32 |
| firestore | 557 | 130 | 26 | 32 | 32 |
| snapshot-native | 324 | 4 | 0 | 0 | 32 |

First-day reduction: 233 reads and 126 writes. Removed reads are 32 bootstrap job
lookups, 100 track documents plus one empty-query minimum, and 100 private queues.
Removed writes are 100 queue seeds and 26 bootstrap checkpoints. The four remaining
writes are the new-PB pending proof slot, track publication, Overall metadata
invalidation, and durable reconciliation checkpoint. They are not hidden or deferred.

A second full, clean day on the same state is measured separately:

| Steady Day | Reads | Writes | Bootstrap Queries | Bootstrap Job Reads | Discovery Queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unset | 352 | 0 | 0 | 32 | 32 |
| firestore | 352 | 0 | 0 | 32 | 32 |
| snapshot-native | 320 | 0 | 0 | 0 | 32 |

Steady-day saving is 32 metadata reads, not another 233 reads / 126 writes.
The remaining 320 reads are 288 reconciliation-job reads and 32 empty discovery
minimum reads. No automatic bootstrap costs reappear on this follow-up day.

The separately reported legacy runner cost of approximately 1,500 reads / 1,000
writes per drain, four times daily, is not measured or removed by this patch.
Stopping that runner belongs to the parent-owned authority/config change after
approval. Do not attribute its possible 6,000R / 4,000W daily saving to this gate.
Necessary reconstruction is still nonzero: the existing independent 1,136-row full
rebuild fixture remains 3,472 reads / 41 writes with exact proof work. No six-hour
canonical/proof scan or entitlement validation was weakened to manufacture savings.

## Tests and Evidence

`test/verification-authority-scheduler.test.js` covers both authority modes plus
unset legacy behavior over cold and steady full days; strict flag matching;
non-coordinated forks; capture-only configuration; new PB publication; stale snapshot
approval overridden by a matching current review hold; pending-slot exact binding;
publication CAS conflict with durable retry; explicit admin repair; and ownership.
Read/write counters are also checked against the Worker's own scheduled audit logs.

Validation: 10 targeted scheduler tests passed; the complete Worker suite passed
1,153 tests with zero failures. Scoped git diff --check passed.
Run `npm --prefix workers/ranked run check` for the full Worker suite.

Private evidence:
`C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-05/cloud-readiness-294/verification-authority-scheduler.log`
and `worker-check-authority.log` in the same directory.

No production calls, deployment, queue deletion, configuration changes, commits,
IAM changes, new services, or edits to parent-owned runner/night/workflow code.
