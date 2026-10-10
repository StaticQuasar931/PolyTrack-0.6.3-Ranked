import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {checkExtraVerification, checkRepositoryExtraVerification} from './extra-verification-check.mjs';
const id='a'.repeat(64), asset='extra-tracks/track-data/submitted/test.track';
const catalog=[{id:'test',trackId:id,trackPath:asset}];
const hash=crypto.createHash('sha256').update('code\n').digest('hex');
test('real Extra catalog has matching registry and pins',()=>assert.deepEqual(checkRepositoryExtraVerification(),[]));
test('checks normalized code without repinning it',()=>{
  assert.deepEqual(checkExtraVerification(catalog,new Set([id]),{[asset]:hash},()=> 'code\r\n'),[]);
  assert.match(checkExtraVerification(catalog,new Set([id]),{[asset]:hash},()=> 'changed')[0],/pin needs review/);
});
test('detects registry drift and unranked admission',()=>{
  assert.match(checkExtraVerification(catalog,new Set(),{[asset]:hash},()=> 'code\n')[0],/Missing Worker/);
  assert.match(checkExtraVerification([{...catalog[0],ranked:false}],new Set([id]),{},()=> '')[0],/Unranked/);
});
test('refuses unsafe paths before reading',()=>{
  assert.match(checkExtraVerification([{...catalog[0],trackPath:'../secret'}],new Set([id]),{},()=> {throw Error('must not read');})[0],/Unsafe/);
});
