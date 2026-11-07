import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {RELEASE_INFO} from './release-info.mjs';
import {RELEASE_HISTORY,buildReleaseHistory,writeOrCheckReleaseHistory,selectReleaseHistory,countKnownUpdates,releaseHistoryTime,
  renderReleaseHistory,createReleaseHistory,bindReleaseHistory} from './release-history.mjs';
import {installInstalledRevisionNotice} from './site-updates.mjs';
import {renderHelpControls} from './help-controls.mjs';
const iso='2026-10-01T12:00:00.000Z',base=Date.parse(iso);
const sha=number=>number.toString(16).padStart(40,'0');
const release=(number=266)=>({number,version:'0.6.3',revision:number-39,notes:['Clearer track and profile controls.'],committedAt:iso});
const record=number=>({number,title:'Clearer controls',commit:sha(number),committedAt:iso,notes:['Recorded player-facing improvement.']});
const history=(current=release())=>({schemaVersion:1,current:{number:current.number,version:current.version,revision:current.revision,notes:[...current.notes]},
  entries:[265,264,263,254].map(record),coverage:{limit:20,olderOmitted:true}});
function gitFixture({current=release(),numbers=[266,265,264,263,254],bots=[],missing=[],limit=20,precommit=false}={}){
  const rows=numbers.map((number,index)=>({commit:sha(number),name:'Human',email:'human@example.test',title:number+'-Clearer controls',date:new Date(base+(number-266)*60000).toISOString()}));
  const all=[...bots,...rows],calls=[];
  const runGit=(...args)=>{calls.push(args);if(args[0]==='log')return all.map(row=>[row.commit,row.name,row.email,row.title,row.date].join('\0')).join('\n');
    if(args[0]==='rev-list')return '266';
    if(args[0]==='ls-tree')return missing.includes(args[2])?'':'tools/release-info.mjs';
    if(args[0]==='show'){const number=parseInt(args[1].split(':')[0],16);return 'const releaseInfo = '+JSON.stringify({...release(number),committedAt:'2000-01-01T00:00:00.000Z'})+';';}
    assert.fail('Unexpected Git operation '+args.join(' '));};
  return {options:{runGit,read:()=> 'const releaseInfo = '+JSON.stringify(current)+';',limit,precommit},calls,rows};
}

test('bounded checked-in history matches real central release and never manufactures numbers in the 254 to 263 gap',()=>{
  assert.equal(selectReleaseHistory(RELEASE_INFO).matches,true);assert.equal(RELEASE_HISTORY.entries.length,20);
  assert.equal(RELEASE_HISTORY.coverage.olderOmitted,true);assert.ok(Object.isFrozen(RELEASE_HISTORY.entries[0].notes));
  const numbers=RELEASE_HISTORY.entries.map(entry=>entry.number),migration=numbers.indexOf(263);
  if(migration>=0&&migration+1<numbers.length)assert.equal(numbers[migration+1],254);
  else assert.ok(numbers.at(-1)>=263,'older migration entries may leave the bounded archive');
  assert.ok(!RELEASE_HISTORY.entries.some(entry=>entry.number>=255&&entry.number<=262));
  assert.ok(RELEASE_HISTORY.entries.every(entry=>new Date(entry.committedAt).toISOString()===entry.committedAt));
  assert.deepEqual(Object.keys(RELEASE_HISTORY.current),['number','version','revision','notes']);
});

test('compact archive preserves every recorded entry and note in both rendering paths',()=>{
  const html=renderReleaseHistory({release:RELEASE_INFO,now:base});
  assert.equal((html.match(/data-release-history-entry/g)||[]).length,20);
  assert.match(html,/<summary>Earlier updates<\/summary>/);
  assert.doesNotMatch(html,/release-history-coverage|Recent history only|Full recorded history/);
  assert.doesNotMatch(html,/recorded earlier updates|Older updates are not included|20 recorded/);
  const document=new Document(),dom=createReleaseHistory(document,{release:RELEASE_INFO,now:base});
  assert.equal(dom.querySelector('summary').textContent,'Earlier updates');
  assert.deepEqual(dom.children[1].children.map(node=>node.tag),['ol','button']);
  assert.equal(dom.querySelectorAll('[data-release-history-entry]').length,20);
  for(const [index,entry] of RELEASE_HISTORY.entries.entries()) {
    assert.ok(html.includes(entry.title));
    const detail=dom.querySelectorAll('[data-release-history-entry]')[index];
    assert.equal(detail.querySelector('summary').textContent,'Update '+entry.number+': '+entry.title);
    assert.deepEqual(detail.querySelectorAll('li').map(node=>node.textContent),entry.notes);
  }
  const full=history();full.coverage.olderOmitted=false;
  assert.doesNotMatch(renderReleaseHistory({release:release(),history:full}),/release-history-coverage|Full recorded history/);
  full.entries[0].notes=[];
  assert.match(renderReleaseHistory({release:release(),history:full}),/>No recorded notes\.</);
  assert.equal(createReleaseHistory(document,{release:release(),history:full}).querySelector('[data-release-history-entry]').querySelector('p').textContent,'No recorded notes.');
});

