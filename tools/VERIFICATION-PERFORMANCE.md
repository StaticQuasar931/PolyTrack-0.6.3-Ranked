# Snapshot and verification performance

Measured locally on 2026-11-16 using Node 24.22.3 on Windows, an i9-12900K,
and saved generation 90. No Firebase calls or publication of benchmark fixtures.
These are stage measurements, not an end-to-end hosted-workflow speedup claim.

| Stage | Before median | After median | Reduction |
| --- | ---: | ---: | ---: |
| Inventory scan, 65,203 physical files | 18.853 s | 5.594 s | 70.3% |
| Encode/write, 4,096 sampled saved JSON files | 21.524 s | 7.282 s | 66.2% |
| Growing ledger checkpoint, 16 additions per checkpoint | 6.211 s | 2.838 s | 54.3% |

## Changes and checks

- Inventory metadata reads use the existing bounded concurrency limit of eight.
  Traversal order, error order, path/link checks, and source-change checks remain.
- Payload encoding and writing use four workers. Output metadata stays in input
  order, encoded bytes are unchanged, duplicate content is serialized safely,
  and every worker drains before failure cleanup. The first input-order failure
  is preserved. Gzip level, codec, file bounds and publication checks are unchanged.
- Checkpoint merging reuses the freshly validated in-process ledger under the
  existing lock. Every addition and colliding witness is fully validated.
- A bounded LRU reuses semantic validation of identical shard bytes. Every read
  still checks the actual file and SHA-256 before lookup, then verifies current
  timestamps, descriptor count and key boundaries. Cached entries are deeply
  frozen. The cache is not persisted and grants no proof authority.
- The cache is bounded by 32 MiB of serialized shard data; JavaScript heap use
  is higher than that bound. It is private tooling, not browser storage.
- Manifest pinning, CAS, writer locks, durable checkpoints, sticky review holds,
  replay/physics checks, first-proof gating and verification priority are unchanged.

## Measurement details

Inventory: four alternating before/after observations per version on a warm
filesystem cache. All eight inventory digests match. Independent payload hashes
and the full existing package validator also passed on generation 90.

Packaging: 4,096 logical files sampled evenly across the generation-90 index,
9,814,031 decoded bytes. Four observations per version in alternating/reversed
order. Each uses the same raw decoded bytes and level-9 gzip. Ordered metadata,
every encoded payload hash and file contents match the original serial loop.
This times encoding and payload writing, not capture or complete publication.

Checkpoint: starts with the real 22,475-entry ledger and advances four times,
adding 16 structurally valid test fixtures each time. These are writer fixtures,
not newly verified runs. Alternating execution order, warmed filesystem and initial
validation. Original and optimized manifests and every referenced shard are
byte-identical after all four checkpoints. Original timings (ms): 6243, 6197,
6207, 6214. Optimized timings: 2649, 2725, 2961, 2952.

Unchanged warm checkpoints separately measured 6.344 s to 0.722 s. That 88.6%
result must not be used as the growing-checkpoint or whole-workflow improvement.
Resetting the original ledger between distinct-addition trials instead measured
6.131 s to 5.069 s; that workload does not retain the advancing cache state.

Two-browser physics experiments were rejected: repeated trials caused startup
timeouts and unavailable verdicts. Production physics concurrency remains unchanged.
No CPU, geometry, replay, cheat-review or timeout checks were relaxed.

## Scope

The active hosted pass is pinned to its existing implementation commit. These
changes neither cancel it nor alter its inputs, progress, receipts or proofs.
Future captures and offline passes use these shared helpers. End-to-end duration
must be measured on a later comparable hosted run; the three stage percentages
cannot be added together or applied to total runtime.

## Native validation lifecycle follow-up

The game already contains the native verifier. Module 5220 in main.bundle.js
creates a persistent simulation worker. Its validate method posts Verify to that
worker. simulation_worker.bundle.js advances frames in a synchronous loop, checks
the exact finish frame, posts the result, then deletes the car and recording.
It does not wait for replay-length wall time or use main-window animation frames.

Our wrapper previously created and disposed a Validator for every replay. The
follow-up reuses one Validator inside each existing batch, retaining per-replay
native validation and determinism checks. A second determinism reply provides a
barrier after the Verify handler exits; worker errors also prevent approval.
Failures discard the instance. Original browser termination and cleanup checks
still run before returning the batch. Unrelated menu RAF rendering is stopped
only after trusted initialization is available. Physics/WASM bytes are unchanged.

The final implementation was compared against release 428 using the same 16
saved valid replays: eight Summer 1, four Rolling Hills and four current Kodub
Uplink replays. Two observations per version, alternating/reversed order:

| Measurement | Before | After | Less time |
| --- | ---: | ---: | ---: |
| Complete verifyBatch median, including browser initialization and cleanup | 18.648 s | 15.406 s | 17.4% |
| Median per-replay verification path, pooled 32 observations per version | 0.702 s | 0.377 s | 46.3% |

Raw batch times (ms): before 20410, 16886; after 15046, 15766. Verdicts, native
track identity/content, geometry, engine digest and determinism outcomes matched.
A valid-A / valid-B / mistimed-A / weekly / valid-A / valid-B sequence also matched
the original verifier, including rejecting the mistimed replay.

Earlier trials of the same lifecycle design measured complete-batch reductions
of 25-29%. The table uses the final source, not the fastest trial. Host load and
warmup varied. Individual warm native-handler measurements were around 0.16-0.24 s
for Summer 1 and 0.48-0.56 s for the weekly track in one instrumented run; those
are not complete-batch or universal per-track timings. The reported 0.333 s result
on a Ryzen 5 7640U has not been independently reproduced on this machine.

The proof implementation fingerprint changes, with an explicit one-way audited
compatibility relation preserving eligible existing proofs, including Uplink.
Older catalog-specific exclusions remain. Historical witness fingerprints and
timestamps are not rewritten. The seven other fingerprint inputs are unchanged;
validator-lifecycle-audit.json records their hashes. CPU/wall/geometry limits,
priority, batch size, capture inputs and native-dispatch budgets are unchanged.

Physics calls remain sequential inside each engine. This follow-up does not claim
300-way concurrency or measured whole-workflow savings. A bounded, separately
measured pool would be needed before enabling safe multi-engine execution.
