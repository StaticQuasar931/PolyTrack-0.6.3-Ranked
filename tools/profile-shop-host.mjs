import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
import {createProfileShopOwnedCache} from './profile-shop-owned-cache.mjs';
import {createShopTransport} from './shop-transport.mjs';
import {createShopControllerStore,createShopController} from './shop-controller.mjs';
const {mountProfileShopUi:mountShopPreview}=await import(new URL('./profile-shop-ui.mjs'+new URL(import.meta.url).search,import.meta.url).href);
import {bindProfileShopPreview} from './profile-shop-preview.mjs';

/** Display price only, never ownership, an offer, or a wallet mutation. */
export function priceForUi(slot,value){
  if(typeof slot!=='string'||typeof value!=='string')return null;
  const matches=PROFILE_SHOP_CATALOG.filter(item=>item.grants.some(grant=>grant.slot===slot&&grant.value===value));
  const price=matches.length===1?matches[0].price:null;
  return Number.isSafeInteger(price)&&price>=0?price:null;
}

// Optional response clock is presentation-only; never a receipt or wallet.
function claimDayWindow(value){
  const {claimDay,serverNow,dayEndsAt}=value||{},day=86400000;
  if(![claimDay,serverNow,dayEndsAt].every(n=>Number.isSafeInteger(n)&&n>0)||
    claimDay!==Math.floor(serverNow/day)||dayEndsAt!==(claimDay+1)*day||serverNow>=dayEndsAt)return null;
  return dayEndsAt-serverNow;
}
export function loginClaimWindow(value){
  return value?.error==='reward_already_claimed'&&value.notCommitted===true?claimDayWindow(value):null;
}
export function freshLoginClaimWindow(value,request){
  const uint=n=>Number.isSafeInteger(n)&&n>=0;
  if(request?.rewardId!=='login'||!/^[a-f0-9]{64}$/.test(request.accountId||'')||
    typeof request.requestId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(request.requestId)||
    value?.op!=='claim'||value.rewardId!=='login'||value.accountId!==request.accountId||value.requestId!==request.requestId||
    value.duplicate!==false||value.alreadyClaimed!==false||value.outcomeOnly!==true||value.delta!==8||
    !uint(value.walletRevision)||!uint(value.balanceAfter))return null;
  return claimDayWindow(value);
}
async function loginMetadata(response){
  const reader=response.clone().body?.getReader();if(!reader)return null;
  const chunks=[];let length=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2048)return null;chunks.push(value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch{return null;}finally{void reader.cancel().catch(()=>{});}
}

/** Host integration, default OFF. No SDK initialization or automatic wallet read.
 * achievementClaimsEnabled defaults false until the parent enables the server phase.
 * getAuth returns the already initialized Firebase auth object. Only an explicit
 * Shop open or refresh invokes transport; tokens remain request-local.
 * noteAccountTransition MUST precede all active-account writes, including A-B-A.
 * observeAuth MUST also be called whenever the host initializes/replaces auth.
 * bind accepts optional getPreviewIdentity:()=>({accountId,name}) from the parent.
 * Rendering still uses getPreviewController/openStudio and the existing Studio DOM.
 * content.__profileShopOpen / __profileShopClose are guarded root-local hooks.
 * __profileShopRefreshPreview refreshes existing renderer output after a frame/identity
 * update with no DOM mutation. It never starts a render, fetch, save or equip.
 */
