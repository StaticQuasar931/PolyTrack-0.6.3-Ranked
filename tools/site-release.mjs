export function stampClientRelease(patch, index, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid release revision');
  if (!patch.includes('installSiteUpdates({revision:') || !/polytrack_062_patch\.js\?v=\d+/.test(index)) {
    throw new Error('Release anchors are missing. No files were changed.');
  }
  patch = patch.replace(/installSiteUpdates\(\{revision:\d+/, `installSiteUpdates({revision:${revision}`)
    .replace(/(filter-(?:runtime|menu|groups)\.(?:mjs|css)|site-updates\.mjs)\?v=\d+/g, `$1?v=${revision}`)
    .replace(/(events\/client\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(tools\/(?:firebase-usage|snapshot-update-check|partial-replay-selection|release-info|finish-presentation|help-controls|public-snapshot-client|record-placement|snapshot-metadata-recovery|ranked-live-snapshot|practice-history|practice-native|developer-diagnostics|practice-profile|local-diagnostics|local-insights|leaderboard-latency-hook|opponent-presets|control-usage|kodub-practice-track|overall-local-controller|overall-local-projection|native-track-search|search-text|unique-profile-name)\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(kodub-weekly\.mjs|tools\/firebase-auth-app\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(const extraCatalogRevision=)['"]\d+['"]/, `$1'${revision}'`);
  patch = patch.replace(/headers\.set\('X-PolyTrack-Revision', String\(\d+\)\)/g, `headers.set('X-PolyTrack-Revision', String(${revision}))`);
  patch = patch.replace(/createLocalInsights\(\{storage,revision:\d+\}\)/g, `createLocalInsights({storage,revision:${revision}})`);
  patch = patch.replace(/(release:\{version:VERSION,revision:)\d+/, '$1'+revision);
  index = index.replace(/polytrack_062_patch\.js\?v=\d+/, `polytrack_062_patch.js?v=${revision}`)
    .replace(/(main\.bundle\.js)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(public-name-policy\.js)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/((?:home-ui|responsive-ui|practice-responsive|help-controls)\.css)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(tools\/responsive-ui\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(events\/(?:events\.css|client\.mjs))(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`);
  return {patch, index};
}

// Event imports and the native bridge must share one dialog instance/cache version.
export function stampEventClientRelease(source, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid release revision');
  if (!source.includes('../tools/partial-replay-selection.mjs')) throw Error('Event release anchors are missing. No files were changed.');
  return source.replace(/(\.\.\/tools\/partial-replay-selection\.mjs|\.\/archive-(?:view|track)\.mjs)(?:\?v=\d+)?(['"])/g, '$1?v='+revision+'$2');
}
