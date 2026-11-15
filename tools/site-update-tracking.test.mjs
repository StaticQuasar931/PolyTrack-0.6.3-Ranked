import test from 'node:test';
import assert from 'node:assert/strict';
import {updateTrackingUrl} from './site-updates.mjs';
test('update attribution preserves the exact page, ordinary query and anchor',()=>{
 const url=new URL(updateTrackingUrl('https://game.example/PolyTrack/?mode=ranked&utm_source=old#garage',339));
 assert.equal(url.origin,'https://game.example');assert.equal(url.pathname,'/PolyTrack/');assert.equal(url.searchParams.get('mode'),'ranked');assert.equal(url.hash,'#garage');assert.equal(url.searchParams.get('utm_source'),'update');assert.equal(url.searchParams.get('utm_medium'),'in_game');assert.equal(url.searchParams.get('utm_campaign'),'client_339');
 assert.equal(updateTrackingUrl(url.href,339),url.href);
});
test('untrusted revisions and non-web locations cannot create tracking navigation',()=>{
 for(const revision of [undefined,-1,NaN,'339','https://evil.example'])assert.equal(updateTrackingUrl('https://game.example/',revision),null);
 for(const href of ['javascript:alert(1)','file:///game/index.html','not a url'])assert.equal(updateTrackingUrl(href,339),null);
});
