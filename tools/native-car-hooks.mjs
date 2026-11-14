// External visual hooks only. The stock game and verifier-pinned bundles stay unchanged.
export function installNativeCarHooks({window,require:load,runtime}={}){
  if(window?.__polytrackNativeCarVisualHooks)return window.__polytrackNativeCarVisualHooks;
  if(!window?.document||typeof load!=='function'||!runtime)throw TypeError('Native visual host required');
  const document=window.document,Car=load(641).A,Renderer=load(1507).A,Profile=load(2522).A,threeModule=load(4922);
  const three={Mesh:threeModule.eaF,Group:threeModule.YJl,Material:threeModule.G_z};
  for(const [prototype,key]of [[Renderer.prototype,'addMaterial'],[Car.prototype,'setCarStyle'],[Car.prototype,'setVisible'],[Car.prototype,'addFinishCallback'],[Car.prototype,'dispose'],[Profile.prototype,'getCurrentUserProfile'],[Profile.prototype,'setCarStyle']]){
    const descriptor=Object.getOwnPropertyDescriptor(prototype,key);if(typeof descriptor?.value!=='function'||descriptor.configurable!==true)throw Error('Unsupported native visual interface');
  }
  const metrics={styleWrites:0,saveEvents:0,authorizedSaves:0};
  const matrixOwners=new WeakMap(),renderers=new WeakSet(),parked=new WeakSet(),candidates=new Map(),restores=[];
  let profileStore=null,boundRoot=null,queued=false,dead=false,lastToken=null,identityChanged=false;
  const safe=fn=>{try{return fn();}catch{return null;}};
  const wrap=(target,key,after)=>{
    const descriptor=Object.getOwnPropertyDescriptor(target,key);if(typeof descriptor?.value!=='function')throw Error('Native interface unavailable: '+key);
    const original=descriptor.value,wrapped=function(...args){const result=original.apply(this,args);safe(()=>after(this,args,result));return result;};
    Object.defineProperty(target,key,{...descriptor,value:wrapped});restores.push(()=>{if(target[key]===wrapped)Object.defineProperty(target,key,descriptor);});
  };
  function index(renderer,node){if(!node)return;for(const child of [node,...(node.children||[])])if(child.matrix){const previous=matrixOwners.get(child.matrix);matrixOwners.set(child.matrix,previous&&previous.node!==child?{ambiguous:true}:{node:child,renderer});}}
  function register(renderer){
    if(renderers.has(renderer)||renderer.canvas!==document.getElementById('screen'))return;
    renderers.add(renderer);const scene=renderer.scene,own=Object.getOwnPropertyDescriptor(scene,'add'),original=scene.add;
    const wrapped=function(...nodes){const result=original.apply(this,nodes);for(const node of nodes)index(renderer,node);return result;};scene.add=wrapped;
    for(const node of scene.children||[])index(renderer,node);
    restores.push(()=>{if(scene.add===wrapped){if(own)Object.defineProperty(scene,'add',own);else delete scene.add;}});
  }
  function exact(car){const entry=matrixOwners.get(car.getChassisMatrix());return entry&&!entry.ambiguous&&entry.node.matrix===car.getChassisMatrix()?entry:null;}
  function schedule(){if(queued||dead)return;queued=true;window.queueMicrotask(()=>{queued=false;if(dead)return;reconcile();});}
  function reconcile(){
    for(const root of candidates.keys())if(!root.isConnected)candidates.delete(root);
    if(identityChanged&&boundRoot){identityChanged=false;runtime.tick(boundRoot);}
    if(boundRoot&&!boundRoot.isConnected){runtime.close(boundRoot);candidates.delete(boundRoot);boundRoot=null;}
    const root=document.querySelector('.customization-ui');if(!root||root===boundRoot)return;
    // In the reviewed Garage, parked cars always receive setVisible; the edit car never does.
    const choices=[...(candidates.get(root)||[])].filter(car=>!parked.has(car)&&exact(car));if(choices.length!==1||!profileStore)return;
    const car=choices[0],entry=exact(car),store=profileStore;boundRoot=root;
    runtime.open({owner:root,root,car,renderer:entry.renderer,three,getProfileToken:()=>store.getCurrentUserProfile()?.token,getDraft:()=>car.getCarStyle().clone(),
      setDraft:style=>{
        const inputs=[...root.querySelectorAll('.color-panel .color .input-container input')];if(inputs.length!==4)throw Error('Native paint controls unavailable');
        const colors=[style.primaryHex,style.secondaryHex,style.frameHex,style.rimsHex];
        for(let i=0;i<4;i++){inputs[i].value='#'+colors[i].toString(16).padStart(6,'0');inputs[i].dispatchEvent(new window.Event('input',{bubbles:true}));}
      },save:()=>{}});
  }
  wrap(Renderer.prototype,'addMaterial',renderer=>register(renderer));
  wrap(Car.prototype,'setCarStyle',car=>{const root=document.querySelector('.customization-ui');if(root){let list=candidates.get(root);if(!list)candidates.set(root,list=new Set());list.add(car);schedule();}});
  wrap(Car.prototype,'setVisible',car=>{parked.add(car);schedule();});
  wrap(Car.prototype,'addFinishCallback',car=>{const entry=exact(car);if(entry)runtime.created({car,chassis:entry.node,renderer:entry.renderer,three,controlled:true});});
  wrap(Car.prototype,'dispose',car=>{runtime.carDisposed(car);for(const list of candidates.values())list.delete(car);});
  wrap(Profile.prototype,'getCurrentUserProfile',(store,args,result)=>{profileStore=store;if(result?.token!==lastToken){if(lastToken!==null)runtime.accountChanged?.();lastToken=result?.token;identityChanged=true;schedule();}});
  wrap(Profile.prototype,'setCarStyle',store=>{metrics.styleWrites++;profileStore=store;if(boundRoot&&isExplicitSave(window.event)){metrics.authorizedSaves++;runtime.saved(boundRoot);}});
  function isExplicitSave(event){
    if(!event)return false;
    const button=event.target?.closest?.('button'),isSave=button&&button.querySelector('img[src$="/save.svg"],img[src="images/save.svg"]');
    const enter=event.type==='keydown'&&event.key==='Enter'&&event.target?.closest?.('.profile-settings-ui');
    return !!boundRoot&&(!!enter||!!isSave&&!!button.closest('.customization-ui,.profile-settings-ui'));

  };
  const explicitSave=event=>{if(isExplicitSave(event))metrics.saveEvents++;};
  document.addEventListener('click',explicitSave,true);document.addEventListener('keydown',explicitSave,true);
  const observer=new window.MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true});
  const api=Object.freeze({stats:()=>({...metrics}),dispose(){if(dead)return;dead=true;observer.disconnect();document.removeEventListener('click',explicitSave,true);document.removeEventListener('keydown',explicitSave,true);if(boundRoot)runtime.close(boundRoot);for(const restore of restores.reverse())restore();candidates.clear();profileStore=null;lastToken=null;if(window.__polytrackNativeCarVisualHooks===api)delete window.__polytrackNativeCarVisualHooks;}});
  window.__polytrackNativeCarVisualHooks=api;return api;
}
