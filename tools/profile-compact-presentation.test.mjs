import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactProfileParticipationMarkup as participation, compactProfileAchievementMarkup as achievements } from './profile-compact-presentation.mjs';

test('four types preserve genuine zero and announce unknown counts', () => {
  const html = participation({ officialCount: 0, communityCount: 2 });
  assert.equal((html.match(/<dt>/g) || []).length, 4);
  assert.match(html, /Official: 0/);
  assert.match(html, /Community: 2/);
  assert.equal((html.match(/Not loaded/g) || []).length, 2);
  assert.equal((html.match(/>\?<\/dd>/g) || []).length, 2);
  assert.doesNotMatch(html, /NaN|undefined|null/);
});

test('Custom excludes Extra without clamping malformed scope to zero', () => {
  assert.match(participation({ customCount: 9, extraCount: 4 }), /Custom excluding Extra: 5/);
  assert.match(participation({ customCount: 4, extraCount: 4 }), /Custom excluding Extra: 0/);
  for (const entry of [{ customCount: 3, extraCount: 4 }, { customCount: 3 }, { extraCount: 0 }]) {
    assert.match(participation(entry), /Custom excluding Extra: Not loaded/);
  }
});

test('invalid counts stay unknown, with no coercion or local total substitution', () => {
  for (const value of [undefined, null, '', '3', NaN, Infinity, -1, 1.5, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const html = participation({ officialCount: value, communityCount: value, extraCount: value, customCount: value }, 7);
    assert.equal((html.match(/>\?<\/dd>/g) || []).length, 4);
    assert.doesNotMatch(html, /<dd[^>]*>7</);
  }
  assert.match(participation({ officialCount: Number.MAX_SAFE_INTEGER }), /Official: 9007199254740991/);
});

test('local Extra PB caveat is conditional, concise, and accessible without visible prose', () => {
  const html = participation({ extraCount: 2 }, 3);
  assert.match(html, /title="3 local Extra PBs; not a completed-track total\."/);
  assert.match(html, /aria-label="Extra: 2\. 3 local Extra PBs;/);
  assert.doesNotMatch(html, /<small|profile-participation-note/);
  for (const count of [0, 1, 2, -1, NaN, '4']) assert.doesNotMatch(participation({ extraCount: 2 }, count), /local Extra PBs/);
  assert.match(participation({}, 3), /Extra: Not loaded\. 3 local Extra PBs/);
});

test('known empty medals are one quiet line with eligibility only in attributes', () => {
  const html = achievements({ gold: 0, silver: 0, bronze: 0 });
  assert.match(html, />No eligible podiums yet<\/p>$/);
  assert.match(html, /title="Top 3 on recognized tracks with 5\+ racers\."/);
  assert.doesNotMatch(html, /<small|<img|<b/);
});

test('missing and malformed medals never imply an empty known podium total', () => {
  for (const medals of [undefined, null, {}, { gold: 0 }, { gold: '2', silver: -1, bronze: NaN }, { gold: Infinity, silver: 1.5, bronze: false }]) {
    const html = achievements(medals);
    assert.match(html, />Podiums not loaded<\/p>$/);
    assert.doesNotMatch(html, /No eligible|NaN|<b>0/);
  }
});

test('only valid earned medals render, native callback receives canonical keys', () => {
  const calls = [];
  const medals = Object.freeze({ gold: 2, silver: 0, bronze: 1 });
  const html = achievements(medals, { medalIcon: kind => { calls.push(kind); return `images/${kind}.svg`; } });
  assert.deepEqual(calls, ['gold', 'bronze']);
  assert.equal((html.match(/profile-achievements /g) || []).length, 2);
  assert.match(html, /Gold podiums: 2/);
  assert.match(html, /alt=""/);
  assert.doesNotMatch(html, /silver|<b>0/);
  assert.doesNotMatch(achievements({ gold: 2, silver: '9', bronze: -1 }), /Silver|Bronze|NaN/);
});

test('escape callback is supported and native icon URLs cannot break attribute boundaries', () => {
  const html = achievements({ gold: 1 }, { medalIcon: () => 'native.svg" onerror="bad<&\'' });
  assert.match(html, /native\.svg&quot; onerror=&quot;bad&lt;&amp;&#39;/);
  assert.doesNotMatch(html, /src="native\.svg" onerror=/);
  const calls = [];
  const escapeHtml = value => { calls.push(value); return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); };
  assert.match(achievements({ gold: 1 }, { escapeHtml, medalIcon: () => 'gold.svg?a=1&b=2' }), /a=1&amp;b=2/);
  participation({}, 5, { escapeHtml });
  assert.ok(calls.includes('Extra: Not loaded. 5 local Extra PBs; not a completed-track total.'));
  assert.doesNotMatch(participation({ officialCount: '<script>bad</script>' }), /<script>/);
});

test('helpers are pure and never access runtime data or platform APIs', () => {
  const entry = Object.freeze({ officialCount: 1, communityCount: 2, customCount: 6, extraCount: 3 });
  assert.equal(participation(entry, 7), participation(entry, 7));
  const source = fs.readFileSync(new URL('./profile-compact-presentation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:document|window|fetch|localStorage|Firebase|Date)\b|^import\s/m);
});
