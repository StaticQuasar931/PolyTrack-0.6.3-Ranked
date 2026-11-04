import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {maintenanceWindowAllows,canonicalDiscoveryDue} from '../src/index.js';

test('production configuration activates coordinated maintenance before capture, not continuous polling',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.vars.BACKGROUND_MAINTENANCE_MODE,'coordinated');
  assert.equal(config.vars.PUBLIC_FIRESTORE_READ_MODE,'capture-only');
  const workflow=readFileSync(new URL('../../../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  assert.match(workflow,/cron: '50 0,12,20 \* \* \*'/);
  // Discovery is bounded, but draining keeps its original cadence after :40.
  for(const hour of [0,8,12,20]){
    const slots=Array.from({length:60},(_,minute)=>minute).filter(minute=>
      canonicalDiscoveryDue(Date.UTC(2026,10,1,hour,minute),config.vars.BACKGROUND_MAINTENANCE_MODE));
    assert.deepEqual(slots,[5,10,15,20,25,30,35,40]);
    assert.equal(maintenanceWindowAllows('* * * * *',Date.UTC(2026,10,1,hour,50),config.vars.BACKGROUND_MAINTENANCE_MODE),false);
  }
});

test('coordinated mode never strands canonical or identity builds between capture windows',()=>{
  for(let minute=0;minute<1440;minute++){
    const at=Date.UTC(2026,10,1)+minute*60000+39338;
    assert.equal(maintenanceWindowAllows('*/5 * * * *',at,'coordinated'),minute%5===0);
    assert.equal(maintenanceWindowAllows('2-59/5 * * * *',at,'coordinated'),minute%5===2);
    const hour=Math.floor(minute/60),localMinute=minute%60;
    assert.equal(canonicalDiscoveryDue(at,'coordinated'),[0,8,12,20].includes(hour)&&localMinute>=5&&localMinute<=40&&localMinute%5===0);
  }
});

test('maintenance only runs before the four coordinated capture windows',()=>{
  const crons=['* * * * *','*/2 * * * *','*/5 * * * *','1-59/5 * * * *','2-59/5 * * * *'];
  for(let hour=0;hour<24;hour++)for(let minute=0;minute<60;minute++)for(const jitter of [0,39338,59999]) {
    const at=Date.UTC(2026,9,29,hour,minute)+jitter;
    for(const cron of crons) {
      const expected=[0,8,12,20].includes(hour)&&({
        '* * * * *':minute<45,'*/2 * * * *':minute===0,
        '*/5 * * * *':minute>=5&&minute<=40&&minute%5===0,'1-59/5 * * * *':minute===41,
        '2-59/5 * * * *':[2,7,12].includes(minute)
      })[cron];
      assert.equal(maintenanceWindowAllows(cron,at,'four-window'),expected);
    }
  }
  for(const at of [undefined,null,NaN,Infinity,-1,1.5,'0'])assert.equal(maintenanceWindowAllows(crons[0],at,'four-window'),false);
  assert.equal(maintenanceWindowAllows('unknown',Date.now(),'four-window'),false);
  assert.equal(maintenanceWindowAllows('unknown',Date.now(),undefined),true);
});
