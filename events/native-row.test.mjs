import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const opponentReview=JSON.parse(fs.readFileSync(new URL('../docs/events/opponent-shortcut-ui-engine-review.json',import.meta.url),'utf8'));
function removeReviewedOpponentInsertions(source,review=opponentReview){
 assert.equal(review.currentEngine,'7cd54f05e02b66c67133fd856f025c829c21d600d8ef6a9071df62b4fb5905c4');
 assert.equal(review.previousEngine,'8249dd184ae2e804b77a2eb3b6551a5569ace0e2695a9de235ecae0bb32efd4b');
 assert.deepEqual(review.changedAssets,['main.bundle.js']);
 assert.equal(review.currentMainBundleSha256,'ac4c96b08a49574d2194bc9de83349680d50b6ffe70deedd546c333af9313b4d');
 assert.equal(review.previousMainBundleSha256,'0115f59210ea8c49c96ab1e8ed499bbf9da5aa98ee1b7df50b591f53bbc4d1b1');
 assert.equal(digest(source),review.currentMainBundleSha256,'served bundle matches the exact reviewed UI revision');
 assert.equal(review.normalizedUiInsertions.length,2,'only the two reviewed opponent UI insertions are allowed');
 assert.equal(review.normalizedUiInsertions[0],'d.dataset.sqRecordingId=String(l),');
 assert.ok(review.normalizedUiInsertions[1].startsWith('(0,R.gn)(this,Fo,"f").__pt062OpponentSelection={version:1,'));
 for(const insertion of review.normalizedUiInsertions){assert.equal(source.split(insertion).length,2,'reviewed opponent UI insertion exists exactly once');source=source.replace(insertion,'');}
 assert.equal(digest(source),review.previousMainBundleSha256,'removing only the two reviewed UI insertions restores the exact prior bundle');
 return source;
}

test('native event row hook changes only reviewed UI anchors in the bundle',()=>{
 let source=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
 source=removeReviewedOpponentInsertions(source);
 const hookStart=source.indexOf('(0,R.gn)(this,Fo,"f").__pt062EventRows='),hookEnd=source.indexOf('},e.appendChild',hookStart);
 assert(hookStart>0&&hookEnd>hookStart,'native row adapter is installed once');
 source=source.slice(0,hookStart)+source.slice(hookEnd+2);
 for(const [from,to] of [
  ['il=function(e,t,n,i,r,a,s,o,l,c,h,z){','il=function(e,t,n,i,r,a,s,o,l,c,h){'],
  ['!z?.event&&d.addEventListener("click",(()=>{(0,R.gn)(this,zo,"f").playUIClick()','d.addEventListener("click",(()=>{(0,R.gn)(this,zo,"f").playUIClick()'],
  ['!z?.event&&kr.F(a,h).then','kr.F(a,h).then'],
  ['b.appendChild(T);return d},rl=function e()','b.appendChild(T)},rl=function e()']
 ]){assert.equal(source.split(from).length,2,'reviewed anchor is unique');source=source.replace(from,to);}
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'3ced66fa3b2fe95a4a504f3123010eb0ef64f1ad3e35cd125069777a2821ddb7','all other bundle bytes, including physics and ordinary native rendering, match the previous reviewed bundle');
});

