import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('  async function prepareCapture(){'),source.indexOf('  return {prepareCapture,'));
test('capture awaits practice readiness before protected binding while catalog loads in parallel',async()=>{
 const order=[];let release;
 const ready=new Promise(resolve=>{release=resolve;});
 const prepare=new Function('bridge','loadCatalog','ensureCapture','tick',body+';return prepareCapture;')(
  {ready:()=>{order.push('ready');return ready;}},async()=>{order.push('catalog');},()=>{order.push('binding');},()=>{order.push('tick');});
 const pending=prepare();await Promise.resolve();assert.deepEqual(order,['catalog','ready']);
 release();await pending;assert.deepEqual(order,['catalog','ready','binding','tick']);
});
test('failed readiness must not install native binding',async()=>{
 let installs=0;
 const prepare=new Function('bridge','loadCatalog','ensureCapture','tick',body+';return prepareCapture;')(
  {ready:async()=>{throw Error('practice not ready');}},async()=>{},()=>{installs++;},()=>{});
 await assert.rejects(prepare(),/practice not ready/);assert.equal(installs,0);
});
test('background capture keeps its readiness gate while explicit launch validates a local session',()=>{
 const calls=[...source.matchAll(/ensureCapture\(\);/g)];assert.equal(calls.length,2);
 assert.match(body,/await[\s\S]*bridge\.ready\(\)/);
 const race=source.slice(source.indexOf('  async function race(period,'),source.indexOf('  async function openEvent('));
 assert.doesNotMatch(race,/bridge\.ready\(/);
 assert.match(race,/accountId!==bridge\.accountId\(\)/);
 assert(race.indexOf('ensureCapture();')<race.indexOf('sessions.enter(period,accountId)'));
 assert(race.indexOf('sessions.enter(period,accountId)')<race.indexOf('await bridge.openTrack('));
});
