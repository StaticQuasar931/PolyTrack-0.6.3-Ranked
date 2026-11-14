/** TRY ONLY. Parent must pass the real catalog and synchronous visual-only hooks.
 * Never pass a saved draft to this controller. onPreview receives only a frozen
 * catalog option plus frozen context {options,byKind,reason,replayIndex}.
 * Replay calls onPreview for EVERY selected kind, oldest to newest. Parent must
 * compose context.byKind over an ephemeral draft copy, never write draft/storage.
 * currentOption remains the latest choice; currentOptions is the full stack.
 * Repeating a choice removes that kind; undo removes the newest selected kind.
 * onUndoDraft is synchronous and runs only when no locked preview remains.
 * Text fields/editable content keep native keyboard undo, including in preview.
 * onRestore re-renders current authoritative/draft visuals outside studio scope.
 * Parent must call canPublish() in programmatic save paths and dispose before
 * account/UI replacement. Hooks must restore root-card visuals as well as studio
 * visuals on hub close/cancel. Dialog ownership is resolved on preview start, so
 * binding before the studio is moved into a native dialog is supported.
 * Capture guards cover only DOM clicks/submit/keyboard.
 * No unlock decisions, storage, network, badge grants, wallet or car fabrication.
 */
const KINDS=new Set(['theme','accent','finish','stage','stageTint','stageEffect','plate','edge','stripe','emblem','emblem2','emblem3','emblemBackdrop','nameFont','nameSize','nameWeight','nameColor','baseSecondary','title','badge']);
const CHOICE='[data-cosmetic-choice],[data-cosmetic-try]';
const PUBLISH='[data-save-profile-cosmetics],[data-cosmetic-publish]';
const LABEL='Preview only - not unlocked';
const bindings=new WeakMap();
const own=(object,key)=>object&&typeof object==='object'?Object.getOwnPropertyDescriptor(object,key)?.value:undefined;

export function resolveCosmeticPreview(catalog,request){
  const kind=own(request,'kind'),id=own(request,'id');
  if(typeof kind!=='string'||!KINDS.has(kind)||typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))return null;
  const options=own(catalog,kind);if(!Array.isArray(options)||options.length>4096)return null;
  const matches=options.filter(option=>Array.isArray(option)&&option[0]===id);
  if(matches.length!==1)return null;
  const option=matches[0],label=option[1],requirement=option[2];
  if(typeof label!=='string'||label.length>256||!(typeof requirement==='number'&&Number.isSafeInteger(requirement)&&requirement>=0||typeof requirement==='string'&&requirement.length>0&&requirement.length<=128))return null;
  return Object.freeze({kind,id,label,requirement,previewOnly:true,unlocked:false});
}

