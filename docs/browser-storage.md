# Browser Storage

PolyTrack keeps personal saves in their original localStorage keys. Downloaded Ranked data uses the dedicated `polytrack-ranked-cache-v1` IndexedDB database.

## What Moves

Only explicitly classified cache keys move: category-rank observations, downloaded event standings/totals/catalogs, snapshot board copies, the last-known racer-name directory, and streak-leader copies. Values are copied as exact strings, without truncating rows or changing verification flags.

Native-version save keys, custom tracks, recording-store data, local PBs, practice history, event bests/replays, pending submissions/retries, settings and account data stay in localStorage. Unrelated games and PolyTrack Lab data are outside the classifier.

## Safety

- Commit the IndexedDB transaction and read the value back before reclaiming the matching localStorage cache copy.
- Remove a legacy cache copy only if it still equals the copied source. A newer old-tab write survives.
- If pre-existing IndexedDB and localStorage values differ, retain both sources rather than overwrite one during migration.
- Never call `localStorage.clear()` or modify the global Storage prototype.
- Blocked/unavailable IndexedDB leaves old sources intact. Optional new cache updates can stay in memory; personal-save writes keep their existing localStorage behavior.
- Coalesce pending cache updates by key. A burst of 1,000 updates does not produce 1,000 durable writes.
- Load rankings and events only after the cache memory view is ready; the game engine itself does not wait for migration.
- Track import waits for the migration queue and does not evict unbacked cache copies to make room.

IndexedDB is local browser storage, not Firebase. This feature adds no database requests or third-party data transfers.

## Compatibility

Older builds retain all native/user-owned keys and their original formats. They do not understand the new cache database, so downloaded cache misses can require their normal reload/refetch path. Running an unmodified old build can still recreate its own localStorage caches; this update cannot rewrite code running in another build. Current builds observe legacy-tab cache writes and preserve differing values safely.

This does not promise infinite storage. If personal saves alone eventually exhaust localStorage, or the browser disables all durable storage, a separate explicit save-storage migration would be required. This fix deliberately does not move shared personal-save keys or silently delete data.

## Tests

`npm test` includes cache-policy, migration/failure/race/coalescing, cache-integration, recording, native-save and import-safety tests.

Run `node --test tools/ranked-data-storage.browser.test.mjs` with the project's Playwright dependency available. `PLAYWRIGHT_MODULE` can point to an existing pinned Playwright installation. Optionally set `POLYTRACK_STORAGE_EXPORT_DIR` to a local backup directory and `POLYTRACK_STORAGE_TEST_REPORT` to a private report path. The browser tests use isolated Chromium/Firefox contexts, preserve protected values byte for byte, reload from IndexedDB, test legacy-tab updates and blocked storage, and reject external network requests. Do not check backup data or reports into Git.
