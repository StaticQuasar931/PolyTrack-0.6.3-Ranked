# Snapshot-Only Hosting

This repository is a static PolyTrack Ranked client with a separately maintained
submission service. Copying the files does not create that service.

## Compatibility Checklist

1. Update the complete client, not only `index.html` or one bundle. Keep the
   release manifest, versioned imports, styles and event modules together.
2. Include the current snapshot pointer and the package it names. Preserve
   content-addressed replay files, track bytes and package metadata.
3. Inspect browser requests after opening Overall, a track board and an event.
   Public standings should come from static snapshot files. A missing snapshot
   must not be replaced with a direct Firestore collection scan.
4. A static Vercel deployment has no `/api/ranked` route unless its operator
   explicitly configures one. Repeated 404s are a configuration or old-client
   problem, not evidence that Firebase should be queried instead.
5. Do not change the permanent snapshot-only public-read policy. Do not embed
   service credentials. Submission access remains governed by backend policy;
   copying a frontend does not grant backend access.
6. Test offline loading, queued PBs, account changes and recovery. Local PB means
   not confirmed uploaded; Waiting means uploaded and awaiting verification.
   A successful HTTP transport response alone is not a saved-run receipt.
7. Retain creator attribution and the distinction from Kodub's official game.

## Diagnosing Quota

HAR request counts are not billed document counts. Firestore Listen transport
requests may contain errors, empty results, or multiple documents. Keep the
project identity, response payload and observation window in the evidence.
Never publish HAR authorization headers or tokens.

The supplied Vercel capture contains nine ranked API 404 responses
and sixteen Firestore Listen requests in eight pairs. The available channel
response text does not establish returned documents or billed reads. Main-site
diagnostics describe a different client and observation period. Do not add their
totals together or extrapolate them as the project's daily bill.

A November 2, 2026 UTC static-file check of that deployment found an unversioned
client patch with no `public-snapshot-client` integration and no permanent
snapshot-only policy. Its HTML points at the canonical Worker, unlike the
relative proxy paths shown in the earlier HAR. These are different observations,
not proof of one unchanged deployment. Static inspection does not execute its
Firestore calls or establish their billed cost.

Operators must update their own deployments. This repository cannot silently
rewrite or revoke another operator's static files. Backend authorization must
enforce access independently of a claimed browser origin.
