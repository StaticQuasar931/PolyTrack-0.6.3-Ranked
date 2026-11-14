import {createStudioEditHistory} from './studio-edit-history.mjs';

const bindings=new WeakMap();
/** Device-only editing history. No persistence or publication is performed here.
 * markSaved requires the exact snapshot confirmed written by the parent.
 * Restore echoes are suppressed through the next microtask checkpoint.
 */
export function bindStudioDraftHistory(studio,{accountId,getAccountId,getDraft,getSavedDraft,onRestore,onUndoPreview}={}){
  if(!studio?.isConnected||[getAccountId,getDraft,getSavedDraft,onRestore].some(fn=>typeof fn!=='function'))throw TypeError('Connected Studio and draft adapters required');
  if(typeof accountId!=='string'||!accountId.trim()||getAccountId()!==accountId)throw TypeError('Current account required');
  bindings.get(studio)?.dispose();
  const document=studio.ownerDocument,history=createStudioEditHistory({accountId,initial:getSavedDraft(),limit:50});
  let disposed=false,queued=false,restoring=false,generation=0;
  const current=()=>!disposed&&studio.isConnected&&getAccountId()===accountId;
  const actions=studio.querySelector('.profile-customizer-actions');
  const marker=document.createElement('span');marker.className='studio-dirty-marker';marker.setAttribute('role','status');marker.setAttribute('aria-live','polite');marker.textContent='Unsaved changes';
  const button=document.createElement('button');button.type='button';button.className='button studio-undo';button.textContent='Undo';button.title='Undo last change (Ctrl+Z)';
  actions?.prepend(marker,button);
  function paint(){
    if(!current())return;
    const dirty=history.isDirty(accountId);marker.hidden=!dirty;studio.classList.toggle('studio-has-unsaved-changes',dirty);
    // The preview adapter can undo even when the draft ring has no earlier state.
    button.disabled=!history.canUndo(accountId)&&typeof onUndoPreview!=='function';
  }
  function record(){if(!current()||restoring)return false;const value=history.record(accountId,getDraft());paint();return value;}
  function queue(){
    if(!current()||queued||restoring)return;
    queued=true;const token=generation;
    queueMicrotask(()=>{if(token!==generation)return;queued=false;record();});
  }
  function undo(){
    if(!current()||restoring)return false;
    record();const value=history.undo(accountId);if(value===null)return false;
    restoring=true;generation++;queued=false;
    try{onRestore(value);}finally{
      paint();
      queueMicrotask(()=>{observer.takeRecords();restoring=false;});
    }
    return true;
  }
  function click(){
    if(!current()||restoring)return;
    if(typeof onUndoPreview==='function'&&onUndoPreview()===true)return;
    undo();
  }
  const observer=new document.defaultView.MutationObserver(queue);
  observer.observe(studio,{subtree:true,attributes:true,attributeFilter:['aria-pressed']});
  studio.addEventListener('click',queue);studio.addEventListener('input',queue);studio.addEventListener('change',queue);button.addEventListener('click',click);
  function dispose(){
    if(disposed)return;disposed=true;generation++;queued=false;observer.disconnect();
    studio.removeEventListener('click',queue);studio.removeEventListener('input',queue);studio.removeEventListener('change',queue);button.removeEventListener('click',click);
    marker.remove();button.remove();studio.classList.remove('studio-has-unsaved-changes');history.dispose();
    if(bindings.get(studio)===api)bindings.delete(studio);
  }
  const api=Object.freeze({record,undo,isDirty:()=>current()&&history.isDirty(accountId),
    markSaved(value){if(!current()||value===undefined)return false;record();history.markClean(accountId,value);paint();return true;},dispose});
  record();bindings.set(studio,api);return api;
}
