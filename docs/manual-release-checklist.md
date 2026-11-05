# Manual Release Checklist

Every manual release commit needs a new numbered Git title and finished Help notes.
The manual release number, client cache revision, game version and Git hash are
separate identities. Snapshot-capture bot commits keep the last manual release's
metadata, notes and preparation timestamp unchanged.

## Prepare And Integrate

1. Set the next manual release number to `git rev-list --count HEAD` plus one, including capture commits. Read the next client revision separately from `site-version.json`. Do not infer one from the other. Confirm file ownership in a shared checkout before editing.
2. Record the actual UTC release preparation instant once, at finalization. Run `node tools/prepare-release-info.mjs RELEASE_NUMBER CLIENT_REVISION ACTUAL_PREPARATION_UTC`, substituting the chosen values. The timestamp must use `YYYY-MM-DDTHH:mm:ss.sssZ`. Obtain the current value with `node -e "console.log(new Date().toISOString())"`, then reuse that exact value for retries. The tool only changes `tools/release-info.mjs`, preserves notes and helper code, and rejects restamping an already-prepared release. Do not use a guessed publication date, a fixture date, file modification time or page-load time.
3. Finalize `tools/release-info.mjs` notes after all feature owners report implementation and test results. Describe only shipped behavior, update the actual game version if needed, and never reuse unchanged notes, leave placeholders or add a prospective Git hash. The preparation tool deliberately does not author notes.
4. The integration owner stamps patch, index, events/client.mjs and site-version together using `prepare-site-update.mjs` or the existing `stampClientRelease` integration. Preserve the minimum-supported-client policy and other manifest fields unless deliberately reviewed. Keep imports, CSS URLs and the installed client revision coherent. The Help metadata import uses the client cache revision, not the manual release number.
5. Pass the exported `RELEASE_INFO` object to `renderHelpControls` as `release`. Do not duplicate notes in the patch. Preserve actual native key bindings and the configurable ghost shortcut. Bind Help on opening or replacing its content and call its cleanup on closing or disposal. The host owns initial focus, Escape, the modal Tab loop, focus restoration and blocking gameplay shortcuts while Help is open.
6. Check search, topic selection, Shift+1/2/3 labels, custom bindings, immediate key lighting before a click, Escape, Tab, touch, reduced motion and phone/landscape/desktop layouts. Current Release uses a real commit/publication timestamp and locally refreshed age, never preparation age. Missing or invalid timestamps remain unknown. Check visibility recovery and clock changes.
7. Keep timestamp meanings separate. A Git commit date is not a deployment or push receipt. Snapshot source capture, package compilation and standings changes are different events. Offline verification does not newly confirm the current Firebase standings. None is an unlock countdown or an instruction to poll a service.

## Before The Manual Commit

1. After finalizing central notes, run `node tools/release-history.mjs --write --precommit`, then `node tools/check-release-info.mjs --precommit RELEASE_NUMBER` with the next manual title number. The guard also rejects stale changelog archives. This validates working files against the preceding manual commit, not the staged index. From release 225 onward, a valid, nonfuture preparation timestamp is required. If the preceding release has a timestamp, the next one must be later.
2. Run the serial offline regression command below. Store logs and screenshots outside the repository. Do not run browser test files or processes in parallel on a resource-constrained machine.

```sh
node --test --test-concurrency=1 tools/release-info.test.mjs tools/help-controls.test.mjs tools/help-release-fixtures.browser.test.mjs tools/site-release.test.mjs tools/prepare-site-update.test.mjs tools/help-search.test.mjs tools/site-updates.test.mjs tools/release-client-identity.test.mjs tools/compatibility-cloud.test.mjs tools/workflow-release-contract.test.mjs
node --test --test-concurrency=2 tools/verifier/queue.test.mjs tools/verifier/publication-queue.test.mjs tools/verifier/scheduled-drain.test.mjs tools/verifier/proof-cache-file.test.mjs tools/verifier/workflow-budget.test.mjs workers/ranked/test/event-preflight-cost.test.js tools/new-account-five-track-cost.test.mjs tools/usage-analytics.test.mjs tools/analytics-url-privacy.test.mjs tools/cached-recording-verification.test.mjs tools/client-pb-profile-followup.test.cjs tools/client-cosmetic-publish-cost.test.cjs tools/offline-pb-analytics.test.cjs workers/ranked/test/event-publication-checkpoints.test.js
```

