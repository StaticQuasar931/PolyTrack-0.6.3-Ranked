import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
const bindings=new WeakMap();
const own=(value,key)=>value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
export class ProfileShopPreviewError extends Error {
  constructor(code){super(code);this.name='ProfileShopPreviewError';this.code=code;}
}
const fail=code=>{throw new ProfileShopPreviewError(code);};
/** Temporary visuals only. All callbacks are synchronous; no auth token is accepted.
 * Host owns the real authenticated store, validated catalog and Studio controller.
 * Bind after setupCosmeticPreview; dispose BEFORE auth/profile replacement.
 * openStudio(reward) must synchronously open the existing hub without selecting a
 * choice. This adapter NEVER edits drafts, equips, purchases, or grants ownership.
 * Compatible with the shop view's {accountId,itemId,previewOnly,signal,isCurrent}.
 */
export function bindProfileShopPreview(content,{accountId,getAccountId,getAuthScope,getCatalog,getPreviewController,openStudio,revision}={}){
  if(!content?.isConnected||!/^[a-f0-9]{64}$/.test(accountId||'')||[getAccountId,getAuthScope,getCatalog,getPreviewController,openStudio].some(fn=>typeof fn!=='function'))fail('invalid_profile_preview_adapter');
  bindings.get(content)?.dispose();
  const scope=getAuthScope(),document=content.ownerDocument;
  let disposed=false,active=null;
  const current=()=>!disposed&&content.isConnected&&getAccountId()===accountId&&typeof scope==='string'&&!!scope&&getAuthScope()===scope;
  function clear(reason='shop-exit'){
    const previous=active;active=null;
    if(!previous)return false;
    previous.signal?.removeEventListener('abort',previous.abort);
    if(previous.controller.currentOption?.()!==previous.option)return false;
    return previous.controller.clear(reason);
  }
  function preview(request){
    if(!current()||own(request,'accountId')!==accountId||own(request,'previewOnly')!==true)fail('stale_profile_preview');
    const signal=own(request,'signal'),isCurrent=own(request,'isCurrent');
    if(typeof isCurrent!=='function'||!isCurrent()||signal?.aborted)fail('stale_profile_preview');
    const item=PROFILE_SHOP_CATALOG.find(item=>item.id===own(request,'itemId'));
    const catalog=getCatalog(),matches=catalog?.items?.filter(row=>own(row,'id')===item?.id);
    const supplied=matches?.length===1?matches[0]:null,grant=own(supplied,'grants');
    if(!item||catalog?.version!==PROFILE_SHOP_CATALOG_VERSION||own(supplied,'kind')!==item.kind||own(supplied,'price')!==item.price||!Array.isArray(grant)||grant.length!==1||own(grant[0],'slot')!==item.grants[0].slot||own(grant[0],'value')!==item.grants[0].value)fail('profile_preview_unavailable');
    clear();
    const reward=Object.freeze({kind:item.grants[0].slot,id:item.grants[0].value});
    if(openStudio(reward)!==true||!current()||!isCurrent()||signal?.aborted)fail('stale_profile_preview');
    const controller=getPreviewController();
    if(typeof controller?.preview!=='function'||typeof controller.currentOption!=='function')fail('profile_preview_unavailable');
    const url=new URL('./profile-shop-art.css',import.meta.url);url.search=new URL(import.meta.url).search;
    if(revision!==undefined&&revision!==null)url.searchParams.set('v',String(revision));
    if(![...document.querySelectorAll('link[data-profile-shop-art-css]')].some(link=>link.href===url.href)){
      const link=document.createElement('link');link.rel='stylesheet';link.href=url.href;link.dataset.profileShopArtCss='';document.head.append(link);
    }
    if(controller.preview(reward)!==true)fail('profile_preview_unavailable');
    const option=controller.currentOption();
    active={controller,option,signal,abort:()=>clear('shop-abort')};
    signal?.addEventListener('abort',active.abort,{once:true});
    if(!current()||!isCurrent()||signal?.aborted){clear('shop-stale');fail('stale_profile_preview');}
    // An owned item can also be tried without applying it: never imply loss of ownership.
    const label=content.querySelector('.cosmetic-preview-banner strong');if(label)label.textContent='Preview only - not applied';
    return true;
  }
  const observer=new document.defaultView.MutationObserver(()=>{if(!current())dispose();});
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-account-id']});
  function dispose(){if(disposed)return;disposed=true;observer.disconnect();clear('shop-dispose');if(bindings.get(content)===api)bindings.delete(content);}
  const api={preview,clear,dispose};bindings.set(content,api);return api;
}
