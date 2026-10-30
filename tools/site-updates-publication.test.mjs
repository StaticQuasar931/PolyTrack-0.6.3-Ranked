import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseUpdateAge, formatReleaseUpdateAge, UPDATED_GAME_URL} from './site-updates.mjs';
import {renderHelpControls} from './help-controls.mjs';

const release = {number:243,revision:212,preparedAt:'2026-10-01T12:00:00.000Z',notes:['Clearer update information.']};
const metadata = {schemaVersion:1,repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',commit:'a'.repeat(40),
  revision:212,releaseNumber:243,committedAt:'2026-10-02T12:00:00Z'};
const now = Date.parse(metadata.committedAt) + 3600000;
function page(value=metadata, href=UPDATED_GAME_URL, baseURI=UPDATED_GAME_URL) {
  return {location:{href},baseURI,querySelector(selector) {
    assert.equal(selector,'meta[name="polytrack-site-publication"]');
    return {getAttribute(name) { assert.equal(name,'content');return typeof value==='string'?value:JSON.stringify(value); }};
  }};
}

test('preparation is never a public publication-age fallback',()=>{
  for (const value of [release,{...release,publishedAt:metadata.committedAt},{},
    {...release,committedAt:metadata.committedAt,commitConfirmed:true,commit:metadata.commit}]) {
    const age=releaseUpdateAge(value,{now});
    assert.equal(age.source,'unknown'); assert.equal(age.text,'Publication time unavailable');
    assert.equal(age.dateTime,''); assert.equal(age.title,''); assert.equal(age.nextUpdateMs,null);
  }
  assert.equal(formatReleaseUpdateAge(release.preparedAt,'prepared',now).source,'unknown');
  const html=renderHelpControls({release,now}),publicPanel=html.slice(html.indexOf('<section class="hc-release"'),html.indexOf('<details class="hc-release-technical">'));
  assert.match(publicPanel,/Publication time unavailable/);
  assert.doesNotMatch(publicPanel,/prepared|2026-10-01|Client revision/i);
  assert.match(html,/<details class="hc-release-technical"><summary>Developer details/);
  assert.match(html,/Prepared .*This is not a deployment timestamp/);
});

test('normal canonical Pages reads release-bound commit metadata locally without requests',()=>{
  const original=globalThis.fetch;
  globalThis.fetch=()=>assert.fail('Publication age must not fetch');
  try {
    for (const href of [UPDATED_GAME_URL,UPDATED_GAME_URL+'index.html',UPDATED_GAME_URL.slice(0,-1)]) {
      const document=page(metadata,href),age=releaseUpdateAge(release,{document,now});
      assert.equal(age.text,'Committed 1 hour ago'); assert.equal(age.source,'committed');
      assert.equal(age.dateTime,'2026-10-02T12:00:00.000Z');
      assert.equal(age.title,`Committed: ${new Date(metadata.committedAt).toLocaleString()}`);
      assert.equal(age.nextUpdateMs,60000);
      const html=renderHelpControls({release,document,now});
      assert.match(html,/>COMMITTED<\/p>/);
      assert.match(html,/data-release-at="2026-10-02T12:00:00.000Z" data-release-source="committed"/);
      assert.doesNotMatch(html,/>RELEASE PREPARED<\/p>/);
    }
  } finally { globalThis.fetch=original; }
});

test('stale, malformed, foreign or caller-mismatched Pages metadata fails closed',()=>{
  const invalid = [{...metadata,releaseNumber:242},{...metadata,revision:211},{...metadata,schemaVersion:2},
    {...metadata,repository:'other/repo'},{...metadata,commit:'main'},{...metadata,committedAt:'2026-02-30T12:00:00Z'},
    {...metadata,committedAt:'2026-10-02T12:00:00+00:00'},{...metadata,privateToken:'never consumed'},
    {...metadata,publishedAt:metadata.committedAt},null,[],{},'{broken','x'.repeat(2049)];
  for (const value of invalid) assert.equal(releaseUpdateAge(release,{document:page(value),now}).source,'unknown');
  for (const href of ['https://foreign.example/', 'https://staticquasar931.github.io.attacker.invalid/PolyTrack-0.6.3-Ranked/',
    'https://staticquasar931.github.io/another-game/','http://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/',
    'https://name:secret@staticquasar931.github.io/PolyTrack-0.6.3-Ranked/',
    'https://script.googleusercontent.com/userCodeAppPanel']) {
    assert.equal(releaseUpdateAge(release,{document:page(metadata,href),now}).source,'unknown');
  }
  assert.equal(releaseUpdateAge(release,{document:page(metadata,UPDATED_GAME_URL,'https://foreign.example/'),now}).source,'unknown');
  assert.equal(releaseUpdateAge(release,{document:page(),installedCommit:'b'.repeat(40),now}).source,'unknown');
  assert.equal(releaseUpdateAge({...release,revision:undefined},{document:page(),now}).source,'unknown');
});

