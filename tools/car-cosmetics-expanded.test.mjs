import test from 'node:test';
import assert from 'node:assert/strict';
import {CAR_COSMETIC_CATALOG as C,normalizeCarSelection,authorizeCarSelection,carSelectionAllowed,FREE_WORKSHOP_KEYS,carEarnedRequirement,carItemFeedback,carChangedSelectionAllowed} from './car-cosmetics-catalog.mjs';
import {carAttachmentParts,carAttachmentFrames} from './car-cosmetics-geometry.mjs';
import {readCarCosmetic,saveCarCosmetic,saveCarVisuals,mergeCarVisualPreferences} from './car-cosmetics.mjs';
import {createNativeCarAppearance} from './car-cosmetics-materials.mjs';
const account='c'.repeat(64);
test('catalog has frozen stable IDs and no invented purchases or prices',()=>{assert(Object.isFrozen(C.finishes[1]));assert.deepEqual(C.accessories.map(i=>i.id),['none','fin','beacon','aerial','roofbox','crown','halo']);assert(!/price|owned|purchase|firebase/i.test(JSON.stringify(C)));assert.deepEqual(normalizeCarSelection({finish:'alien'}),C.defaults);});
test('explicitly free workshop IDs work locally; host policy can deny or restrict all selections',()=>{const s={accessory:'fin',finish:'satin',emblem:'diamond',front:'lamps'};assert.deepEqual(authorizeCarSelection(s,account),{...s,rear:'none',sticker:'none'});assert.equal(carSelectionAllowed(s,account),true);assert.equal(carSelectionAllowed({...s,finish:'paid-unknown'},account),false);assert.equal(carSelectionAllowed(s,account,()=>false),false);assert.equal(carSelectionAllowed(s,account,()=>Promise.resolve(true)),false);assert.equal(carSelectionAllowed(s,account,()=>{throw Error();}),false);assert.equal(carSelectionAllowed(s,account,q=>q.accountId===account),true);assert.equal(carSelectionAllowed(s,'other',q=>q.accountId===account),false);});
test('new visual saves preserve legacy paint timestamp and reject invalid IDs',()=>{const map=new Map(),s={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};saveCarCosmetic(s,account,'fin',[1,2,3,4],123);assert(saveCarVisuals(s,account,{...C.defaults,finish:'metallic',emblem:'diamond'}));saveCarCosmetic(s,account,'beacon');assert.deepEqual(readCarCosmetic(s,account),{accessory:'beacon',finish:'metallic',emblem:'diamond',front:'none',paintColors:[1,2,3,4],paintSavedAt:123});assert.equal(saveCarVisuals(s,account,{...C.defaults,finish:'alien'}),false);assert.equal(JSON.parse(map.values().next().value).version,1);});
test('every attachment is finite, closed, outward-wound and bounded across all three quality levels',()=>{for(const [category,list]of [['accessory',C.accessories],['emblem',C.emblems],['front',C.fronts]])for(const {id}of list){if(id==='none')continue;for(const quality of ['low','medium','high']){const parts=carAttachmentParts(category,id,quality);assert(parts.length<=8);assert(parts.reduce((n,p)=>n+p.triangles,0)<=120);for(const part of parts){if(part.decal){assert.equal(id,'crest');assert.equal(part.triangles,2);assert([...part.positions].every(Number.isFinite));const ys=[...part.positions].filter((_,i)=>i%3===1);assert(Math.max(...ys)-Math.min(...ys)<1e-7);continue;}const a=part.positions,edges=new Map();let volume=0;assert([...a].every(v=>Number.isFinite(v)&&Math.abs(v)<=.6));for(let i=0;i<a.length;i+=9){const p=[...a.slice(i,i+3)],q=[...a.slice(i+3,i+6)],r=[...a.slice(i+6,i+9)];volume+=(p[0]*(q[1]*r[2]-q[2]*r[1])+p[1]*(q[2]*r[0]-q[0]*r[2])+p[2]*(q[0]*r[1]-q[1]*r[0]))/6;for(const [x,y]of [[p,q],[q,r],[r,p]]){const key=[x.join(','),y.join(',')].sort().join('|');edges.set(key,(edges.get(key)||0)+1);}}assert(volume>0,category+id+' outward volume');assert([...edges.values()].every(n=>n===2),category+id+' closed faces');}}}});
test('attachment frames use real body surfaces and reject unsupported geometry',()=>{const parts=carAttachmentParts('accessory','roofbox','low');const body=parts.find(p=>p.positions.length===108);const f=carAttachmentFrames(body.positions);assert(f.roof.normal[1]>.99);assert(f.front.normal[2]>.99);assert(f.roof.width>0);assert.throws(()=>carAttachmentFrames([0,0,0]));assert.throws(()=>carAttachmentFrames([NaN,0,0]));});
test('unsupported native models fail closed without material or scene mutations',()=>{let changes=0;const cap={chassis:{traverse:fn=>fn({name:'DifferentBody'}),remove:()=>changes++},renderer:{addMaterial:()=>changes++}};assert.throws(()=>createNativeCarAppearance(cap,{...C.defaults,finish:'satin'}),/Exact native Body/);assert.equal(changes,0);});

