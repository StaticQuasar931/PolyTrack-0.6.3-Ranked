import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function canOfferSiteUpdate('),end=source.indexOf('\n  }',start)+4;
test('update offers delegate to the same shared game-menu guard used for reload',()=>{
 const document={};let allowed=false,calls=0;
 const siteUpdateMenuState={canUpdateFromGameMenu:actual=>{assert.equal(actual,document);calls++;return allowed;}};
 const context=vm.createContext({document,siteUpdateMenuState});vm.runInContext(source.slice(start,end),context);
 assert.equal(context.canOfferSiteUpdate(),false);allowed=true;
 assert.equal(context.canOfferSiteUpdate(),true);assert.equal(calls,2);
 context.siteUpdateMenuState=null;assert.equal(context.canOfferSiteUpdate(),false);
});
test('menu reconciliation resumes both pending release notices without new requests',()=>{
 const start=source.indexOf('  function reconcileUiContents('),end=source.indexOf('\n  }',start);
 const body=source.slice(start,end);assert.match(body,/installedRevisionNotice\?\.resume\(\)/);assert.match(body,/siteUpdateHandle\?\.resume\(\)/);
 assert.match(source,/siteUpdateHandle=module\.installSiteUpdates/);
 assert.match(source,/isIdle:canOfferSiteUpdate/);
 assert.match(source,/canReload:canOfferSiteUpdate/);
});
