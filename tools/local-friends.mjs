const HASH=/^[a-f0-9]{64}$/;
export const FRIEND_LIMIT=32;
export function createLocalFriends({accountId,storage}={}){
  if(!HASH.test(accountId||''))throw Error('A local racer account is required');
  const key='polytrack:local-friends:v1:'+accountId;
  let ids=[],persisted=true;
  try{const text=storage?.getItem(key);if(text&&text.length<=4096){const value=JSON.parse(text);if(value?.version===1&&Array.isArray(value.ids))ids=[...new Set(value.ids.filter(id=>HASH.test(id)&&id!==accountId))].slice(0,FRIEND_LIMIT);}}catch{persisted=false;}
  function save(){try{if(!storage)throw Error();storage.setItem(key,JSON.stringify({version:1,ids}));persisted=true;}catch{persisted=false;}return persisted;}
  return {ids:()=>[...ids],has:id=>ids.includes(id),get persisted(){return persisted;},
    add(id){if(!HASH.test(id||'')||id===accountId)return {ok:false,reason:'invalid'};if(ids.includes(id))return {ok:true,persisted};if(ids.length>=FRIEND_LIMIT)return {ok:false,reason:'full'};ids.push(id);return {ok:true,persisted:save()};},
    remove(id){ids=ids.filter(value=>value!==id);return {ok:true,persisted:save()};}};
}
const validTime=f=>typeof f?.timeMs==='number'&&Number.isFinite(f.timeMs)&&f.timeMs>0;
export function friendChallenges({self=[],friends=[],complete=false,local=[],allowTrack=()=>true,limit=3}={}){
  if(complete!==true||!Array.isArray(self)||!Array.isArray(friends))return [];
  const mine=new Map(self.filter(validTime).map(f=>[f.trackId,f]));
  for(const f of Array.isArray(local)?local:[]){if(!validTime(f)||f.reviewHold||f.needsReview||['rejected','mismatch'].includes(f.verificationStatus))continue;const old=mine.get(f.trackId);if(!old||f.timeMs<old.timeMs)mine.set(f.trackId,{...f,deviceLocal:true});}
  const rows=[];
  for(const friend of friends){if(!HASH.test(friend?.id||'')||friend.complete!==true||!Array.isArray(friend.finishes))continue;
    for(const theirs of friend.finishes){if(!validTime(theirs)||!allowTrack(theirs.trackId)||theirs.runVerified===false||theirs.integrityVerified===false)continue;
      const yours=mine.get(theirs.trackId);if(yours&&yours.timeMs<=theirs.timeMs)continue;
      rows.push({friendId:friend.id,trackId:theirs.trackId,targetMs:theirs.timeMs,yourMs:yours?.timeMs??null,gapMs:yours?yours.timeMs-theirs.timeMs:null,relativeGap:yours?(yours.timeMs-theirs.timeMs)/yours.timeMs:null,weight:Number(theirs.weight)||0,local:yours?.deviceLocal===true});}}
  rows.sort((a,b)=>Number(a.gapMs===null)-Number(b.gapMs===null)||(a.relativeGap??Infinity)-(b.relativeGap??Infinity)||b.weight-a.weight||a.trackId.localeCompare(b.trackId)||a.friendId.localeCompare(b.friendId));
  const selected=[],seen=new Set();for(const row of rows){if(seen.has(row.trackId))continue;seen.add(row.trackId);selected.push(row);if(selected.length>=Math.max(1,Math.min(8,limit)))break;}return selected;
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountLocalFriends(host,{store,viewedId,resolveRacer,loadScoring,localFinishes=()=>[],allowTrack,trackName=id=>id,onOpenRacer,onOpenTrack,formatTime=ms=>(ms/1000).toFixed(3)+'s',isCurrent=()=>true}={}){
  if(!host?.isConnected||!store)return()=>{};const document=host.ownerDocument;let disposed=false,request=0;
  const current=()=>!disposed&&host.isConnected&&isCurrent();
  const name=id=>resolveRacer?.(id)?.name||'Saved racer';
  const status=text=>{const node=host.querySelector('[data-friend-status]');if(node)node.textContent=text;};
  const render=()=>{if(!current())return;
    if(viewedId){host.innerHTML='<button type="button" class="button local-friend-toggle" data-friend-toggle aria-pressed="'+store.has(viewedId)+'">'+(store.has(viewedId)?'Saved friend':'Add local friend')+'</button><span data-friend-status role="status"></span>';return;}
    const ids=store.ids();host.innerHTML='<details class="local-friends-panel"><summary><strong>Local friends</strong><span>'+ids.length+' / '+FRIEND_LIMIT+'</span></summary><p>Saved only on this device. Add racers from their profiles, then chase their PBs.</p><div class="local-friend-list">'+ids.map(id=>'<div><button type="button" class="button" data-friend-open="'+id+'">'+esc(name(id))+'</button><button type="button" class="button" data-friend-remove="'+id+'" aria-label="Remove '+esc(name(id))+' from local friends">Remove</button></div>').join('')+'</div><div class="local-friend-challenges" aria-live="polite"></div><span data-friend-status role="status"></span></details>';
    host.querySelector('details')?.addEventListener('toggle',()=>{if(host.querySelector('details')?.open)void refreshChallenges();});};
  async function refreshChallenges(){const generation=++request,output=host.querySelector('.local-friend-challenges');if(!output||!current())return;const ids=store.ids();if(!ids.length){output.textContent='Open a racer profile and choose Add local friend.';return;}output.textContent='Finding friendly rivalries...';
    let index;try{index=await loadScoring?.();}catch{}if(!current()||generation!==request)return;
    if(!index?.profiles?.get){output.textContent='Friend challenges need a complete saved snapshot.';return;}
    const selfId=host.dataset.friendAccount,own=index.profiles.get(selfId);if(!own){output.textContent='Complete ranked results are needed to compare PBs.';return;}
    const challenges=friendChallenges({self:own,complete:true,local:localFinishes(),friends:ids.map(id=>({id,complete:index.profiles.has(id),finishes:index.profiles.get(id)})),allowTrack});
    output.innerHTML=challenges.length?'<h4>A little friendly competition</h4>'+challenges.map(row=>'<button type="button" class="local-friend-challenge" data-friend-track="'+esc(row.trackId)+'"><strong>'+esc(trackName(row.trackId))+'</strong><span>Beat '+esc(name(row.friendId))+': '+esc(formatTime(row.targetMs))+'</span><small>'+(row.gapMs===null?'Your first finish starts the chase.':esc(formatTime(row.gapMs))+' separates your PBs.'+(row.local?' Your saved PB is included.':''))+'</small></button>').join(''):'You lead or tie your saved friends on the available shared tracks. Nicely done.';
  }
  function click(event){const button=event.target.closest('button');if(!button||!host.contains(button)||!current())return;
    if(button.hasAttribute('data-friend-toggle')){const result=store.has(viewedId)?store.remove(viewedId):store.add(viewedId);render();status(!result.ok?'Your local friends list is full.':!result.persisted?'Saved for this visit. Browser storage is unavailable.':store.has(viewedId)?'Added on this device. No friend request is sent.':'Removed from this device.');}
    else if(button.dataset.friendRemove){store.remove(button.dataset.friendRemove);render();const details=host.querySelector('details');if(details)details.open=true;}
    else if(button.dataset.friendOpen)onOpenRacer?.(button.dataset.friendOpen);
    else if(button.dataset.friendTrack)onOpenTrack?.(button.dataset.friendTrack);
  }
  render();host.addEventListener('click',click);return()=>{disposed=true;request++;host.removeEventListener('click',click);host.replaceChildren();};
}