test('real finish lifecycle clones only paint slots and cleans every owned resource once',()=>{
 const arrays=carAttachmentParts('accessory','roofbox','low')[4].positions;
 const matrix={elements:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],clone(){return {...this,clone:this.clone,invert(){return this;},multiply(){return this;}};}};
 const material=()=>({isMeshStandardMaterial:true,type:'MeshStandardMaterial',name:'Glass',onBeforeCompile(shader){shader.uniforms.carColorPattern={value:'native-pattern'};shader.uniforms.carColorSecondary={value:{toArray:()=>[1,.5,0]}};shader.fragmentShader='native-secondary-pattern '+shader.fragmentShader;},color:{getHex:()=>0x123456},roughness:.4,metalness:0,emissive:{copy(){}},clone(){const v=material();v.dispose=()=>disposed++;return v;}});
 let disposed=0,added=0,removed=0;const originals=[material(),material(),material(),material()];originals[0].name='Main';
 const attribute={count:arrays.length/3,getX:i=>arrays[i*3],getY:i=>arrays[i*3+1],getZ:i=>arrays[i*3+2]};
 const body={name:'Body',material:originals,geometry:{attributes:{position:attribute},getAttribute:()=>attribute},matrixWorld:matrix,updateWorldMatrix(){}};
 const cap={chassis:{traverse:fn=>fn(body),matrixWorld:matrix,updateWorldMatrix(){},remove(){}},renderer:{addMaterial(){added++;},removeMaterial(){removed++;}}};
 for(const density of ['low','medium','high']){const appearance=createNativeCarAppearance(cap,{...C.defaults,finish:'satin'},density);assert.notEqual(body.material,originals);assert.notEqual(body.material[0],originals[0]);assert.equal(body.material[1],originals[1]);assert.equal(body.material[2],originals[2]);const shader={uniforms:{},fragmentShader:'diffuse #include <emissivemap_fragment>'};body.material[0].onBeforeCompile(shader);assert.equal(shader.uniforms.carColorPattern.value,'native-pattern');assert.deepEqual(shader.uniforms.carColorSecondary.value.toArray(),[1,.5,0]);assert.match(shader.fragmentShader,/native-secondary-pattern/);assert.equal(body.material[0].roughness,.76);assert.equal(originals[0].roughness,.4);appearance.clear();appearance.clear();assert.equal(body.material,originals);}
 assert.equal(added,3);assert.equal(removed,3);assert.equal(disposed,3);
});


test('new physical items are earned-only with exact confirmed requirements, never grandfathered free',()=>{assert.equal(FREE_WORKSHOP_KEYS.length,26);for(const [category,id,kind,target]of [['accessory','crown','confirmed-podiums',1],['front','rearbar','confirmed-ranked-tracks',5],['emblem','crest','confirmed-podiums',1],['sticker','laurel','confirmed-podiums',1]]){assert(!FREE_WORKSHOP_KEYS.includes(category+':'+id));assert.equal(carSelectionAllowed({...C.defaults,[category]:id},account),false);assert.equal(carEarnedRequirement({category,id}).kind,kind);assert.equal(carEarnedRequirement({category,id}).target,target);const confirmed={accountId:account,tracks:5,podiums:1};const policy=q=>q.accountId===confirmed.accountId&&(q.category==='front'?confirmed.tracks>=5:confirmed.podiums>=1);assert.equal(carSelectionAllowed({...C.defaults,[category]:id},account,policy),true);assert.equal(carSelectionAllowed({...C.defaults,[category]:id},'another-account',policy),false);}});
test('unrelated local saves preserve locked legacy preferences without equipping or deleting them',()=>{const stored={accessory:'crown',finish:'original',front:'rearbar',emblem:'crest'},draft=authorizeCarSelection(stored,account),expected=normalizeCarSelection(stored);assert.equal(draft.rear,'none');assert.equal(draft.accessory,'none');assert.equal(draft.emblem,'none');assert.deepEqual(mergeCarVisualPreferences(stored,{...draft,finish:'satin'},['finish']),{...expected,finish:'satin'});assert.deepEqual(mergeCarVisualPreferences(stored,draft,[]),expected);assert.equal(mergeCarVisualPreferences(stored,draft,['rear']).rear,'none');assert(carChangedSelectionAllowed({...expected,finish:'satin'},['finish'],account));assert(!carChangedSelectionAllowed(expected,['accessory'],account));});
test('roof centerline follows translated real bounds and is independent of triangle winding order',()=>{const geometry=carAttachmentParts('accessory','roofbox','low')[4].positions,translated=Float32Array.from(geometry,(v,i)=>v+[.37,.6,-.9][i%3]),a=carAttachmentFrames(translated),b=carAttachmentFrames(Float32Array.from([...translated].reduce((all,_,i,src)=>i%9===0?[...src.slice(i,i+9),...all]:all,[])));assert(Math.abs(a.roof.point[0]-.37)<1e-6);assert.deepEqual(a.roof,b.roof);});

