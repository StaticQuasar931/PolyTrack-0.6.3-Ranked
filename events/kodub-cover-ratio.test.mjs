import test from 'node:test';
import assert from 'node:assert/strict';
import {fitKodubCover} from './kodub-weekly.mjs';

test('weekly cover ratio reaches the button, card and outer layout after image changes',()=>{
  const style=()=>{const values=new Map();return {getPropertyValue:key=>values.get(key)||'',setProperty:(key,value)=>values.set(key,value)};};
  let loaded;
  const image={naturalWidth:512,naturalHeight:256,addEventListener:(_event,handler)=>{loaded=handler;}};
  const button={style:style(),querySelector:()=>image};
  const rail={style:style(),querySelectorAll:()=>[]};
  const card={style:style(),querySelector:()=>button,closest:()=>rail};
  fitKodubCover(card);
  for(const node of [button,card,rail])assert.equal(node.style.getPropertyValue('--kodub-cover-ratio'),'2');
  image.naturalWidth=768;loaded();
  for(const node of [button,card,rail])assert.equal(node.style.getPropertyValue('--kodub-cover-ratio'),'3');
  image.naturalHeight=0;loaded();
  for(const node of [button,card,rail])assert.equal(node.style.getPropertyValue('--kodub-cover-ratio'),'3');
});
