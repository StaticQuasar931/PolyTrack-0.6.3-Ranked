# Events UI Polish

## Owned Changes

- `client.mjs`: shared local reset-date formatter with invalid-date fallback; Ranked footer now includes month/day and Local, not only weekday/time.
- Timed cards use a wrapping metadata footer. Reset dates no longer compete for the same grid row as reward or assignment text.
- Schedule-only cards say `Practice available; event scoring not confirmed` and `Event results unavailable`. RP caps and cached verified standings are not advertised for these cards. The full explanation remains in title/accessibility text. Local PBs say `Saved on this device`, not verified or awarded.
- Confirmed-event incentives use `Up to N Event RP` from catalog metadata. Schedule-only incentives instead offer practice without promising RP; missing reward metadata says `Event RP details unavailable`. Kodub no longer has a separate hard-coded 700-point green banner.
- Permanent incentive stays `Normal RP + up to 1001 Event RP / No reset`; personal awarded points remain in the result area, not the incentive/capacity label.
- `events.css`: scoped wrapping, readable incentive text, and explicitly sized in-flow PB timer/trophy icons. The compact featured cards omit racer-capacity text; the Events browser retains it.

No physics, scoring, submission, verification, or schedule-assignment behavior changed. No cloud reads or deployments were performed. Browser tests use local fixtures. No revision/version bump or commit was made. `kodub-weekly.mjs` and `kodub-weekly.test.mjs` were not edited.

## Parent Integration Contract

### Preserve Both Panels During Opening

In `polytrack_062_patch.js`, the event bridge `openTrack` delegates to `focusTrackFromRanked(id,{event:true})`. That function schedules a native button click after selecting the track tab. Preserve a left leaderboard loading placeholder and the right information panel from the first visible `.track-info-ui` frame, before async leaderboard rows exist. A loading label inside an already-mounted container alone does not reserve a missing/hidden leaderboard panel.

Coordinate the shared track-menu layout with `showTrackLoadingPreview`, `setTrackLoadStateForGeneration`, and the existing `sq-track-leaderboard-loading` class. The placeholder must not replace/destroy the native `.leaderboard-ui` node or its `__pt062EventRows` renderer. `events/client.mjs` `syncNativeBoard` intentionally adopts that native node and returns until it exists. Do not add a second independently owned event leaderboard or clear the placeholder merely because the right panel is mounted. Remove it only when the native two-panel scaffold is ready, with generation guards for stale loads.

Keep the existing event-row exceptions to normal leaderboard loading visibility (`events.css` rules for `html.sq-track-leaderboard-loading body.sq-event-active`). Existing integration tests cover those exceptions and native-node restoration.

### Restore Community/Events On Back

`focusTrackFromRanked` currently derives `tabIndex` from `info.type`; an official weekly track selects tab 1 even though it was entered from community/events. Capture the originating menu/tab/scroll context for event navigation before changing tabs. Restore community/events when the event's native Back returns to track selection, rather than using the event track's official type as the return destination.

The optional `bridge.restoreTrackSelection()` hook is now implemented in `events/client.mjs`. Event/archive Back leaves the session, restores the native node via `tick()`, calls the saved native Back button, then invokes the hook. Normal trusted Back/Exit invokes it in the next task, after native event handlers finish. Both paths reject restoration if the navigation request or account changed, or any event/archive intent is active. A request is consumed before calling the hook, and detached/stale event Back handlers are inert. Cached card redraws do not call the hook or open tracks.

Parent contract: capture the originating selection context in the bridge/native navigation layer and implement `restoreTrackSelection()` as a no-argument, synchronous consumer of that saved token. If no token is pending, do nothing. Restore menu/tab/scroll only; never reopen the event track. If restoration schedules asynchronous work, validate the captured parent token again before applying it so it cannot overwrite newer navigation. Do not infer the return tab from `view.period.trackId`. No parent patch files were changed by this worker.

### Shared Footer And Asset Loading

Ranked footer reset text is now longer and explicitly local. Let `.weekly-cup > small`, `.daily-card > small`, and their `strong` descendants wrap without fixed-height clipping at short desktop/phone widths. Parent owns those shared/global styles and any release cache-key changes for loading updated events assets.

## Verification

- Wording follow-up: visible server-confirmation jargon is replaced with practice/results guidance; schedule-only cards never advertise an RP cap or cached verified counts. Metadata/layout tests passed 10/10 at all five listed sizes; the focused copy, opening-restriction, Kodub, Ranked-footer, and restore integration run passed 16/16. The integration fixture now supplies the parent navigation function's newly introduced return-context dependencies; parent code itself is unchanged. `git diff --check -- events` is clean.
- Back-hook follow-up: 6 new browser integration regressions cover exactly-once normal/event/archive Back, native-handler ordering, stale handlers, account/navigation changes, newer event ownership, and absent optional hooks. A focused run including native restoration/listener regressions passed 9 tests. The full updated `node --test events/client-integration.test.mjs` suite passed 72/72 tests; `git diff --check -- events` was clean.
- `node --test events/client-card-metadata.test.mjs events/schedule.test.mjs events/client-integration.test.mjs`: 74 passed.
- `node --test events/community-layout.browser.test.mjs events/standings-layout.browser.test.mjs`: 4 passed.
- `node --test events/ui-polish.test.mjs`: 4 passed, covering reset boundaries/invalid dates, incentive separation, permanent incentive stability, metadata non-overlap, and PB-icon containment. Browser sizes: 1366x600, 1024x600, 844x390, 390x844, 320x568. Final combined rerun with metadata and schedule tests: 12 passed.
- `git diff --check -- events`: clean, apart from Git's informational LF-to-CRLF warnings.

Parent reports that shared scaffold and return-context hooks are implemented. Those parent changes were not edited or independently reverified in this wording follow-up. No claim is made that an unconfirmed event can currently award RP or that a saved local run is verified.
