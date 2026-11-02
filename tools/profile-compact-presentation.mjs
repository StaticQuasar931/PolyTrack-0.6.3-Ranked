function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function knownCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Counts are supplied by the caller, never inferred from local PBs or totals. */
export function compactProfileParticipationMarkup(entry, savedExtraCount = 0, { escapeHtml = escapeAttribute } = {}) {
  const official = knownCount(entry?.officialCount);
  const community = knownCount(entry?.communityCount);
  const extra = knownCount(entry?.extraCount);
  const custom = knownCount(entry?.customCount);
  const otherCustom = custom !== null && extra !== null && custom >= extra ? custom - extra : null;
  const local = knownCount(savedExtraCount);
  const note = local !== null && local > 0 && (extra === null || local > extra)
    ? `${local} local Extra PBs; not a completed-track total.` : '';
  const rows = [['Official', official], ['Community', community], ['Extra', extra], ['Custom', otherCustom]];
  return '<div class="profile-participation"><span>Completed tracks</span>' +
    '<dl class="profile-participation-counts" aria-label="Completed tracks by type">' +
    rows.map(([label, count]) => {
      const meaning = label === 'Custom' ? 'Custom excluding Extra' : label;
      const detail = [label === 'Custom' ? 'Excludes Extra.' : '', label === 'Extra' ? note : ''].filter(Boolean).join(' ');
      return '<div' + (detail ? ` title="${escapeHtml(detail)}"` : '') + '>' +
        `<dt>${label}</dt><dd aria-label="${escapeHtml(`${meaning}: ${count === null ? 'Not loaded' : count}${label === 'Extra' && note ? `. ${note}` : ''}`)}">${count === null ? '?' : count}</dd></div>`;
    }).join('') + '</dl></div>';
}

/** medalIcon returns a trusted native image URL, not markup. No zero medals are invented. */
export function compactProfileAchievementMarkup(medals, { escapeHtml = escapeAttribute, medalIcon } = {}) {
  const rows = [['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']]
    .map(([kind, label]) => [kind, label, knownCount(medals?.[kind])]);
  const earned = rows.filter(([, , count]) => count !== null && count > 0);
  if (!earned.length) {
    const unknown = rows.some(([, , count]) => count === null);
    const label = unknown ? 'Podiums not loaded' : 'No eligible podiums yet';
    const detail = unknown ? 'Podium counts unavailable.' : 'Top 3 on recognized tracks with 5+ racers.';
    return `<p class="profile-no-medals" title="${escapeHtml(detail)}" aria-label="${escapeHtml(`${label}. ${detail}`)}">${label}</p>`;
  }
  return earned.map(([kind, label, count]) => {
    const url = typeof medalIcon === 'function' ? medalIcon(kind) : '';
    const image = typeof url === 'string' && url ? `<img src="${escapeHtml(url)}" alt="">` : '';
    return `<span class="profile-achievements profile-medal-card ${kind}" title="${escapeHtml(`${label}: top 3 on recognized tracks with 5+ racers.`)}" aria-label="${escapeHtml(`${label} podiums: ${count}`)}">${image}<b>${count}</b><small>${label}</small></span>`;
  }).join('');
}
