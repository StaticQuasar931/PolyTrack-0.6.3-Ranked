import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const source=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const renderStart=source.indexOf('  function renderEntryRow(');
const after=source.slice(renderStart,source.indexOf('\n  }',renderStart)+4);
function fn(name) {
  const start=source.indexOf('  function '+name+'(');
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n  }',start)+4);
}
const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(decimals=3) {
  const ctx=vm.createContext({
    Number,Date,Object,Math,MIN_RANKED_TRACKS:3,TOTAL_TRACKS:10,AVERAGE_PLACEMENT_VERSION:2,OVERALL_PAGE_SIZE:15,
    overallCategory:'overall',overallCompletionScope:'all',overallRankingScope:'all',
    localStorage:{getItem:()=>String(decimals)},escapeHtml,cleanUserId:String,safeDisplayName:value=>value,
    normalizeEntries:rows=>rows.map(row=>({...row})),normalizeCarColorId:()=>'',
    __pt062NormalizeStyle:()=>'',__pt062GetRememberedStyle:()=>'',categoryTrackMarkup:()=>'',
    activeRankedAccountId:()=> 'self',categoryContextMarkup:()=>'',completedTrackCount:()=>3,
    eligibleWinCount:()=>0,improvedRacerScore:()=>0,risingRacerScore:()=>0,rankingMetricFor:()=>({known:true,value:1}),
    rankedWeightTitle:()=>'',LEADERBOARD_INFO:{overall:'Rank points.'},preciseDurationLabel:()=>'',
    compactParticipationMeta:()=>'',medalSummaryMarkup:()=>'',cosmeticTitleText:()=>'',
    profileBadgeMarkup:()=>'',racerCosmeticClasses:()=>'',carModelPreview:()=>'',countryFlagMarkup:()=>''
  });
  vm.runInContext(fn('rpDecimals')+'\n'+fn('formatRp')+'\n'+after,ctx);
  return {ctx,render:entry=>ctx.renderEntryRow(entry,0)};
}
function row(score=10.1234,rank=2,originScore=10.1234,originRank=2) {
  return {userId:'self',name:'Racer',score,rank,raceCount:3,totalTracks:10,localPending:true,
    localEstimateOrigin:{score:originScore,rank:originRank}};
}
function title(html) {return html.match(/<span class="overall-rank" title="([^"]*)"/)[1];}
function aria(html) {return html.match(/aria-label="([^"]*)"/)[1];}

test('identical displayed RP and rank suppress comparison in both tooltip and ARIA but retain unpublished status',()=>{
  const entry=row(),saved=JSON.stringify(entry),html=fixture().render(entry);
  for(const value of [title(html),aria(html)]) {
    assert.match(value,/Local estimate\./);
    assert.ok(value.length<145,'estimate stays concise');
    assert.doesNotMatch(value,/Local estimate:|Snapshot:/);
    assert.match(value,/Pending verification\./);
  }
  assert.equal(JSON.stringify(entry),saved);assert.equal(entry.localPending,true);
});

test('comparison follows every supported precision, not raw floating-point equality',()=>{
  for(const decimals of [2,3,4]) {
    const f=fixture(decimals),entry=row(10.123401,2,10.123402,2);
    assert.match(title(f.render(entry)),/Local estimate\. Pending verification\./);
  }
  const entry=row(10.12344,2,10.12346,2);
  assert.match(title(fixture(3).render(entry)),/Local estimate\. Pending verification\./);
  assert.match(title(fixture(4).render(entry)),/Local estimate: 10.1234 RP\. Snapshot: 10.1235 RP\./);
});

test('a rank-only change remains announced even when displayed RP matches',()=>{
  const html=fixture().render(row(10.123401,1,10.123402,2));
  for(const value of [title(html),aria(html)]) {
    assert.match(value,/Local estimate: #1\. Snapshot: #2\./);
    assert.doesNotMatch(value,/Displayed RP and rank match|10\.123 RP, #/);
  }
});

test('a score-only change compares only RP; both changes compare both fields',()=>{
  assert.match(title(fixture().render(row(9.1234,2,10.1234,2))),/Local estimate: 9\.123 RP\. Snapshot: 10\.123 RP\./);
  assert.match(title(fixture().render(row(9.1234,1,10.1234,2))),/Local estimate: 9\.123 RP, #1\. Snapshot: 10\.123 RP, #2\./);
});

test('filtered place is never falsely compared to the snapshot global rank',()=>{
  const entry={...row(),filteredRank:1,filteredTotal:5,globalRank:2},html=fixture().render(entry);
  assert.match(aria(html),/Filtered place 1 of 5\. Global rank 2\./);
  assert.match(aria(html),/Local estimate\. Pending verification\./);
  const changed=fixture().render({...entry,rank:3});
  assert.match(aria(changed),/Local estimate: #3\. Snapshot: #2\./);
});

test('plain snapshot and separately captured-board notices retain their established wording',()=>{
  const entry=row();delete entry.localEstimateOrigin;
  assert.equal(title(fixture().render(entry)),'Snapshot ranking.');
  entry.casualProjection={captureRecalculated:true};
  assert.equal(title(fixture().render(entry)),'Track-board estimate. Verified PBs only.');
});

test('complete row ARIA and title remain escaped with untrusted names',()=>{
  const html=fixture().render({...row(),name:'Racer" <tag>&'});
  assert.match(aria(html),/Racer&quot; &lt;tag&gt;&amp;/);
  assert.ok(aria(html).includes(title(html)));
  assert.doesNotMatch(html,/<tag>/);
});

test('score hover and accessible note use the same concise estimate without the long ranking help',()=>{
  const html=fixture().render(row(9.1234,1,10.1234,2));
  const note=html.match(/<div class="overall-stats" title="([^"]*)" aria-label="([^"]*)"/);
  assert.ok(note);
  assert.equal(note[1],note[2]);
  assert.equal(note[1],title(html));
  assert.ok(note[1].length<110);
  assert.doesNotMatch(note[1],/Rank points\.|public standings|Unpublished/);
});
