# Client usage analytics

The existing Google Analytics property can receive a small `polytrack_client_usage`
event from the owned GitHub game and the four explicitly listed owned Google script
origins. Other deployments do not enable this instrumentation. This collection was
explicitly approved by the project owner on November 4, 2026.

The event contains deltas from the existing browser-local observer, not a new
Firestore query. It does not send game account IDs, names, track IDs, recordings,
document paths, URL parameters, tokens, or local history. Existing Google tag and
browser privacy/consent behavior still apply; this module adds no identifier.

## Fields

| Parameter | Meaning |
| --- | --- |
| `client_revision` | Loaded client asset revision, not the release title number |
| `deployment_group` | `github` or `google_embed` |
| `usage_scope` | Always `client_observed` |
| `event_schema` | Event format version, currently 1 |
| `interval_seconds` | Time since the last accepted observation, capped at one day |
| `fs_reads_est`, `fs_writes_est` | Known instrumented SDK estimates in this interval |
| `fs_unknown_reads`, `fs_unknown_writes` | Operations whose corresponding count is unknown |
| `worker_ops` | Observed Worker operations, not backend document reads |
| `snapshot_ops`, `cache_ops` | Observed static snapshot/cache operations |

Events are best-effort at fifteen-minute intervals and when the page becomes
hidden or leaves. Empty intervals are suppressed. Reports are at least one minute
apart and capped at 128 per loaded page. Reloaded historical counters are baselined
instead of resent. Invalid data is omitted, not turned into a known zero. Blocked
Analytics never blocks gameplay or retries through Firebase.

## Interpretation

These events cannot establish billed project usage. They exclude server fanout,
rule-dependent reads, hidden SDK retries, uninstrumented references, old clients,
and sessions with unavailable/blocked Analytics. Unknown-operation counts are not
document counts. A cache or snapshot operation does not imply a Firebase request.
The event is not an abuse-prevention or authorization signal.

Use event-scoped custom dimensions for `client_revision` and `deployment_group`
in GA4 if those breakdowns are needed in reports. The custom event alone does not
create those definitions. Register custom metrics for estimate fields only if
they are clearly labeled as observed estimates. Do not compare event totals
directly with the Firebase billing chart or add hostname users as unique people.
