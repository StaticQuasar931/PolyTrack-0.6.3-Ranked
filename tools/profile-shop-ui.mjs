import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
const {renderProfileShopSwatch}=await import(new URL('./profile-shop-art.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const {ACHIEVEMENT_COIN_SCHEDULE}=await import(new URL('./achievement-coin-schedule.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const achievementMaximum=ACHIEVEMENT_COIN_SCHEDULE.reduce((sum,row)=>sum+row.amount,0);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uint=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export const formatShopPoints=value=>uint(value)?value.toLocaleString('en-US'):'Not available';
const coinIcon='<svg class="sp-coin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm3 5h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-9v10"/></svg>';
export function sortProfileShopItems(items,mode='catalog',ownedIds=[]) {
  const owned=new Set(ownedIds);
  return items.map((item,index)=>({item,index})).sort((a,b)=>
    (mode==='price'?a.item.price-b.item.price:mode==='name'?a.item.label.localeCompare(b.item.label,'en'):mode==='unowned'?Number(owned.has(a.item.id))-Number(owned.has(b.item.id)):0)||a.index-b.index
  ).map(({item})=>item);
}
let serial=0;

/** Profile-only presentation. No transport, persistence, awards or balance arithmetic.
 * Parent supplies the current catalog version (or its items array), same-account confirmed wallet and
 * inventory. purchaseEnabled and claimsEnabled default OFF. Mount never reads data.
 * onPurchase({accountId,itemId,price,walletRevision}) follows purchase confirmation.
 * Controller opening settles configured rewards before the confirmed wallet GET.
 * This presentation never claims or reads money on mount.
 * renderCosmeticPreview returns an inert detached actual Studio preview element.
 * Confirmation results: {confirmed:true,accountId,itemId|rewardId,wallet?,inventory?}.
 * onApply({accountId,itemId,draftOnly:true,isCurrent}) requires confirmed ownership.
 * Host must honor isCurrent, change ONLY the existing Studio draft, and return
 * {applied:true,accountId,itemId,draftOnly:true} before UI reports it was applied.
 * Optional actions: onRefresh,onPreview,onRestorePreview,onStudio,onClose. getRacerName may read existing owner-scoped rendered data.
 * Parent owns authentication, automatic opening synchronization and all server validation.
 * Returns cleanup() with .update(nextOptions); late results cannot cross accounts.
 */
export function mountProfileShopUi(root,options={}) {
  if(!root?.ownerDocument)return Object.assign(()=>{},{update:()=>{}});
  const doc=root.ownerDocument,prefix=`shop-preview-${++serial}`,host=doc.createElement('section');
  host.className='shop-preview';host.setAttribute('aria-labelledby',prefix+'-title');root.append(host);
  let state={...options},confirmId=null,previewId=null,operation=null,message='',disposed=false,epoch=0,previewGeneration=0;
  let sortMode='catalog';
  let earnOpen=doc.defaultView.matchMedia('(min-width:801px)').matches;
  const scoped=()=>typeof state.accountId==='string'&&state.accountId.length>0;
  const wallet=()=>scoped()&&state.cloudSaveConnected!==false&&state.wallet?.status==='confirmed'&&state.wallet.accountId===state.accountId&&uint(state.wallet.balance)&&uint(state.wallet.revision)?state.wallet:null;
  const inventory=()=>scoped()&&state.cloudSaveConnected!==false&&state.inventory?.status==='confirmed'&&state.inventory.accountId===state.accountId&&Array.isArray(state.inventory.ownedIds)?state.inventory:null;
  const items=()=>{
    if(!Array.isArray(state.catalog)&&state.catalog?.version!==PROFILE_SHOP_CATALOG_VERSION)return [];
    const input=Array.isArray(state.catalog)?state.catalog:state.catalog.items,seen=new Set();
    return (Array.isArray(input)?input:[]).filter(item=>{
      const known=PROFILE_SHOP_CATALOG.find(row=>row.id===item?.id),grant=item?.grants;
      return known&&item.price===known.price&&item.kind==='profile-cosmetic'&&typeof item.label==='string'&&uint(item.price)&&Array.isArray(grant)&&grant.length===1&&grant[0]?.slot===known.grants[0].slot&&grant[0]?.value===known.grants[0].value&&!seen.has(item.id)&&seen.add(item.id);
    });
  };
  const owned=item=>inventory()?.ownedIds.includes(item.id)===true;
  const canBuy=item=>state.purchaseEnabled===true&&typeof state.actions?.onPurchase==='function'&&!!wallet()&&!!inventory()&&!owned(item)&&wallet().balance>=item.price&&!operation&&!state.loading&&!state.busy;
  const canApply=item=>owned(item)&&typeof state.actions?.onApply==='function'&&!operation&&!state.loading&&!state.busy&&!confirmId;
  const balanceMessage=balance=>balance?'Original profile designs. No performance effects.':
    state.cloudSaveConnected===false?'Connect Cloud Save to load your confirmed balance and purchases.':
    state.error==='profile_not_owned'?'Complete your first ranked run to use the cloud shop. If you already have one, connect its owning Cloud Save.':
    state.error==='authentication_required'?'Reconnect Cloud Save to confirm your balance.':
    state.loading||state.busy?'Synchronizing eligible rewards and confirmed balance...':
    'Confirmed balance is unavailable. Reopen Shop to retry; no points are estimated.';
  function restorePreview(){++previewGeneration;if(previewId){previewId=null;state.actions?.onRestorePreview?.();}}
  const racerName=()=>{try{return state.getRacerName?.()||'';}catch{return '';}};
  function render(focusKey) {
    const list=sortProfileShopItems(items(),sortMode,inventory()?.ownedIds??[]),balance=wallet(),pending=!!operation,selected=list.find(item=>item.id===confirmId);
    host.innerHTML=`<header class="sp-head" ${state.embedded?'hidden':''}><div><p>PROFILE COLLECTION</p><h2 id="${prefix}-title">Style shop</h2></div>${state.actions?.onClose?'<button type="button" data-sp-action="close">Close</button>':''}</header>
      <p class="sp-status" role="status" aria-live="polite" ${pending?'aria-busy="true"':''}><strong class="sp-safety">Previewing never buys or applies.</strong><span>${esc(message||balanceMessage(balance))}</span>${previewId&&!state.hasLivePreview?'<button type="button" data-sp-action="clear">Exit preview</button>':''}</p>
      <div class="sp-summary"><div><span>${balance&&(pending||state.loading||state.busy)?'Last confirmed balance':'Confirmed balance'}</span><strong>${balance?coinIcon+formatShopPoints(balance.balance)+' Style Coins':state.loading||state.busy?'Synchronizing...':'Not available'}</strong></div><p data-sp-cloud-status>${state.cloudSaveConnected===false?'Connect Cloud Save to synchronize.':balance&&(pending||state.loading||state.busy)?'Previous server confirmation; current balance is synchronizing.':balance?'Confirmed by the server.':'Balance synchronizes automatically when Shop opens.'}</p></div>
      ${state.communityCodeState?.saved===true?'<p class="sp-community-local" data-sp-community-local>'+ (state.communityCodeState.formatValid===true?'Saved Community code has a valid local format.':'Saved Community code format needs attention.')+' Cloud Save is separate. Membership is not verified.</p>':''}
      <details class="sp-earn" ${earnOpen?'open':''}><summary><span class="sp-earn-label">Earn Style Coins</span><small>Eligible rewards sync on opening</small></summary><div class="sp-claim-body"><p>Eligible daily and track rewards synchronize automatically when Shop opens. The server checks eligibility and previous payouts. No claim button or estimated money.</p><p>Daily: 8 Style Coins. Recognized track milestones: 1 +20 / 5 +30 / 20 +50 / 35 +30 / 50 +40 / 70 +50 / 89 +60.</p>${state.achievementClaimsEnabled===true?'<p data-sp-achievement-policy>'+ACHIEVEMENT_COIN_SCHEDULE.length+' once-only cosmetic achievement bonuses, up to '+formatShopPoints(achievementMaximum)+' Style Coins. Shared title/style conditions pay once. Current server evidence only; not all historical goals are covered.</p>':''}${state.rewardSync==='unavailable'?'<p>Automatic reward synchronization is unavailable in this browser right now. Confirmed balance remains server-owned.</p>':''}</div></details>
      <p class="sp-note">Only the designs listed here can be bought with Style Coins. Other cosmetics are earned separately. Preview first; apply owned styles in Racer Studio.</p><label class="sp-sort">Sort designs <select data-sp-sort aria-label="Sort designs">${[['catalog','Catalog order'],['price','Price: low to high'],['name','Name'],['unowned','Not owned first']].map(([value,label])=>`<option value="${value}" ${sortMode===value?'selected':''}>${label}</option>`).join('')}</select></label><div class="sp-grid">${list.map(item=>{
        const isOwned=owned(item),reason=isOwned?'Owned':!inventory()?'Ownership not confirmed':balance&&balance.balance<item.price?'More Style Coins needed':'Not owned';
        const slot=item.grants[0].slot;
        const kind={theme:'COLOR THEME',baseSecondary:'SECONDARY COLOR',plate:'PLACE BLOCK',stage:'BACKDROP',stripe:'PATTERN',edge:'EDGE',nameFont:'NAME FONT',nameColor:'NAME COLOR'}[slot]||'PROFILE STYLE';
        return `<article class="sp-item ${previewId===item.id?'is-preview':''}"><div class="sp-art" aria-hidden="true" data-sp-swatch data-sp-item-preview="${esc(item.id)}">${renderProfileShopSwatch(item.id,{name:racerName(),density:state.density==='low'?'low':'normal'})}</div><div class="sp-item-meta"><span>${kind}</span><span>${reason}</span></div><h3>${esc(item.label)}</h3><p class="sp-price">${isOwned?'In your collection':`<strong>${coinIcon}${formatShopPoints(item.price)} Style Coins</strong>`}</p><div class="sp-item-actions"><button type="button" data-sp-action="preview" data-sp-id="${esc(item.id)}" ${typeof state.actions?.onPreview!=='function'||pending?'disabled':''}>${previewId===item.id?'Selected':'Try style'}</button>${isOwned?`<button type="button" data-sp-action="apply" data-sp-id="${esc(item.id)}" ${!canApply(item)?'disabled':''}>Apply to draft</button>`:`<button type="button" data-sp-action="buy" data-sp-id="${esc(item.id)}" ${!canBuy(item)||confirmId?'disabled':''} aria-label="Buy ${esc(item.label)} for ${formatShopPoints(item.price)} Style Coins">Buy</button>`}</div></article>`;
      }).join('')||'<p class="sp-empty">Profile styles are not available yet.</p>'}</div>
      ${selected?`<div class="sp-confirm" role="group" aria-labelledby="${prefix}-confirm"><h3 id="${prefix}-confirm">Buy ${esc(selected.label)}?</h3><p>Price ${formatShopPoints(selected.price)} Style Coins. Confirmed balance ${balance?formatShopPoints(balance.balance)+' Style Coins':'not available'}.</p><p>Purchase adds this profile design to your collection. Applying is separate.</p><div><button type="button" data-sp-action="cancel">Cancel</button><button type="button" data-sp-action="confirm" ${!canBuy(selected)?'disabled':''}>Confirm purchase</button></div></div>`:''}
      <footer>${state.reconciliationRequired&&typeof state.actions?.onReconcile==='function'?'<button type="button" data-sp-action="reconcile">Check pending transaction</button>':''}${typeof state.actions?.onStudio==='function'?'<button type="button" data-sp-action="studio">Open Racer Studio <span aria-hidden="true">&rsaquo;</span></button>':'<p>Owned styles can be applied in Racer Studio.</p>'}<span>Style Coins are earned in-game. No real-money purchases.</span></footer>`;
    // Only detached host snapshots are accepted; never move or mutate the live renderer.
    if(typeof state.renderCosmeticPreview==='function')for(const item of list){
      const target=host.querySelector('[data-sp-item-preview="'+item.id+'"]');
      try{
        const snapshot=state.renderCosmeticPreview({accountId:state.accountId,itemId:item.id,grant:{...item.grants[0]},density:state.density==='low'?'low':'normal'});
        if(snapshot?.nodeType===1&&snapshot.ownerDocument===doc&&!snapshot.isConnected){
          snapshot.inert=true;snapshot.setAttribute('aria-hidden','true');snapshot.dataset.spExistingPreview='';target.replaceChildren(snapshot);
        }
      }catch{}
    }
    if(focusKey)host.querySelector(`[data-sp-action="${focusKey}"]`)?.focus({preventScroll:true});
    if(focusKey==='confirm')host.querySelector('.sp-confirm')?.scrollIntoView({block:'center',behavior:'instant'});
  }
  function restoreBuy(id) {render();[...host.querySelectorAll('[data-sp-action="buy"]')].find(button=>button.dataset.spId===id)?.focus({preventScroll:true});}
  async function purchase(item) {
    if(!canBuy(item)||confirmId!==item.id)return;
    const token=++epoch,accountId=state.accountId,callback=state.actions.onPurchase,revision=wallet().revision;
    restorePreview();confirmId=null;operation={type:'purchase',itemId:item.id};message='Purchase submitted. Waiting for server confirmation.';render();
    try {
      const result=await callback({accountId,itemId:item.id,price:item.price,walletRevision:revision});
      if(disposed||token!==epoch||state.accountId!==accountId)return;
      if(result?.confirmed===true&&result.accountId===accountId&&result.itemId===item.id) {
        if(result.wallet?.status==='confirmed'&&result.wallet.accountId===accountId&&uint(result.wallet.balance)&&uint(result.wallet.revision)&&result.wallet.revision>=revision)state.wallet=result.wallet;
        if(result.inventory?.status==='confirmed'&&result.inventory.accountId===accountId&&Array.isArray(result.inventory.ownedIds))state.inventory=result.inventory;
        operation=null;message=owned(item)?'Purchase confirmed. Added to your collection.':'Purchase confirmed. Ownership refresh is needed.';
      } else {message='Waiting for server confirmation. Do not submit another purchase.';}
    } catch {if(disposed||token!==epoch)return;message='Purchase could not be confirmed. Reopen Shop to check server status before trying again.';operation={type:'purchase',itemId:item.id};}
    if(!disposed&&token===epoch)render();
  }
  async function apply(item){
    if(!canApply(item))return;
    const token=++epoch,accountId=state.accountId,callback=state.actions.onApply;restorePreview();operation={type:'apply',itemId:item.id};message='Opening your Studio draft...';render();
    const isCurrent=()=>!disposed&&token===epoch&&state.accountId===accountId&&owned(item);
    try{const result=await callback({accountId,itemId:item.id,draftOnly:true,isCurrent});if(!isCurrent())return;message=result?.applied===true&&result.draftOnly===true&&result.accountId===accountId&&result.itemId===item.id?'Added to your Studio draft. Publish there to share.':'Continue in Racer Studio to apply this style.';}
    catch{if(!isCurrent())return;message='Could not open the Studio draft. Nothing was published.';}
    if(isCurrent()){operation=null;render();}
  }
  const click=event=>{
    const button=event.target.closest('button');if(!button||!host.contains(button)||button.disabled)return;
    const item=items().find(item=>item.id===button.dataset.spId),action=button.dataset.spAction;
    if(action==='buy'&&item&&canBuy(item)){confirmId=item.id;message='';render('confirm');}
    else if(action==='cancel'){const id=confirmId;confirmId=null;message='Purchase cancelled.';restoreBuy(id);}
    else if(action==='confirm'){const selected=items().find(item=>item.id===confirmId);if(selected)void purchase(selected);}
    else if(action==='preview'&&item){
      restorePreview();previewId=item.id;message='Selected for preview. Nothing purchased or equipped.';render();
      [...host.querySelectorAll('[data-sp-action="preview"]')].find(node=>node.dataset.spId===item.id)?.focus({preventScroll:true});
      const previewEpoch=epoch,previewToken=++previewGeneration;
      try {Promise.resolve(state.actions.onPreview({...item})).catch(()=>{if(!disposed&&previewEpoch===epoch&&previewToken===previewGeneration){previewId=null;message='Preview unavailable. Nothing was purchased.';render();}});}catch{previewId=null;message='Preview unavailable. Nothing was purchased.';render();}
    }
    else if(action==='apply'&&item)void apply(item);
    else if(action==='clear'){restorePreview();message='Preview closed.';render();}
    else if(action==='reconcile'&&typeof state.actions?.onReconcile==='function')state.actions.onReconcile();
    else if(action==='studio'){restorePreview();state.actions?.onStudio?.({category:'profile'});}
    else if(action==='close'){restorePreview();state.actions?.onClose?.();}
  };
  const keydown=event=>{if(event.key==='Escape'&&confirmId){event.preventDefault();event.stopPropagation();const id=confirmId;confirmId=null;message='Purchase cancelled.';restoreBuy(id);}};
  const change=event=>{if(event.target.matches('[data-sp-sort]')&&['catalog','price','name','unowned'].includes(event.target.value)){sortMode=event.target.value;render();host.querySelector('[data-sp-sort]')?.focus({preventScroll:true});}};
  const toggle=event=>{if(event.target.matches('.sp-earn'))earnOpen=event.target.open;};
  host.addEventListener('change',change);host.addEventListener('toggle',toggle,true);host.addEventListener('click',click);host.addEventListener('keydown',keydown);render();
  function cleanup(){if(disposed)return;disposed=true;++epoch;restorePreview();host.removeEventListener('change',change);host.removeEventListener('toggle',toggle,true);host.removeEventListener('click',click);host.removeEventListener('keydown',keydown);host.remove();}
  cleanup.clearPreview=()=>{if(disposed)return;restorePreview();message='Preview closed.';render();};
  cleanup.update=next=>{if(disposed)return;++epoch;restorePreview();state={...state,...next};confirmId=null;operation=null;previewId=null;message='';render();};
  return cleanup;
}
