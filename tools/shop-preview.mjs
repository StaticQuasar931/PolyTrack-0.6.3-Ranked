import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
import {renderProfileShopArt} from './profile-shop-art.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uint=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export const formatShopPoints=value=>uint(value)?value.toLocaleString('en-US'):'Not available';
const rewards=[{id:'login',label:'Daily visit',points:8},{id:'milestones',label:'1 / 5 / 20 ranked tracks',points:null}];
let serial=0;

/** Profile-only presentation. No transport, persistence, awards or balance arithmetic.
 * Parent supplies catalog v2 (or its items array), same-account confirmed wallet and
 * inventory. purchaseEnabled and claimsEnabled default OFF. Mount never reads data.
 * onPurchase({accountId,itemId,price,walletRevision}) follows purchase confirmation.
 * onClaim({accountId,rewardId,walletRevision}) follows an explicit claim button.
 * Confirmation results: {confirmed:true,accountId,itemId|rewardId,wallet?,inventory?}.
 * onApply({accountId,itemId,draftOnly:true,isCurrent}) requires confirmed ownership.
 * Host must honor isCurrent, change ONLY the existing Studio draft, and return
 * {applied:true,accountId,itemId,draftOnly:true} before UI reports it was applied.
 * Optional actions: onRefresh,onPreview,onRestorePreview,onStudio,onClose.
 * Parent owns manual fetch, authentication, all server validation and publication.
 * Returns cleanup() with .update(nextOptions); late results cannot cross accounts.
 */