test('real commit age still updates in minutes, hours and days and reports clock skew',()=>{
  const document=page(),start=Date.parse(metadata.committedAt);
  for (const [elapsed,text] of [[0,'less than a minute'],[60000,'1 minute'],[3600000,'1 hour'],[86400000,'1 day'],[1209600000,'14 days']]) {
    const age=releaseUpdateAge(release,{document,now:start+elapsed});
    assert.equal(age.text,`Committed ${text} ago`);
    assert.ok(age.nextUpdateMs>0&&age.nextUpdateMs<=60000);
  }
  assert.equal(releaseUpdateAge(release,{document,now:start-1}).text,'Device clock is before commit time');
});

test('explicit audited manual commit date needs no SHA and cannot be replaced by discovery',()=>{
  const options={verifiedReleaseCommitAt:'2026-10-02T12:00:00.000Z',now,
    document:{get baseURI(){assert.fail('Fixed release date must not consult discovery');}}};
  const age=releaseUpdateAge({...release,committedAt:'2030-01-01T00:00:00Z'},options);
  assert.equal(age.text,'Committed 1 hour ago'); assert.equal(age.source,'committed');
  assert.equal(age.dateTime,options.verifiedReleaseCommitAt);
  assert.equal(age.title,`Committed: ${new Date(options.verifiedReleaseCommitAt).toLocaleString()}`);
  for (const committedAt of ['2026-10-02T12:00:00.000Z','2026-10-02T12:00:00Z']) {
    const html=renderHelpControls({release,verifiedReleaseCommitAt:committedAt,now});
    assert.match(html,/>COMMITTED<\/p>/); assert.match(html,/data-release-fixed="true"/);
    assert.match(html,/title="Committed: /); assert.doesNotMatch(html,/>RELEASE PREPARED<\/p>/);
    const result=releaseUpdateAge(release,{verifiedReleaseCommitAt:committedAt,now,
      installedCommit:metadata.commit,verifiedSiteCommitMetadata:{...metadata,publishedAt:'2030-01-01T00:00:00Z'},
      verifiedReleasePointer:{schemaVersion:1,repository:metadata.repository,commit:metadata.commit,indexSha256:'b'.repeat(64),
        snapshotDirectory:'public-snapshots99',publishedAt:'2030-01-01T00:00:00Z'}});
    assert.equal(result.dateTime,age.dateTime); assert.equal(result.source,'committed');
  }
  for (const date of [null,'',true,1790942400000,'bad','2026-02-30T12:00:00Z','2026-10-02T12:00:00.123Z']) {
    assert.equal(releaseUpdateAge(release,{...options,verifiedReleaseCommitAt:date}).source,'unknown');
  }
  for (const field of ['committedAt','verifiedReleaseCommitAt']) {
    assert.equal(releaseUpdateAge({...release,[field]:options.verifiedReleaseCommitAt},{now}).source,'unknown');
  }
  assert.equal(releaseUpdateAge(release,{...options,now:Date.parse(options.verifiedReleaseCommitAt)+86400000}).text,'Committed 1 day ago');
});

test('final installedReleaseCommittedAt capability is used by notice/Help age, never ordinary release fields',()=>{
  const options={installedReleaseCommittedAt:metadata.committedAt,now};
  assert.equal(releaseUpdateAge(release,options).text,'Committed 1 hour ago');
  const html=renderHelpControls({release,...options});assert.match(html,/data-release-fixed="true"/);
  assert.match(html,/>COMMITTED<\/p>/);
  assert.equal(releaseUpdateAge({...release,installedReleaseCommittedAt:metadata.committedAt},{now}).source,'unknown');
});
