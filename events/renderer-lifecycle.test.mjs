import test from 'node:test';
import assert from 'node:assert/strict';
import {handleEventCarIntersections,retryDeferredEventCarRenders} from './client.mjs';

test('event car observer defers bounded overflow and retries after queue space opens',()=>{
  const observed=new Set(),unobserved=new Set(),board={contains:row=>row.connected};
  const rows=Array.from({length:15},(_,index)=>({connected:true,isConnected:true,index}));
  const view={board,carStyles:new WeakMap(rows.map(row=>[row,'style-'+row.index])),deferredCarRows:new Set(),
    carObserver:{observe(row){observed.add(row);},unobserve(row){observed.delete(row);unobserved.add(row);}}};
  rows.forEach(row=>observed.add(row));
  let slots=12;const rendered=[];
  const render=(row,style)=>{if(!slots)return false;slots--;rendered.push(style);return true;};
  handleEventCarIntersections(view,rows.map(target=>({target,isIntersecting:true})),render);
  assert.equal(rendered.length,12);
  assert.equal(view.deferredCarRows.size,3);
  assert.equal(observed.size,15,'admitted rows stay observed until rendering completes');

  slots=1;retryDeferredEventCarRenders(view,render);
  assert.equal(view.deferredCarRows.size,2);
  assert.equal(rendered.length,13);

  const removed=[...view.deferredCarRows][0];removed.connected=false;removed.isConnected=false;
  retryDeferredEventCarRenders(view,render);
  assert.equal(view.deferredCarRows.has(removed),false);
  assert.equal(unobserved.has(removed),true);

  slots=1;retryDeferredEventCarRenders(view,render);
  assert.equal(view.deferredCarRows.size,0);
  const reopened={connected:true,isConnected:true,index:'reopened'};
  view.board.contains=row=>row.connected;
  view.carStyles.set(reopened,'reopened-style');view.carObserver.observe(reopened);slots=1;
  handleEventCarIntersections(view,[{target:reopened,isIntersecting:true}],render);
  assert.equal(rendered.at(-1),'reopened-style');
  assert.equal(view.deferredCarRows.has(reopened),false);
});

test('deferred hidden event rows wait for visibility instead of cycling the render queue',()=>{
  let visible=false,calls=0,observes=0,unobserves=0;
  const row={connected:true,isConnected:true,getClientRects:()=>visible?[{}]:[]};
  const view={board:{contains:target=>target.connected},carStyles:new WeakMap([[row,'hidden-style']]),deferredCarRows:new Set([row]),carObserver:{observe(){observes++;},unobserve(){unobserves++;}}};
  const render=()=>{calls++;return true;};
  retryDeferredEventCarRenders(view,render);
  retryDeferredEventCarRenders(view,render);
  assert.equal(calls,0);
  assert.equal(view.deferredCarRows.has(row),true);
  assert.equal(observes,1,'hidden deferred row is reobserved once, not on every drain');
  assert.equal(unobserves,1);
  handleEventCarIntersections(view,[{target:row,isIntersecting:false}],render);
  assert.equal(view.deferredCarRows.has(row),true,'non-intersecting updates must not drop deferred work');
  visible=true;handleEventCarIntersections(view,[{target:row,isIntersecting:true}],render);
  assert.equal(calls,1);
  assert.equal(view.deferredCarRows.has(row),false);
});
