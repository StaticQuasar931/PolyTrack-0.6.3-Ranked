# PolyTrack Ranked Worker

This Worker is the only writer for Season 1 track, overall, badge, and release metadata documents. Browsers continue to own only their PB and public profile documents.

## Required secrets

Set these with `wrangler secret put` and never commit their values:

```text
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
ADMIN_REBUILD_TOKEN
```

Use a dedicated Firebase service account restricted to the PolyTrack production collections. Do not reuse a project-owner credential.

## Endpoints

- `POST /v1/pb/notify`: Firebase bearer token plus `{ "resultId": "accountId_trackId" }`.
- `POST /v1/profile/notify`: Firebase bearer token plus `{ "accountId": "owned-account-id" }` after an identity change.
- `GET /v1/status`: public operational state for the game UI.
- `POST /v1/admin/rebuild`: private full rebuild using `X-Admin-Token`.
- `POST /v1/admin/migrate`: private, resumable beta-to-Season-1 rebuild using `X-Admin-Token`.

Overall rebuilds are coalesced to a five-minute minimum interval and also run from the five-minute cron trigger.
The Worker performs structural replay validation only. It intentionally emits `verified: false`; deterministic anti-cheat verification is a separate post-release system.

## Deploy

1. Run `npm install`.
2. Run `npm run check`.
3. Configure the exact final game origins in `ALLOWED_ORIGINS`.
4. Set all required secrets.
5. Run `npm run deploy`.
6. Set `window.POLYTRACK_RANKED_BROKER_URL` to the Worker origin in the release loader.
