# Kodub's Track of the Week

Kodub's native weekly selection is independent of our daily and weekly ranked
events. It uses the native track info/play flow, not event sessions or Event RP.
No official leaderboard entries or player tokens are imported. The new weekly
track is not automatically admitted to the trusted Ranked track registry.

## Menu Layout

The community menu has two separate sections: a full-width Featured events area
(Kodub weekly, our weekly event, our daily event), then the community version
buttons and their normal tracks below. Changing a version never hides the featured
area. Rolling Hills stays in its normal version group and does not implicitly
start an event. Unavailable event slots show a status instead of disappearing.

## Retrieval

- The client reads `events/kodub/current.json` as a local fallback.
- It requests `/v1/kodub-weekly` on the configured Ranked Worker for fresh data.
- Matching capture metadata uses the local assets; a new selection uses the
  Worker's mirrored track and images without needing a website update.
- The Worker caches metadata for at most 60 seconds (bounded by expiry) and
  immutable hash-addressed assets for one day. Cache entries are origin-specific.
- The proxy only accepts the fixed weekly endpoint and strict hashed asset paths
  at Kodub, rejects redirects, bounds downloads and checks track/image formats.
- Expired captures are never returned as current. A successful live response
  with no selection overrides the fallback. During outages after expiry, there
  may be no weekly card until a refresh succeeds. There is no fabricated track.
- Native menu logic refreshes at rollover. The layout removes the previous moved
  card when its replacement arrives. Reloading the page also refreshes the feed.

## Captured Week

Track: **going back in time**, author **leonnnn2400** (full display name preserved
in the JSON), native ID
`5fc79f76ee33a37a0ee8815a5cce75b4686330649c74793630fbfc12c11a2bb3`.
Native decoder confirms 11,448 parts. End is `2026-09-20T20:00:00.000Z`, or
September 20 at 1:00 PM PDT. The native date range derives its start by subtracting
seven days; the upstream response itself supplies only the end date. Nostalgia
is the artwork title, not the track metadata name.

The capture contains the 38,004-byte track and 16,740/622-byte WebP cover/thumbnail.
Assets are in `events/kodub/assets`, outside the pinned physics asset inventory.
The verifier engine digest, ranked registry, production scores and event periods
remain unchanged.

## Optional Local Capture Refresh

Run `node tools/sync-kodub-weekly.mjs` to capture the current official selection.
On Windows with enterprise/system certificates use `NODE_USE_SYSTEM_CA=1`.
The script needs no credentials, validates all downloads before replacing the
manifest, and leaves the previous manifest intact if a download fails. It does
not delete older assets, commit or push. This is optional because the live Worker
feed handles future weeks on demand.

## Deployment And Checks

The Worker feed was deployed and tested against the real upstream. All three
mirrored assets returned HTTP 200. The frontend still needs its normal repository
publication; no commit or push was made in this task.

Browser checks covered 1366x768, 390x844 and 768x1024. Both an isolated local-copy
launch and a live Worker-only launch (local manifest deliberately unavailable)
opened the matching native track and reached gameplay, without event session
activation or browser errors. No scores were submitted by these tests.

Cloudflare requires the supported `manual` redirect mode with explicit status
checking rather than Node's `error` option; see
[Workers Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/).
