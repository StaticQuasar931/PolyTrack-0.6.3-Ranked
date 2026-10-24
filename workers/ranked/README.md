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
- `GET /v1/status`: public operational state for the game UI.
- `POST /v1/admin/rebuild`: private full rebuild using `X-Admin-Token`.
- `POST /v1/admin/migrate`: private, resumable beta-to-Season-1 rebuild using `X-Admin-Token`.

Overall rebuilds are coalesced to a five-minute minimum interval and also run from the five-minute cron trigger.
The Worker checks submission ownership and structure. New runs remain pending until the pinned native replay verifier checks their exact inputs, track, and finish time. GitHub Actions runs that verifier separately; only still-current results receive its verdict. A physics-valid replay does not prove human play. See [Verifier Guide](../../tools/verifier/README.md) and [Database Guide](../../tools/verifier/DATABASE-GUIDE.md).

## Capacity Before Promotion

Normal ranked publication and the per-track verification slot map are capped at **500 racers per track**. This is not merely a display-page limit: a canonical rebuild that sees 501 records fails with `TRACK_CAP_REQUIRES_PAGINATION`, and a full verifier map rejects a new account slot with `VERIFICATION_TRACK_CAP`. Previously published standings can remain stale while accepted canonical results await publication. A fresh static snapshot capture cannot repair that backend backlog.

Overall currently publishes **200 racers**. Profiles outside that list do not automatically have an authoritative Overall placement.

The configured finite-event policy allows **200 entrants per period**, **2,048 admissions**, and **16 MiB of retained replay data**. These are admission/storage guards, not pagination settings. The event capacity is bound into each period; changing configuration does not resize existing periods.

Resolve these capacity constraints before large-scale promotion. Use bounded, resumable canonical processing and sharded verification, then publish standings and per-account ranks from a coherent full-field version. Do not simply raise constants, remove overflow checks, or label a truncated board complete. Monitor publication failures as well as visible racer counts: a frozen count may mean publication has stalled.

## Deploy

1. Run `npm ci`.
2. Run `npm run check`.
3. Configure the exact final game origins in `ALLOWED_ORIGINS`.
4. Set all required secrets.
5. Run `npm run deploy`.
6. Set `window.POLYTRACK_RANKED_BROKER_URL` to the Worker origin in the release loader.
