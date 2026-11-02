# Kodub weekly archive provenance

The offline builder reads events/kodub/selections.json and trusted-tracks.json,
originally captured by tools/sync-kodub-weekly.mjs from the official endpoint
https://vps.kodub.com/v6/trackOfTheWeek (version 0.6.3).
It checks each SHA-256 against the existing trusted descriptor, checks embedded
name and creator credit, and aliases the existing exact trusted bytes without copying them. Images reuse the existing
content-addressed events/kodub/assets files, with their hashes checked too.
No runtime archive fetch, Firebase call, event creation, or verification job is added.

## Date coverage

| Track | Captured weekly end (UTC) |
| --- | --- |
| going back in time | 2026-09-20 20:00 |
| La Riviera | 2026-09-27 20:00 |
| Horrice | 2026-10-04 20:00 |
| JEALOUSY | 2026-10-11 20:00 |
| Velvoire | 2026-10-18 20:00 |
| Spite | 2026-10-25 20:00 |
| Hydropower | 2026-11-01 20:00 |
| Zonda | 2026-11-08 20:00 |

These are exact captured endTime fields, not inferred publication, submission,
or start dates. Zonda is the current selection in the captured current.json,
not a claim that its week has already ended. Older selections with no captured
trusted bytes or metadata are not invented. Official Kodub website and itch.io
search did not provide additional usable historical track/date evidence.

Rebuild: node extra-tracks/build-kodub-archive.mjs --write
Check: node extra-tracks/build-kodub-archive.mjs

## Alias-only integration

All eight entries use archiveImport:true and the existing exact path
 events/kodub/assets/<codeHash>.track. They retain Kodub's canonical trackId and
have no ranked:false, unranked or importOnly flag. No Extra Worker IDs, static
track pins or alternate leaderboard identities are added. This batch's earlier
four registry/pin additions were removed, and its exact-byte copied track files
were deleted after verifying their resolved paths and equality with trusted
source bytes. No pre-existing asset was removed.

UI labels identify "Kodub archive - original leaderboard". Normal snapshot PBs
and native all-time boards remain authoritative. Aliases are excluded from the
client's global Extra and unranked-challenge registration. The parent-owned
runtime requires the exact hash path and original identity before import.

checkExtraVerification validates aliases against events/kodub/trusted-tracks.json:
trackId, codeHash and assetPath must match one trusted descriptor, the catalog
path must exactly match its local asset, and the actual bytes must hash to that
codeHash. A false-ranked/unranked/importOnly alias or an Extra-registry alias
fails validation. Normal Extra entries retain their existing pin/registry checks.

No physics, compatibility code, engine files map or fingerprint changed.
The engine generation and registry consistency gates pass with the original pins.

Unchanged engineDigest:
7203ead74e290932abafe7f45ae5d121b5e1488b788f7dbe9ea95c8eb30d1ed1

Unchanged verifier fingerprint:
4a52404b07cb6a78944c5073de19a46cefc7f73efd82bb56490abe1b2f35d79f

The rejected static-copy approach needed special support for La Riviera (42,781
parts), JEALOUSY (54,028), Velvoire (74,069) and Spite (28,470). That distinction
is no longer catalog admission policy: aliases neither enter static verifier
inventory nor disable an existing native Kodub board. No broad ranked-ready claim
is made about new Extra boards because none are created.

## Future captures

The existing capture schedule is unchanged. After official capture succeeds, the
workflow runs the catalog-only builder with continue-on-error:true. It always
stages events/kodub, but stages extra-tracks/catalog.json ONLY when the builder
step outcome is success. Failed/skipped alias refreshes cannot stage a catalog. The builder validates the whole
selection set first and publishes its catalog via temporary-file rename. It writes
no tracks, images, registry, pins or fingerprints. Rebuilds are idempotent and
remove obsolete practice-only classification from migrated archive aliases.

If an unsupported future entry fails validation, the prior catalog is retained
and the workflow reports that alias integration needs manual attention. A valid
official capture still publishes. No new schedule, service, job dispatch, worker
deployment, credential or runtime Firebase request is added.

Validation limitations: the builder still rejects an entry over 262,144 bytes,
unknown encoding/metadata, attribution or modified-date mismatch, missing trusted
bytes/images, hash mismatch, identity collision, or repeated selection identity
requiring date reconciliation. It does not silently invent dates or partially
accept a rejected selection set. Official captured history remains available even
when its newest entry needs manual catalog review.

Manual checks:

    node extra-tracks/build-kodub-archive.mjs --write
    node extra-tracks/build-kodub-archive.mjs
    node extra-tracks/sync-code-metadata.mjs --check
    node tools/extra-verification-check.mjs
    node --input-type=module -e "import {validateEnginePin} from './tools/verifier/run.mjs'; await validateEnginePin();"
    node --test --test-concurrency=1 extra-tracks/kodub-archive.test.mjs extra-tracks/catalog-ui.test.mjs tools/extra-verification-check.test.mjs tools/verifier/engine-pin.test.cjs

## Featured picks

Daily periods start at 00:00 UTC. Weekly periods start Monday at 00:00 UTC.
Canonical identities and period keys make choices deterministic for identical
catalog, published grades and snapshot statistics, independently of device order.
The editorial pool consists only of an explicit Curated tier/tag, a featured
submission, or a Kodub weekly entry with captured date provenance and a code hash.
Positive racer counts alone never promote an unreviewed track into that pool.

Within that pool, prefer a published quality grade of at least 6/10 with positive
exact snapshot racer coverage, then a grade of at least 6/10, then positive exact
coverage, then the remaining editorial pool. The second choice avoids repeating
an editorial candidate when another editorial candidate is available. A single
editorial candidate is reused rather than replaced with an unreviewed track.

Only a catalog with no editorial candidates uses the broader catalog, visibly
labeled "Discovery selection", with its catalog-fallback reason in the tooltip.
Missing coverage is shown as "Player count unavailable", never as zero. Exact known zero remains zero.
Published grades remain distinct from device-local ratings. Existing complete
snapshot statistics provide all racer counts; nothing requests live counts.

Pick dates are displayed in local time with exact machine-readable UTC dates.
One bounded local timeout updates only the spotlights at the next UTC midnight,
which also handles the Monday week boundary. It does not rerender the track grid
or disturb an open review. Closing or destroying the menu clears the timeout.
A hidden document cancels it; becoming visible recomputes the choices and arms
one fresh timeout. Generation tokens ignore callbacks from earlier menu sessions.
There is no polling, Firebase request, new board/event, or background service.
Picks call the existing onPlay callback with the original catalog entry, with no
code download until the user asks to play. At most two local thumbnail images
are added; no per-track cloud cache is created.

Browser status: the latest serial featured/compact run passed 8/8 with no skips.
It covers the editorial pool, honest known-zero/unknown coverage, UTC day/week
rollover while open, visibility and close/reopen behavior, 280x653, short phones,
and empty catalogs. Browser processes were closed and the slot released.
Screenshots: featured-1366x900.png, featured-390x844.png, featured-320x740.png,
featured-280x653.png and featured-short-320x568.png in the task's local screenshot
folder. Native bridge/PB regression tests also run offline against the parent-owned
source to protect canonical board identity.