test('missed updates count actual recorded manual updates, not numeric gaps, visits or playtime',()=>{
  const info=release(),data=history(info);
  assert.equal(countKnownUpdates(info,number=>number===254,data),4);
  assert.equal(countKnownUpdates(info,number=>number===263,data),3);
  assert.equal(countKnownUpdates(info,number=>number===265,data),1);
  assert.equal(countKnownUpdates(info,number=>[254,265].includes(number),data),1);
  assert.equal(countKnownUpdates(info,number=>number===266,data),0);
  assert.equal(countKnownUpdates(info,()=>false,data),null,'first visit is unknown');
  assert.equal(countKnownUpdates(info,number=>number===200,data),null,'baseline outside coverage is unknown');
  assert.equal(countKnownUpdates(info,()=>{throw Error('storage denied');},data),null);
  assert.equal(countKnownUpdates({...info,number:267},()=>true,data),null,'stale module cannot count');
  assert.equal(countKnownUpdates(info,()=>true,{...data,entries:[record(265),record(265)]}),null);
});

test('missed counts skip manual non-release commits and revision/number gaps',()=>{
  const info=release(),data=history(info);
  data.entries=[record(265),{...record(264),number:null}, {...record(263),notes:[]},record(254)];
  assert.equal(countKnownUpdates(info,number=>number===254,data),2);
  assert.equal(countKnownUpdates({...info,revision:900},number=>number===254,
    {...data,current:{...data.current,revision:900}}),2);
  assert.equal(countKnownUpdates(info,number=>number===263,data),null,'an unpublished baseline is not a known release');
});

test('builder uses actual commit identities, timestamps and central notes and bounds older coverage',async()=>{
  const f=gitFixture({limit:2}),data=await buildReleaseHistory(f.options);
  assert.deepEqual(data.entries.map(entry=>entry.number),[265,264]);assert.equal(data.coverage.olderOmitted,true);
  assert.equal(data.entries[0].committedAt,f.rows[1].date);assert.notEqual(data.entries[0].committedAt,'2000-01-01T00:00:00.000Z');
  assert.deepEqual(data.entries[0].notes,release(265).notes);
  assert.ok(f.calls.every(([command])=>['log','rev-list','ls-tree','show'].includes(command)));
  for(const limit of [0,21,1.5,NaN])await assert.rejects(buildReleaseHistory({...f.options,limit}),/limit/);
});

test('capture exclusion requires both exact bot identity and exact capture title',async()=>{
  const bot={commit:sha(900),name:'github-actions[bot]',email:'41898282+github-actions[bot]@users.noreply.github.com',title:'Sync public ranked snapshots',date:iso};
  const bots=[bot,{...bot,commit:sha(901),title:'Sync Kodub weekly fallback'},{...bot,commit:sha(902),email:'someone@example.test'},
    {...bot,commit:sha(903),name:'Human'},{...bot,commit:sha(904),title:'A different bot change'}];
  // The real installed manual release remains the first non-capture commit.
  const f=gitFixture({bots:[bot,{...bot,commit:sha(901),title:'Sync Kodub weekly fallback'}]});
  assert.equal((await buildReleaseHistory(f.options)).entries[0].number,265);
  const g=gitFixture();const log=g.options.runGit('log');g.options.runGit=(...args)=>args[0]==='log'?log+'\n'+bots.slice(2).map(row=>[row.commit,row.name,row.email,row.title,row.date].join('\0')).join('\n'):f.options.runGit(...args);
  const data=await buildReleaseHistory(g.options);for(const commit of [902,903,904])assert.ok(data.entries.some(row=>row.commit===sha(commit)));
});

