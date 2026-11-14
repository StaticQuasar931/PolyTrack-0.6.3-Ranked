import test from 'node:test';
import assert from 'node:assert/strict';
import {updateReminderPreference,UPDATE_REMINDER_KEY} from './site-update-dismissal.mjs';
function store(){const values=new Map();return{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),values};}
const doc=localStorage=>({defaultView:{localStorage}});
test('three fresh Documents count visits; restore/reinstall never counts',()=>{
 const storage=store(),first=doc(storage),p=updateReminderPreference(first);p.dismiss('visits');
 for(let i=0;i<8;i++)assert.equal(updateReminderPreference(first),p);
 assert.equal(JSON.parse(storage.getItem(UPDATE_REMINDER_KEY)).wait,3);
 assert.equal(updateReminderPreference(doc(storage)).suppressed(),true);
 assert.equal(updateReminderPreference(doc(storage)).suppressed(),true);
 assert.equal(updateReminderPreference(doc(storage)).suppressed(),false);
});
test('session hides only this Document; permanent requires three explicit selections',()=>{
 const storage=store();for(let i=0;i<3;i++){const p=updateReminderPreference(doc(storage));assert.equal(p.canTurnOff(),false);assert.equal(p.dismiss('off'),false);p.dismiss('session');assert.equal(p.suppressed(),true);}
 const p=updateReminderPreference(doc(storage));assert.equal(p.suppressed(),false);assert.equal(p.canTurnOff(),true);p.dismiss('off');assert.equal(updateReminderPreference(doc(storage)).suppressed(),true);
 assert.ok(storage.getItem(UPDATE_REMINDER_KEY).length<128);assert.equal(storage.values.size,1);
});
test('blocked, malformed and excessive storage never blocks the updater',()=>{
 for(const storage of [{getItem(){throw Error();},setItem(){throw Error();}},{getItem:()=>'{',setItem(){}},{getItem:()=> 'x'.repeat(129),setItem(){}}]){
 const p=updateReminderPreference(doc(storage));assert.equal(p.suppressed(),false);p.dismiss('visits');assert.equal(p.suppressed(),true);
 }
 const d={defaultView:{get localStorage(){throw Error();}}};assert.equal(updateReminderPreference(d).suppressed(),false);
});
