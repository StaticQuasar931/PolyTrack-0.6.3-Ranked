/** Pure, in-memory, single-account draft snapshots. No persistence or side effects.
 * reset explicitly switches accounts and drops the old ring. Stale account calls
 * fail closed. Snapshots are canonical plain JSON data, detached and deep frozen.
 * record only real draft edits; restore/undo/replay never auto-record. Parent owns
 * suppression of redraw echoes through the next microtask. markClean is for an
 * authoritative baseline or confirmed save, not a preview clear or an undo.
 */
function snapshot(value,seen=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(!value||typeof value!=='object'||seen.has(value))throw TypeError('Plain finite JSON snapshot required');
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(!array&&proto!==Object.prototype&&proto!==null)throw TypeError('Plain JSON snapshot required');
  if(array&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,index)=>key!==String(index))))throw TypeError('Dense JSON arrays required');
  seen.add(value);
  const copy=array?[]:{};
  for(const key of Object.keys(value).sort()){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value' in descriptor))throw TypeError('Snapshot accessors are not supported');
    Object.defineProperty(copy,key,{value:snapshot(descriptor.value,seen),enumerable:true});
  }
  seen.delete(value);return Object.freeze(copy);
}
const accountValid=value=>typeof value==='string'&&value.trim().length>0;
export function createStudioEditHistory({accountId,initial,limit=50}={}){
  if(!Number.isSafeInteger(limit)||limit<2||limit>1000)throw RangeError('History limit must be 2..1000');
  let account=null,ring=[],clean=null,disposed=false;
  const valid=id=>!disposed&&account!==null&&id===account;
  const key=value=>JSON.stringify(value);
  function reset(id,value){
    if(disposed)return false;
    if(!accountValid(id))throw TypeError('Explicit account ID required');
    const next=snapshot(value);account=id;ring=[next];clean=key(next);return next;
  }
  function current(id){return valid(id)&&ring.length?ring.at(-1):null;}
  function record(id,value){
    if(!valid(id)||!ring.length)return false;
    const next=snapshot(value);
    if(key(next)===key(ring.at(-1)))return false;
    ring.push(next);if(ring.length>limit)ring.shift();return next;
  }
  function canUndo(id){return valid(id)&&ring.length>1;}
  function undo(id){if(!canUndo(id))return null;ring.pop();return ring.at(-1);}
  function markClean(id,value){
    if(!valid(id)||!ring.length)return false;
    clean=key(value===undefined?ring.at(-1):snapshot(value));return true;
  }
  function clear(){account=null;ring=[];clean=null;}
  function dispose(){clear();disposed=true;}
  if(accountId!==undefined)reset(accountId,initial);
  return Object.freeze({reset,current,record,undo,canUndo,markClean,
    isDirty:id=>valid(id)&&ring.length>0&&key(ring.at(-1))!==clean,
    size:id=>valid(id)?ring.length:0,clear,dispose});
}