export function mountShopPreview(root,options={}) {
  if(!root?.ownerDocument)return Object.assign(()=>{},{update:()=>{}});
  const doc=root.ownerDocument,prefix=`shop-preview-${++serial}`,host=doc.createElement('section');
  host.className='shop-preview';host.setAttribute('aria-labelledby',prefix+'-title');root.append(host);
  let state={...options},confirmId=null,previewId=null,operation=null,message='',disposed=false,epoch=0,previewGeneration=0;
  let earnOpen=doc.defaultView.matchMedia('(min-width:801px)').matches;
  const scoped=()=>typeof state.accountId==='string'&&state.accountId.length>0;
  const wallet=()=>scoped()&&state.wallet?.status==='confirmed'&&state.wallet.accountId===state.accountId&&uint(state.wallet.balance)&&uint(state.wallet.revision)?state.wallet:null;
  const inventory=()=>scoped()&&state.inventory?.status==='confirmed'&&state.inventory.accountId===state.accountId&&Array.isArray(state.inventory.ownedIds)?state.inventory:null;
  const items=()=>{
    if(!Array.isArray(state.catalog)&&state.catalog?.version!==PROFILE_SHOP_CATALOG_VERSION)return [];
    const input=Array.isArray(state.catalog)?state.catalog:state.catalog.items,seen=new Set();
    return (Array.isArray(input)?input:[]).filter(item=>{
      const known=PROFILE_SHOP_CATALOG.find(row=>row.id===item?.id),grant=item?.grants;
      return known&&item.kind==='profile-cosmetic'&&typeof item.label==='string'&&uint(item.price)&&Array.isArray(grant)&&grant.length===1&&grant[0]?.slot===known.grants[0].slot&&grant[0]?.value===known.grants[0].value&&!seen.has(item.id)&&seen.add(item.id);
    });
  };
  const owned=item=>inventory()?.ownedIds.includes(item.id)===true;
  const canBuy=item=>state.purchaseEnabled===true&&typeof state.actions?.onPurchase==='function'&&!!wallet()&&!!inventory()&&!owned(item)&&wallet().balance>=item.price&&!operation;
  const canClaim=reward=>!(reward?.id==='login'&&state.dailyClaimed===true)&&state.claimsEnabled===true&&typeof state.actions?.onClaim==='function'&&!!wallet()&&!operation&&!confirmId;
  const canApply=item=>owned(item)&&typeof state.actions?.onApply==='function'&&!operation&&!confirmId;
  function restorePreview(){++previewGeneration;if(previewId){previewId=null;state.actions?.onRestorePreview?.();}}
  function render(focusKey) {
    const list=items(),balance=wallet(),pending=!!operation,selected=list.find(item=>item.id===confirmId);
    host.innerHTML=`<header class="sp-head" ${state.embedded?'hidden':''}><div><p>PROFILE COLLECTION</p><h2 id="${prefix}-title">Racer shop</h2></div>${state.actions?.onClose?'<button type="button" data-sp-action="close">Close</button>':''}</header>
      <p class="sp-status" role="status" aria-live="polite" ${pending?'aria-busy="true"':''}><strong class="sp-safety">Previewing never buys or applies.</strong><span>${esc(message||(!balance?'Check your balance to load confirmed points.':'Original profile designs. No performance effects.'))}</span>${previewId?'<button type="button" data-sp-action="clear">Exit preview</button>':''}</p>
      <div class="sp-summary"><div><span>Confirmed balance</span><strong>${balance?formatShopPoints(balance.balance)+' CP':'Not available'}</strong></div>${typeof state.actions?.onRefresh==='function'?`<button type="button" data-sp-action="refresh" ${pending||state.refreshEnabled===false?'disabled':''}>${balance?'Refresh balance':'Check balance'}</button>`:'<p>Balance appears after a manual server check.</p>'}</div>
      <details class="sp-earn" ${earnOpen?'open':''}><summary><span class="sp-earn-label">Earn CP</span><small>Daily claim: 8 CP / milestones</small></summary><div class="sp-claim-body"><p>Server checks eligibility. One-time milestones: 1 track +20 CP / 5 tracks +30 CP / 20 tracks +50 CP.</p><div class="sp-claim-actions">${rewards.map(reward=>`<button type="button" data-sp-action="claim" data-sp-reward="${reward.id}" ${!canClaim(reward)?'disabled':''}><span>${reward.label}</span><strong>${reward.id==='login'&&state.dailyClaimed===true?'Claimed today':reward.points===null?'Claim milestones':'Claim '+formatShopPoints(reward.points)+' CP'}</strong></button>`).join('')}</div></div></details>
      <p class="sp-note">Three original profile designs. Preview first, apply owned styles in Racer Studio.</p><div class="sp-grid">${list.map(item=>{
        const isOwned=owned(item),reason=isOwned?'Owned':!inventory()?'Ownership not confirmed':balance&&balance.balance<item.price?'More CP needed':'Not owned';
        const kind={plate:'PLACE BLOCK',stage:'BACKDROP',stripe:'PATTERN'}[item.grants[0].slot];
        return `<article class="sp-item ${previewId===item.id?'is-preview':''}"><div class="sp-art" aria-hidden="true">${renderProfileShopArt(item.id,{density:state.density==='low'?'low':'normal'})}</div><div class="sp-item-meta"><span>${kind}</span><span>${reason}</span></div><h3>${esc(item.label)}</h3><p class="sp-price">${isOwned?'In your collection':`<strong>${formatShopPoints(item.price)} CP</strong>`}</p><div class="sp-item-actions"><button type="button" data-sp-action="preview" data-sp-id="${esc(item.id)}" ${typeof state.actions?.onPreview!=='function'||pending?'disabled':''}>${previewId===item.id?'Preview selected':'Preview'}</button>${isOwned?`<button type="button" data-sp-action="apply" data-sp-id="${esc(item.id)}" ${!canApply(item)?'disabled':''}>Apply to draft</button>`:`<button type="button" data-sp-action="buy" data-sp-id="${esc(item.id)}" ${!canBuy(item)||confirmId?'disabled':''}>Buy for ${formatShopPoints(item.price)} CP</button>`}</div></article>`;
      }).join('')||'<p class="sp-empty">Profile styles are not available yet.</p>'}</div>
      ${selected?`<div class="sp-confirm" role="group" aria-labelledby="${prefix}-confirm"><h3 id="${prefix}-confirm">Buy ${esc(selected.label)}?</h3><p>Price ${formatShopPoints(selected.price)} CP. Confirmed balance ${balance?formatShopPoints(balance.balance)+' CP':'not available'}.</p><p>Purchase adds this profile design to your collection. Applying is separate.</p><div><button type="button" data-sp-action="cancel">Cancel</button><button type="button" data-sp-action="confirm" ${!canBuy(selected)?'disabled':''}>Confirm purchase</button></div></div>`:''}
      <footer>${state.reconciliationRequired&&typeof state.actions?.onReconcile==='function'?'<button type="button" data-sp-action="reconcile">Check pending transaction</button>':''}${typeof state.actions?.onStudio==='function'?'<button type="button" data-sp-action="studio">Open Racer Studio <span aria-hidden="true">&rsaquo;</span></button>':'<p>Owned styles can be applied in Racer Studio.</p>'}<span>CP are earned points. No real-money purchases.</span></footer>`;
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
    } catch {if(disposed||token!==epoch)return;message='Purchase could not be confirmed. Refresh server status before trying again.';operation={type:'purchase',itemId:item.id};}
    if(!disposed&&token===epoch)render();
  }
  async function claim(reward){
    if(!canClaim(reward))return;
    const token=++epoch,accountId=state.accountId,revision=wallet().revision,callback=state.actions.onClaim;
    restorePreview();operation={type:'claim',rewardId:reward.id};message='Waiting for server confirmation. Do not submit again.';render();
    try{
      const result=await callback({accountId,rewardId:reward.id,walletRevision:revision});
      if(disposed||token!==epoch||state.accountId!==accountId)return;
      if(result?.confirmed===true&&result.accountId===accountId&&result.rewardId===reward.id){
        if(result.wallet?.status==='confirmed'&&result.wallet.accountId===accountId&&uint(result.wallet.balance)&&uint(result.wallet.revision)&&result.wallet.revision>=revision)state.wallet=result.wallet;
        operation=null;message='Claim confirmed.';
      }
    }catch{if(disposed||token!==epoch)return;message='Could not confirm. Refresh server status before trying again.';}
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
    } else if(action==='claim'){const reward=rewards.find(row=>row.id===button.dataset.spReward);if(reward)void claim(reward);}
    else if(action==='apply'&&item)void apply(item);
    else if(action==='clear'){restorePreview();message='Preview closed.';render();}
    else if(action==='reconcile'&&typeof state.actions?.onReconcile==='function')state.actions.onReconcile();
    else if(action==='refresh'&&!operation&&typeof state.actions?.onRefresh==='function')state.actions.onRefresh();
    else if(action==='studio'){restorePreview();state.actions?.onStudio?.({category:'profile'});}
    else if(action==='close'){restorePreview();state.actions?.onClose?.();}
  };
  const keydown=event=>{if(event.key==='Escape'&&confirmId){event.preventDefault();event.stopPropagation();const id=confirmId;confirmId=null;message='Purchase cancelled.';restoreBuy(id);}};
  const toggle=event=>{if(event.target.matches('.sp-earn'))earnOpen=event.target.open;};
  host.addEventListener('toggle',toggle,true);host.addEventListener('click',click);host.addEventListener('keydown',keydown);render();
  function cleanup(){if(disposed)return;disposed=true;++epoch;restorePreview();host.removeEventListener('toggle',toggle,true);host.removeEventListener('click',click);host.removeEventListener('keydown',keydown);host.remove();}
  cleanup.update=next=>{if(disposed)return;++epoch;restorePreview();state={...state,...next};confirmId=null;operation=null;previewId=null;message='';render();};
  return cleanup;
}
