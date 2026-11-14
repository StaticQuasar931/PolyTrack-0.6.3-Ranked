const ENDPOINT='https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/profile/community-badge';
const INVITE='https://discord.gg/jW2az4AQUH';
const ACCOUNT=/^[a-f0-9]{64}$/;
const FIELDS=['version','accepted','accountId','badgeId','source','membershipVerified','alreadyClaimed'];
let serial=0;

export function normalizeCommunityCode(value){
  if(typeof value!=='string'||value.length>192)return null;
  const input=value.trim();return /^[A-Z2-7]{16}$/.test(input)?input:null;
}
export const normalizeCommunityInvite=normalizeCommunityCode;

export function validateCommunityBadgeResponse(value,accountId){
  if(!ACCOUNT.test(accountId||'')||!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==FIELDS.length||!FIELDS.every(key=>Object.hasOwn(value,key))||
    value.version!==1||value.accepted!==true||value.accountId!==accountId||value.badgeId!=='community'||
    value.source!=='relay-code'||value.membershipVerified!==false||typeof value.alreadyClaimed!=='boolean')return null;
  return Object.freeze(Object.fromEntries(FIELDS.map(key=>[key,value[key]])));
}

async function readResponse(response){
  if(response.status!==200)throw Error('claim_rejected');
  const reader=response.body?.getReader();if(!reader)throw Error('invalid_response');
  const chunks=[];let length=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4096)throw Error('invalid_response');chunks.push(value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{void reader.cancel().catch(()=>{});}
}

/** No mount I/O or SDK initialization. getAuth returns an already initialized auth.
 * getAuthScope MUST include a monotonic account/auth generation, including A-B-A.
 * hasClaim is a boolean or current owner-scoped getter, never a balance/grant source.
 * onClaimed(frozenValidatedResponse); onUse({accountId,badgeId,draftOnly,isCurrent}).
 * onUse must check isCurrent before editing only the draft; this module never saves.
 * Dispose before root replacement, profile close, or account/auth transitions.
 */
