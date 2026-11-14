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

Publication uses seven generated branches:

- `cdn-release`: the small mutable public release pointer.
- `cdn-assets`: the runtime package, including its bound entry HTML.
- `cdn-snapshots`: current snapshot metadata, indexes and bootstrap files.
- `cdn-snapshot-payload-0`, `cdn-snapshot-payload-1`,
  `cdn-snapshot-payload-2` and `cdn-snapshot-payload-3`: hashed snapshot
  payloads, routed by the first hexadecimal hash digit modulo four.

The pointer connects six immutable package commits. Splitting metadata and
payloads keeps each package within the archive budget; combining them can exceed
it even when individual files are small. Generated package trees omit obsolete
snapshot generations and development directories/tests. All seven generated
branches are required by the current publisher. The source main branch and its
history are not deleted or rewritten. No private untracked files are read or copied.

Every file in the generated tree must be strictly below 20,000,000 bytes,
including files outside the initial readiness probes. The publisher separately
measures the tar archive, including a GitHub-style root prefix, padding and
headers, and rejects packages at or above 49,000,000 bytes. The archive is a
measurement, not one large file served to browsers. Identical asset trees reuse
their existing immutable commit.

The pointer's `commit` is the runtime asset commit; `snapshotCommit` and
`metadataSnapshotCommit` identify the metadata package; `payloadShards` binds
its metadata base and four payload bases to full immutable commit URLs.
`sourceCommit` records the main commit they were built from. The publisher binds
the entry HTML to that exact metadata URL and payload mapping. Existing
automatic HTML already reads `commit`, so this change does not require another Apps Script HTML replacement.

## Order And Coverage

1. A source or snapshot commit reaches main.
2. The publisher checks out current main after acquiring its shared release lock.
3. It checks local snapshot pointers, all bootstrap bindings and required asset
   paths, builds the compact asset tree, enforces all per-file limits, measures
   each package size, and pushes metadata, all four payload branches and runtime.
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
prevent creating or updating any of the seven generated branches listed above,
fix that narrowly. Do not disable main protections or broaden token permissions.

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
An asset readiness failure leaves the old pointer untouched. All repository workflows
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

## History, Cleanup And Rollback

Keep all seven generated branches and their immutable package histories. Each
new package commit retains the previous branch tip as its parent. Commit hashes
inside release JSON and HTML are text, not Git reachability links. Do not delete,
force-push, recreate or prune package branches/history merely because the latest
pointer no longer names an older package. This publisher has no safe automatic
retirement policy for historical packages.

The five-minute discovery cache is not a package-retention deadline. Already-open
clients, pinned launchers, saved fallback releases and embedded baselines may
still request older metadata or payload commits. Browser payload caching is
opportunistic, not a complete offline release or a reason to remove remote refs.
Removing obsolete files from a new package tree does not require deleting old
package history. Any future cleanup needs a separately reviewed dependency and
retention plan covering all these consumers, not just the current pointer.

Rollback is forward-only through the supported publisher: revert the faulty
source change in a new descendant commit on main and publish a new release.
Preserve the old packages throughout. Do not reset branches or restore an old
release.json verbatim: the publisher rejects backward source ancestry, and the
loader ignores publication dates older than its saved release. A new release
must carry its own bound package URLs, entry digest and publication date. No
Firebase recapture is required solely to revert game code when the existing
snapshot remains valid. CDN publication is not a fully offline game distribution.

## References

- https://www.jsdelivr.com/tools/purge
- https://github.com/jsdelivr/jsdelivr#usage-documentation
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
