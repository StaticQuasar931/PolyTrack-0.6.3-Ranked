import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function canOfferSiteUpdate('),end=source.indexOf('\n  }',start)+4;
function harness({hidden=false,modal=false,editing=false,menu=false}={}){
 const document={visibilityState:hidden?'hidden':'visible',querySelector:()=>modal?{}:null,activeElement:{matches:()=>editing},querySelectorAll:()=>menu?[{visible:true}]:[]};
 const c=vm.createContext({document,isElementVisible:node=>node.visible});vm.runInContext(source.slice(start,end),c);return c;
}
test('update badge is offered on menus, not during races, typing or a modal',()=>{
 assert.equal(harness({menu:true}).canOfferSiteUpdate(),true);
 for(const state of [{},{menu:true,hidden:true},{menu:true,modal:true},{menu:true,editing:true}])assert.equal(harness(state).canOfferSiteUpdate(),false);
});
test('menu reconciliation resumes both pending release notices without new requests',()=>{
 const start=source.indexOf('  function reconcileUiContents('),end=source.indexOf('\n  }',start);
 const body=source.slice(start,end);assert.match(body,/installedRevisionNotice\?\.resume\(\)/);assert.match(body,/siteUpdateHandle\?\.resume\(\)/);
 assert.match(source,/siteUpdateHandle=module\.installSiteUpdates/);
 assert.match(source,/isIdle:canOfferSiteUpdate/);
 assert.match(source,/canReload:\(\)=>canShowInstalledRevisionNotice\(\)/);
});
