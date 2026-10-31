import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installResponsiveViewport,availableViewport} from './responsive-ui.mjs';

function fixture({width=1366,height=600,visualHeight=height,containerWidth=width,rootWidth=width,rootHeight=height,useContainer=true}={}){
  const events=new Map(),visualEvents=new Map(),properties={},frames=new Map();let writes=0,id=0,scrolled=0;
  const html={clientWidth:rootWidth,clientHeight:rootHeight,style:{setProperty(key,value){properties[key]=value;writes++;}},dataset:{}};
  const window={innerWidth:width,innerHeight:height,visualViewport:{width,height:visualHeight,offsetTop:0,
    addEventListener:(key,fn)=>visualEvents.set(key,fn),removeEventListener:key=>visualEvents.delete(key)},
    addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key),
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key)};
  const document={documentElement:html,addEventListener(){},removeEventListener(){},activeElement:{matches:()=>true,closest:()=>true,scrollIntoView:()=>scrolled++}};
  const container={getBoundingClientRect:()=>({width:containerWidth,height})};
  const dispose=installResponsiveViewport({document,window,container:useContainer?container:undefined});
  const flush=()=>{for(const [id,fn]of frames){frames.delete(id);fn();}};
  return {window,properties,html,dispose,events,visualEvents,frames,flush,writes:()=>writes,scrolled:()=>scrolled};
}
test('uses the content container, not screen resolution or a parent frame',()=>{
  const f=fixture({width:1920,height:1080,containerWidth:600});
  assert.equal(f.properties['--sq-available-width'],'600px');assert.equal(f.html.dataset.sqSpace,'narrow');
  assert.equal(f.properties['--sq-available-height'],'1080px');f.dispose();
});
test('short height is independent of width and keyboard viewport keeps fields reachable',()=>{
  const f=fixture({width:1366,height:700,visualHeight:300});
  assert.equal(f.html.dataset.sqSpace,'short');assert.equal(f.properties['--sq-available-height'],'300px');assert.equal(f.scrolled(),1);f.dispose();
});
test('resize bursts coalesce and unchanged dimensions produce no style writes',()=>{
  const f=fixture(),before=f.writes();for(let i=0;i<100;i++)f.events.get('resize')();
  assert.equal(f.frames.size,1);f.flush();assert.equal(f.writes(),before);
  f.window.visualViewport.height=500;f.visualEvents.get('resize')();f.flush();assert.equal(f.properties['--sq-available-height'],'500px');f.dispose();
  assert.equal(f.events.size,0);assert.equal(f.visualEvents.size,0);
});
test('shared responsiveness does not write canvas size, native scale or the page selector',()=>{
  const module=fs.readFileSync(new URL('./responsive-ui.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(module,/screen\.(width|height)|window\.parent|devicePixelRatio|canvas\.width|\.transform\s*=/);
  const css=fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');assert.doesNotMatch(css,/\.pages\s*\{|#ui\s*\{/);
});

test('menu page-pan correction preserves vertical scroll and intentional pinch zoom',()=>{
 const f=fixture(),calls=[];
 f.window.scrollX=24;f.window.scrollY=8;f.window.visualViewport.scale=1;
 // The listener only needs an active native menu, not a screen-size guess.
 const dispose=f.dispose;dispose();
 const document={documentElement:f.html,querySelector:()=>({}),addEventListener(){},removeEventListener(){}};
 f.window.scrollTo=value=>{calls.push(value);f.window.scrollX=value.left;};
 const stop=installResponsiveViewport({document,window:f.window});
 assert.deepEqual(calls,[{left:0,top:8,behavior:'instant'}]);
 f.window.scrollX=24;f.window.visualViewport.scale=1.5;f.events.get('scroll')();f.flush();
 assert.equal(calls.length,1);assert.equal(f.window.scrollX,24);stop();
});
test('optional Overall results use the static reader without a Firestore fallback',()=>{
  const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const branch=patch.slice(patch.indexOf("if(data.resultBundleLocation==='main_results'"),patch.indexOf('direct = normalizeEntries',patch.indexOf("if(data.resultBundleLocation==='main_results'")));
  assert.match(branch,/readPublicSnapshotBackup\('overall-results'\)/);assert.doesNotMatch(branch,/readDirectPublicSnapshot|\.collection\(/);
});

test('root client bounds reject mobile overflow-expanded inner dimensions',()=>{
 const f=fixture({width:535,height:949,visualHeight:948,rootWidth:440,rootHeight:780,useContainer:false});
 assert.equal(f.properties['--sq-available-width'],'440px');assert.equal(f.properties['--sq-available-height'],'780px');f.dispose();
});

test('available viewport intersects offset containers and visual keyboard bounds',()=>{
 const document={documentElement:{clientWidth:1000,clientHeight:800}};
 const window={innerWidth:1000,innerHeight:800,visualViewport:{width:800,height:300,offsetLeft:100,offsetTop:240}};
 const container={getBoundingClientRect:()=>({left:200,top:100,width:900,height:600,right:1100,bottom:700})};
 assert.deepEqual(availableViewport({document,window,container}),{left:200,top:240,width:700,height:300});
});

test('out-of-range visual offsets cannot shrink a full-size viewport',()=>{
 const document={documentElement:{clientWidth:440,clientHeight:780}};
 const window={innerWidth:903,innerHeight:1601,visualViewport:{width:440,height:780,offsetLeft:153,offsetTop:550}};
 assert.deepEqual(availableViewport({document,window}),{left:0,top:0,width:440,height:780});
 window.visualViewport={width:414,height:720,offsetLeft:80,offsetTop:120};
 assert.deepEqual(availableViewport({document,window}),{left:26,top:60,width:414,height:720});
});

test('menu fit uses the native formula with root bounds rather than overflow-expanded inner dimensions',()=>{
 const f=fixture({width:903,height:1601,rootWidth:440,rootHeight:780,useContainer:false});
 assert.equal(Number(f.properties['--sq-menu-fit-scale']),440/1150);f.dispose();
 const tiny=fixture({width:384,height:216,useContainer:false});
 assert.equal(Number(tiny.properties['--sq-menu-fit-scale']),216/800);tiny.dispose();
});
test('late root resizing is observed even without another window resize',()=>{
 const callbacks=[],watched=[],events=[],properties={};const html={clientWidth:440,clientHeight:780,dataset:{},style:{setProperty:(key,value)=>properties[key]=value}};
 let frame;const window={innerWidth:440,innerHeight:780,visualViewport:{width:440,height:780,addEventListener(){},removeEventListener(){}},
 addEventListener(){},removeEventListener(){},requestAnimationFrame:fn=>(frame=fn,1),cancelAnimationFrame(){},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},
 ResizeObserver:class{constructor(callback){callbacks.push(callback);}observe(node){watched.push(node);}disconnect(){watched.length=0;}}};
 const document={documentElement:html,addEventListener(){},removeEventListener(){},dispatchEvent:event=>events.push(event)};
 const dispose=installResponsiveViewport({document,window});assert.deepEqual(watched,[html]);
 html.clientWidth=956;html.clientHeight=360;window.innerWidth=956;window.innerHeight=360;window.visualViewport.width=956;window.visualViewport.height=360;
 callbacks[0]();frame();assert.equal(properties['--sq-available-width'],'956px');assert.equal(properties['--sq-available-height'],'360px');
 assert.equal(events.at(-1).type,'sq-viewport-changed');assert.deepEqual(events.at(-1).detail,{width:956,height:360,top:0,left:0});
 const before=events.length;callbacks[0]();frame();assert.equal(events.length,before);dispose();assert.deepEqual(watched,[]);
});
