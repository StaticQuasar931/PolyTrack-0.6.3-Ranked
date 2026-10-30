import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {RELEASE_INFO as CURRENT_RELEASE_INFO} from './release-info.mjs';
const RELEASE_INFO = Object.freeze({number:224,version:'0.6.3',revision:193,notes:Object.freeze(['Current fixture notes.'])});
import {isCaptureCommit,manualReleaseNumber,parseReleaseInfo,validateReleaseInfo} from './check-release-info.mjs';
const manual = {title:'224-Help and Release Safety'};
const validate = (info = RELEASE_INFO, options = {}) => validateReleaseInfo(info,{manual,revision:193,...options});

test('central record has valid separate identities, frozen notes and no prospective hash', async()=>{
  assert.ok(Object.isFrozen(CURRENT_RELEASE_INFO)); assert.ok(Object.isFrozen(CURRENT_RELEASE_INFO.notes));
  assert.deepEqual(validate(CURRENT_RELEASE_INFO,{manual:{title:CURRENT_RELEASE_INFO.number+'-Current release'},revision:CURRENT_RELEASE_INFO.revision}),[]);
  assert.deepEqual(parseReleaseInfo(await fs.readFile(new URL('./release-info.mjs',import.meta.url),'utf8')),CURRENT_RELEASE_INFO);
  assert.equal(CURRENT_RELEASE_INFO.commit,undefined);
});
test('manual number parsing never confuses client revision or bot title with release number',()=>{
  for (const title of ['224-Help','224 - Help','224: Help']) assert.equal(manualReleaseNumber(title),224);
  for (const title of ['revision 193','Sync public ranked snapshots','224','224-','Help 224']) assert.equal(manualReleaseNumber(title),null);
});
test('capture exemption requires exact existing workflow title and bot identity',()=>{
  for (const title of ['Sync public ranked snapshots','Sync Kodub weekly fallback']) {
    const bot={title,name:'github-actions[bot]',email:'41898282+github-actions[bot]@users.noreply.github.com'};
    assert.equal(isCaptureCommit(bot),true);
    assert.equal(isCaptureCommit({...bot,name:'Human'}),false);
    assert.equal(isCaptureCommit({...bot,email:'human@example.test'}),false);
    assert.equal(isCaptureCommit({...bot,title:'224-Manual update'}),false);
    assert.equal(isCaptureCommit({...bot,title:title+' changed'}),false);
  }
});
test('missing, stale, future, placeholder and unchanged notes are release blocking',()=>{
  for(const notes of [undefined,[],[''],['   '],['TODO write notes'],[null]]) assert.ok(validate({...RELEASE_INFO,notes}).length);
  assert.ok(validate({...RELEASE_INFO,number:223}).some(error=>/stale/.test(error)));
  assert.ok(validate({...RELEASE_INFO,number:225}).some(error=>/ahead/.test(error)));
  assert.ok(validate(RELEASE_INFO,{previousInfo:{notes:[...RELEASE_INFO.notes]}}).some(error=>/every manual commit/.test(error)));
  assert.ok(validate(RELEASE_INFO,{manual:{title:'Unnumbered manual change'}}).length);
  assert.ok(validate({...RELEASE_INFO,revision:192}).length);
  assert.ok(validate({...RELEASE_INFO,commit:'224'}).length);
  assert.deepEqual(validate(RELEASE_INFO,{previousInfo:{notes:['Previous release notes.']}}),[]);
});
test('precommit explicitly permits expected next 224 while HEAD is manual 223',()=>{
  assert.deepEqual(validate(RELEASE_INFO,{manual:{title:'223-Workflow Fixes'},expectedNext:224}),[]);
  assert.ok(validate(RELEASE_INFO,{manual:{title:'223-Workflow Fixes'},expectedNext:225}).length);
  assert.ok(validate(RELEASE_INFO,{manual:{title:'224-Help'},expectedNext:224}).length);
  assert.ok(validate({...RELEASE_INFO,number:223},{manual:{title:'223-Workflow Fixes'},expectedNext:224}).length);
});
test('guard is local-only and current capture workflow titles remain recognized',async()=>{
  const source=await fs.readFile(new URL('./check-release-info.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/fetch\(|https?:|firebase|\bgit\(['"'](?:push|pull|fetch)['"']/i);
  for(const [file,title] of [['publish-verified-snapshots.yml','Sync public ranked snapshots'],['sync-event-catalog.yml','Sync public ranked snapshots'],['sync-kodub-weekly.yml','Sync Kodub weekly fallback']]){
    const workflow=await fs.readFile(new URL('../.github/workflows/'+file,import.meta.url),'utf8');
    assert.ok(workflow.includes('git commit -m "'+title+'"'));
    assert.ok(workflow.includes('git config user.name "github-actions[bot]"'));
    assert.ok(workflow.includes('41898282+github-actions[bot]@users.noreply.github.com'));
  }
});

import {checkReleaseInfo} from './check-release-info.mjs';
import {parseReleasePreparedAt,releaseAge} from './release-info.mjs';
import {prepareReleaseInfo,stampReleaseCommitTime} from './prepare-release-info.mjs';

test('preparation metadata is strict UTC, never guessed from missing or malformed dates',()=>{
  for(const value of [undefined,null,'','yesterday','2026-02-30T12:00:00.000Z','2026-01-01','2026-01-01T00:00:00Z','2026-01-01T00:00:00.000+00:00',42]){
    assert.equal(parseReleasePreparedAt(value),null,String(value));
    assert.deepEqual(releaseAge(value),{text:'Preparation time not recorded',nextUpdateMs:null});
  }
});

test('release age crosses precise minute, hour, day and week boundaries using wall time',()=>{
  const at='2026-10-01T12:00:00.000Z',base=Date.parse(at);
  for(const [elapsed,text] of [[0,'Less than a minute ago'],[59999,'Less than a minute ago'],[60000,'1 minute ago'],[120000,'2 minutes ago'],[3599999,'59 minutes ago'],[3600000,'1 hour ago'],[7200000,'2 hours ago'],[86399999,'23 hours ago'],[86400000,'1 day ago'],[172800000,'2 days ago'],[604799999,'6 days ago'],[604800000,'1 week ago'],[1209600000,'2 weeks ago']]){
    const age=releaseAge(at,base+elapsed);assert.equal(age.text,text);assert.ok(age.nextUpdateMs>0&&age.nextUpdateMs<=60000);
  }
  assert.equal(releaseAge(at,base+59999).nextUpdateMs,1);
  assert.equal(releaseAge(at,base+3599999).nextUpdateMs,1);
  assert.equal(releaseAge(at,base-1).text,'Device clock is before preparation time');
  assert.equal(releaseAge(at,NaN).nextUpdateMs,null);
});

test('release 225 guard requires a real, later, nonfuture preparation instant',()=>{
  const info={...RELEASE_INFO,number:225,revision:194,preparedAt:'2026-10-02T12:00:00.000Z'};
  const options={manual:{title:'224-Previous release'},expectedNext:225,revision:194,now:Date.parse('2026-10-02T13:00:00.000Z')};
  assert.deepEqual(validateReleaseInfo(info,options),[]);
  for(const preparedAt of [undefined,'2026-02-30T12:00:00.000Z','2026-10-03T12:00:00.000Z'])assert.ok(validateReleaseInfo({...info,preparedAt},options).length);
  assert.ok(validateReleaseInfo(info,{...options,previousInfo:{notes:['Older notes'],preparedAt:info.preparedAt}}).some(error=>/later preparation/.test(error)));
});

test('explicit release prep is deterministic, preserves notes and helpers, and refuses restamping',()=>{
  const source='const releaseInfo = '+JSON.stringify(RELEASE_INFO)+';\nexport const RELEASE_INFO=Object.freeze(releaseInfo);\n// Preserve helper code.';
  const input={number:225,revision:194,preparedAt:'2026-10-02T12:00:00.000Z'};
  const next=prepareReleaseInfo(source,input),info=parseReleaseInfo(next);
  assert.deepEqual(info,{...RELEASE_INFO,...input});
  assert.ok(next.endsWith('// Preserve helper code.'));
  assert.equal(prepareReleaseInfo(source,input),next);
  assert.equal(prepareReleaseInfo(next,input),next);
  assert.throws(()=>prepareReleaseInfo(next,{...input,preparedAt:'2026-10-03T12:00:00.000Z'}),/restamped/);
  for(const change of [{number:227},{number:223},{revision:193},{preparedAt:'invalid'}])assert.throws(()=>prepareReleaseInfo(source,{...input,...change}));
  assert.throws(()=>prepareReleaseInfo(next,{...input,number:226,revision:195}),/later/);
});

test('release checklist documents the existing CDN gate and generic preparation process',async()=>{
  const checklist=await fs.readFile(new URL('../docs/manual-release-checklist.md',import.meta.url),'utf8');
  const workflow=await fs.readFile(new URL('../.github/workflows/publish-cdn-release.yml',import.meta.url),'utf8');
  assert.match(checklist,/prepare-release-info\.mjs RELEASE_NUMBER CLIENT_REVISION ACTUAL_PREPARATION_UTC/);
  assert.match(checklist,/--test-concurrency=1/);
  assert.doesNotMatch(checklist,/Parent Integration For 224|precommit 224|No workflow was changed|v=193/);
  assert.match(workflow,/name: Check Help release information\s+run: node tools\/check-release-info\.mjs/);
  assert.ok(workflow.indexOf('name: Check Help release information')<workflow.indexOf('name: Validate immutable assets'));
});
function fixture({info=RELEASE_INFO,prior,head=224,captures=0,dirty=false,integrated=true,stamped=true,missing=false,cache=193,installed=193}={}) {
  const encode=record=>'const releaseInfo = '+JSON.stringify(record)+';';
  const bot=Array.from({length:captures},(_,i)=>`bot${i}\0github-actions[bot]\x0041898282+github-actions[bot]@users.noreply.github.com\0Sync public ranked snapshots`);
  const history=[...bot,`manual\0Human\0human@example.test\0${head}-Manual update`,`prior\0Human\0human@example.test\0${head-1}-Earlier update`].join('\n');
  const calls=[];
  const runGit=(...args)=>{
    calls.push(args);
    if(args[0]==='log')return history;
    if(args[0]==='ls-tree')return missing?'':'tools/release-info.mjs\n';
    if(args[0]==='show')return encode(prior||{...info,notes:['Earlier release.']});
    if(args[0]==='diff')return dirty?'tools/release-info.mjs\n':'';
    assert.fail('Unexpected Git operation: '+args.join(' '));
  };
  const read=file=>({
    'tools/release-info.mjs':encode(info),
    'site-version.json':JSON.stringify({revision:stamped?193:192}),
    'polytrack_062_patch.js':integrated?`import('./tools/release-info.mjs?v=${cache}');installSiteUpdates({revision:${installed}});renderHelpControls({release:releaseInfoModule.RELEASE_INFO});`:"renderHelpControls({release:{revision:192,notes:['Old notes']}})",
    'index.html':'<script src="polytrack_062_patch.js?v=193"></script>'
  })[file];
  return {runGit,read,calls};
}
test('repository guard skips arbitrarily long capture history with zero network or Git writes',()=>{
  const f=fixture({captures:600});
  assert.deepEqual(checkReleaseInfo(f).errors,[]);
  assert.ok(f.calls.every(([command])=>['log','ls-tree','show','diff'].includes(command)));
  assert.equal(checkReleaseInfo({...fixture({head:223}),expectedNext:224}).errors.length,0);
});
test('repository guard blocks inline metadata, unstamped revision and uncommitted pre-push fixes',()=>{
  for(const options of [{integrated:false},{stamped:false},{dirty:true},{missing:true},{cache:192},{installed:1930}]) assert.ok(checkReleaseInfo(fixture(options)).errors.length,JSON.stringify(options));
  const stale=fixture({prior:{...RELEASE_INFO,number:223}});
  assert.ok(checkReleaseInfo(stale).errors.some(error=>/every manual commit/.test(error)));
});

test('the recorded public commit date must match Git, not preparation or capture time',()=>{
  const committedAt='2026-10-01T12:00:00.000Z',info={...RELEASE_INFO,preparedAt:'2026-10-01T11:00:00.000Z',committedAt};
  const f=fixture({info,prior:{...info,number:223,notes:['Earlier release.'],preparedAt:'2026-09-30T12:00:00.000Z',committedAt:'2026-09-30T13:00:00.000Z'}});
  const check=date=>checkReleaseInfo({...f,runGit:(...args)=>args[0]==='show'&&args[2]==='--format=%cI'?date:f.runGit(...args)});
  assert.deepEqual(check(committedAt).errors,[]);
  assert.ok(check('2026-10-01T11:00:00Z').errors.some(error=>/actual manual Git commit/.test(error)));
  const source='const releaseInfo = '+JSON.stringify({...info,committedAt:undefined})+';';
  assert.equal(parseReleaseInfo(stampReleaseCommitTime(source,committedAt)).committedAt,committedAt);
  assert.throws(()=>stampReleaseCommitTime(source,'2026-10-01T12:00:00.123Z'),/actual commit instant/);
  const next=prepareReleaseInfo('const releaseInfo = '+JSON.stringify(info)+';',
    {number:225,revision:194,preparedAt:'2026-10-02T12:00:00.000Z'});
  assert.equal(parseReleaseInfo(next).committedAt,undefined,'a new release cannot inherit the prior commit date');
});
