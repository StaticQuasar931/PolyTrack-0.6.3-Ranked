# Verifier diagnostics

This is a private, read-only admin diagnostic sidecar. It does not publish, repair, lease, retry, or migrate any data. It does not change the verifier workflow or expose a browser route.

## Run

From the repository root, with the existing private service-account JSON already present in `FIREBASE_VERIFIER_SERVICE_ACCOUNT`:

```text
node tools/verifier/diagnose.mjs --html=verifier-report.html
```

The command reads that environment variable only. It does not read a default credential file, search the filesystem for credentials, or print the credential. The output path is a local file path; keep the generated HTML private.

Useful bounded options:

- `--due-only` limits the queue page to currently due queue documents.
- `--track-id=<id>` reads one exact queue document and avoids a queue query.
- `--summary=<path>` adds a previously saved drain summary to the scheduler diagnosis. The file is parsed locally and only bounded counters are emitted.
- `--now=<epoch-ms>` makes a report reproducible in tests or incident review.
- `--html=<path>` writes the readable local HTML view. It contains an escaped table and client-side search with no external resources.
- `--json` keeps the machine-readable report on stdout; it can be combined with `--html`.

The default scope is at most eight pending queue documents, 64 recent audit records, and 32 recent event runs. Current queue, completed normal history, and event history have separate bounds. The hard maximums are 16 queue documents, 128 audit records, and 64 event runs. `scope.truncated`, `scope.auditHistoryMayBeTruncated`, and `scope.eventHistoryMayBeTruncated` identify bounded views that may have more records; the report is not a complete backlog or archive count.

The report joins active queue slots and recent private verification audit records to canonical runs, then checks an existing per-track leaderboard snapshot for published rank/field size. It also reads recent event-run records using a projection limited to run ID, period, account, track, time, received time, status, proof status/reason/check time, and completion time. It emits account IDs, run IDs, period IDs, track IDs/names, statuses, reasons, timestamps, timestamp source, wait age, verification latency, and bounded aggregate counts. It does not emit replay contents, replay hashes, owner UIDs, display names, credentials, or native proof payloads.

The HTML view shows scope/time, account ID, run ID, readable track name plus ID, status, published place, wait duration, submission time, verification time, and verification latency. It intentionally omits detailed native reasons and replay/private fields from the rendered table. Search runs locally in the browser with inline JavaScript. The HTML is never written to `GITHUB_STEP_SUMMARY`, a GitHub job output, a Worker route, or the public events UI.

Normal submission time uses only `submittedAt`, `pbAt`, or `ingestedAt`; it never falls back to account creation or ambiguous generic creation fields. For old audit records whose canonical run has since been replaced, submission time is reported as unavailable rather than guessed. Event submission time uses the server `receivedAt` value. Event visibility is recent and bounded; it is not a complete event archive export.

The trusted-track comparison uses the committed `track-geometry.json` inventory and reports whether a queued track is present in that pinned registry. It does not admit a track or alter the registry. A missing or unknown trusted track remains waiting under the existing verifier policy.

## Parent integration

The parent admin tooling can import `createDiagnosticReport` from `./tools/verifier/diagnostics/report.mjs` and pass the existing authenticated Firestore adapter. The adapter must expose only `call` and `get`; the module never calls `write`. Keep the returned JSON behind the existing authenticated admin boundary and do not add it to the public Worker or events UI.

The scheduler section records the safe policy: event verification receives four native slots first, normal verification receives twelve, and only unused event slots can be borrowed. A historical `budgetDeferred` plus `no_progress` summary is flagged as the old misleading classification; current code reports `budget_deferred` so operators can distinguish request exhaustion from actual queue stagnation.
