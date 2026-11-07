import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildTrackStatistics, encodeSnapshot, decodeSnapshot, publishSnapshot, MAX_DECODED_BYTES, MAX_FILE_BYTES} from './snapshot-package.mjs';
import {buildTrackSnapshotPaging} from './track-snapshot-paging.mjs';
import {assertCdnAssetSizes} from './publish-cdn-release.mjs';
const trackId='a'.repeat(64),one='b'.repeat(64),two='c'.repeat(64);
const winner={accountId:one,name:'Board leader',rank:1,timeMs:10000,pbAt:1700000000000,runVerified:true,weight:2};
const runner={accountId:two,name:'Runner-up',rank:2,timeMs:11000,weight:2};
const board=(patch={})=>({trackId,complete:true,totalEntries:2,updatedAt:1800000000000,entries:[winner,runner],...patch});
const files=(value=board(),record={path:`tracks/${trackId}.json`})=>[
  {logicalPath:'manifest.json',value:{trackIdsKnown:1,tracks:{[trackId]:record}}},
  ...(value?[{logicalPath:`tracks/${trackId}.json`,value}]:[])
];
const row=(value,record)=>buildTrackStatistics(files(value,record)).tracks[trackId];

test('schema 1 compact leader matches the complete board and record time under reordered input',()=>{
  const expected={accountId:one,name:'Board leader',timeMs:10000,pbAt:1700000000000,runVerified:true};
  for(const entries of [[winner,runner],[runner,winner]]){
    const source=board({entries}),stats=buildTrackStatistics(files(source));
    const full=buildTrackSnapshotPaging(source).preview.entries[0];
    assert.equal(stats.schemaVersion,1);assert.equal(stats.complete,true);
    assert.deepEqual(stats.tracks[trackId].leader,expected);
    assert.equal(stats.tracks[trackId].leader.accountId,full.accountId);
    assert.equal(stats.tracks[trackId].leader.timeMs,full.timeMs);
  }
});
test('complete exact-time source without supplied ranks uses the same account tie order as full-board paging',()=>{
  const entries=[{accountId:two,timeMs:10000,name:'Tie loser'},{userId:one,timeMs:10000,nickname:'Tie winner'}];
  const source=board({entries});
  assert.equal(row(source).leader.accountId,buildTrackSnapshotPaging(source).preview.entries[0].userId);
  assert.deepEqual(row(source).leader,{accountId:one,name:'Tie winner',timeMs:10000,pbAt:null});
});
test('missing, empty and partial sources omit leader rather than guessing from a prefix or another file',()=>{
  for(const source of [null,board({entries:[],totalEntries:0}),board({complete:false}),
    board({totalEntries:10}),board({entries:[winner,winner]}),board({entries:[winner,null]})]){
    assert.equal(Object.hasOwn(row(source),'leader'),false);
  }
  assert.equal(Object.hasOwn(row(board(),{path:null}),'leader'),false);
});
test('leader authority fails closed without changing legacy count/weight completeness semantics',()=>{
  for(const patch of [{trackId:two},{sourceComplete:false},{ranksExact:false},{totalEntriesExact:false},
    {authoritative:false},{sourceAuthoritative:false}]){
    const result=row(board(patch));
    assert.equal(Object.hasOwn(result,'leader'),false);
    assert.equal(result.count,2);assert.equal(result.players,2);assert.equal(result.weight,2);assert.equal(result.complete,true);
  }
  assert.equal(Object.hasOwn(row(board(),{path:`tracks/${two}.json`}), 'leader'),false);
  for(const patch of [{complete:false},{sourceComplete:false},{ranksExact:false},{totalEntriesExact:false},{missing:true}])
    assert.equal(row(board(),{path:`tracks/${trackId}.json`,...patch}).leader,undefined);
  assert.equal(row(board({entries:[{...winner,userId:two},runner]})).leader,undefined);
});
test('invalid or unavailable exact time never promotes an apparently valid runner-up',()=>{
  for(const timeMs of [null,undefined,0,-1,1.5,'10000',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    assert.equal(row(board({entries:[{...winner,timeMs},runner]})).leader,undefined);
    assert.equal(row(board({entries:[winner,{...runner,timeMs}]})).leader,undefined);
  }
});
test('contradictory rank-one evidence and local/rejected rows cannot advertise an authoritative leader',()=>{
  for(const entries of [[{...winner,rank:2},runner],[winner,{...runner,rank:1}],
    [{...winner,globalRank:2},runner],[{...winner,position:'1'},runner],
    [{...winner,timeMs:12000},runner],...['local','localPending','pending'].map(key=>[{...winner,[key]:true},runner]),
    [{...winner,validationState:'rejected'},runner],[winner,{...runner,verificationStatus:'mismatch'}]]){
    assert.equal(row(board({entries})).leader,undefined);
  }
});
test('leader is a bounded public allowlist, not a copied identity/cosmetics/run document',async()=>{
  const source=board({entries:[{...winner,name:'  \uFF21\u0000\u202e  '+ 'x'.repeat(200),
    email:'private-email',token:'private-token',profileCosmetics:{theme:'private-theme'},countryCode:'GB',
    replayHash:'private-hash',uploadId:'private-upload',recording:{frames:'private-frames'}},runner]});
  const stats=buildTrackStatistics(files(source)),leader=stats.tracks[trackId].leader;
  assert.equal(leader.name,'A '+'x'.repeat(22));assert.equal(leader.name.length,24);
  assert.deepEqual(Object.keys(leader).sort(),['accountId','name','pbAt','runVerified','timeMs']);
  const encoded=await encodeSnapshot(stats),decoded=JSON.parse(Buffer.from(await decodeSnapshot(encoded)).toString('utf8'));
  assert.deepEqual(decoded,stats);assert.doesNotMatch(JSON.stringify(decoded),/private-|profileCosmetics|countryCode|replayHash|uploadId|recording/);
  assert.equal(source.entries[0].name.includes('\u202e'),true,'source evidence is not mutated');
});
test('PB date is observed run evidence, not snapshot freshness; verification is never invented',()=>{
  for(const pbAt of [undefined,null,0,-1,'1700000000000',1.5,Infinity,8640000000000001]){
    const result=row(board({entries:[{...winner,pbAt,runVerified:'true'},runner]})).leader;
    assert.equal(result.pbAt,null);assert.equal(Object.hasOwn(result,'runVerified'),false);
  }
  assert.equal(row(board({entries:[{...winner,pbAt:null,createdAt:1700000000001,runVerified:false},runner]})).leader.pbAt,1700000000001);
  assert.equal(row(board({entries:[{...winner,runVerified:false},runner]})).leader.runVerified,false);
  assert.equal(row(board({entries:[{...winner,name:null,nickname:null},runner]})).leader.name,'');
});
test('current-directory name overlay belongs to the real caller and matches a full-board row',async()=>{
  const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const context=vm.createContext({snapshotRacerDirectoryEntries:{[one]:{name:'Current directory name',updatedAt:1800000000100}},
    cleanUserId:value=>String(value||''),activeRankedAccountId:()=>two,readJsonStorage:()=>null,PROFILE_COSMETICS_KEY:'unused'});
  for(const name of ['snapshotRacerDirectoryIdentity','rowIdentityFreshness','overlaySnapshotRacerDirectory']){
    const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',start);
    assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end+4),context);
  }
  const leader=row(board()).leader;
  assert.equal(leader.name,'Board leader','packaging does not guess current identity');
  const compact=context.overlaySnapshotRacerDirectory([leader],1800000000000)[0];
  const full=context.overlaySnapshotRacerDirectory([winner],1800000000000)[0];
  assert.equal(compact.name,'Current directory name');assert.equal(compact.name,full.name);
  assert.equal(compact.timeMs,full.timeMs);assert.equal(compact.accountId,full.accountId);
  assert.equal(leader.name,'Board leader');
});
test('schema 1 remains readable when old packages have no optional leader',async()=>{
  const stats=buildTrackStatistics(files(board({entries:[{accountId:one,weight:2},{accountId:two,weight:2}]})));
  assert.equal(stats.schemaVersion,1);assert.equal(stats.tracks[trackId].leader,undefined);
  assert.equal(stats.tracks[trackId].players,2);
  assert.deepEqual(JSON.parse(Buffer.from(await decodeSnapshot(await encodeSnapshot(stats))).toString('utf8')),stats);
});
test('468-track statistics remain below package/CDN caps and existing hard limits still reject oversize',async()=>{
  const tracks={},input=[];
  for(let index=1;index<=468;index++){
    const id=index.toString(16).padStart(64,'0');tracks[id]={path:`tracks/${id}.json`};
    input.push({logicalPath:`tracks/${id}.json`,value:board({trackId:id})});
  }
  const stats=buildTrackStatistics([{logicalPath:'manifest.json',value:{tracks,trackIdsKnown:468}},...input]);
  assert.equal(Object.values(stats.tracks).filter(value=>value.leader).length,468);
  assert.ok(Buffer.byteLength(JSON.stringify(stats))<MAX_DECODED_BYTES);
  const bytes=await encodeSnapshot(stats);assert.ok(bytes.length<MAX_FILE_BYTES);
  assert.doesNotThrow(()=>assertCdnAssetSizes([{path:'track-statistics.bin',bytes:bytes.length}]));
  assert.throws(()=>assertCdnAssetSizes([{path:'track-statistics.bin',bytes:20000000}]),/under 20,000,000/);
  await assert.rejects(encodeSnapshot({padding:'x'.repeat(MAX_DECODED_BYTES)}),/Decoded snapshot exceeds/);
});
test('published package carries compact leader through normal content-addressed encode/decode without networking',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('statistics package test is offline'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-statistics-'));
  t.after(async()=>{
    const absolute=await fs.realpath(root),temporary=await fs.realpath(os.tmpdir()),relative=path.relative(temporary,absolute);
    assert.ok(relative.startsWith('snapshot-statistics-')&&!relative.includes(path.sep));
    await fs.rm(absolute,{recursive:true,force:true});
  });
  const staging=path.join(root,'staging');await fs.mkdir(path.join(staging,'tracks'),{recursive:true});
  for(const file of files(board()))await fs.writeFile(path.join(staging,file.logicalPath),JSON.stringify(file.value));
  const result=await publishSnapshot({root,stagingDirectory:staging,historyDirectory:path.join(root,'history')});
  const index=JSON.parse(await fs.readFile(path.join(root,result.directory,'index.json'),'utf8'));
  const item=index.files['track-statistics.json'],bytes=await fs.readFile(path.join(root,result.directory,item.path));
  const stats=JSON.parse(Buffer.from(await decodeSnapshot(bytes)).toString('utf8'));
  assert.deepEqual(stats.tracks[trackId].leader,row(board()).leader);
  assert.equal(item.decodedBytes,Buffer.byteLength(JSON.stringify(stats)+'\n'));
  assert.match(item.path,/^[a-f0-9]{64}\.bin$/);assert.equal(index.encoding,'gzip-xor-a7-v1');
});
