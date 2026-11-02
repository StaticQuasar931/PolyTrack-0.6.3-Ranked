# PolyTrack Ranked Worker

The Worker publishes Season 1 standings and runs event maintenance. Authoritative standings are written by the trusted backend and replay verifier, not game clients. Players can submit their own PBs and update their public profiles.

## Required secrets

Set these with `wrangler secret put` and never commit their values:

```text
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
ADMIN_REBUILD_TOKEN
```

Use a dedicated Firebase service account with only the Firestore permissions this backend requires. Do not reuse a project-owner credential. Server credentials bypass client security rules; keep them private.

## Main Endpoints

- `POST /v1/pb/notify`: Firebase bearer token plus `{ "resultId": "accountId_trackId" }`.
- `POST /v1/profile/notify`: Firebase bearer token plus `{ "accountId": "owned-account-id" }` after an identity change.
- `GET /v1/status`: capture-authenticated operational state in the deployed capture-only policy, not a browser polling endpoint.
- `POST /v1/admin/rebuild`: private full rebuild using `X-Admin-Token`.
- `POST /v1/admin/migrate`: private, resumable beta-to-Season-1 rebuild using `X-Admin-Token`.

Production uses coordinated maintenance: discovery/bootstrap and Overall aggregation are grouped around four capture windows. Canonical and identity work keeps its continuation cadence so fixed-read-time builds do not expire between windows. PB submission remains enabled outside those windows. See [Quota Follow-Up](QUOTA_AUDIT_20261101.md) and [Cloud Paths](CLOUD_PATHS.md).
The Worker checks submission ownership and structure. New runs remain pending until the pinned native replay verifier checks their exact inputs, track, and finish time. GitHub Actions runs that verifier separately; only still-current results receive its verdict. A physics-valid replay does not prove human play. See [Verifier Guide](../../tools/verifier/README.md) and [Database Guide](../../tools/verifier/DATABASE-GUIDE.md).

## Capacity Before Promotion

Normal ranked publication supports resumable full-field builds, immutable 100-row pages, and sharded verification queues. The 500-entry inline root is not a total-racer admission cap. A build can still fail closed on an expired read-time fence, missing parts, publication size limits, or incompatible proofs. Inspect pending/blocked work rather than declaring a truncated root complete.

Overall retains a 200-entry inline root and publishes larger complete fields through immutable pages. Static compilation also validates full-field completeness before calculating placements. Do not derive an outside-top-200 placement from an inline root alone.

The configured finite-event policy allows **2,000 entrants per period**, **2,048 admissions**, and **16 MiB of retained replay data**. These remain admission/storage guards, not display-page limits. Reviewed policy upgrades preserve proofs and use guarded period writes; changing configuration alone is not proof that an old period was upgraded.

Use bounded, resumable canonical processing and sharded verification, then publish standings and per-account ranks from a coherent full-field version. Do not remove overflow checks or label a truncated board complete. Monitor publication failures as well as visible racer counts: a frozen count may mean publication has stalled. Profile identity discovery is paged too; a player with more than 100 tracks must not be silently truncated.

## Deploy

1. Run `npm ci`.
2. Run `npm run check`.
3. Configure the exact final game origins in `ALLOWED_ORIGINS`.
4. Set all required secrets.
5. Run `npm run deploy`.
6. Set `window.POLYTRACK_RANKED_BROKER_URL` to the Worker origin in the release loader.
