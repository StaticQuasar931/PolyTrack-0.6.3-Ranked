import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyNativeResponse} from './weekly-native.mjs';
const now=Date.UTC(2026,8,19),id='a'.repeat(64);
const track={id,name:'Summer 1',environment:0,trackUrl:'tracks/official/summer1.track',thumbnail:'tracks/official/thumbnails/summer1.png'};
const period={id:'w_test',trackId:id,kind:'weekly',enabled:true,startsAt:now-1000,endsAt:now+60000};
const response=(periods=[period],info=()=>track)=>weeklyNativeResponse({periods},info,'https://example.test/new-repo/',now);
test('native weekly feed uses the existing event identity, expiry and path-scoped local assets',()=>{
 const result=response();assert.equal(result.current.trackId,id);assert.equal(result.current.trackUrl,'https://example.test/new-repo/tracks/official/summer1.track');
 assert.equal(result.current.endTime,new Date(period.endsAt).toISOString());assert.equal(result.serverTime,new Date(now).toISOString());
 assert.equal(result.current.author,null);assert.equal(result.current.environment,0);
});
test('no expired, disabled, future, ambiguous or unregistered event can become the weekly track',()=>{
 for(const periods of [[],[period,period],[{...period,kind:'daily'}],[{...period,enabled:false}],[{...period,archived:true}],[{...period,endsAt:now}],[{...period,startsAt:now+1}]])assert.equal(response(periods).current,null);
 for(const patch of [{id:'b'.repeat(64)},{retired:true},{environment:9},{trackUrl:'https://host.example/track'},{trackUrl:'tracks/../private.track'},{thumbnail:'data:text/html,test'}])assert.equal(response([period],()=>({...track,...patch})).current,null);
});
test('cloud metadata cannot substitute track names, files, thumbnails or game code',()=>{
 const current=response([{...period,name:'cloud name',trackUrl:'javascript:alert(1)',thumbnail:'https://evil.test'}]).current;
 assert.equal(current.name,'Summer 1');assert.match(current.thumbnailUrl,/example\.test\/new-repo\/tracks\/official/);
});