test('front and rear combinations persist separately without extending the legacy schema',()=>{const map=new Map(),s={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};saveCarCosmetic(s,account,'crown',[1,2,3,4],123);for(const front of ['splitter','lamps']){assert(saveCarVisuals(s,account,{...C.defaults,accessory:'crown',front,rear:'rearbar'}));const raw=JSON.parse(map.get('polytrack-car-cosmetics-v1:'+account));assert(!('rear' in raw));assert.equal(raw.front,front);assert.deepEqual(raw.paintColors,[1,2,3,4]);assert.equal(raw.paintSavedAt,123);assert.equal(readCarCosmetic(s,account).rear,'rearbar');assert.equal(readCarCosmetic(s,account).front,front);}saveCarCosmetic(s,account,'fin');assert.equal(readCarCosmetic(s,account).rear,'rearbar');assert.equal(readCarCosmetic(s,account).accessory,'fin');assert.equal(readCarCosmetic(s,'b'.repeat(64)).rear,undefined);});
test('rear save failure rolls back the legacy record and invalid rear values never write',()=>{const map=new Map(),s={getItem:k=>map.get(k)??null,setItem:(k,v)=>{if(k.includes('-rear-'))throw Error('quota');map.set(k,v);},removeItem:k=>map.delete(k)};saveCarCosmetic(s,account,'crown');const before=map.get('polytrack-car-cosmetics-v1:'+account);assert(!saveCarVisuals(s,account,{...C.defaults,front:'lamps',rear:'rearbar'}));assert.equal(map.get('polytrack-car-cosmetics-v1:'+account),before);assert(!saveCarVisuals(s,account,{...C.defaults,rear:'unknown'}));assert.equal(carItemFeedback({category:'accessory',id:'crown'},account).reason,'Requires 1 confirmed podium');});
test('flat logo is surface-only and metal/neon parameters preserve readable paint rather than mirror chrome',()=>{const parts=carAttachmentParts('emblem','crest');assert(parts.every(p=>p.decal&&p.triangles===2));assert(Math.max(...parts.flatMap(p=>[...p.positions].filter((_,i)=>i%3===1)))<.003);const metal=C.finishes.find(f=>f.id==='metallic'),neon=C.finishes.find(f=>f.id==='neon');assert(metal.roughness>=.5&&metal.metalness<=.2);assert(neon.emissive>=.5);});