export function mountCommunityBadge({document,root,accountId,getAccountId,getAuth,getAuthScope,fetch:fetcher=globalThis.fetch,revision,onClaimed,onUse,hasClaim=false,getSavedCode=()=>''}={}){
  const version=Number(revision);
  if(!document||root?.ownerDocument!==document||!ACCOUNT.test(accountId||'')||
    [getAccountId,getAuth,getAuthScope,fetcher].some(fn=>typeof fn!=='function')||
    !Number.isSafeInteger(version)||version<1||version>1000000)throw TypeError('Invalid community badge adapters');
  const safe=fn=>{try{return fn();}catch{return null;}},auth=safe(getAuth),owner=auth?.currentUser||null,scope=safe(getAuthScope);
  let disposed=false,epoch=0,pending=null,claimed=false,unsubscribe=null;
  const section=document.createElement('section'),id='community-badge-'+(++serial);
  section.className='community-badge';section.setAttribute('aria-labelledby',id+'-title');
  section.innerHTML=`<style>
    .community-badge{box-sizing:border-box;min-width:0;padding:16px;border:1px solid #577ba7;background:#192d54;color:#eef7ff;font:14px/1.45 ForcedSquare,sans-serif}
    .community-badge *{box-sizing:border-box}.community-badge h3{margin:0 0 8px;color:#7ee7ff;font:normal 24px/1.15 ForcedSquare,sans-serif}
    .community-badge p{margin:8px 0;font:14px/1.45 ForcedSquare,sans-serif!important;font-style:normal!important}
    .community-badge form{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.community-badge label{width:100%}
    .community-badge input{flex:1;min-width:130px;max-width:100%;min-height:44px;padding:10px;border:1px solid #7399bd;border-radius:0;background:#102244;color:#fff;font:14px/1.4 ForcedSquare,sans-serif}
    .community-badge button,.community-badge a{min-height:44px;padding:10px 14px;border:1px solid #7aa4c4;background:#284575;color:#fff;font:18px/1.2 ForcedSquare,sans-serif;cursor:pointer}
    .community-badge a{display:inline-flex;align-items:center;text-decoration:none}.community-badge button:disabled{opacity:.55;cursor:default}
    .community-badge [data-community-use]{background:#7ee7ff;color:#13274a}.community-badge :is(button,a,input):focus-visible{outline:3px solid #ffda83;outline-offset:3px}
    .community-badge [role=status]{color:#ffda83;min-height:20px;overflow-wrap:anywhere}.community-badge .cb-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
    @media(max-width:460px){.community-badge form>input,.community-badge form>button{flex-basis:100%;width:100%}}
  </style><h3 id="${id}-title">Community badge</h3><p>Claim with the community relay code</p><p id="${id}-help">Membership is not checked.</p><form novalidate><label for="${id}-code">Community code</label><input id="${id}-code" data-community-input type="password" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="${id}-help ${id}-status"><button type="submit" data-community-claim>Claim</button></form><div class="cb-actions"><a href="${INVITE}" target="_blank" rel="noopener noreferrer">Join Discord</a><button type="button" data-community-use>Use badge</button></div><p id="${id}-status" role="status" aria-live="polite"></p>`;
  root.append(section);
  const form=section.querySelector('form'),input=section.querySelector('input'),claimButton=section.querySelector('[data-community-claim]'),useButton=section.querySelector('[data-community-use]'),status=section.querySelector('[role=status]');
  const current=()=>!disposed&&root.isConnected&&section.isConnected&&safe(getAccountId)===accountId&&
    safe(getAuth)===auth&&auth?.currentUser===owner&&!!owner?.uid&&typeof scope==='string'&&!!scope&&safe(getAuthScope)===scope;
  const hasBadge=()=>current()&&(claimed||(typeof hasClaim==='function'?safe(hasClaim)===true:hasClaim===true));
  function render(){if(disposed)return;const available=current();claimButton.disabled=!available||!!pending||hasBadge();input.disabled=!!pending;useButton.disabled=!hasBadge()||!!pending||typeof onUse!=='function';section.setAttribute('aria-busy',String(!!pending));}
  function invalidate(){epoch++;claimed=false;pending?.abort();pending=null;if(!disposed){status.textContent='Account changed. Reopen Studio to continue.';render();}}
  if(typeof auth?.onAuthStateChanged==='function'){
    let initial=true;
    unsubscribe=auth.onAuthStateChanged(user=>{if(initial&&user===owner){initial=false;return;}initial=false;invalidate();},invalidate);
  }
  async function claim(event){
    event.preventDefault();if(pending||!current()||hasBadge())return;
    const communityCode=normalizeCommunityCode(input.value);
    if(!communityCode){input.setAttribute('aria-invalid','true');status.textContent='Enter the 16-character community relay code.';input.focus();return;}
    input.removeAttribute('aria-invalid');const generation=epoch,controller=new AbortController();pending=controller;status.textContent='Waiting for confirmation...';render();
    const sameContext=()=>current()&&epoch===generation;
    const valid=()=>sameContext()&&!controller.signal.aborted;
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      // Race token acquisition against disposal without persisting or logging it.
      const token=await new Promise((resolve,reject)=>{
        const abort=()=>reject(Error('cancelled'));controller.signal.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>{if(!valid())throw Error('cancelled');return owner.getIdToken();}).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
      });
      if(!valid())return;
      if(typeof token!=='string'||!token||token.length>16384||/[\r\n]/.test(token))throw Error('invalid_token');
      const response=await fetcher(ENDPOINT,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+token,'X-PolyTrack-Revision':String(version)},body:JSON.stringify({accountId,communityCode}),signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
      const result=validateCommunityBadgeResponse(await readResponse(response),accountId);if(!valid())return;if(!result)throw Error('invalid_response');
      claimed=true;status.textContent=result.alreadyClaimed?'Community badge already claimed.':'Community badge claimed.';render();
      if(valid()){try{onClaimed?.(result);}catch{if(valid())status.textContent='Badge claimed. Reopen Studio to use it.';}}
    }catch{if(sameContext())status.textContent='Claim could not be confirmed. Check the community code or reopen Studio before trying again.';}
    finally{clearTimeout(timer);if(pending===controller){pending=null;render();}}
  }
  function use(){
    if(pending||!hasBadge()||typeof onUse!=='function')return;
    const generation=epoch,isCurrent=()=>current()&&epoch===generation&&hasBadge();
    try{const result=onUse(Object.freeze({accountId,badgeId:'community',draftOnly:true,isCurrent}));if(result?.then)Promise.resolve(result).catch(()=>{if(isCurrent())status.textContent='Could not open the badge draft. Nothing was published.';});}
    catch{if(isCurrent())status.textContent='Could not open the badge draft. Nothing was published.';}
  }
  const savedCode=normalizeCommunityCode(safe(getSavedCode));if(savedCode)input.value=savedCode;
  form.addEventListener('submit',claim);useButton.addEventListener('click',use);render();
  status.textContent=hasBadge()?'Community badge already claimed.':!current()?'Sign in to claim this badge.':savedCode?'Your saved relay code is ready. Claim to confirm the badge.':'';
  return function dispose(){if(disposed)return;disposed=true;epoch++;pending?.abort();pending=null;unsubscribe?.();form.removeEventListener('submit',claim);useButton.removeEventListener('click',use);section.remove();};
}
