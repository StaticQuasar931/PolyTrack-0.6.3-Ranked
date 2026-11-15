const {createStudioEditHistory}=await import(new URL('./studio-edit-history.mjs'+new URL(import.meta.url).search,import.meta.url).href);

const bindings=new WeakMap();
/** Device-only editing history. No persistence or publication is performed here.
 * markSaved requires the exact snapshot confirmed written by the parent.
 * Restore echoes are suppressed through the next microtask checkpoint.
 */
export function bindStudioDraftHistory(studio,{accountId,getAccountId,getDraft,getSavedDraft,onRestore,onUndoPreview,canUndoPreview,onClearPreview}={}){
  if(!studio?.isConnected||[getAccountId,getDraft,getSavedDraft,onRestore].some(fn=>typeof fn!=='function'))throw TypeError('Connected Studio and draft adapters required');
  if(typeof accountId!=='string'||!accountId.trim()||getAccountId()!==accountId)throw TypeError('Current account required');
  bindings.get(studio)?.dispose();
  const document=studio.ownerDocument,history=createStudioEditHistory({accountId,initial:getSavedDraft(),limit:50});
  let disposed=false,queued=false,restoring=false,generation=0;
  const current=()=>!disposed&&studio.isConnected&&getAccountId()===accountId;
  const actions=studio.querySelector('.profile-customizer-actions');
  const marker=document.createElement('span');marker.className='studio-dirty-marker';marker.setAttribute('role','status');marker.setAttribute('aria-live','polite');marker.textContent='Unsaved changes';
  const button=document.createElement('button');button.type='button';button.className='button studio-undo';button.textContent='Undo';button.title='Undo last change (Ctrl+Z)';
  const restoreButton=document.createElement('button');restoreButton.type='button';restoreButton.className='button studio-restore-saved';restoreButton.textContent='Restore saved draft';restoreButton.title='Restore your last confirmed saved design without publishing';
  actions?.prepend(marker,button,restoreButton);
  const previewActive=()=>typeof canUndoPreview==='function'?canUndoPreview()===true:studio.classList.contains('cosmetic-preview-active');
  function paint(){
    if(!current())return;
    const dirty=history.isDirty(accountId);marker.hidden=!dirty;if(studio.classList.contains('studio-has-unsaved-changes')!==dirty)studio.classList.toggle('studio-has-unsaved-changes',dirty);
    // The preview adapter can undo even when the draft ring has no earlier state.
    button.disabled=!history.canUndo(accountId)&&!previewActive();
    restoreButton.disabled=!dirty&&!previewActive();
  }
  function preparePreview(){
    const parts=[['.profile-preview-stage>.overall-car-model','stage','Edit car backdrop'],['.profile-row-showcase','theme','Edit nameplate'],['.showcase-row>strong','plate','Edit place block']];
    for(const [selector,kind,label] of parts)for(const node of studio.querySelectorAll(selector))if(!node.hasAttribute('data-studio-preview-part')){
      node.dataset.studioPreviewPart=kind;node.setAttribute('role','button');node.tabIndex=0;node.setAttribute('aria-label',label);
    }
  }
  function record(){if(!current()||restoring)return false;preparePreview();const value=history.record(accountId,getDraft());paint();return value;}
  function queue(){
    if(!current()||queued||restoring)return;
    queued=true;const token=generation;
    queueMicrotask(()=>{if(token!==generation)return;queued=false;record();});
  }
  function undo(){
    if(!current()||restoring)return false;
    record();const value=history.undo(accountId);if(value===null)return false;
    return restore(value);
  }
  function restore(value){
    restoring=true;generation++;queued=false;
    try{onRestore(value);}finally{
      paint();
      queueMicrotask(()=>{observer.takeRecords();restoring=false;});
    }
    return true;
  }
  function click(){
    if(!current()||restoring)return;
    if(previewActive()&&typeof onUndoPreview==='function'&&onUndoPreview()===true){paint();return;}
    undo();
  }
  function restoreSaved(){
    if(!current()||restoring)return false;
    record();
    if(previewActive()){
      if(typeof onClearPreview==='function')onClearPreview();
      else {let remaining=1000;while(previewActive()&&remaining-->0){if(typeof onUndoPreview!=='function'||onUndoPreview()!==true)break;}}
      if(previewActive())return false;
    }
    const value=history.restoreSaved(accountId);return value!==null&&restore(value);
  }
  const observer=new document.defaultView.MutationObserver(records=>{paint();if(records.some(row=>row.type==='childList'||row.attributeName==='aria-pressed'))queue();});
  observer.observe(studio,{subtree:true,attributes:true,childList:true,attributeFilter:['aria-pressed','class']});
  studio.addEventListener('click',queue);studio.addEventListener('input',queue);studio.addEventListener('change',queue);button.addEventListener('click',click);restoreButton.addEventListener('click',restoreSaved);
  function dispose(){
    if(disposed)return;disposed=true;generation++;queued=false;observer.disconnect();
    studio.removeEventListener('click',queue);studio.removeEventListener('input',queue);studio.removeEventListener('change',queue);button.removeEventListener('click',click);restoreButton.removeEventListener('click',restoreSaved);
    marker.remove();button.remove();restoreButton.remove();studio.classList.remove('studio-has-unsaved-changes');history.dispose();
    if(bindings.get(studio)===api)bindings.delete(studio);
  }
  const api=Object.freeze({record,undo,restoreSaved,refresh:paint,canUndo:()=>current()&&(history.canUndo(accountId)||previewActive()),isDirty:()=>current()&&history.isDirty(accountId),
    markSaved(value){if(!current()||value===undefined)return false;record();history.markClean(accountId,value);paint();return true;},dispose});
  record();bindings.set(studio,api);return api;
}