The second command is the actual credential-free verification workflow gate. Run
it before each manual push, not only when editing verifier code: catalog aliases
and discovery changes can also affect its routing assertions. Never rerun a live
capture to diagnose a failing offline test.

3. Review the existing project release checks and exact staged diff. Stage only the authorized files; never revert or stage unrelated agents' changes. The checked working files and staged files must match.
4. When committing is separately authorized, use a title in the form `RELEASE_NUMBER-Short descriptive title`. Commit the central metadata and stamped entry files together. Preparation and offline testing do not authorize a commit, push, capture or deployment.

## Firebase Impact Review

Before dispatching a changed capture workflow, run every offline test command in
its wrapper and reusable publisher locally, including `post-verification-snapshot.test.mjs`.
Release/CDN checks alone do not cover exact capture-script and artifact-path contracts.
Never use a live dispatch as the first execution of a changed offline gate.

1. Identify every changed path that can cause document reads, writes, rule-dependent reads, retries or derived publication. A static UI change must not silently add a live fallback or per-row query.
2. Record measured fixture costs before and after backend changes, including deferred batch work. Distinguish HTTP requests, estimated document operations and actual billed usage; do not omit reconciliation, rule or index costs from a savings claim.
3. Keep browsing, searches, popularity and local recalculation on the loaded snapshot. Reuse exact replay bindings and frozen archives; never trust stale cached ownership or a physics proof for a changed replay.
4. Confirm document/request budgets, conflict handling, quota backoff, queue durability and preservation of the previous valid snapshot. No capture or verification retries are allowed merely to repair CDN propagation.
5. Review the one public update number, concise player-facing Help notes and timestamp meaning. Developer identities belong in the closed technical disclosure, not beside the public number.
6. Test unchanged/no-op and failure paths explicitly. Use `workers/ranked/CLOUD_PATHS.md` to check the complete action, including deferred work. Local log summaries must not double count operation and request summaries or label unknown failed costs as zero.
7. Preflight and legacy queue processing share one verification document allowance. Pass only its conservative remaining budget to the second process; missing or exhausted accounting blocks that process. Capture has separate component caps and must not be described as covered by this allowance. A private catalog handoff must match the exact capture source and attempt, remain outside public staging, and fall back to a fresh request if stale or invalid.

## Before Push Or Publication

1. Immediately before committing, record a whole-second UTC `committedAt` using `stampReleaseCommitTime` from `tools/prepare-release-info.mjs`, and use that exact instant as `GIT_COMMITTER_DATE`. After the authorized commit, run `node tools/check-release-info.mjs` without `--precommit`. It checks the actual manual Git commit date as well as the title, notes and stamped entry files. Never inherit the previous release's commit date or call a preparation date a release date.
2. Run the offline regression command above plus `node --test --test-concurrency=1 tools/workflow-capture-coordination.test.mjs tools/workflow-release-contract.test.mjs tools/snapshot-retry-workflow.test.mjs`.
3. Review `git status --short` and the outgoing diff. Keep private evidence outside the repository. Publication, live verification and CDN checks need separate authorization; passing offline tests does not certify propagation or live service health.
4. For new browser dependencies, inspect the generated CDN readiness graph, including cache-bound `new URL(..., import.meta.url)` imports. Every required module must both be probed and included in the immutable runtime package. Run the real-commit CDN packaging tests before pushing; a green synthetic fixture alone is not sufficient.

