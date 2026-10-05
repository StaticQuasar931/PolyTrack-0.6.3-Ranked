import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('native event row hook changes only reviewed UI anchors in the bundle',()=>{
 let source=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
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