test('stickers share their art with the Workshop and render as bounded upward-facing decals',async()=>{
 const {carStickerIcon}=await import('./car-cosmetics-geometry.mjs');
 for(const {id} of C.stickers.filter(item=>item.id!=='none')){
  const parts=carAttachmentParts('sticker',id);
  assert.match(carStickerIcon(id),/<polygon /);
  assert(parts.length&&parts.every(p=>p.decal&&[...p.positions].every(v=>Number.isFinite(v)&&Math.abs(v)<.16)));
  for(const {positions:a} of parts)for(let i=0;i<a.length;i+=9)
   assert((a[i+5]-a[i+2])*(a[i+6]-a[i])-(a[i+3]-a[i])*(a[i+8]-a[i+2])>0,id);
 }
});
test('sticker saves preserve old reader format, accessories, paint, and other accounts',()=>{
 const values=new Map(),s={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 saveCarCosmetic(s,account,'fin',[1,2,3,4],123);
 assert(saveCarVisuals(s,account,{...C.defaults,accessory:'fin',emblem:'diamond',sticker:'bolt'}));
 assert(!('sticker' in JSON.parse(values.get('polytrack-car-cosmetics-v1:'+account))));
 assert.equal(readCarCosmetic(s,account).sticker,'bolt');
 assert.equal(readCarCosmetic(s,'d'.repeat(64)).sticker,undefined);
 saveCarCosmetic(s,account,'aerial');assert.equal(readCarCosmetic(s,account).sticker,'bolt');
 assert.deepEqual(readCarCosmetic(s,account).paintColors,[1,2,3,4]);
 assert(!saveCarVisuals(s,account,{...C.defaults,sticker:'bad'}));
});
test('replay ownership fails closed on duplicate bytes with conflicting or missing owners',async()=>{
 const {replayOwnerScope}=await import('./native-car-hooks.mjs');
 const own={recording:'x',owner:account};
 assert.equal(replayOwnerScope([own,own]).get('x'),account);
 assert.equal(replayOwnerScope([own,{recording:'x',owner:'d'.repeat(64)},own]).get('x'),null);
 assert.equal(replayOwnerScope([own,{recording:'x'}]).get('x'),null);
});

test('native replay parsing attaches only scoped recording objects and restores the parser after teardown',async()=>{
 const {installNativeCarHooks}=await import('./native-car-hooks.mjs');
 class Recording{static deserialize(bytes){return {bytes};}}
 class Renderer{addMaterial(){}}
 class Car{setCarStyle(){}setVisible(){}addFinishCallback(){}dispose(){}getChassisMatrix(){return this.matrix;}getRecording(){return this.recording;}}
 class Profile{getCurrentUserProfile(){}setCarStyle(){}}
 const canvas={},document={body:{},getElementById:()=>canvas,querySelector:()=>null,addEventListener(){},removeEventListener(){}};
 const window={document,queueMicrotask,MutationObserver:class{observe(){}disconnect(){}}};
 const seen=[],runtime={created:cap=>seen.push(cap),carDisposed(){}};
 const modules={641:{A:Car},1507:{A:Renderer},2522:{A:Profile},4922:{},1754:{A:Recording}};
 const original=Recording.deserialize,adapter=installNativeCarHooks({window,runtime,require:id=>modules[id]});
 try{
  const renderer=new Renderer();renderer.canvas=canvas;renderer.scene={children:[],add(node){this.children.push(node);}};renderer.addMaterial();
  const spawn=recording=>{const car=new Car();car.matrix={};car.recording=recording;renderer.scene.add({matrix:car.matrix});car.setCarStyle();return car;};
  spawn(Recording.deserialize('same'));
  const own=adapter.withReplayOwners([{recording:'same',owner:account}],()=>Recording.deserialize('same'));
  const ownCar=spawn(own);ownCar.setCarStyle();
  spawn(adapter.withReplayOwners([{recording:'same',owner:account},{recording:'same'}],()=>Recording.deserialize('same')));
  assert.equal(seen.length,1);assert.equal(seen[0].car,ownCar);assert.equal(seen[0].replayOwner,account);
 }finally{adapter.dispose();}
 assert.equal(Recording.deserialize,original);
});

test('six sticker positions and three sizes round-trip without changing legacy or another profile',async()=>{
 const {STICKER_POSITIONS,STICKER_SIZES,normalizeStickerLayout}=await import('./car-cosmetics-catalog.mjs');
 assert.equal(Object.keys(STICKER_POSITIONS).length,7);assert.equal(Object.keys(STICKER_SIZES).length,3);
 const values=new Map(),s={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 for(const position of Object.keys(STICKER_POSITIONS)){
  const stickerLayout={position,size:'large'};
  assert(saveCarVisuals(s,account,{...C.defaults,sticker:'roundel',stickerLayout}));
  assert.deepEqual(readCarCosmetic(s,account).stickerLayout,stickerLayout);
  assert.equal(readCarCosmetic(s,'d'.repeat(64)).stickerLayout,undefined);
  assert(!('stickerLayout' in JSON.parse(values.get('polytrack-car-cosmetics-v1:'+account))));
 }
 assert.deepEqual(normalizeStickerLayout({position:'constructor',size:'bad'}),{position:'center',size:'standard'});
});
test('Workshop preview restores only the camera it owns',async()=>{
 const {createWorkshopView}=await import('./car-cosmetics.mjs');
 class V{constructor(...v){this.v=v;}copy(other){this.v=other.v;}}
 const camera={clone:()=>({position:new V(),lookAt(){},updateMatrixWorld(){}})};
 const renderer={camera,setCamera(next){this.camera=next;}};
 const view=createWorkshopView({renderer,chassis:{localToWorld:v=>v}});
 view.focus('sticker');const preview=renderer.camera;assert.notEqual(preview,camera);
 view.focus('rear');assert.equal(renderer.camera,preview);assert(preview.position.v[2]<0);
 view.reset();assert.equal(renderer.camera,camera);
 view.focus('finish');renderer.camera={};const native=renderer.camera;
 view.reset();assert.equal(renderer.camera,native);
});
