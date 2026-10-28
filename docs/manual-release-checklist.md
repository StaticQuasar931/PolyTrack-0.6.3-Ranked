# Manual Release Checklist

Every manual commit must have a new numbered Git title and updated Help notes.
Release number 224 is not client revision 193 and neither is a Git commit hash.
Snapshot-capture bot commits keep the last manual release and notes unchanged.

## Before Every Manual Commit

1. Update `tools/release-info.mjs`: next manual `number`, real game `version`, stamped client `revision`, and concise notes describing only shipped behavior. Never copy unchanged notes or add a prospective commit hash.
2. Pass the exported `RELEASE_INFO` object to `renderHelpControls` as its `release` property. Do not duplicate notes in the patch. Preserve actual native binding and ghost-shortcut props.
3. Parent integrator stamps patch, index and site-version together with `stampClientRelease`. Its release-info import must use the client cache revision. Keep the existing minimum-supported-client policy unless deliberately reviewed; `prepare-site-update.mjs` preserves `minimumSupportedRevision` and all other manifest fields while updating `revision`.
4. Check Help release info, control search, Shift+1/2/3 labels, custom bindings, key lighting, Escape, Tab focus, touch and phone/desktop layouts. Snapshot age reports package publication age, not board confirmation or the last standings change. Board confirmation records when that board was checked; standings-change time records when its results last changed. None is an unlock countdown.
5. Run `node tools/check-release-info.mjs --precommit 224` for this release. For later manual commits, replace 224 with the next title number. This checks the working files against the preceding manual Git commit; it is not a staged-index check. Review `git diff --cached` after staging so staged files are exactly the checked files.
6. Run `node --test tools/release-info.test.mjs tools/help-controls.test.mjs tools/help-release-fixtures.browser.test.mjs tools/site-release.test.mjs tools/help-search.test.mjs tools/site-updates.test.mjs tools/release-client-identity.test.mjs tools/compatibility-cloud.test.mjs tools/workflow-release-contract.test.mjs`. These are offline tests, not capture or publication commands.
7. Review the staged diff and existing project release checks. Use a numbered title, for example `224-Help and Release Safety`. Do not perform Firebase reads, capture, push or deployment as part of these offline checks.

## Before Every Push

1. Run `node tools/check-release-info.mjs` after the manual commit. It checks Help metadata against the latest non-capture Git title, even if capture bots committed afterward. A new numbered title with unchanged notes fails.
2. Run the offline regression command above and `node --test tools/site-release.test.mjs tools/workflow-capture-coordination.test.mjs tools/workflow-release-contract.test.mjs tools/snapshot-retry-workflow.test.mjs`.
3. Review `git status --short` and the outgoing diff. Keep private evidence outside the repository and never stage unrelated shared-work changes.
4. Parent owner runs existing release policy and packaging checks, reviews workflow syntax compatibility, and authorizes any network publication separately. Passing offline checks does not certify CDN propagation or live service health.

## Parent Integration For 224

- Import `./tools/release-info.mjs?v=193` using the existing local module loader and retain the returned module. Set Help's `release` prop to `releaseInfoModule.RELEASE_INFO` (or destructure `RELEASE_INFO` and pass it directly). The guard accepts either form, including an object spread.
- Stamp client 193 in patch/index/site-version without changing the verifier engine or inventing a Git hash. Keep manual release number 224 only in the central record and Git title.
- Replace the previous inline Help notes. `help-search.test.mjs` supports central metadata and checks that its revision matches the manifest.
- Artwork fill and compact diagnostics belong to their respective owners. Only add those claims to central notes after their implementation and fixture checks pass. Keep Snapshot confirmation wording consistent across boards and Help.
- No workflow was changed by this task. Parent may add `node tools/check-release-info.mjs` to an existing offline CI gate before publication, after reviewing shared ownership. Keep current bot capture titles/identity; no service, secret, or permission expansion is needed.
- The guard permits only exact existing bot capture titles with the configured Actions bot name and email. New capture workflows need an explicitly tested exemption, not a generic bot bypass. Git identity checks are convention checks, not cryptographic authentication.
