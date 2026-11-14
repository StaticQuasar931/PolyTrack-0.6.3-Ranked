import {roofAttachment} from './car-roof-geometry.mjs';
// Native visual-only additions. Never changes controls, physics, stock parts or cloud data.
export const CAR_PAINTS=Object.freeze([
  Object.freeze({id:'mint',name:'Mint Rally',colors:[0x167d70,0xeafff7,0x171d23,0xc6e6d8]}),
  Object.freeze({id:'ember',name:'Ember Circuit',colors:[0xa63f27,0xffdf9a,0x25201e,0xe8a742]}),
  Object.freeze({id:'night',name:'Night Signal',colors:[0x17334e,0x7ee7ff,0x151e2b,0xd7e6ed]})
]);
export const CAR_ACCESSORIES=Object.freeze([['none','None'],['fin','Aero fin'],['beacon','Rally beacon'],['aerial','Radio aerial'],['roofbox','Touring box'],['crown','Podium crown'],['halo','Neon rail']]);
const IDS=new Set(CAR_ACCESSORIES.map(([id])=>id));
const KEY='polytrack-car-cosmetics-v1:';
const validId=id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
const faces=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[1,2,6],[1,6,5],[0,4,7],[0,7,3]];
export function accessoryGeometry(id,density='low'){
  if(!IDS.has(id)||id==='none'||!['low','medium','high'].includes(density))throw Error('Unknown car accessory');
  const points=id==='fin'?[[-.018,0,-.25],[.018,0,-.25],[.018,0,.24],[-.018,0,.24],[-.012,.16,-.17],[.012,.16,-.17],[.012,.055,.18],[-.012,.055,.18]]:[[-.07,0,-.07],[.07,0,-.07],[.07,0,.07],[-.07,0,.07],[-.045,.13,-.045],[.045,.13,-.045],[.045,.13,.045],[-.045,.13,.045]];
  if(!['fin','beacon'].includes(id)){
    const boxes=id==='aerial'?[[0,.16,0,.018,.32,.018]]:id==='roofbox'?[[0,.07,0,.28,.14,.4]]:id==='halo'?[[-.14,.025,0,.035,.05,.4],[.14,.025,0,.035,.05,.4],[0,.025,-.18,.28,.05,.035]]:[[0,.025,0,.26,.05,.16],[-.09,.095,0,.045,.13,.08],[0,.12,0,.045,.18,.08],[.09,.095,0,.045,.13,.08]];
    const vertices=[];for(const [x,y,z,w,h,d]of boxes){const corners=[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]].map(([a,b,c])=>[x+a*w/2,y+b*h/2,z+c*d/2]);for(const face of faces)for(const i of face)vertices.push(...corners[i]);}
    return Object.freeze({positions:new Float32Array(vertices),triangles:vertices.length/9});
  }
  if(density==='low'){

    const simple=id==='fin'?[[-.014,0,-.25],[.014,0,-.25],[0,0,.24],[0,.16,-.12]]:[[-.065,0,-.065],[.065,0,-.065],[.065,0,.065],[-.065,0,.065],[0,.13,0]];
    const triangles=id==='fin'?[[0,2,1],[0,1,3],[1,2,3],[2,0,3]]:[[0,2,1],[0,3,2],[0,1,4],[1,2,4],[2,3,4],[3,0,4]];
    return Object.freeze({positions:new Float32Array(triangles.flatMap(face=>face.flatMap(index=>simple[index]))),triangles:triangles.length});
  }
  return Object.freeze({positions:new Float32Array(faces.flatMap(face=>face.flatMap(index=>points[index]))),triangles:12});
}
const validPaint=value=>Array.isArray(value)&&value.length===4&&value.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffff);
export function readCarCosmetic(storage,accountId){
  if(!validId(accountId))return {accessory:'none'};
  try{const value=JSON.parse(storage.getItem(KEY+accountId));if(value?.version!==1||!IDS.has(value.accessory)||!Object.keys(value).every(key=>['version','accessory','paintColors','paintSavedAt'].includes(key)))return {accessory:'none'};
    return {accessory:value.accessory,...(validPaint(value.paintColors)&&Number.isSafeInteger(value.paintSavedAt)&&value.paintSavedAt>0?{paintColors:[...value.paintColors],paintSavedAt:value.paintSavedAt}:{})};
  }catch{return {accessory:'none'};}
}
export function saveCarCosmetic(storage,accountId,accessory,paintColors,now=Date.now()){
  if(!validId(accountId)||!IDS.has(accessory)||paintColors!==undefined&&(!validPaint(paintColors)||!Number.isSafeInteger(now)||now<=0))return false;
  try{const prior=readCarCosmetic(storage,accountId),value=JSON.stringify({version:1,accessory,...(paintColors?{paintColors:[...paintColors],paintSavedAt:now}:prior.paintColors?{paintColors:prior.paintColors,paintSavedAt:prior.paintSavedAt}:{})});if(storage.getItem(KEY+accountId)!==value)storage.setItem(KEY+accountId,value);return true;}catch{return false;}
}