export function createProfileShopHost({document,getAccountId,getAuth,storage,revision,enabled=false,achievementClaimsEnabled=false,fetch:fetcher,assertOnline=()=>{}}={}){
  if(!document||typeof getAccountId!=='function'||typeof getAuth!=='function')throw TypeError('Profile shop host adapters required');
  let disposed=false,auth=null,unsubscribe=null,ownedUnsubscribe=null,authEpoch=0,lastAccount=getAccountId(),store=null;
  const ownedCache=createProfileShopOwnedCache(storage);
  let loginMarker=null;
  const monotonic=()=>document.defaultView.performance.now();
  const loginClaimed=()=>!!(loginMarker&&loginMarker.accountId===getAccountId()&&loginMarker.uid===user()?.uid&&loginMarker.epoch===authEpoch&&monotonic()>=loginMarker.at&&monotonic()-loginMarker.at<loginMarker.remaining);
  const mounts=new Set();
  const currentAuth=()=>{try{return getAuth()||null;}catch{return null;}};
  const user=()=>currentAuth()?.currentUser||null;
  const scope=()=>{const current=user();return current?.uid?`${authEpoch}:${current.uid}`:null;};
  function notifyOwned(reason){for(const mount of mounts)mount.refresh(reason);}
  function reset(){authEpoch++;loginMarker=null;for(const mount of mounts)mount.close(true);store?.reset();notifyOwned('auth');}
  function observeAuth(next){
    if(disposed||!next||next===auth)return;
    unsubscribe?.();auth=next;reset();
    if(typeof auth.onAuthStateChanged==='function'){
      let initial=true;const initialUser=auth.currentUser;
      unsubscribe=auth.onAuthStateChanged(next=>{if(initial&&next===initialUser){initial=false;return;}initial=false;reset();},()=>reset());
    }
  }
  const transport=createShopTransport({fetch:async(url,options)=>{
    const accountId=getAccountId(),uid=user()?.uid,epoch=authEpoch,at=monotonic();
    const response=await (fetcher||globalThis.fetch)(url,options);
    if([200,409].includes(response.status)&&new URL(url).pathname==='/v1/currency/claim'&&options.method==='POST'){
      let body;try{body=JSON.parse(options.body);}catch{}
      if(body?.rewardId==='login'&&body.accountId===accountId){
        const metadata=await loginMetadata(response);
        const remaining=response.status===409?loginClaimWindow(metadata):freshLoginClaimWindow(metadata,body);
        if(remaining!==null&&!disposed&&!options.signal?.aborted&&epoch===authEpoch&&uid&&uid===user()?.uid&&accountId===getAccountId())loginMarker={accountId,uid,epoch,at,remaining};
      }
    }
    return response;
  },revision:Number(revision),getToken:async({signal})=>{
    assertOnline();observeAuth(currentAuth());const current=user(),account=getAccountId(),epoch=authEpoch;
    if(!enabled||!current||signal.aborted)throw Error('shop_authentication_required');
    const token=await current.getIdToken();
    if(disposed||signal.aborted||epoch!==authEpoch||current!==user()||account!==getAccountId())throw Error('shop_auth_context_changed');
    return token;
  }});
  function sharedStore(){
    observeAuth(currentAuth());
    if(!store){
      store=createShopControllerStore({transport,storage,getAccountId,getAuthScope:scope,makeRequestId:()=>document.defaultView.crypto.randomUUID(),enabled:enabled===true});
      ownedUnsubscribe=store.subscribe(state=>{
        const ownerUid=user()?.uid,id=getAccountId(),wallet=state.wallet,inventory=state.inventory;
        if(!ownerUid||state.accountId!==id||state.catalog?.version!==PROFILE_SHOP_CATALOG_VERSION||wallet?.accountId!==id||wallet.inventoryComplete!==true||inventory?.accountId!==id||inventory.catalogVersion!==PROFILE_SHOP_CATALOG_VERSION)return;
        const before=ownedCache.read(id,ownerUid);
        ownedCache.remember({accountId:id,ownerUid,catalogVersion:inventory.catalogVersion,revision:wallet.revision,ownedItemIds:inventory.ownedItemIds,complete:true});
        if(JSON.stringify(before?.ownedItemIds)!==JSON.stringify(inventory.ownedItemIds))notifyOwned('confirmed');
      });
    }
    return store;
  }
  function ensureStyle(){
      const css=new URL('./profile-shop-ui.css',import.meta.url);css.searchParams.set('v',String(revision));
      if(![...document.querySelectorAll('link[data-profile-shop-css]')].some(link=>link.href===css.href)){const link=document.createElement('link');link.rel='stylesheet';link.href=css.href;link.dataset.profileShopCss='';document.head.append(link);}
  }
  function bind(content,{accountId,isSelf,openStudio,getPreviewController,applyDraft,onOwnedUiChange,getPreviewIdentity}={}){
    if(disposed||!content?.isConnected||isSelf!==true||accountId!==getAccountId()||!/^[a-f0-9]{64}$/.test(accountId||''))return ()=>{};
    const studio=content.querySelector('.profile-customizer');if(!studio)return ()=>{};ensureStyle();
    const controls=studio.querySelector('.profile-customizer-actions')||studio;
    const button=document.createElement('button');button.type='button';button.className='button profile-shop-open';button.textContent='Style shop';button.setAttribute('aria-haspopup','dialog');
    controls.append(button);
    let dialog=null,view=null,preview=null,mirrorObserver=null,mirrorSource=null,mirrorRoot=null,mirrorRow=null,mirrorQueued=false,clearUiPreview=null,closed=false,focus=null,publicViewGeneration=0;
    const previewScope=()=>`${authEpoch}:${user()?.uid||'signed-out'}`;
    const current=()=>!disposed&&!closed&&content.isConnected&&accountId===getAccountId()&&(!content.dataset.accountId||content.dataset.accountId===accountId);
    const goStudio=reward=>{if(!current())return false;dialog?.close();return openStudio?.(reward)===true;};
    const racerName=()=>{
      if(!current())return '';
      if(typeof getPreviewIdentity==='function'){
        let value;try{value=getPreviewIdentity();}catch{return '';}
        return value?.accountId===accountId&&typeof value.name==='string'?value.name.trim().slice(0,80):'';
      }
      return studio.querySelector('.profile-preview-stage>span>b')?.textContent?.trim().slice(0,80)||'';
    };
    function syncMirror(){
      if(!current()||!dialog?.open||!mirrorObserver)return;
      const target=dialog.querySelector('[data-sp-live-stage]'),source=studio.querySelector('.profile-preview-stage');
      if(!target)return;
      const heading=dialog.querySelector('.sp-live-preview>header>strong');if(heading)heading.textContent=racerName()||'Profile preview';
      const garageTrigger=studio.querySelector('[data-car-workshop-open]');
      dialog.querySelector('[data-sp-live-garage]').hidden=!garageTrigger||garageTrigger.disabled;
      const locked=getPreviewController?.()?.isActive?.()===true;
      dialog.querySelector('[data-sp-live-note]').textContent=locked?'Preview only. Not applied or unlocked.':'Your current racer. Try a style to preview it here.';
      dialog.querySelector('[data-sp-live-clear]').hidden=!locked;
      if(!source){target.textContent='Open Racer Studio to load your preview.';return;}
      if(typeof getPreviewIdentity==='function'&&!racerName()){target.textContent='Your racer preview is unavailable.';return;}
      const copy=source.cloneNode(true);copy.inert=true;
      // cloneNode does not copy rendered pixels; reuse only the real renderer output.
      const sourceCanvases=source.querySelectorAll('canvas');
      for(const [index,canvas] of [...copy.querySelectorAll('canvas')].entries()){
        try{
          const original=sourceCanvases[index],context=canvas.getContext('2d');
          if(!original?.width||!original.height||!context)throw Error('Renderer unavailable');
          context.drawImage(original,0,0);
        }catch{const note=document.createElement('span');note.textContent='Renderer preview unavailable.';note.dataset.spRendererUnavailable='';canvas.replaceWith(note);}
      }
      const name=copy.querySelector(':scope>span>b');if(name&&racerName())name.textContent=racerName();
      for(const node of [copy,...copy.querySelectorAll('[id],[tabindex],button,input,select,textarea,a')]){
        node.removeAttribute('id');node.removeAttribute('autofocus');
        if(node.matches('button,input,select,textarea,a,[tabindex]'))node.setAttribute('tabindex','-1');
      }
      const sourceRow=studio.querySelector('.profile-row-showcase'),row=sourceRow?.cloneNode(true);
      if(row){row.inert=true;for(const node of [row,...row.querySelectorAll('[id],[tabindex],button,input,select,textarea,a')]){node.removeAttribute('id');node.removeAttribute('autofocus');if(node.matches('button,input,select,textarea,a,[tabindex]'))node.setAttribute('tabindex','-1');}target.replaceChildren(copy,row);}else target.replaceChildren(copy);
      const sourceRoot=source.closest('.profile-customizer-preview')||studio;
      if(source!==mirrorSource||sourceRoot!==mirrorRoot||sourceRow!==mirrorRow){
        mirrorSource=source;mirrorRoot=sourceRoot;mirrorRow=sourceRow;mirrorObserver.disconnect();
        // Structure and renderer content only: publish guards mutate sibling controls.
        mirrorObserver.observe(sourceRoot,{childList:true});
        if(sourceRoot.parentElement)mirrorObserver.observe(sourceRoot.parentElement,{childList:true});
        mirrorObserver.observe(source,{subtree:true,childList:true,characterData:true,attributes:true});
        if(sourceRow)mirrorObserver.observe(sourceRow,{subtree:true,childList:true,characterData:true,attributes:true});
        const actions=studio.querySelector('.profile-customizer-actions');if(actions)mirrorObserver.observe(actions,{childList:true});
        if(garageTrigger)mirrorObserver.observe(garageTrigger,{attributes:true,attributeFilter:['disabled']});
        const card=content.closest('.overall-profile-card');if(card)mirrorObserver.observe(card,{attributes:true,attributeFilter:['class','style']});
      }
    }
    const keepShopPreview=reward=>{if(!current()||openStudio?.(reward)!==true)return false;syncMirror();return true;};
    function close(invalidate=false){
      publicViewGeneration++;
      mirrorObserver?.disconnect();mirrorObserver=null;mirrorSource=null;mirrorRoot=null;mirrorRow=null;
      preview?.dispose();preview=null;view?.dispose();view=null;clearUiPreview=null;dialog?.close();dialog?.remove();dialog=null;
      if(!invalidate&&focus?.isConnected)focus.focus({preventScroll:true});
    }
    function createDialog(){
      ensureStyle();
      dialog=document.createElement('dialog');dialog.className='profile-shop-dialog';dialog.setAttribute('aria-label','Style shop');
      dialog.innerHTML='<header class="sp-host-head"><strong>Style shop</strong><button type="button" data-shop-host-close aria-label="Close style shop">Close</button></header><p class="sp-host-gate" role="status"></p><div class="sp-host-body"></div>';
      const grid=document.createElement('div');grid.className='sp-live-layout';
      const live=document.createElement('aside');live.className='sp-live-preview profile-customizer-preview';live.setAttribute('aria-label','Your racer preview');
      live.innerHTML='<header><strong>Your racer</strong><span>LIVE PREVIEW</span></header><div data-sp-live-stage></div><p data-sp-live-note role="status"></p><div class="sp-live-actions"><button type="button" data-sp-live-clear hidden>Exit preview</button><button type="button" data-sp-live-garage hidden>Car workshop</button></div>';
      const body=dialog.querySelector('.sp-host-body');body.before(grid);grid.append(live,body);
      mirrorObserver=new document.defaultView.MutationObserver(()=>{if(mirrorQueued)return;mirrorQueued=true;queueMicrotask(()=>{mirrorQueued=false;syncMirror();});});
      live.querySelector('[data-sp-live-garage]').addEventListener('click',()=>{
        const trigger=studio.querySelector('[data-car-workshop-open]');
        if(!current()||!trigger?.isConnected||trigger.disabled)return;
        close();if(!current())return;content.__profileHubClose?.();
        if(current()&&trigger.isConnected&&!trigger.disabled)trigger.click();
      });
      live.querySelector('[data-sp-live-clear]').addEventListener('click',()=>{if(clearUiPreview)clearUiPreview();else preview?.clear();syncMirror();});
      content.append(dialog);dialog.querySelector('[data-shop-host-close]').addEventListener('click',()=>close());
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      const notice=dialog.querySelector('.sp-host-gate');
      notice.textContent=!enabled?'Profile shop is not enabled yet. Purchases and claims are unavailable.':!user()?'Sign in to check your confirmed balance.':'';
      notice.hidden=!notice.textContent;
      const active=sharedStore();
      // The fixed public art catalog is not ownership, balance, or purchase proof.
      if(typeof getPreviewController==='function'&&typeof openStudio==='function')preview=bindProfileShopPreview(content,{accountId,getAccountId,getAuthScope:previewScope,getCatalog:()=>({version:PROFILE_SHOP_CATALOG_VERSION,items:PROFILE_SHOP_CATALOG}),getPreviewController,openStudio:keepShopPreview,revision});
      view=createShopController({root:dialog.querySelector('.sp-host-body'),store:active,
        mountShopPreview:(root,options)=>{
          const decorate=options=>{
            const generation=++publicViewGeneration,before=previewScope();
            return {...options,getRacerName:racerName,hasLivePreview:true,achievementClaimsEnabled:enabled===true&&achievementClaimsEnabled===true,dailyClaimed:loginClaimed(),embedded:true,catalog:options.catalog?.items?.length?options.catalog:{version:PROFILE_SHOP_CATALOG_VERSION,items:PROFILE_SHOP_CATALOG},actions:{...options.actions,...(preview?{
              onPreview:item=>{
                const isCurrent=()=>current()&&generation===publicViewGeneration&&before===previewScope();
                if(!isCurrent())throw Error('stale_profile_preview');
                const result=preview.preview({accountId,itemId:item.id,previewOnly:true,isCurrent});syncMirror();return result;
              },onRestorePreview:()=>{preview?.clear();syncMirror();}
            }:{})}};
          };
          const cleanup=mountShopPreview(root,decorate(options)),update=cleanup.update;clearUiPreview=cleanup.clearPreview;
          cleanup.update=options=>{preview?.clear();update(decorate(options));};return cleanup;
        },
        onCarPreview:preview?request=>preview.preview(request):undefined,onRestorePreview:()=>preview?.clear(),
        onStudio:()=>goStudio(),onClose:()=>close(),
        onApply:typeof applyDraft==='function'?async request=>{
          const state=active.state(),item=PROFILE_SHOP_CATALOG.find(item=>item.id===request.itemId),before=scope();
          if(!current()||!request.isCurrent()||!user()||!item||state.accountId!==accountId||!state.inventory?.ownedItemIds.includes(item.id))throw Error('confirmed_ownership_required');
          preview?.clear();if(!goStudio({kind:item.grants[0].slot,id:item.grants[0].value}))throw Error('studio_unavailable');
          if(!current()||before!==scope()||!request.isCurrent())throw Error('shop_auth_context_changed');
          const result=applyDraft(item.grants[0],{accountId,isCurrent:()=>current()&&before===scope()&&request.isCurrent()});
          if(result!==true)throw Error('studio_draft_unavailable');
          return {applied:true,accountId,itemId:item.id,draftOnly:true};
        }:undefined
      });
    }
    async function open(){
      if(!current())return false;focus=document.activeElement;observeAuth(currentAuth());
      openStudio?.();if(!current())return false;
      if(!dialog)createDialog();if(!dialog.open)dialog.showModal();syncMirror();
      if(enabled&&user()){try{await view.open();}catch{if(current()&&dialog){const notice=dialog.querySelector('.sp-host-gate');notice.hidden=false;notice.textContent='Server status could not be confirmed. Refresh explicitly to try again.';}}}
      return current();
    }
    const launchShop=()=>{if(!current())return false;void open();return true;};
    const closeShop=()=>{if(current())close(true);};
    const refreshPreview=()=>{if(!current()){close(true);return false;}syncMirror();return !!dialog?.open;};
    content.__profileShopOpen=launchShop;content.__profileShopClose=closeShop;content.__profileShopRefreshPreview=refreshPreview;
    content.dispatchEvent(new document.defaultView.CustomEvent('profile-shop-ready'));
    const click=()=>{void open();};button.addEventListener('click',click);
    const mount={close,cleanup,refresh:reason=>{if(current())onOwnedUiChange?.(reason);}};mounts.add(mount);
    observeAuth(currentAuth());mount.refresh('cache');
    function cleanup(){if(closed)return;closed=true;close(true);button.removeEventListener('click',click);button.remove();mounts.delete(mount);if(content.__profileShopOpen===launchShop)delete content.__profileShopOpen;if(content.__profileShopClose===closeShop)delete content.__profileShopClose;if(content.__profileShopRefreshPreview===refreshPreview)delete content.__profileShopRefreshPreview;content.dispatchEvent(new document.defaultView.CustomEvent('profile-shop-ready'));}
    cleanup.open=open;cleanup.refreshPreview=refreshPreview;return cleanup;
  }
  return {bind,observeAuth,reset,priceForUi,
    ownsForUi(accountId,unlockId){
      const ownerUid=user()?.uid;if(disposed||accountId!==getAccountId()||!ownerUid)return false;
      if(ownedCache.owns(accountId,ownerUid,unlockId))return true;
      const state=store?.state();
      if(state?.accountId===accountId&&state.wallet?.inventoryComplete===true&&state.inventory?.catalogVersion===PROFILE_SHOP_CATALOG_VERSION)
        return PROFILE_SHOP_CATALOG.some(item=>state.inventory.ownedItemIds.includes(item.id)&&item.grants.some(grant=>grant.slot+':'+grant.value===unlockId));
      return false;
    },
    noteAccountTransition(next){if(next!==lastAccount){lastAccount=next;reset();}},
    dispose(){if(disposed)return;disposed=true;unsubscribe?.();ownedUnsubscribe?.();for(const mount of [...mounts])mount.cleanup();mounts.clear();store?.dispose();}};
}