export function bindCosmeticPreview(studio,{catalog,onPreview,onRestore,onUndoDraft}={}){
  if(!studio?.ownerDocument||!studio.isConnected||typeof onPreview!=='function'||typeof onRestore!=='function')throw TypeError('Connected studio, catalog and synchronous visual-only hooks required');
  bindings.get(studio)?.dispose();
  const document=studio.ownerDocument,win=document.defaultView;
  const publishButtons=()=>[...studio.querySelectorAll(PUBLISH)];
  const accountStamp=()=>JSON.stringify([...new Set([studio.getAttribute('data-account-id'),...publishButtons().map(button=>button.getAttribute('data-account-id'))].filter(value=>value!==null))].sort());
  const account=accountStamp();
  const compact=win.matchMedia('(max-width:850px), (max-height:500px)');
  let options=[],selected=null,snapshot=null,banner=null,disposed=false,restoring=false,modal=null,lastChoice=null;
  let offsetHost=null,offsetBefore='';
  function releaseOffset(){
    if(offsetHost){
      if(offsetBefore)offsetHost.style.setProperty('--cosmetic-preview-header-height',offsetBefore);
      else offsetHost.style.removeProperty('--cosmetic-preview-header-height');
    }
    offsetHost=null;offsetBefore='';
  }
  function measureBanner(){
    if(offsetHost&&banner)offsetHost.style.setProperty('--cosmetic-preview-header-height',`${Math.ceil(banner.getBoundingClientRect().height)+12}px`);
  }
  const bannerObserver=new win.ResizeObserver(measureBanner);
  const guarded=new Map();
  const capture=()=>({
    classes:[studio,...studio.querySelectorAll('*')].map(node=>({node,cls:node.getAttribute('class'),style:node.getAttribute('style')})),
    labels:[...studio.querySelectorAll('[data-cosmetic-title-preview],[data-cosmetic-badge-preview]')].map(node=>({node,children:[...node.childNodes].map(child=>child.cloneNode(true))}))
  });
  const attr=(node,name,value)=>value===null?node.removeAttribute(name):node.setAttribute(name,value);
  function restoreVisuals(){
    if(!snapshot)return;
    for(const {node,cls,style} of snapshot.classes)if(node===studio||studio.contains(node)){attr(node,'class',cls);attr(node,'style',style);}
    for(const {node,children} of snapshot.labels)if(studio.contains(node))node.replaceChildren(...children.map(child=>child.cloneNode(true)));
  }
  function guardButtons(){
    for(const button of publishButtons()){
      if(!guarded.has(button))guarded.set(button,{disabled:button.disabled,aria:button.getAttribute('aria-disabled'),title:button.getAttribute('title')});
      button.disabled=true;button.setAttribute('aria-disabled','true');button.setAttribute('title',LABEL+'. Exit preview before publishing.');
    }
  }
  function releaseButtons(){
    for(const [button,state] of guarded){button.disabled=state.disabled;attr(button,'aria-disabled',state.aria);attr(button,'title',state.title);}
    guarded.clear();
  }
  function mark(){
    studio.classList.add('cosmetic-preview-active');guardButtons();
    if(!banner){
      banner=document.createElement('div');banner.className='cosmetic-preview-banner';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
      const text=document.createElement('strong');text.textContent=LABEL;
      const close=document.createElement('button');close.type='button';close.className='button cosmetic-preview-clear';close.dataset.cosmeticPreviewClear='';close.textContent='Exit preview';
      banner.append(text,close);
      bannerObserver.observe(banner);
      banner.addEventListener('click',event=>{
        if(event.target.closest?.('[data-cosmetic-preview-clear]')){stop(event);clear('exit');}
      });
      banner.addEventListener('keydown',keydown);
    }
    placeBanner();
  }
  function placeBanner(){
    if(!banner)return;
    const target=compact.matches?(studio.closest('.ph-studio-panel')||studio):(studio.querySelector('.profile-customizer-preview')||studio);
    if(banner.parentElement!==target||target.firstElementChild!==banner)target.prepend(banner);
    const next=compact.matches?target:null;
    if(next!==offsetHost){releaseOffset();offsetHost=next;offsetBefore=next?.style.getPropertyValue('--cosmetic-preview-header-height')||'';}
    measureBanner();
  }
  const layoutChange=()=>{if(current()&&selected)placeBanner();};
  function modalExit(event){if(selected)clear(event.type==='cancel'?'modal-cancel':'modal-close');}
  function watchModal(){
    const next=studio.closest('dialog');if(next===modal)return;
    modal?.removeEventListener('close',modalExit);modal?.removeEventListener('cancel',modalExit);
    modal=next;modal?.addEventListener('close',modalExit);modal?.addEventListener('cancel',modalExit);
  }
  function releaseModal(){modal?.removeEventListener('close',modalExit);modal?.removeEventListener('cancel',modalExit);modal=null;}
  function clear(reason='exit'){
    if(!selected||restoring)return false;
    const returnFocus=(reason==='exit'||reason==='escape')&&banner?.contains(document.activeElement)?lastChoice:null;
    const previous=selected,previousOptions=Object.freeze([...options]);options=[];selected=null;restoring=true;
    try{restoreVisuals();onRestore(Object.freeze({reason,previous,options:previousOptions,previewOnly:true}));}
    finally{bannerObserver.disconnect();releaseOffset();banner?.remove();banner=null;studio.classList.remove('cosmetic-preview-active');releaseButtons();snapshot=null;restoring=false;releaseModal();
      if(returnFocus?.isConnected&&studio.contains(returnFocus)&&!returnFocus.disabled&&!disposed&&accountStamp()===account)returnFocus.focus({preventScroll:true});
      lastChoice=null;}
    return true;
  }
  function dispose(reason='dispose'){
    if(disposed)return;disposed=true;observer.disconnect();compact.removeEventListener('change',layoutChange);
    studio.removeEventListener('click',click,true);studio.removeEventListener('keydown',keydown,true);studio.removeEventListener('submit',submit,true);studio.removeEventListener('input',edit,true);studio.removeEventListener('change',edit,true);studio.removeEventListener('toggle',toggle);
    try{clear(reason);}finally{releaseModal();if(bindings.get(studio)===api)bindings.delete(studio);}
  }
  function current(){
    if(disposed)return false;
    if(!studio.isConnected||accountStamp()!==account){dispose(studio.isConnected?'account-change':'detached');return false;}
    return true;
  }
  function preview(request,trigger=null){
    if(!current())return false;
    const option=resolveCosmeticPreview(catalog,request);if(!option)return false;
    const matches=node=>node.dataset.cosmeticKind===option.kind&&node.dataset.cosmeticValue===option.id;
    lastChoice=trigger&&studio.contains(trigger)&&trigger.matches(CHOICE)&&matches(trigger)?trigger:[...studio.querySelectorAll(CHOICE)].find(matches)||null;
    watchModal();if(modal&&!modal.open){releaseModal();return false;}
    if(!snapshot)snapshot=capture();
    const existing=options.find(item=>item.kind===option.kind);
    options=options.filter(item=>item.kind!==option.kind);
    if(existing?.id!==option.id)options.push(option);
    if(!options.length){clear('toggle');return true;}
    return replay(existing?.id===option.id?'toggle':'preview');
  }
  function replay(reason){
    selected=options.at(-1);
    const active=Object.freeze([...options]);
    const byKind=Object.freeze(Object.fromEntries(active.map(option=>[option.kind,option.id])));
    try{
      restoreVisuals();
      // Reset parent-owned root visuals before replaying the complete ephemeral set.
      if(banner)onRestore(Object.freeze({reason:'replay',previous:selected,options:active,previewOnly:true}));
      mark();
      for(const [index,option] of active.entries()){
        const context=Object.freeze({reason,options:active,byKind,replayIndex:index,previewOnly:true});
        const result=onPreview(option,context);
        if(result&&typeof result.then==='function')throw TypeError('Preview hook must be synchronous');
      }
      mark();return true;
    }catch(error){clear('render-failed');throw error;}
  }
  function undoPreview(){
    if(!current()||!options.length)return false;
    if(options.length===1)return clear('undo');
    options=options.slice(0,-1);return replay('undo');
  }
  function undo(){
    if(!current())return false;
    if(options.length)return undoPreview();
    if(typeof onUndoDraft!=='function')return false;
    const result=onUndoDraft(Object.freeze({previewOnly:false}));
    if(result&&typeof result.then==='function')throw TypeError('Draft undo hook must be synchronous');
    return result!==false;
  }
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const canPublish=()=>current()&&!selected;
  function guardPublish(event){if(canPublish())return true;if(event)stop(event);return false;}
  function click(event){
    if(!current())return;
    const target=event.target?.closest?.('button,a,input');if(!target||!studio.contains(target))return;
    if(target.matches('[data-cosmetic-preview-clear]')){stop(event);clear('exit');return;}
    if(target.matches(PUBLISH)){guardPublish(event);return;}
    const choice=target.closest(CHOICE);
    if(choice&&studio.contains(choice)){
      if(choice.hasAttribute('data-cosmetic-try')||choice.dataset.cosmeticLocked==='true'){
        stop(event);preview({kind:choice.dataset.cosmeticKind,id:choice.dataset.cosmeticValue},choice);
      }else if(selected)clear('edit');
      return;
    }
    if(selected&&target.matches('[data-discard-profile-cosmetics],[data-studio-close]'))clear('exit');
  }
  function keydown(event){
    if(!current())return;
    if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='z'){
      // Text editing always retains the browser's native undo, even in preview.
      if(event.target?.closest?.('input,textarea')||event.target?.isContentEditable)return;
      if(selected||typeof onUndoDraft==='function'){stop(event);undo();}return;
    }
    if(event.key==='Escape'&&selected){stop(event);clear('escape');return;}
    if(!['Enter',' '].includes(event.key))return;
    const choice=event.target?.closest?.(CHOICE);
    if(choice&&studio.contains(choice)&&(choice.hasAttribute('data-cosmetic-try')||choice.dataset.cosmeticLocked==='true')){stop(event);preview({kind:choice.dataset.cosmeticKind,id:choice.dataset.cosmeticValue});}
    else if(event.target?.matches?.(PUBLISH)&&selected)stop(event);
  }
  function submit(event){if(selected||!current())stop(event);}
  function edit(){if(selected)clear('edit');}
  function toggle(){if(studio.open===false&&selected)clear('close');}
  const observer=new win.MutationObserver(()=>{
    if(!current()||!selected)return;
    if(modal&&!modal.open){clear('modal-close');return;}
    if(modal&&!studio.closest('dialog')){clear('modal-detach');return;}
    watchModal();guardButtons();
  });
  const api={preview,clear,dispose,undo,undoPreview,currentOptions:()=>Object.freeze(current()?[...options]:[]),isActive:()=>current()&&!!selected,currentOption:()=>current()?selected:null,canPublish,guardPublish};
  bindings.set(studio,api);
  compact.addEventListener('change',layoutChange);
  studio.addEventListener('click',click,true);studio.addEventListener('keydown',keydown,true);studio.addEventListener('submit',submit,true);studio.addEventListener('input',edit,true);studio.addEventListener('change',edit,true);studio.addEventListener('toggle',toggle);
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-account-id','open']});
  return api;
}
