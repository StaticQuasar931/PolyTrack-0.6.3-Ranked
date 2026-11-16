import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import compatibility from './audited-verifier-compatibility.cjs';
import {buildNativeVerificationPolicy} from './native-verification-policy.mjs';
import {createLedgerEntry,ledgerBinding,ledgerKey,writeLedger,applyLedgerToBoard} from './native-verification-ledger.mjs';

const OLD='4a52404b07cb6a78944c5073de19a46cefc7f73efd82bb56490abe1b2f35d79f',MID='22dee8233571960694a09ff1f6934454cacbee1e2010aff81a02de369a91f5f3',CURRENT='3fd07e5bdf54fec2e699e88e6e507c9cff77eb4f152ce4afd429e0e728625553';
const ENGINE='7203ead74e290932abafe7f45ae5d121b5e1488b788f7dbe9ea95c8eb30d1ed1',VERSION='polytrack-native-bounded-v1';
const ADDED='b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f',DYNAMIC='7febc1003fa4afd5a79b917619abf8771a6caad0ad16a0383582a6a364544fb7';
const UPLINK='99fe53184c661a29a6b9125af16897c54c6ce228df05b22b8f3cd504ff9e8b37';
const sha=x=>createHash('sha256').update(x).digest('hex'),geometry={parts:20,spanX:100,spanZ:120},content=sha('independent fixture code');
const context={witnessEngineDigest:ENGINE,currentEngineDigest:ENGINE,witnessVerifierVersion:VERSION,currentVerifierVersion:VERSION,trackId:DYNAMIC};
const {verifierFingerprintsCompatible:compatible}=compatibility;
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'audited-compat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('exact directional audited relation admits unchanged dynamic trusted tracks, not the added exception',()=>{
 assert.equal(compatible(OLD,CURRENT,context),true);assert.equal(compatible(CURRENT,CURRENT,context),true);
 assert.equal(compatible(MID,CURRENT,context),true);
 assert.equal(compatible(MID,CURRENT,{...context,trackId:ADDED}),true,'Magician approval predates only the Uplink addition');
 for(const witness of [OLD,MID])assert.equal(compatible(witness,CURRENT,{...context,trackId:UPLINK}),false,'old witnesses cannot authorize the new exception');
 for(const [from,to,c] of [[CURRENT,OLD,context],[OLD,'f'.repeat(64),context],['f'.repeat(64),CURRENT,context],
  [OLD,CURRENT,{...context,trackId:ADDED}],[OLD,CURRENT,{...context,trackId:'invalid'}]])assert.equal(compatible(from,to,c),false);
 for(const key of ['witnessEngineDigest','currentEngineDigest','witnessVerifierVersion','currentVerifierVersion'])
  assert.equal(compatible(OLD,CURRENT,{...context,[key]:'changed'}),false);
 const source=fs.readFileSync(new URL('./audited-verifier-compatibility.cjs',import.meta.url),'utf8'),module={exports:{}};
 vm.runInNewContext(source,{module,require:()=>({verifierFingerprint:'f'.repeat(64)})});
 assert.equal(module.exports.verifierFingerprintsCompatible(OLD,CURRENT,context),false,'a future actual verifier cannot inherit the old pair');
});

function fixture(t,lane='normal',disposition='approved',id=DYNAMIC){
 const replay='fixture-replay',job={lane,accountId:sha('account'),trackId:id,timeMs:20001,frames:20001,
  uploadId:lane==='normal'?1:null,replayHash:sha(replay),replay};
 if(lane==='event')Object.assign(job,{periodId:'kodub_fixture',runId:sha('event-run')});
 job.resultId=lane==='event'?job.runId:job.accountId+'_'+id;
 const policy={engineDigest:ENGINE,compatibleEngines:[],verifierVersion:VERSION,verifierFingerprint:OLD,
  resourceProfiles:['standard'],reviewPolicyVersions:['snapshot-controls-v1'],trackContentHashes:{[id]:content},
  trackGeometries:{[id]:{geometryPolicy:'default',trackGeometry:geometry}}};
 const binding={verifierVersion:VERSION,verifierFingerprint:OLD,resourceProfile:'standard',resultId:job.resultId,
  trackId:id,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:sha(replay),nativeTrackId:id,trackContentHash:content,engineDigest:ENGINE};
 const nativeResult={...binding,binding,status:'verified',reason:'native_exact_finish',deterministic:true,
  trackGeometry:geometry,geometryPolicy:'default',boundInputFingerprint:sha(JSON.stringify(binding))};
 const result=disposition==='approved'?nativeResult:{...nativeResult,status:'unavailable',reason:'review_'+disposition};
 const entry=createLedgerEntry({job,nativeResult,result,review:{complete:true,disposition,bindingKey:ledgerKey(ledgerBinding(job)),
  policyVersion:'snapshot-controls-v1',attestationHash:sha('review')},verifiedAt:Date.now()-60000,policy});
 const ledger=writeLedger({root:temporary(t),entries:[entry],expectedManifestHash:null});
 const current={...policy,verifierFingerprint:CURRENT},board={trackId:id,...(lane==='event'?{periodId:job.periodId}:{}),entries:[{...job}]};
 return {entry,ledger,job,policy:current,apply:extra=>applyLedgerToBoard({board,ledger,canonicalRows:[job],recordings:[job],policy:current,lane,...extra})};
}

