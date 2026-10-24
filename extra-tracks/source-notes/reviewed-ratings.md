# Reviewed Extra Track Opinions

`reviewed-data.mjs` stores curated review inputs by stable anonymous reviewer key and canonical track hash. Each tuple is quality, difficulty, vote, followed only when needed by explicit added and removed tags. Zero means an absent score or no vote. It contains no player names, PBs, activity, export dates, credentials, or source-track code.

The initial `reviewer-001` input covers all 255 catalog tracks: 255 quality scores, 255 difficulty scores, two positive votes, zero negative votes, and no explicit tag edits. The export's copied catalog/effective tag arrays are not imported as opinions. No tracks are missing or unknown.

Import a future reviewer from the repository root:

```powershell
node tools/import-extra-reviews.mjs --input 'C:/path/to/review.json' --reviewer reviewer-002
```

Reuse the same key to replace that reviewer's opinions without double-counting. Use a different key only for a distinct reviewer. The importer prints missing and unknown canonical IDs and leaves catalog.json, track files and thumbnails unchanged. Review that report before committing. Removed catalog identities in an existing dataset require deliberate reconciliation rather than silent deletion.

Quality and difficulty are independent arithmetic means of supplied scores. Unrated values are excluded, neutral votes do not count, missing reviewed values sort last in either direction. Rounded reviewed difficulty filters correspond to the nearest displayed difficulty level. Tag changes use only explicit deltas: more additions than removals includes the tag, more removals excludes it, ties preserve the original source state. Missing opinions are not votes. A single reviewer is explicitly labeled as one opinion, not a measured difficulty or consensus.

Personal ratings, votes and tag choices stay in existing local storage. Published opinions never become personal activity, ratings, exports, favorites or PBs. Local tag choices apply after reviewed defaults. Source catalog difficulty and reviewed difficulty have separate controls.

Integration: include the new modules in deployment and the release asset/version process. No patch, package, version, or workflow was changed by this scoped task. Add `node --test tools/import-extra-reviews.test.mjs` to the parent validation command if desired. The existing isolated browser fixtures now serve the two new module dependencies. Browser checks must be run serially by the parent task.
