# Release294 Worker Read Amplification and Capture Signers

## Scope

Base HEAD: 5fd47ac0f63176e4cfcc513bb47ac16904642897.
Worker source, worker tests, and this worker document only. No production calls,
deployment, commit, schedule changes, services, IAM, login, billing, or credentials.
The parent owns tools/workflow/night-runner changes. Preserve unrelated .gitignore.

## Implemented Reduction

A six-hour source-catalog audit previously scanned fresh track roots and then
expanded every paged root again, even when the committed expanded source bundle
already contained exactly the same immutable generation. This amplification also
spent the shared invocation request budget and could prevent larger audits finishing.

Reuse now requires a successfully validated, scope-bound and digest-bound source
bundle, an equal source binding, and equality of ALL freshly scanned root fields.
The cached expanded field is truncated only for comparison against the complete
inline preview; its full validated entries are retained for computation. A root
metadata, inline preview, signature, revision, generation, or membership change
still follows the existing authority path. Cache corruption/missing companions and
forced recovery still fetch and validate pages. Fresh-root discovery and final
metadata CAS have not been removed. No new writes, queues, or services were added.

This uses the existing immutable-page contract. An out-of-band rewrite/deletion of
an immutable page without advancing its root is not a supported publication; use
forced recovery to diagnose or repair it. This change is not permission to mutate
pages in place or to reuse a generation for different content.

## Measured Complete Costs

Offline real Worker entry points and atomic precondition-enforcing Firestore double:
three 1,001-row paged track boards, all proof-pending, four cold six-hour audits,
each followed by one clean invocation. Each cold audit reads the durable source
companion, not an unbilled warm-memory shortcut. HEAD source-loader code was loaded
from git show into an isolated baseline module; the repository was not reverted.

| Scope | HEAD Reads | Release294 Reads | HEAD Writes | Release294 Writes |
| --- | ---: | ---: | ---: | ---: |
| Initial publication | 39 | 39 | 4 | 4 |
| Four audits and four clean follow-ups | 164 | 32 | 16 | 16 |
| Complete fixture | 203 | 71 | 20 | 20 |

Complete-fixture reads drop 65.0%; steady audit/follow-up reads drop 80.5%.
132 immutable-page reads are eliminated, not deferred. There are zero added writes.
Each cold audit uses eight counted Worker requests instead of 41, including Cache
API work. Four full source-root scans remain. Changed generations and forced repair
retain their full page cost. Future repair work is not silently moved to a queue.
The initial population cost is explicitly included above, not hidden as setup.

These numbers isolate the source amplification with pending boards. Verified
populations still incur necessary entitlement and verification reads. They are not
production attribution and do not establish that this alone materially cuts the
reported 49,000 daily reads. In this fixture the 132 daily reads saved would equal
only about 0.27% of that reported total. Production monitoring/logs remain unavailable;
no production volume or cost claim is made.

## Audit Findings and Deliberate Non-Changes

- Canonical discovery queries ingestedAt incrementally and drains durable keyed PB
  work. Full reconstruction remains a fallback for missing/incomplete/obsolete
  publications, explicit full work, legacy backfill, or capacity overflow. No new
  six-hour full-canonical timer exists in this Worker path.
- The six-hour source audit discovers fresh root membership. It is not a reason to
  revalidate the same immutable pages. This is the implemented reduction.
- Six-hour Overall entitlement audits remain. Privileged out-of-band entitlement
  edits need not advance the Worker epoch. An unchanged input revision alone is
  insufficient to skip those canonical reads safely. Existing journaled reuse,
  changed-account reads, exact timestamp fences, and metadata CAS remain intact.
- Stationary 1,136-row full reconstruction still costs 3,472 reads / 41 writes in
  the existing end-to-end audit, including historical and fresh proof work. This
  patch does not pretend these costs disappeared or weaken their proof checks.
- Sparse PB coalescing remains opt-in. Existing complete route-plus-drain tests
  measure a single 496-racer notification at 4R/3W immediate versus 7R/5W coalesced.
  Canonical client work adds the same 2R/2W to both. Those fixtures exclude native
  verification, subsequent proof publication, Overall, event totals, and capture;
  they are not full-day billing estimates. No blanket sparse-PB coalescing is added.
- No blind raw-delta snapshot builder was introduced. Trusted ingestedAt alone
  does not provide deletion/tombstone or review/proof invalidation coverage.
- Capture/snapshot cadence is unchanged. This patch does not reduce the parent's
  capture frequency or strand existing incremental work.

## Optional Local Capture Signer

capture-read-auth.js accepts LOCAL_CAPTURE_SERVICE_ACCOUNT_EMAIL as an optional
second exact service-account email. Existing CAPTURE_SERVICE_ACCOUNT_EMAIL retains
precedence and its FIREBASE_CLIENT_EMAIL fallback remains unchanged. Without the
new optional value, the local signer remains unauthorized. No deployment config or
secret was modified. Parent must obtain approval before configuring/deploying it.

The verifier pins its configured issuer list for the isolate lifetime. At most two
issuer states exist, each with at most four imported RSA keys, one refresh in flight,
its own expiry and 30-second refresh cooldown. Keys are never indexed globally by
kid. Identical kid values across issuers are tested with different RSA pairs;
cross-issuer signatures fail. Unknown issuers are rejected before Google lookup.
Issuer churn cannot allocate new caches. Invalid nonempty local configuration fails
closed. Duplicate exact configured emails use one issuer state. Existing fixed-host,
exact-path/query, GET-only, 60-second lifetime, bounded token/JWKS, timeout, key
strength, and expiry rechecks remain. A local stalled refresh does not block hosted
verification. Both authorized signers' router probes require zero Firestore access.

## Evidence and Tests

Private evidence directory:
C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-05/cloud-readiness-294

- baseline-worker.log: isolated HEAD-loader baseline, including bootstrap.
- release294-worker.log: new targeted source-audit accounting and regression tests.
- capture-auth-tests.log: targeted issuer isolation and authentication tests.
- worker-check.log: first complete Worker suite, 1,137 passed before final additions.
- worker-check-final.log: final complete Worker suite, 1,143 passed, zero failed,
  including hosted/local router coverage. Scoped git diff --check passed.

Run locally: npm --prefix workers/ranked run check.
