# CDN Release Publishing

## What Changes

Apps Script can discover releases through jsDelivr without a browser request to
GitHub, raw GitHub, GitHub Pages, Firebase, or the Worker for discovery.

The one mutable URL is:

`https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@cdn-release/release.json`

Its dedicated `cdn-release` branch contains only a public release.json, with the
source commit, snapshot directory, entry HTML SHA-256, schema version and date.
No credentials, reports, server configuration or private player data are copied.

Game files use `@<full commit SHA>/...`. Each Git commit is a full tree. A file
unchanged since an earlier commit still exists at the later commit URL. No purge
of immutable files or all historical paths is necessary. Old active games retain
their coherent old tree; new visits discover the newer one.

## Compact Asset Package

jsDelivr returned explicit 50 MB package-size denials for the source tree on
October 24, 2026. Cached files could still return 200 while other files returned
403, so one successful icon request did not establish package availability.

Publication builds two separate Git trees: `cdn-assets` contains runtime files,
and `cdn-snapshots` contains the current snapshot package. Each omits obsolete
snapshot generations and development directories/tests. The `cdn-release` branch
is the small pointer connecting those two immutable trees. All three generated
branches are required by the current publishing workflow. The source main branch
and its history are not deleted or rewritten. No private untracked files are read or copied.

Every file in the generated tree must be strictly below 20,000,000 bytes,
including files outside the initial readiness probes. The publisher separately
measures the tar archive, including a GitHub-style root prefix, padding and
headers, and rejects packages at or above 49,000,000 bytes. The archive is a
measurement, not one large file served to browsers. Identical asset trees reuse
their existing immutable commit.

The pointer's `commit` is the runtime asset commit, `snapshotCommit` identifies
the snapshot tree, and `sourceCommit` records the main commit they were built from.
The publisher binds the entry HTML to that exact immutable snapshot URL. Existing
automatic HTML already reads `commit`, so this change does not require another Apps Script HTML replacement.

## Order And Coverage

1. A source or snapshot commit reaches main.
2. The publisher checks out current main after acquiring its shared release lock.
3. It checks local snapshot pointers, all bootstrap bindings and required asset
   paths, builds the compact asset tree, enforces all per-file limits, measures
   each package size, and pushes the runtime and snapshot branches.
4. It compares CDN bytes against the committed entry point, directly referenced
   files, runtime modules, native startup images, physics worker/WASM, snapshot
   bootstrap, and initial rankings payloads. Only after these pass does it
   fast-forward the public pointer branch. Hashes use Git blobs, not Windows
   checkout line endings. No force push or source working-tree edit is used.
5. It purges only the mutable pointer and verifies the resulting public content.
   Purge acknowledgments alone do not count as success. Retries are bounded.

Manual pushes to main trigger `Publish CDN release`. The three file-writing
workflows explicitly call it after their capture/push job: sync-event-catalog,
sync-kodub-weekly, and publish-verified-snapshots. verify-runs reaches it through
its existing publish-verified-snapshots call. This explicit chain matters because
GITHUB_TOKEN pushes normally do not trigger another push workflow.

No GitHub Pages deployment is needed: jsDelivr resolves the committed repository
tree directly. No Firebase reads or writes are added. Only the built-in Actions
token with contents:write is needed; no new secret or access token is required.

## Setup

Commit and push the workflow, tool, tests, and this document to canonical main.
Check that `Publish CDN release` completes successfully. If repository rules
prevent creating or updating `cdn-release`, `cdn-assets` or `cdn-snapshots`, fix that narrowly. Do not disable
main protections or broaden token permissions.

Then replace Apps Script's index HTML with the separately generated private
automatic index.html and update the existing web-app deployment. Keep its normal
Code.gs doGet. Do not upload the private build/audit folders to GitHub.

Until the first successful pointer publication, the loader uses its embedded
baseline. Existing deployed HTML is not changed by adding this workflow.

## Failure And Maintenance

The browser caches a successfully discovered pointer for five minutes; reloads
do not extend that discovery timestamp. It checks the entry HTML digest before
executing it and falls back to a saved release or the embedded baseline on error.
Rollback-like CDN responses older than its saved publication date are ignored.

CDN propagation is not instantaneous and one runner cannot certify every CDN
edge or school network. If the canonical pointer is still stale after the bounded
check, the job completes with `cdn_status=deferred` and a warning. This confirms
publication, NOT CDN freshness. The CDN-only schedule checks again and honors the
persisted purge cooldown without recapturing Firebase data or adding a duplicate
pointer commit. Retry `Publish CDN release` only, not verification or snapshot
capture. A current mirror alone cannot confirm the canonical loader URL.

Asset readiness failures, hash mismatches and invalid pointers still fail the job.
An asset readiness failure leaves the old pointer untouched. All five workflows
are syntax-checked by the checksum-pinned official actionlint validator before
CDN publication; offline release-contract tests cover their job handoffs.

Temporary 403/404, throttling, server errors and network failures get bounded
backoff of 5, 15, 30 and 60 seconds, with a five-minute readiness budget.
Retry-After is honored within that budget. Explicit package-size denials fail
immediately because retrying cannot make an oversized package smaller. Hash
mismatches remain release-blocking. No additional Firebase operations are added.

If main advances during checkout, rerun publication. Newer capture/push jobs also
request publication. Superseded pending Actions jobs may be coalesced by GitHub;
the next admitted job reads current main rather than the caller's old SHA.

The loader requires reachable jsDelivr assets. It is not offline mode, and it
does not update or interrupt an already-open race. Current game code may still
make optional GitHub-hosted update checks; those are distinct from this loader's
CDN-only discovery path.

Readiness probes cover initial critical files, not full UI correctness, every
replay or every dynamic import. Run normal release tests before pushing game-code
changes to main. This channel treats main as the approved publishing branch.

## References

- https://www.jsdelivr.com/tools/purge
- https://github.com/jsdelivr/jsdelivr#usage-documentation
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
