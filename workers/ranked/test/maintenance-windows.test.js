import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceWindowAllows} from '../src/index.js';

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
