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
