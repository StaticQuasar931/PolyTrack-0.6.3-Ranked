# PolyTrack Ranked | PolyTrack 0.6.3 Mod

**Hunt PBs, compare racers and choose your next track.**

[Play PolyTrack Ranked](https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/)

A browser-based Ranked mod for Kodub's PolyTrack, with Overall rankings, events, ghosts, a route planner and local practice history. No installation is needed to play.

## For PB Hunters

- **Rankings:** compare Overall RP, Event RP, track wins, completion and more.
- **Route Planner:** find opportunities by potential benefit, ease or practice focus. Suggestions are estimates, not guaranteed gains.
- **Practice History:** review tracked attempts, finishes, active practice time and improvements. Tracking is local and partial, not a complete lifetime history.
- **Ghosts and player groups:** choose opponents, save ghost-selection presets, or build friends-only leaderboards with Advanced Filters.
- **Events:** race Kodub's featured track, daily and weekly events, and Rolling Hills Racer. Each card shows its scoring and timing.
- **Extra Tracks:** search by progress, tags, rating and difficulty, or sort by snapshot popularity, then import a track to play. Incomplete player counts are marked unknown.
- **Racer Studio:** customize your car, nameplate and profile with supported cosmetics and earned designs.

## Find Your Way Around

Open **Help & Controls** for searchable shortcuts and your current key bindings.

| Where | Shortcut | Action |
| --- | --- | --- |
| Track selection | Shift + 1 / 2 / 3 | Official / Community / Custom tracks |
| Overall Rankings | 1 / 2 / 3 / 4 | Your four Quick Rankings |
| Leaderboards | A / D or Left / Right | Change pages when not typing |

Other shortcuts depend on the screen and your bindings. Help separates driving, replay, editor, filtering and ghost-selection controls.

## Understand the Standings

Public standings come from published snapshots, rather than a database query on every click. Package publication, individual data confirmation and the last standings change are different dates. A snapshot can be published later than the runs it contains. Opening leaderboards, searching and sorting do not need live Firebase leaderboard reads.

Your local PBs can affect a **local ranking estimate** before the next publication. That does not verify a run or change public standings. Hover or focus supported score/rank values for their provenance. Published standings can lag behind new submissions.

Replays are checked separately. Unverified or held runs do not automatically receive verified ranking eligibility. Verification cannot guarantee detection of every possible form of cheating. Some older replay files may be unavailable.

Only eligible finishes submitted during the exact active event can earn its Event RP. Playing an archived track does not reopen that event's scoring. Extra Tracks marked unranked do not award Ranked RP.

## Your Leaderboard

Use **Filters** to include or exclude racers, select countries, badges or public group tags, and save or share loadouts. Normal filtering retains published RP; Smart mode calculates a separate group score from available loaded results. Missing results are marked rather than invented. Filters do not change public verification or rankings.

Six-digit group tags are public labels, not passwords or private multiplayer rooms. Multiplayer depends on network conditions; a wired connection alone does not guarantee a direct peer connection.

## Diagnostics and Feedback

Help contains the loaded release information and a developer diagnostics export. Nothing uploads automatically. Review the profile and private-track options before sharing a report.

Compact exports preserve report data with fewer repeated field names and IDs. They are **not encrypted or anonymized**. A readable JSON option is also available. Decode a compact report locally with:

```sh
node tools/decode-developer-report.mjs input.json readable-report.json
```

Please include the loaded release/client revision, browser, available game area and reproduction steps when reporting a bug. Do not post passwords, credentials, service-account files or private track codes.

## Development and Releases

Before every manual commit or push, follow the [release checklist](docs/manual-release-checklist.md). Release notes, client cache revisions, workflow compatibility and privacy checks belong to the same release. See [CDN publication](docs/cdn-release.md) for publishing and deferred-propagation behavior.

The update screen shows one player-facing update number. Developer details keep the separate cache revision and game version available without presenting them as competing update numbers.

Public PB submissions retain the submitting website's origin for private maintenance summaries, not its paths, query strings or referrers. Browser diagnostics estimate only instrumented device activity, not total billed Firebase usage.

## Credits

PolyTrack was created by **Kodub**. Ranked mod maintained by **StaticQuasar931**. Thanks to **Window Cleaner** for track grading help. Community tracks remain credited to their creators in-game, including DoraChad and the KackyThrowback contributors where applicable. This is not Kodub's official PolyTrack website.