for(const lane of ['normal','event'])test('old '+lane+' witness is admitted without rewriting historical fingerprint',t=>{
 const f=fixture(t,lane);assert.equal(f.apply().report.verified,1);assert.equal(f.entry.witnesses[0].verifierFingerprint,OLD);
 assert.equal(f.apply({recordings:[]}).report.verified,0);
 assert.equal(f.apply({recordings:[{...f.job,replay:'changed'}]}).report.verified,0);
 assert.equal(f.apply({canonicalRows:[{...f.job,timeMs:f.job.timeMs+1,frames:f.job.frames+1}]}).report.verified,0);
 for(const patch of [{verifierFingerprint:'f'.repeat(64)},{engineDigest:'f'.repeat(64),compatibleEngines:[ENGINE]},
  {verifierVersion:'other-version'},{resourceProfiles:['extended-local']},{reviewPolicyVersions:['other-review']},
  {trackContentHashes:{[DYNAMIC]:'f'.repeat(64)}},{trackGeometries:{[DYNAMIC]:{geometryPolicy:'default',trackGeometry:{...geometry,parts:21}}}}])
  assert.equal(f.apply({policy:{...f.policy,...patch}}).report.verified,0);
 const added=fixture(t,lane,'approved',ADDED);assert.equal(added.apply().report.verified,0);
});

for(const disposition of ['held','excluded'])test('old '+disposition+' disposition stays authoritative',t=>{
 const f=fixture(t,'event',disposition);assert.equal(f.apply().report[disposition],1);assert.equal(f.apply().report.verified,0);
});

test('policy materializes old static/dynamic witnesses only after independent code and geometry checks',t=>{
 const root=temporary(t),STATIC='a'.repeat(64),write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 write('tracks/unit.track','independent fixture code');write('tools/verifier/engine-manifest.json',{engineDigest:ENGINE,tracks:{'tracks/unit.track':content}});
 write('tools/verifier/track-geometry.json',{tracks:[{id:STATIC,name:'tracks/unit.track',hash:content}]});write('extra-tracks/catalog.json',[]);
 write('events/kodub/assets/'+content+'.track','independent fixture code');
 write('events/kodub/trusted-tracks.json',[DYNAMIC,ADDED].map(trackId=>({trackId,codeHash:content,assetPath:'assets/'+content+'.track'})));
 const witness=trackId=>({binding:{trackId},witnesses:[{engineDigest:ENGINE,verifierVersion:VERSION,verifierFingerprint:OLD,
  trackContentHash:content,geometryPolicy:'default',trackGeometry:geometry}]});
 const entries=[witness(STATIC),witness(DYNAMIC),witness(ADDED)],policy=buildNativeVerificationPolicy({root,entries});
 assert.equal(policy.trackContentHashes[STATIC],content);assert.equal(policy.trackContentHashes[DYNAMIC],content);
 assert.equal(policy.trackContentHashes[ADDED],undefined);assert.equal(policy.verifierFingerprint,CURRENT);
 const bad=witness(DYNAMIC);bad.witnesses[0].trackContentHash='f'.repeat(64);
 assert.throws(()=>buildNativeVerificationPolicy({root,entries:[bad]}),/independent asset pin/);
 const badGeometry=witness(DYNAMIC);badGeometry.witnesses[0].trackGeometry={parts:100000,spanX:1,spanZ:1};
 assert.throws(()=>buildNativeVerificationPolicy({root,entries:[badGeometry]}),/geometry policy/);
 const unknown=witness(DYNAMIC);unknown.witnesses[0].verifierFingerprint='f'.repeat(64);
 assert.deepEqual(buildNativeVerificationPolicy({root,entries:[unknown]}).trackContentHashes,{});
});
