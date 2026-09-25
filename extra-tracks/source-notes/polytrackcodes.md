# PolyTrackCodes source note

## Permission scope

The user has confirmed written permission to redistribute PolyTrackCodes track codes. This import is limited to individually selected codes and preserves creator attribution and source-page links in the source manifest. It does not copy site artwork or other assets; no separate permission for those materials was provided.

## Editorial picks imported

One hundred nineteen selected codes are listed with creator credit and their individual source-page links in `../sources/polytrackcodes.json`. Every code was checked against its native PolyTrack track ID and bounded geometry. Fifty-three additional codes were imported on 2026-09-23 from the source's per-track endpoint, after excluding duplicates and out-of-bounds geometry. Native thumbnails were generated locally from the decoded tracks; no source artwork was copied. Source copy counts, where available, are a snapshot of code-copy activity, not live racer counts; missing counts are left null. The game does not display external links on every card, but the source filter and manifest remain available.

## Source terms

[PolyTrackCodes Terms of Service](https://www.polytrackcodes.com/terms) prohibit scraping, copying, or redistributing the site's database without permission. The stated permission does not extend to artwork.


## Additional PolyTrackCodes selection (2026-09-24)

Forty more individually selected track codes were imported from the user-authorized source on 2026-09-24, bringing this source manifest to 159 and the full Extra catalog to 200. Candidate metadata came from `GET https://polytrackcodes-data-api.aifeefee70.workers.dev/tracks?fields=list&limit=500`; each selected code came from `GET /tracks/{slug}`. Selection favored attributed tracks with strong copy activity/rates. Each code passed `tools/verifier/kodub-track.cjs` bounded game-format preflight, had a nonempty embedded creator, and its native ID was computed from the decoded canonical track body using the game `TrackData.getId()` SHA-256 representation. IDs are unique against the full existing catalog. Codes exceeding the default 20,000-part limit were excluded. Attribution and source-page URLs are in both the catalog and source manifest. No source artwork was copied; native preview generation was not available in the bounded import workflow.