test('precommit generation is byte-stable after the actual commit and requires exact next count',async()=>{
  const current=release(267),before=gitFixture({current,precommit:true}),after=gitFixture({current,numbers:[267,266,265,264,263,254]});
  assert.deepEqual(await buildReleaseHistory(before.options),await buildReleaseHistory(after.options));
  await assert.rejects(buildReleaseHistory({...before.options,read:()=> 'const releaseInfo = '+JSON.stringify(release(268))+';'}),/actual next/);
  await assert.rejects(buildReleaseHistory({...before.options,precommit:false}),/finalize/);
});

test('missing historical notes stay explicit and unfinished central notes block generation',async()=>{
  const f=gitFixture({missing:[sha(265)]}),data=await buildReleaseHistory(f.options);assert.deepEqual(data.entries[0].notes,[]);
  const html=renderReleaseHistory({release:release(),history:data,now:base});assert.match(html,/No recorded notes/);
  for(const notes of [[],['TODO finish'],['TBD'],['placeholder'],[null]])await assert.rejects(buildReleaseHistory({...f.options,read:()=> 'const releaseInfo = '+JSON.stringify({...release(),notes})+';'}),/finished notes/);
});

test('automated freshness check catches a stale JSON/module or changed finalization notes without metadata edits',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-release-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'tools'));
  await fs.copyFile(new URL('./release-history.mjs',import.meta.url),path.join(root,'tools/release-history.mjs'));
  const f=gitFixture();await assert.rejects(writeOrCheckReleaseHistory({...f.options,root}),/stale/);
  await writeOrCheckReleaseHistory({...f.options,root,write:true});const first=await fs.readFile(path.join(root,'tools/release-history.mjs'),'utf8');
  await writeOrCheckReleaseHistory({...f.options,root});
  await fs.writeFile(path.join(root,'tools/release-history.mjs'),first.replace(/\r?\n/g,'\r\n'));
  await fs.writeFile(path.join(root,'tools/release-history.json'),(await fs.readFile(path.join(root,'tools/release-history.json'),'utf8')).replace(/\r?\n/g,'\r\n'));
  await writeOrCheckReleaseHistory({...f.options,root});await writeOrCheckReleaseHistory({...f.options,root,write:true});assert.equal((await fs.readFile(path.join(root,'tools/release-history.mjs'),'utf8')).replace(/\r\n?/g,'\n'),first.replace(/\r\n?/g,'\n'));
  const changed={...f.options,read:()=> 'const releaseInfo = '+JSON.stringify({...release(),notes:['New finalized notes.']})+';'};
  await assert.rejects(writeOrCheckReleaseHistory({...changed,root}),/stale/);
  await fs.writeFile(path.join(root,'tools/release-history.json'),'{}');await assert.rejects(writeOrCheckReleaseHistory({...f.options,root}),/stale/);
});

test('archive uses local commit ages/dates, escaped finished notes and honest bounded coverage',()=>{
  const data=history(),entry=data.entries[0];entry.title='<img src=x onerror=evil()>';entry.notes=['<script>bad()</script>'];
  const html=renderReleaseHistory({release:release(),history:data,now:base+3600000});
  assert.match(html,/Earlier updates/);assert.doesNotMatch(html,/release-history-coverage|Recent history only/);assert.match(html,/Committed 1 hour ago/);
  assert.ok(html.includes(new Date(iso).toLocaleString()));assert.match(html,/datetime="2026-10-01T12:00:00.000Z"/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|since you last played|since your last visit/);
  assert.doesNotMatch(html,/<details[^>]*\sopen(?:\s|>)/);
  assert.equal(releaseHistoryTime(iso,base-1).age,'Device clock is before commit time');
  assert.equal(releaseHistoryTime('invalid',base).dateTime,'');
  assert.equal(renderReleaseHistory({release:release(267),history:data}),'');
  assert.match(renderHelpControls({release:release(),releaseHistory:data,now:base}),/data-release-history/);
});