## Existing CI Gate And Capture Exceptions

- `.github/workflows/publish-cdn-release.yml` already runs `node tools/check-release-info.mjs` in **Check Help release information**, before CDN publication safeguards and the publication/refresh step. Preserve this gate. It is not merely a proposed parent integration step.
- The guard itself reads local files and Git history only. The surrounding publication workflow includes network operations; invoking that workflow is not an offline check.
- Only exact existing capture titles with the configured Actions bot name and email are exempt from advancing manual release metadata. New capture workflows need explicitly tested exemptions, not a generic bot bypass.
- Git identity checks are convention checks, not cryptographic authentication. No service, secret or permission expansion is needed for the local release guard.

## Snapshot And Workflow Gate

1. Validate every `.github/workflows/*.yml` with actionlint. Run the exact offline test commands in affected workflows before exposing production credentials. Run `npm run test:verification-snapshot` for capture, replay, projection, or workflow changes.
2. Run `npm run check --prefix workers/ranked` and the verifier suites when their shared event or queue code changes. A passing preflight is not evidence that verification and subsequent snapshot publication succeeded.
3. Before pushing, run `node --test tools/publish-cdn-release.test.mjs` against the committed candidate, not the previous HEAD. For an isolated candidate commit, set `POLYTRACK_CDN_TEST_COMMIT` to its full hash. Confirm boot dependencies, snapshot pointers, blob bindings, and CDN size limits.
4. Audit the current package using `node tools/archive-data-audit.mjs`. Production publication must use `updatePublicSnapshot`, which calls `assertSnapshotReplayCompleteness` before packaging. Every normal, event, archived and pending-playback row in the candidate needs its exact bound, valid replay files; permanent standings reuse checked normal inputs. A verified flag, matching time or stored coverage summary is not a substitute. Missing or invalid replay evidence blocks the entire publication and leaves the prior snapshot unchanged. Do not hide rows, bypass the barrier with the low-level codec, or recapture automatically. Retain the encrypted checkpoint and recover offline. Missing archives are not empty final standings.
5. For a manual live run, check active Actions first, use explicit read/request limits, stop on quota errors, and reuse captured data for offline Overall calculation. Keep measured requests, estimated document reads, and billed Firebase usage distinct. Do not repeat verification or capture to fix CDN propagation.
6. Check portrait, landscape, in-between widths, text scaling, and rotation without a page reload. Include event cards, native Play/Watch, partial-replay consent, Help focus/keys, and generation-change behavior.

## Snapshot-Native Verification

1. Validate the checked-in authority configuration before source credentials are exposed. Capture sources and missing replay bytes once, then remove capture credentials before offline physics/review. Snapshot-native mode must not run the legacy Firestore verdict publisher.
2. Bind every reusable proof to the racer, track, time, frames, upload/run/period identity, replay SHA, pinned engine and track bytes. Recheck the current review policy and preserve holds. A matching finish alone is not proof of fair play.
3. Test a second capture of an unchanged source: keep approved flags, dates and playable replay metadata without refetching the same boards. Changed source bindings and holds must invalidate the relevant approval.
4. Compile track boards, profiles, Event RP and Overall from the same applied ledger. Preserve pristine event/totals baselines so repeated captures cannot double-count rewards. Missing geometry, bytes, policy or review coverage stays explicitly unavailable/pending.
5. Publish the manifest-pinned ledger and audited package together. Keep Node-only proof files out of the browser CDN asset archive. On a concurrent source change, stop and revalidate rather than rebasing verification decisions blindly.
6. Validate the public recovery recipient before admitting a native capture. Keep the private key local. Retain completed proof shards before compilation; they remain recovery evidence, not approval authority. Upload only encrypted checkpoints for failed, deferred or unpublished captures, retaining them for three days. Do not duplicate successful captures as artifacts when the audited package and ledger are already published. A replay-completeness failure or CDN delay never authorizes another database capture.
