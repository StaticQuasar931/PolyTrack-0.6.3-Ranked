# Event RP server handoff

Event RP was activated after the matching client/workflow and Firestore rules were published. `EVENTS_ENABLED` is true. Local unit/adapter/coordinator tests passed; this is not a 200-player concurrency or production load-test claim. A full real-player event submission/verification smoke test remains required.

## Contract

- GET `/v1/events/catalog`: `{periods,archives,totals,updatedAt}`.
- GET `/v1/events/{id}/snapshot`: `{period,entries,archived,updatedAt}`.
- GET `/v1/events/totals`: `{entries,updatedAt}`.
- POST `/v1/events/{id}/runs`: exactly the client payload `{accountId,trackId,attemptId,timeMs,frames,replay,carStyle}`. Authentication owns accountId. No server session token. Response `{runId,status,duplicate}`.
- GET `/v1/events/{id}/receipt?accountId=...`: authenticated owner receipt or null.
- Public fallback: `0.6.2_event_public/catalog`, `totals`, `{periodId}`. Server writes only.
- School writes: `0.6.2_event_inbox/{periodId}_{accountId}`. Exactly the seven submission fields plus `periodId,ownerUid,receivedAt`. Receipt uses Firestore serverTimestamp. Strictly faster owned replacements preserve identity and require a new attemptId, with at least five seconds between receipts. No pending/status/score fields.
- Manual owner status fallback: `0.6.2_event_receipts/{periodId}_{accountId}`. Fields `ownerUid,accountId,periodId,attemptId,timeMs,status,reason,updatedAt`, optionally `eventImproved,canonicalImproved`. No receipt means awaiting intake, not verification success. Compare attemptId before displaying a verdict. Open/manual refresh only; no polling required.

Period metadata: `id,trackId,startsAt,endsAt,graceMs,maxRp,targetMs,kind,label,entrantLimit`. All dates are epoch milliseconds. Catalog periods satisfy startsAt <= server time < endsAt; archives retain the same metadata. Entries are `{accountId,name,timeMs,rp,rank}`; cumulative entries are `{accountId,name,rp,events,rank}` (top 200).

## Eligibility and score

Only explicit client event-card sessions submit runs. Server authentication proves account ownership and native replay verification proves the submitted finish, NOT recording freshness or actual UI entry. Reused recordings are not falsely rejected as timestamp-proven old recordings. Ordinary/canonical results never seed event scores.

Native frames/time values are actual game milliseconds: `timeMs === frames`. No `/60` conversion. Event RP is `min(maxRp, floor(maxRp * targetMs / timeMs))`, daily maximum 100 and weekly maximum 500. Verified per-period PB improvements update cumulative RP by difference, never stack repeated runs. Faster event runs can improve normal PBs atomically; existing faster canonical PBs are preserved.

## Calendar and target

UTC daily id `d_YYYYMMDD`; weekly id `w_YYYYMMDD` uses UTC Monday. Initial track choice matches registry insertion order and existing seeds: day % official length, (Monday * 17 + 11) % all length. All order begins Rolling Hills, then official, then remaining community tracks.

Provisioning considers at most two track snapshots per invocation, proceeding through a persisted registry offset when the initial track lacks a physics-verified target. Daily/weekly provisioning priority alternates. A target is frozen from a physics-verified leaderboard time. No verified target means no event published, not a fabricated constant. Server catalog is authoritative if fallback selection differs from the original featured track.

## Bounds and lifecycle

Reviewed configuration `event-200-v1`: **200 total entrants per period**, 2,048 admitted runs per period, 512 simultaneously queued runs, 16 MiB outstanding replay characters, 65,536 characters per replay, five-minute run maximum, five-second admission spacing, 1,536 shared verification attempts/day. The weekly entrant limit is a whole-week cap, not a concurrency cap. Catalog exposes entrantLimit. These ceilings do not guarantee service throughput; normal workload, GitHub delay and retries reduce capacity.

Verifier workflow uses a shared 16-native-job budget: normal <=12, event remainder 4..16; event batches <=4 and inbox attempts <=16. Intake alternates due retry preference and fresh receipts. Fixed-receipt rate/admission/entrant rejections are terminal with owner status. Temporary queue/replay pressure schedules private due retries while advancing the fresh scan, avoiding head-of-line blocking.

Event scoring closes after a one-day settlement grace. Public archives are immutable. Accepted queued runs remain eligible for canonical-only verification for seven more days; archived Event RP never changes. Native retry attempts <=3. Replay bodies are removed on terminal verification; canonical winning replay is retained in the ordinary PB document.

Private per-period run/queue/subject/status records are removed in batches of at most eight after the seven-day canonical drain window. Additional bounded sweeps remove non-admitted inbox/status/retry records. Private period config/archive metadata expires after 90 days only after admitted-subject cleanup AND all supplemental inbox/status/cursor/retry sweeps finish. Catalog entries are retained until those cleanup steps complete; a full catalog fails provisioning closed rather than dropping unfinished cleanup. Public standings remain permanently, with permanent public archive_YYYYMM indexes keyed by UTC end month. Each monthly index contains {month,periods,updatedAt} and is capped at120 periods (daily+weekly normally <=36). GET /v1/events/archives/YYYYMM reads the same index. Lifetime aggregate RP remains. Permanent archive storage grows over time; free-tier costs are not guaranteed forever. Transactions enforce at most 16 reads and 16 writes; full canonical+profile+event+receipt promotion is nine writes. Cleanup is separate from normal reconciliation cron work.

## Activation checklist

1. Run `npm --prefix workers/ranked run check`, verifier tests, and `node --test tools/verifier/events.test.mjs`. Run private full rules emulator tests, including owner receipts and post-event normal PB updates.
2. Deploy the compatible private rules, including owner-only receipts and server receipt inbox validation. Do not deploy an obsolete pending/status inbox contract.
3. Deploy Worker with the already populated capacity JSON and event limiter binding. Keep EVENTS_ENABLED false until rules, client and verifier source all match this contract.
4. Publish the matching client and verifier workflow. Workflow retains private credentials; no new paid or continuously local service is required by this design.
5. Explicitly enable EVENTS_ENABLED and deploy that configuration only after authorization. The independent one-minute Worker cron handles provisioning, intake and cleanup; no public period exists until a verified target is found.
6. Dispatch the existing verifier workflow if authorized; confirm seven-field direct submission, school inbox fallback, owner rejection/verification status, non-all-time event PB, one-way faster normal PB, and immutable archive behavior in the deployed environment. Local tests are not a substitute for this smoke test.

No client or API route can complete verification, provision a period, award RP, change a target, or edit archives. Private verifier proof and owner IDs never appear in public standings.
