# PolyTrack 0.6.2 Public Release Gate

Target: September 6, 2026 at 10:00 AM Pacific. Launch only when every blocker is checked.

## Blockers

- [ ] Ranked Worker deployed with a dedicated least-privilege Firebase service account.
- [x] Release Firestore rules pass the local emulator security suite.
- [ ] Updated production Firestore rules deployed.
- [ ] Canonical PB migration rehearsed in an isolated namespace.
- [ ] Direct, public relay, and validated Discord relay paths pass across separate networks.
- [ ] No reproducible PB loss, racer replacement, mixed revision, or stale-cloud overwrite.
- [ ] Required viewport and browser matrix passes without clipped controls.
- [ ] Six-hour RC soak stays below the error and quota gates.
- [ ] Apps Script loader is pinned to the final 40-character commit SHA.
- [ ] Final iframe execution origin is present in both Worker allowlists.
- [ ] Rollback commit and prior Apps Script deployment are recorded.

## Commands

```text
npm run release:check
cd workers/ranked && npm run check
cd C:\Users\Static\Documents\Codexstorage\polytrack-turn-broker && npm run check
```

Set `FIRESTORE_RULES_PATH` when running `release:check` to verify the private release rules file too.

The private emulator suite currently covers eight ownership, tampering, multiplayer expiry, visibility, and PB-regression cases.

## Honest Positioning

Use `Community Ranked`. Runs receive structural validation and retain replays, but deterministic replay verification is not part of this release.
