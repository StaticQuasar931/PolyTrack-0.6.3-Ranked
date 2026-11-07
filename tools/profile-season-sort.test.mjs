import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import{profilePodiumProgress}from'./profile-podium-progress.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
test('season order is numeric and keeps unknown-placement official tracks in their season',()=>{
 const a=source.indexOf('  function profileTrackSeasonOrder('),b=source.indexOf('  function ',source.indexOf('  function sortProfileFinishes(',a)+10);assert.ok(a>=0&&b>a);
 const names={s10:'Summer 10',s2:'Summer 2',s1:'Summer 1',w1:'Winter 1',d1:'Desert 1',c:'Community'};
 const c=vm.createContext({profileSort:'season',profileSortDirection:1,trackInfo:id=>({name:names[id],type:id==='c'?'community':'official'}),knownFinishWeight:()=>1});vm.runInContext(source.slice(a,b),c);
 const input=['d1','s10','w1','s2','s1','c'].map(trackId=>({trackId,rank:trackId==='s1'?null:4,fieldSize:200}));assert.deepEqual(Array.from(c.sortProfileFinishes(input),r=>r.trackId),['s1','s2','s10','w1','d1','c']);assert.equal(input[0].trackId,'d1');
 c.profileSortDirection=-1;assert.deepEqual(Array.from(c.sortProfileFinishes(input),r=>r.trackId),['c','d1','w1','s10','s2','s1']);
});
test('embedded podium model matches the tested module',()=>{
 const a=source.indexOf('function profilePodiumProgress('),b=source.indexOf('  function profileAchievementMarkup(',a);assert.ok(a>0&&b>a);const c=vm.createContext({});vm.runInContext(source.slice(a,b),c);
 for(const medals of [{gold:0,silver:0,bronze:0},{gold:1,silver:0,bronze:0},{}]){const entry={medals},rows=[{trackId:'a',rank:4,fieldSize:100}],options={isEligible:()=>true,trackName:()=> 'Summer 1'};assert.deepEqual(JSON.parse(JSON.stringify(c.profilePodiumProgress(entry,rows,options))),profilePodiumProgress(entry,rows,options));}
});