class Node {
  constructor(tag,doc){Object.assign(this,{tag,ownerDocument:doc,style:{},dataset:{},children:[],attributes:new Map(),listeners:new Map(),open:false});}
  get isConnected(){return this===this.ownerDocument.body||Boolean(this.parentElement?.isConnected);}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);}
  getAttribute(name){return this.attributes.get(name)??null;}removeAttribute(name){this.attributes.delete(name);}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  remove(){const parent=this.parentElement;if(parent)parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;}
  addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==fn));}
  fire(type,event={}){for(const fn of this.listeners.get(type)||[])fn({type,target:this,preventDefault(){},stopPropagation(){},...event});}
  matches(selector){if(selector.startsWith('['))return this.attributes.has(selector.slice(1,-1));return this.tag===selector;}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  querySelectorAll(selector){const list=selector.split(',').map(value=>value.trim()),nodes=[];for(const child of this.children){if(list.some(part=>child.matches(part)))nodes.push(child);nodes.push(...child.querySelectorAll(selector));}return nodes;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getClientRects(){let node=this;while(node.parentElement){if(node.parentElement.tag==='details'&&!node.parentElement.open&&node!==node.parentElement.children[0])return[];node=node.parentElement;}return this.isConnected?[{}]:[];}
  focus(){this.ownerDocument.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}
}
class Document {
  constructor(){this.visibilityState='visible';this.listeners=new Map();this.defaultView=new Node('window',this);this.body=new Node('body',this);this.activeElement=null;}
  createElement(tag){return new Node(tag,this);}hasFocus(){return true;}addEventListener(...args){Node.prototype.addEventListener.apply(this,args);}removeEventListener(...args){Node.prototype.removeEventListener.apply(this,args);}
}
const storage=()=>{const data=new Map();return{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
const keyEvent=(key,target,shiftKey=false)=>({key,code:key,target,shiftKey,defaultPrevented:false,cancelBubble:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.cancelBubble=true;},stopImmediatePropagation(){this.cancelBubble=true;}});
function notice({store=storage(),data=history(),...options}={}){
  const document=new Document(),before=document.createElement('button');document.body.append(before);before.focus();
  const handle=installInstalledRevisionNotice({revision:227,release:release(),releaseHistory:data,document,isReady:()=>true,isIdle:()=>true,storage:store,sessionStorage:null,
    now:()=>base+3600000,setTimeout:()=>1,clearTimeout:()=>{},...options});
  return{document,handle,store,before,dialog:document.body.children.find(node=>node.tag==='dialog')};
}

test('installed notice shows a compact known acknowledgment count, never a first-visit or out-of-coverage guess',()=>{
  for(const [baseline,expected] of [[254,4],[263,3],[265,1],[200,null],[null,null]]){
    const store=storage();if(baseline)store.setItem('polytrack-site-update-ack-release-v1:'+baseline,'acknowledged');
    const h=notice({store});const count=h.dialog.querySelectorAll('small').find(node=>Object.hasOwn(node.dataset,'siteUpdatesSinceAck'));
    assert.equal(count?.textContent,expected>1?expected+' updates since you last checked':undefined);
    h.handle.dispose();assert.equal(store.getItem('polytrack-site-update-ack-release-v1:266'),null);
  }
});

test('native archive disclosures close on Escape in order, restore focus and do not acknowledge the notice',()=>{
  const h=notice(),archive=h.dialog.querySelector('[data-release-history]'),entry=archive.querySelector('[data-release-history-entry]');
  assert.equal(archive.open,false);archive.open=true;entry.open=true;const target=entry.querySelector('time');target.focus();
  let event=keyEvent('Escape',target);h.document.defaultView.fire('keydown',event);assert.equal(entry.open,false);assert.equal(archive.open,true);assert.ok(h.document.activeElement===entry.querySelector('summary'),'entry summary retains focus');
  event=keyEvent('Escape',archive.querySelector('summary'));h.document.defaultView.fire('keydown',event);assert.equal(archive.open,false);assert.ok(h.document.activeElement===archive.querySelector('summary'),'archive summary retains focus');
  assert.equal(h.store.getItem('polytrack-site-update-ack-release-v1:266'),null);
  archive.open=true;archive.fire('click',{target:archive.querySelector('[data-release-history-close]')});assert.equal(archive.open,false);assert.equal(h.document.activeElement,archive.querySelector('summary'));
  const ok=h.dialog.querySelectorAll('button').find(node=>node.textContent==='OK');ok.fire('click');assert.equal(h.store.getItem('polytrack-site-update-ack-release-v1:266'),'acknowledged');assert.ok(h.document.activeElement===h.before,'return focus to the opener');
  h.handle.dispose();
});

test('notice Tab loop reaches the archive summary and expanded archive controls, not only OK',()=>{
  const h=notice(),archive=h.dialog.querySelector('[data-release-history]'),ok=h.dialog.querySelectorAll('button').find(node=>node.textContent==='OK');
  ok.focus();h.document.defaultView.fire('keydown',keyEvent('Tab',ok));assert.equal(h.document.activeElement,archive.querySelector('summary'));
  h.document.defaultView.fire('keydown',keyEvent('Tab',h.document.activeElement,true));assert.ok(h.document.activeElement===ok,'wrap backward to OK');
  archive.open=true;const inside=archive.querySelector('[data-release-history-close]');inside.focus();const event=keyEvent('Tab',inside);h.document.defaultView.fire('keydown',event);
  assert.ok(h.document.activeElement===inside,'interior Tab remains native instead of being forced to OK');h.handle.dispose();
});

test('archive binding cleanup removes local handlers and unavailable history cannot create controls',()=>{
  const document=new Document(),root=createReleaseHistory(document,{release:release(),history:history(),now:base});document.body.append(root);
  const binding=bindReleaseHistory(root);binding.dispose();binding.dispose();assert.equal(root.listeners.get('click').length,0);assert.equal(root.listeners.get('keydown').length,0);
  assert.equal(createReleaseHistory(document,{release:release(267),history:history()}),null);
});


test('browser fixture bundles parse offline and the static history UI has no network or database path',async()=>{
  const [historySource,releaseSource,updatesSource,helpSource]=await Promise.all(['release-history.mjs','release-info.mjs','site-updates.mjs','help-controls.mjs'].map(file=>fs.readFile(new URL('./'+file,import.meta.url),'utf8')));
  const runtime=historySource.slice(0,historySource.indexOf('/** Offline builder.'));
  assert.doesNotMatch(runtime.slice(runtime.indexOf('// END GENERATED RELEASE HISTORY')),/\bfetch\s*\(|XMLHttpRequest|firebase|node:/i);
  const names='RELEASE_HISTORY,countKnownUpdates,createReleaseHistory,bindReleaseHistory,renderReleaseHistory';
  const bundled='const {'+names+'}=(()=>{'+runtime.replace(/\bexport /g,'')+';return {'+names+'};})();\n';
  const strip=source=>source.replace(/^const \{[^\n]+\}=await import\([^\n]+;\r?\n/gm,'').replace(/\bexport /g,'');
  const fixture=bundled+strip(releaseSource)+strip(updatesSource)+strip(helpSource);
  assert.doesNotThrow(()=>new vm.Script(fixture));
  const rendered=vm.runInNewContext(fixture+';renderHelpControls({release:RELEASE_INFO,now:'+base+'})',{URL});
  assert.match(rendered,/data-release-history/);
  assert.equal((rendered.match(/data-release-history-entry/g)||[]).length,20);
  assert.doesNotMatch(rendered,/Hover over the age|recorded earlier updates|Older updates are not included/);
});

test('entry hover dates use recorded local commit or preparation time, never a fabricated date',()=>{
  for(const prepared of [false,true]){
    const data=history(),entry=data.entries[0];
    if(prepared){entry.preparedAt=entry.committedAt;delete entry.committedAt;}
    const value=entry.committedAt??entry.preparedAt,label=prepared?'Prepared':'Committed',local=new Date(value).toLocaleString();
    const html=renderReleaseHistory({release:release(),history:data,now:base});
    assert.ok(html.includes('title="'+label+': '+local+'"'));
    const document=new Document(),dom=createReleaseHistory(document,{release:release(),history:data,now:base});
    assert.equal(dom.querySelector('[data-release-history-entry]').querySelector('summary').title,label+': '+local);
    assert.equal(dom.querySelector('summary').textContent,'Earlier updates');
    delete entry.committedAt;delete entry.preparedAt;
    assert.equal(renderReleaseHistory({release:release(),history:data,now:base}),'','undated historical input is not assigned the current release date');
  }
});

test('archive clock warnings distinguish prepared dates and do not look like relative ages',()=>{
 for(const prepared of [false,true]){
  const data=history(),entry=data.entries[0];
  if(prepared){entry.preparedAt=entry.committedAt;delete entry.committedAt;}
  const expected='Device clock is before '+(prepared?'preparation':'commit')+' time';
  const html=renderReleaseHistory({release:release(),history:data,now:base-1});
  const document=new Document(),dom=createReleaseHistory(document,{release:release(),history:data,now:base-1});
  assert.ok(html.includes(expected));assert.ok(dom.querySelector('time').textContent.startsWith(expected));
  assert.doesNotMatch(html,/(?:Prepared|Committed) Device clock/);
 }
 assert.equal(releaseHistoryTime(iso,NaN).age,'Commit time unavailable');
});