test('opponent UI review remains chained to the prior proof and immutable physics assets',()=>{
 const priorBytes=fs.readFileSync(new URL('../'+opponentReview.previousReview,import.meta.url));
 assert.equal(opponentReview.previousReview,'docs/events/native-row-ui-engine-review.json');
 assert.equal(digest(priorBytes.toString('utf8').replace(/\r\n?/g,'\n')),opponentReview.previousReviewSha256);
 const prior=JSON.parse(priorBytes),manifest=JSON.parse(fs.readFileSync(new URL('../tools/verifier/engine-manifest.json',import.meta.url),'utf8'));
 assert.equal(opponentReview.previousEngine,prior.currentEngine);
 const extension=JSON.parse(fs.readFileSync(new URL('../tools/verifier/indexed-playback-review.json',import.meta.url),'utf8'));
 assert.equal(extension.previousReview,'docs/events/opponent-shortcut-ui-engine-review.json');
 assert.equal(extension.previousReviewSha256,digest(fs.readFileSync(new URL('../'+extension.previousReview,import.meta.url),'utf8').replace(/\r\n?/g,'\n')));
 assert.equal(extension.currentEngine,'3cb2e59839b5ad85ea34d892e1f10ca7dc04f9d8cec17770fbd843673614a3a0');
 assert.equal(extension.previousEngine,opponentReview.currentEngine);assert.equal(manifest.engineDigest,extension.currentEngine);
 assert.deepEqual(extension.changedAssets,['simulation_worker.bundle.js']);
 assert.equal(extension.nativeAB.pairCount,11);assert.equal(extension.nativeAB.pairs.length,11);
 for(const pair of extension.nativeAB.pairs){assert.equal(pair.equal,true);assert.match(pair.streamSha256,/^[a-f0-9]{64}$/);assert.equal(pair.baseStates,pair.candidateStates);assert.equal(pair.baseBytes,pair.candidateBytes);}
 assert.equal(extension.historicalBootstrapUnchanged,true);
 for(const [asset,hash] of Object.entries(extension.unchangedAssets))assert.equal(digest(fs.readFileSync(new URL('../'+asset,import.meta.url))),hash);
 for(const [asset,hash] of Object.entries(extension.currentAssets))assert.equal(digest(fs.readFileSync(new URL('../'+asset,import.meta.url))),hash);
 assert.equal(opponentReview.trackPinsUnchanged,true);assert.equal(opponentReview.geometryPinsReusedBecausePhysicsAndTracksUnchanged,true);assert.equal(opponentReview.historicalBootstrapUnchanged,true);
 assert.deepEqual(opponentReview.unchangedPhysicsAssets,prior.unchangedPhysicsAssets);
 assert.deepEqual(Object.keys(opponentReview.unchangedPhysicsAssets).sort(),['lib/polytrack_physics.js','polytrack_physics.wasm']);
 for(const [asset,hash] of Object.entries(opponentReview.unchangedPhysicsAssets))assert.equal(digest(fs.readFileSync(new URL('../'+asset,import.meta.url))),hash,asset+' remains immutable');
 assert.deepEqual(Object.keys(opponentReview.unchangedSimulationAssets),['simulation_worker.bundle.js']);
 assert.deepEqual(extension.previousAssets,opponentReview.unchangedSimulationAssets);
 assert.equal(digest(JSON.stringify(Object.entries(manifest.tracks).sort(([a],[b])=>a<b?-1:a>b?1:0))),opponentReview.trackPinsSha256);
 const geometry=JSON.parse(fs.readFileSync(new URL('../tools/verifier/track-geometry.json',import.meta.url),'utf8'));
 assert.equal(extension.geometryRowsSha256,extension.geometryBaseline.rowsSha256);
 assert.equal(digest(JSON.stringify(geometry.tracks)),extension.geometryRowsSha256);
});

test('reviewed opponent UI stripping rejects extra edits, duplicate anchors and changed review allowances',()=>{
 const source=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
 for(const altered of [source+' ',source+opponentReview.normalizedUiInsertions[0]])assert.throws(()=>removeReviewedOpponentInsertions(altered));
 assert.throws(()=>removeReviewedOpponentInsertions(source,{...opponentReview,currentMainBundleSha256:digest(source+' ')}));
 assert.throws(()=>removeReviewedOpponentInsertions(source,{...opponentReview,normalizedUiInsertions:[...opponentReview.normalizedUiInsertions,'arbitrary extra UI edit']}));
 assert.throws(()=>removeReviewedOpponentInsertions(source,{...opponentReview,normalizedUiInsertions:[opponentReview.normalizedUiInsertions[0],opponentReview.normalizedUiInsertions[1]+'unreviewed']}));
});
