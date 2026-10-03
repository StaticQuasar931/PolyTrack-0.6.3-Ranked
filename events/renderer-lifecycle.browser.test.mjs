import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {handleEventCarIntersections,retryDeferredEventCarRenders} from './client.mjs';

const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

test('event car thumbnails defer overflow, prune removed rows, and retry reopened rows',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.setContent('<main id="board"></main>');
    const result=await page.evaluate(({handleSource,retrySource})=>{
      const handle=eval('('+handleSource+')'),retry=eval('('+retrySource+')');
      const board=document.querySelector('#board'),observed=new Set(),unobserved=new Set();
      for(let i=0;i<15;i++){const row=document.createElement('button');row.textContent='row '+i;board.append(row);observed.add(row);}
      const view={board,carStyles:new WeakMap(),deferredCarRows:new Set(),carObserver:{unobserve(row){observed.delete(row);unobserved.add(row);}}};
      [...board.children].forEach((row,index)=>view.carStyles.set(row,'style-'+index));
      let outstanding=0;const accepted=[];
      const render=(row,style)=>{if(outstanding>=12)return false;outstanding++;accepted.push(style);return true;};
      handle(view,[...board.children].map(target=>({target,isIntersecting:true})),render);
      const initial={accepted:accepted.length,deferred:view.deferredCarRows.size,observed:observed.size};
      outstanding--;retry(view,render);
      const afterDrain={accepted:accepted.length,deferred:view.deferredCarRows.size,observed:observed.size};
      const removed=[...view.deferredCarRows][0];removed.remove();retry(view,render);
      const afterRemoval={deferred:view.deferredCarRows.size,removedStyleRendered:accepted.includes(view.carStyles.get(removed))};
      outstanding--;retry(view,render);
      const reopened=document.createElement('button');reopened.textContent='reopened';board.append(reopened);view.carStyles.set(reopened,'reopened-style');observed.add(reopened);outstanding--;
      handle(view,[{target:reopened,isIntersecting:true}],render);
      return {initial,afterDrain,afterRemoval,reopened:accepted.includes('reopened-style'),reopenedUnobserved:unobserved.has(reopened),remainingDeferred:view.deferredCarRows.size};
    },{handleSource:handleEventCarIntersections.toString(),retrySource:retryDeferredEventCarRenders.toString()});
    assert.deepEqual(result.initial,{accepted:12,deferred:3,observed:15});
    assert.deepEqual(result.afterDrain,{accepted:13,deferred:2,observed:15});
    assert.deepEqual(result.afterRemoval,{deferred:1,removedStyleRendered:false});
    assert.equal(result.reopened,true);
    assert.equal(result.reopenedUnobserved,false);
    assert.equal(result.remainingDeferred,0);
  }finally{await browser.close();}
});

test('connected hidden deferred rows stay idle until visible again',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();await page.setContent('<main id="board"></main>');
    const result=await page.evaluate(({handleSource,retrySource})=>{
      const handle=eval('('+handleSource+')'),retry=eval('('+retrySource+')');
      const board=document.querySelector('#board'),row=document.createElement('button');row.style.cssText='display:none;width:40px;height:20px';board.append(row);
      const observed=new Set([row]);let observeCalls=0,unobserveCalls=0,renderCalls=0;
      const view={board,carStyles:new WeakMap([[row,'hidden-style']]),deferredCarRows:new Set([row]),carObserver:{observe(target){observeCalls++;observed.add(target);},unobserve(target){unobserveCalls++;observed.delete(target);}}};
      const render=()=>{renderCalls++;return true;};
      retry(view,render);retry(view,render);handle(view,[{target:row,isIntersecting:false}],render);
      const hidden={connected:row.isConnected,boxes:row.getClientRects().length,deferred:view.deferredCarRows.has(row),renderCalls,observeCalls,unobserveCalls};
      row.style.display='block';handle(view,[{target:row,isIntersecting:true}],render);
      return {hidden,visibleBoxes:row.getClientRects().length,renderCalls,deferred:view.deferredCarRows.has(row)};
    },{handleSource:handleEventCarIntersections.toString(),retrySource:retryDeferredEventCarRenders.toString()});
    assert.deepEqual(result.hidden,{connected:true,boxes:0,deferred:true,renderCalls:0,observeCalls:1,unobserveCalls:1});
    assert.equal(result.visibleBoxes,1);assert.equal(result.renderCalls,1);assert.equal(result.deferred,false);
  }finally{await browser.close();}
});
