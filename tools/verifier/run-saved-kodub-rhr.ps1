param(
    [Parameter(Mandatory = $true)][string]$TestedCommit,
    [Parameter(Mandatory = $true)][string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $root
if ($TestedCommit -notmatch '^[a-f0-9]{40}$' -or (git rev-parse HEAD).Trim() -ne $TestedCommit) {
    throw 'Checkout must be the independently tested implementation commit.'
}
$owned = @(
    'tools/verifier', 'tools/native-verification-ledger.mjs', 'tools/native-verification-policy.mjs',
    'tools/native-event-snapshot.mjs', 'tools/retained-native-board-cache.mjs',
    'tools/native-target-filter.mjs', 'tools/published-target-retention.mjs',
    'tools/native-snapshot-phase.mjs', 'tools/native-snapshot-phase.test.mjs',
    'tools/public-offline-verification.mjs', 'tools/public-offline-verification.test.mjs',
    'tools/public-snapshot-backup.mjs', 'tools/update-public-snapshot.mjs',
    'tools/verifier/track-geometry.json', 'tools/verifier/magicians-residence-review.test.cjs',
    'tools/verifier/local-snapshot-verification.mjs', 'tools/verifier/local-snapshot-verification.test.mjs',
    'tools/verifier/saved-event-offline-plan.mjs', 'tools/verifier/saved-event-offline.test.mjs',
    'tools/verifier/verify-saved-events.mjs', 'tools/verifier/run-saved-kodub-rhr.ps1'
)
$dirty = git status --porcelain --untracked-files=all -- $owned
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the tested verifier patch before native work; no dirty verifier source is admitted.' }
if (-not [IO.Path]::IsPathFullyQualified($RunDirectory) -or (Test-Path -LiteralPath $RunDirectory)) {
    throw 'A new absolute private run directory is required.'
}
$env:EXPECTED_SOURCE_COMMIT = $TestedCommit
$env:SNAPSHOT_SOURCE_COMMIT = '60922970ed7d31bbf2866e179a1c0374ae43a51b'
$env:SNAPSHOT_GENERATION = '85'
$env:SNAPSHOT_INDEX_SHA256 = '574af2694a76693bfb913de337b1ebd2749ce6d7159b45e62c805833ef2f47db'
$env:LEDGER_MANIFEST_SHA256 = '50a88045114a2e9e9174ea80c2f1b506943bcd757b55c9e2135e3a0fcf5bf7cb'
$env:LEDGER_ENTRIES = '19457'
$env:GITHUB_RUN_ATTEMPT = '1'
$env:NATIVE_JOB_LIMIT = '128'
$env:NATIVE_TARGET_SCOPE = 'all'
$env:TARGET_TRACK_IDS = '["b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f","fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778"]'
$env:WARMUP_FIRST_PROOF = '1'
& node tools/verifier/verify-saved-events.mjs $root $RunDirectory
if ($LASTEXITCODE -ne 0) { throw 'Bounded saved verification stopped. Preserve receipts; do not rerun or reset its budget.' }
