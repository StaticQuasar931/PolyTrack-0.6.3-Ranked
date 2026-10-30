import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {plannerEaseEstimate,plannerPracticeEvidence} from './planner-route-model.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const from=source.indexOf('function plannerEaseEstimate('),to=source.indexOf('\nfunction ',from+1);
assert.ok(from>=0&&to>from);
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:0;
const embedded=new Function('plannerPositive','plannerPracticeEvidence',source.slice(from,to)+';return plannerEaseEstimate')(positive,plannerPracticeEvidence);
test('the shipped planner matches the tested model across ties and invalid source fields',()=>{
  for(const accountId of ['a','z'])for(const targetRank of [1,2])for(const change of [{},{ranksExact:false},{sourceComplete:false},{trackId:'wrong'},{serverUpdatedAt:1,updatedAt:100}]){
    const entries=[{accountId:'b',timeMs:1000},{accountId:'c',timeMs:1100},{accountId,timeMs:2000}];
    const snapshot={trackId:'track',complete:true,totalEntries:3,updatedAt:100,...change,entries};
    const action={trackId:'track',currentRank:3,timeMs:2000,targetRank,cachedAt:50};
    assert.deepEqual(embedded(action,snapshot,accountId),plannerEaseEstimate(action,snapshot,accountId));
  }
});