function chassisFor(car,renderer){
  const matrix=car.getChassisMatrix(),matches=[];
  renderer.scene.traverse(node=>{if(node.matrix===matrix)matches.push(node);});
  if(matches.length!==1)throw Error('Exact native chassis is unavailable');return matches[0];
}
function buildAccessoryMount({car,renderer,chassis,three},id,density){
  if(id==='none')return ()=>{};
  if(!chassis||chassis.matrix!==car.getChassisMatrix())throw Error('Native chassis identity mismatch');
  let reference=null;chassis.traverse(node=>{if(!reference&&node.geometry?.attributes?.position?.array instanceof Float32Array)reference=node;});
  if(!reference)throw Error('Native car geometry unavailable');
  const source=reference.geometry,positions=source.getAttribute('position'),Geometry=source.constructor,Attribute=positions.constructor;
  source.computeBoundingBox();const box=source.boundingBox;if(!box)throw Error('Native car bounds unavailable');
  const group=new three.Group();group.name='PolyTrackVisualAccessory';
  reference.updateWorldMatrix(true,false);chassis.updateWorldMatrix(true,false);
  const relative=chassis.matrixWorld.clone().invert().multiply(reference.matrixWorld),m=relative.elements,vertices=[];
  for(let i=0;i<positions.count;i++){const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);vertices.push(m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]);}
  const anchor=roofAttachment(vertices,source.index?.array);group.position.set(anchor.x,anchor.y,anchor.z);
  const assets=[],meshes=[];
  try{
    const spec=accessoryGeometry(id,density),geometry=new Geometry();assets.push(()=>geometry.dispose());geometry.setAttribute('position',new Attribute(spec.positions,3));geometry.computeVertexNormals();
    const material=new three.Material({color:id==='fin'?0x7ee7ff:0xffce72,flatShading:true,emissive:id==='halo'?0x37b5ce:0,emissiveIntensity:.5});material.name='PolyTrackAccessory';assets.push(()=>material.dispose());renderer.addMaterial(material);assets.push(()=>renderer.removeMaterial(material));
    const mesh=new three.Mesh(geometry,material);mesh.raycast=()=>{};mesh.name='PolyTrackAccessory-'+id;mesh.castShadow=false;mesh.receiveShadow=false;group.add(mesh);meshes.push(mesh);
    chassis.add(group);
    let dead=false;return ()=>{if(dead)return;dead=true;chassis.remove(group);for(const dispose of assets.reverse())try{dispose();}catch{}};
  }catch(error){chassis.remove(group);for(const dispose of assets.reverse())try{dispose();}catch{}throw error;}
}
function mountAccessory(capability,id,density){
  if(id==='none')return ()=>{};
  let active=true,clear=buildAccessoryMount(capability,id,density);
  const canvas=capability.renderer.canvas;
  const lost=()=>{clear?.();clear=null;};
  const restored=()=>{if(!active)return;try{clear=buildAccessoryMount(capability,id,density);}catch{clear=null;}};
  canvas?.addEventListener('webglcontextlost',lost);canvas?.addEventListener('webglcontextrestored',restored);
  return ()=>{if(!active)return;active=false;canvas?.removeEventListener('webglcontextlost',lost);canvas?.removeEventListener('webglcontextrestored',restored);clear?.();clear=null;};
}
export function installCarCosmetics({window,getAccountId,getDensity=()=> 'low'}={}){
  if(!window?.document||typeof getAccountId!=='function')throw TypeError('Native car host required');
  if(window.__polytrackCarCosmetics)return window.__polytrackCarCosmetics;
  const document=window.document,garages=new Map(),cars=new Map();let disposed=false,requestedUntil=0;
  let storage;try{storage=window.localStorage;}catch{}
  const density=()=>{const value=safe(getDensity);return ['medium','high'].includes(value)?value:'low';};
  const safe=fn=>{try{return fn();}catch{return null;}};
  function close(owner){const state=garages.get(owner);if(!state)return;garages.delete(owner);state.dead=true;state.epoch++;state.visibilityObserver?.disconnect();state.launcher?.remove();state.clear?.();state.panel.remove();}
  function refresh(state){state.clear?.();state.clear=null;state.renderedAccessory='none';try{state.clear=mountAccessory(state.capability,state.accessory,density());state.renderedAccessory=state.accessory;state.panel.dataset.carAccessory=state.accessory;return true;}catch{state.status.textContent='Accessory preview is unavailable. Original car is unchanged.';return false;}}
  async function identify(state){
    const token=safe(state.capability.getProfileToken);if(typeof token!=='string'||!token||token.length>4096){state.status.textContent='Select a local racer profile to save accessories.';return;}
    if(state.token===token)return state.identityPromise;state.token=token;const epoch=++state.epoch;state.clear?.();state.clear=null;state.accountId=null;state.undo=[];state.use.disabled=true;
    const pending=window.crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));state.identityPromise=pending;const digest=await pending;
    if(state.dead||epoch!==state.epoch||safe(state.capability.getProfileToken)!==token)return;
    state.accountId=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');state.accessory=readCarCosmetic(storage,state.accountId).accessory;state.savedAccessory=state.accessory;state.select.value=state.accessory;state.use.disabled=false;state.status.textContent='Accessories save on this device. Paint uses the normal Garage save.';refresh(state);
  }
  function open(capability){
    if(disposed||!capability?.owner||!capability.root?.isConnected||typeof capability.getProfileToken!=='function'||typeof capability.getDraft!=='function'||typeof capability.setDraft!=='function')return;
    for(const owner of [...garages.keys()])close(owner);const chassis=chassisFor(capability.car,capability.renderer),cap={...capability,chassis};
    const panel=document.createElement('section');panel.className='car-cosmetic-workshop';panel.setAttribute('aria-label','Car appearance workshop');
    panel.innerHTML='<style>.car-cosmetic-workshop{position:fixed;z-index:20000;touch-action:pan-y;overscroll-behavior:contain;bottom:max(64px,env(safe-area-inset-bottom));left:max(12px,env(safe-area-inset-left));width:290px;max-height:calc(100% - 140px);overflow:auto;padding:14px;box-sizing:border-box;background:#172b50;border:1px solid #709ac1;border-left:3px solid #7ee7ff;color:#eef7ff;font:16px/1.4 ForcedSquare,sans-serif;pointer-events:auto}.car-cosmetic-workshop h3{font:26px ForcedSquare,sans-serif;margin:0 0 8px}.car-cosmetic-workshop button,.car-cosmetic-workshop select{min-height:40px;padding:8px;background:#294774;border:1px solid #7da5ca;color:white;font:16px ForcedSquare,sans-serif}.car-cosmetic-workshop [data-car-paints]{display:flex;gap:6px;flex-wrap:wrap}.car-cosmetic-workshop label{display:block;margin-top:14px}.car-cosmetic-workshop select{width:100%;margin-bottom:8px}.car-cosmetic-workshop p{font:14px/1.4 ForcedSquare,sans-serif;margin:10px 0 0}.car-cosmetic-workshop .car-workshop-status{color:#ffdc8b}.car-cosmetic-workshop :focus-visible{outline:3px solid #ffdc8b;outline-offset:2px}@media(max-width:650px){.car-cosmetic-workshop{width:240px;bottom:52px;left:8px;padding:10px;max-height:50vh}.car-cosmetic-workshop h3{font-size:22px}}</style><button type="button" data-car-toggle aria-expanded="true" aria-label="Show or hide car workshop controls" style="width:100%;font-size:22px;text-align:left">Car workshop</button><div data-car-controls><p>Choose a roof accessory. Your Garage paint stays unchanged.</p><label>Roof accessory<select aria-label="Roof accessory"></select></label><button type="button" data-car-use>Use accessory</button><p class="car-workshop-status" role="status" aria-live="polite"></p></div>';
    document.body.append(panel);const state={capability:cap,panel,status:panel.querySelector('[role=status]'),select:panel.querySelector('select'),use:panel.querySelector('[data-car-use]'),accessory:'none',accountId:null,epoch:0,dead:false,token:null,clear:null,undo:[],savedAccessory:'none'};garages.set(cap.owner,state);state.use.disabled=true;
    const toggle=panel.querySelector('[data-car-toggle]'),bar=capability.root.querySelector('.customization-panel-ui > .tab-bar');
    const launcher=document.createElement('button');launcher.type='button';launcher.className='button';launcher.dataset.carWorkshopTab='';launcher.textContent='Car workshop';launcher.setAttribute('aria-label','Open roof accessory workshop');launcher.style.borderLeft='2px solid #7ee7ff';launcher.style.marginLeft='8px';
    if(bar)bar.append(launcher);else{launcher.style.cssText+=';position:fixed;left:12px;bottom:12px;z-index:20000';document.body.append(launcher);}state.launcher=launcher;state.expanded=Date.now()<requestedUntil;requestedUntil=0;
    const syncVisibility=()=>{const hidden=!capability.root.isConnected||capability.root.classList.contains('hidden')||window.getComputedStyle(capability.root).display==='none';panel.hidden=hidden||!state.expanded;launcher.hidden=hidden;};
    const setExpanded=value=>{state.expanded=value;toggle.setAttribute('aria-expanded',String(value));launcher.setAttribute('aria-expanded',String(value));syncVisibility();};
    launcher.addEventListener('click',()=>setExpanded(!state.expanded));toggle.addEventListener('click',()=>{setExpanded(false);launcher.focus({preventScroll:true});});
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setExpanded(false);launcher.focus({preventScroll:true});}});
    state.visibilityObserver=new window.MutationObserver(syncVisibility);state.visibilityObserver.observe(capability.root,{attributes:true,attributeFilter:['class','style']});setExpanded(state.expanded);
    for(const [id,label]of CAR_ACCESSORIES){const option=document.createElement('option');option.value=id;option.textContent=label;state.select.append(option);}
    state.select.addEventListener('change',()=>{if(state.dead||!IDS.has(state.select.value))return;state.undo.push({kind:'accessory',value:state.accessory});if(state.undo.length>40)state.undo.shift();state.accessory=state.select.value;if(refresh(state))state.status.textContent='Accessory preview. Choose Use accessory to save it.';});
    state.use.addEventListener('click',()=>save(state));void identify(state).catch(()=>{if(!state.dead)state.status.textContent='Local profile could not be confirmed. Nothing was saved.';});
  }
  function save(state,paintColors){if(state.dead||!state.accountId||state.renderedAccessory!==state.accessory||safe(state.capability.getProfileToken)!==state.token)return false;const ok=paintColors===undefined&&state.savedAccessory===state.accessory||saveCarCosmetic(storage,state.accountId,state.accessory,paintColors);if(ok)state.savedAccessory=state.accessory;state.status.textContent=ok?'Accessory saved on this device.':'Could not save accessory. Your previous saved choice is unchanged.';return ok;}
  function created(capability){
    if(disposed||capability?.controlled!==true||!capability.car||!capability.chassis||cars.size>=4)return;
    const id=safe(getAccountId);if(!validId(id))return;
    carDisposed(capability.car);const accessory=readCarCosmetic(storage,id).accessory;let clear;try{clear=mountAccessory(capability,accessory,density());}catch{return;}cars.set(capability.car,{id,clear,accessory});
  }
  function carDisposed(car){const record=cars.get(car);if(!record)return;cars.delete(car);record.clear();}
  const undoKey=event=>{
    if(!(event.ctrlKey||event.metaKey)||event.shiftKey||event.altKey||event.key.toLowerCase()!=='z'||event.target?.closest?.('input,textarea,[contenteditable=true]'))return;
    const state=[...garages.values()].find(state=>!state.dead&&state.undo.length);if(!state)return;
    event.preventDefault();event.stopImmediatePropagation();const previous=state.undo.pop();
    if(previous.kind==='paint'){state.capability.setDraft(previous.value);state.status.textContent='Paint change undone. Use Save to keep the draft.';}
    else{state.accessory=previous.value;state.select.value=previous.value;if(refresh(state))state.status.textContent='Accessory preview undone. Choose Use accessory to save.';}
  };
  document.addEventListener('keydown',undoKey,true);
  const guard=fn=>(...args)=>{try{return fn(...args);}catch{return false;}};
  const api=Object.freeze({requestOpen:()=>{requestedUntil=Date.now()+5000;},open:guard(open),close:guard(close),saved:guard(owner=>{const state=garages.get(owner);if(!state)return;const token=safe(state.capability.getProfileToken),accessory=state.accessory,paint=state.capability.getDraft(),colors=[paint.primaryHex,paint.secondaryHex,paint.frameHex,paint.rimsHex];void identify(state).then(()=>{if(state.dead||safe(state.capability.getProfileToken)!==token||!state.accountId)return;state.accessory=accessory;state.select.value=accessory;refresh(state);save(state,colors);}).catch(()=>{});}),tick:guard(owner=>{const state=garages.get(owner);if(state&&safe(state.capability.getProfileToken)!==state.token)void identify(state).catch(()=>{});}),created:guard(created),carDisposed:guard(carDisposed),accountChanged:guard(()=>{for(const car of [...cars.keys()])carDisposed(car);}),stats:()=>({garageViews:garages.size,garageAccessories:[...garages.values()].filter(state=>state.renderedAccessory&&state.renderedAccessory!=='none').length,controlledCars:cars.size,controlledAccessories:[...cars.values()].filter(state=>state.accessory!=='none').length}),dispose(){if(disposed)return;disposed=true;document.removeEventListener('keydown',undoKey,true);for(const owner of [...garages.keys()])close(owner);for(const car of [...cars.keys()])carDisposed(car);if(window.__polytrackCarCosmetics===api)delete window.__polytrackCarCosmetics;}});
  window.__polytrackCarCosmetics=api;return api;
}
