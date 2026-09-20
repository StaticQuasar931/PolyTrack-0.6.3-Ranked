# PolyTrack 0.6.3 Ranked

Migration candidate built from the supplied PolyTrack 0.6.3 distribution, retaining the existing Community Ranked additions and shared player data.

## First commit

This folder is ready for an initial migration-candidate commit. It has not been committed, connected to a remote, deployed, or published by the migration agent. Create the GitHub repository as `PolyTrack-0.6.3-Ranked`; GitHub names cannot contain spaces. The configured Pages URL is:

https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/

Do not enable Pages or the new scheduled verifier until the coordinated backend steps below are completed. A commit is not a production-release approval.

## What migrated

- The 0.6.3 game bundle, chunks, simulation worker, UI, and new community assets.
- Ranked, PB storage, profiles, cosmetics, route planning, multiplayer hooks, and the existing event system.
- Native event launch and event-only ghost hooks re-ported to the new native game symbols.
- 88 current catalog tracks, including Rolling Hills Racer. Legacy Asguardia remains available to the verifier and retains its original community classification, medals and saved favorite identity. Ranked's historical catalog count is therefore 89, not the 88 current menu entries.
- The native weekly-track panel now uses the existing server-owned weekly-event catalog through our client adapter. It does not call Kodub's disabled weekly endpoint. Its button opens our event flow, and it does not display an unrelated normal-track PB.
- Exact thumbnail paths and a missing custom-group cover.
- An audited 0.6.3 replay-verifier asset pin. Only exact proofs from explicitly reviewed prior engines remain accepted; new proofs require the new pin. A client-provided verified flag is never sufficient.

The weekly panel currently displays OUR active weekly event using a bundled track. It does not automatically discover Kodub's actual weekly choice. Supporting an unbundled Kodub selection requires obtaining its track data and schedule, admitting the trusted asset into the catalog/verifier, and publishing the corresponding server event. No untrusted remote track URL is accepted by this adapter.

## Accounts and data

Cloud collections, Firebase project configuration, native storage prefixes, account token hashing, and custom save/cache keys intentionally keep their existing names. In particular, `polytrack_062_patch.js` and `0.6.2_*` collections are compatibility identifiers, not an accidentally unmigrated engine.

The new GitHub Pages path has the SAME origin as the old game. A synthetic browser test confirmed that the native account and migration marker survive navigation from an old path to a new path unchanged. No production accounts, PBs, badges or event results were deleted or rewritten during this migration.

A different browser, device, custom domain, cleared storage, or a restricted/partitioned embed is not the same continuity case. Existing secure account-transfer/recovery requirements still apply. Ownership protections were not weakened.

## Coordinated deployment, after the first commit

1. Create/push to `StaticQuasar931/PolyTrack-0.6.3-Ranked`. Keep Pages unpublished initially.
2. Disable the old repository's **Verify PolyTrack runs** workflow before activating the new one. Both repositories share the same canonical data and verification queue; they must not run conflicting engine pins.
3. Deploy `workers/ranked` to the existing `polytrack-ranked-worker`, using its existing private secrets. This updates the track registry and matching verifier pin. The Worker remains shared with 0.6.2, so treat this as a coordinated change, not an isolated test deployment. Request one authenticated server-side overall rebuild afterward so catalog totals update without waiting for a new PB. Do not delete or replace canonical results.
4. Add the existing private verifier service-account JSON as a GitHub Actions secret named `FIREBASE_VERIFIER_SERVICE_ACCOUNT` in the NEW repository. Never add that file to Git.
5. Add a repository Actions variable `POLYTRACK_VERIFIER_ENABLED` with value `true`. The new workflow deliberately stays disabled until this variable is set.
6. Run the new verifier manually. Inspect the actual summary and one real, correctly bound result before relying on scheduled verification. Resource-limit results remain waiting rather than falsely verified.
7. Enable GitHub Pages for the new repository. Confirm the actual URL matches the configured canonical URL and test an existing account in the SAME browser as the old game.
8. Test a normal PB, event PB, replay, profile change, cosmetic publication, Worker-blocked Firestore fallback, and multiplayer with two devices. Do not delete canonical data if a rollout must be stopped.

No Firestore collection/document shape or rule change is introduced by this migration. The provided rules were inspected as context, not deployed or tested against a live project. Confirm that the rules currently deployed are the intended existing rules. No TURN Worker change is required solely for a different path under the same origin. Its source is not included in these supplied repositories; its live behavior was not retested here.

## Local validation

Node 24 and Playwright 1.62.1 were used. Native browser tests made no production writes. Bundled Playwright of the same locked version was used through the test environment overrides.

- Client tests: 192 passed, 0 failed.
- Ranked Worker tests: 114 passed, 0 failed.
- Verifier safeguard tests: 80 passed, 0 failed.
- Native physics tests: 3 passed, 0 failed. These exercised 45 official/larger community tracks, the largest reviewed geometry, and the existing replay-work limits using synthetic recordings.
- Additional same-origin native account continuity test: passed.
- All 88 current catalog IDs matched native decoded track data. 89 trusted geometries include retired Asguardia. Existing track identities were not reassigned.
- JavaScript syntax, release/secret scan, ignore-pattern checks, and tracked diff whitespace check: passed. Initial files are untracked until the first commit.
- Affected scoring tests were rerun after the final legacy-metric adjustment: 165 passed, 0 failed (overlaps the suites above).

Browser inspection: initial driving view and track selection at 1366x768; native weekly-event card with isolated event metadata; Ranked offline/error layout at 1366x768, 390x844, 768x1024 and 1024x768. Compact footers scroll. This was not a full real-device, browser-zoom, populated-profile, or cross-network acceptance test.

Useful commands after installing verifier dependencies (`npm ci --prefix tools/verifier --ignore-scripts`, then Chromium via Playwright):

```text
npm run release:check
npm run test:client
npm run test:ranked
npm run test:verifier
npm run test:migration
npm run test:native-limits --prefix tools/verifier
```

This is a compiled upstream distribution. The inherited upstream `build`/Jest scripts require upstream source that is not in this distribution; use the migration-specific commands above for this repository.

## Repository hygiene

`.gitignore` excludes dependencies, Wrangler state, environment secrets, common Firebase service-account filenames, key files, local emulator data, logs, screenshots/test artifacts, private admin pages and private agent handoffs. It deliberately does NOT ignore the shipped bundles, WASM, tracks, verifier manifest, public migration documentation or lockfiles.

Review the GitHub Desktop change list before committing. A `.gitignore` cannot identify every arbitrary secret filename or remove a secret already committed elsewhere.

## Scope and remaining acceptance work

- The two long-term request/audit text files were background. Their future redesign/features are not claimed complete by this migration.
- No live production PB or event was submitted, no cloud rebuild was run, and no credentials were committed.
- No emulator suite was present in the supplied source repository; production Firestore authorization is not claimed newly tested.
- workers.dev school blocking remains an infrastructure limitation. Existing Firestore fallback is preserved; TURN still cannot be replaced by Firestore signaling alone.
- Live verification workflow, real cloud publishing, cross-device imports and cross-network multiplayer require post-deployment testing.
- Exact Kodub weekly-track mirroring is not available without a separate source for its weekly selection and track data.

## Audit files

`docs/migration/migration-file-inventory.json` compares raw 0.6.2 from main, the modified 0.6.2 tree, raw 0.6.3 and this candidate. `native-track-audit.json` records native track identities/geometry. `engine-review.json` records the reviewed physics compatibility decision. Neither source project was modified.
