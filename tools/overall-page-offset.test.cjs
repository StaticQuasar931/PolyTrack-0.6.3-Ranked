const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  let overallPageOffset=0;');
const end=source.indexOf('  function handleArchivePageShortcut(',start);
function fixture(){
 let now=1000;const jumps=[],favorites=[],dialogs=[];
 const buttons=Array.from({length:4},(_,i)=>({visible:true,disabled:false,getAttribute:name=>name==='aria-keyshortcuts'?String(i+1):null,click:()=>favorites.push(i+1)}));
 const panel={querySelector:()=>null,querySelectorAll:()=>buttons};
 const context=vm.createContext({Date:{now:()=>now},HTMLInputElement:class{},HTMLTextAreaElement:class{},HTMLSelectElement:class{},document:{getElementById:()=>panel,querySelectorAll:()=>dialogs},isElementVisible:value=>Boolean(value)&&value.visible!==false,overallPage:4,currentLeaderboardCount:()=>400,OVERALL_PAGE_SIZE:10,
 jumpOverallPage:page=>{if(page<1||page>40)return false;jumps.push(page);context.overallPage=page-1;return true;},changeOverallPage:delta=>context.overallPage+=delta});
 vm.runInContext(source.slice(source.indexOf('  function shortcutDigit('),start)+source.slice(start,end),context);
 const key=(code,other={})=>context.handleOverallLeaderboardShortcut({code,key:'',target:null,shiftKey:true,preventDefault(){},stopPropagation(){},...other});
 return {context,jumps,favorites,buttons,dialogs,key,advance:()=>now+=4000};
}
test('relative page shortcuts add and subtract without changing direct Shift digits',()=>{
 const f=fixture();f.key('Equal');f.key('Digit5');assert.deepEqual(f.jumps,[10]);
 f.key('Minus');f.key('Digit3');assert.deepEqual(f.jumps,[10,7]);
 f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftLeft'});f.key('Digit2');assert.deepEqual(f.jumps,[10,7,2]);
 f.key('NumpadAdd');f.key('Digit0');assert.deepEqual(f.jumps,[10,7,2,12]);
});
test('relative page mode survives delay but clears on Shift release and ignores typing',()=>{
 const f=fixture();f.key('Equal');f.advance();f.key('Digit5');assert.deepEqual(f.jumps,[10]);f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftRight'});
 f.key('Equal',{ctrlKey:true});f.key('Digit3');assert.equal(f.jumps.at(-1),3);
 f.key('Digit4',{target:new f.context.HTMLInputElement()});assert.equal(f.jumps.at(-1),3);
 f.key('Minus',{repeat:true});f.key('Digit2');assert.equal(f.jumps.at(-1),2);
});

test('relative jumps clamp to available pages rather than silently doing nothing',()=>{
 const f=fixture();f.key('Minus');f.key('Digit9');assert.equal(f.jumps.at(-1),1);
 f.context.overallPage=37;f.key('Equal');f.key('Digit9');assert.equal(f.jumps.at(-1),40);
});

test('repeated plus/minus digits preserve relative mode until Shift is released',()=>{
 const f=fixture();f.key('Equal');f.key('Digit3');f.key('Digit3');f.advance();f.key('Digit3');assert.deepEqual(f.jumps,[8,11,14]);
 f.key('Minus');f.key('Digit3');f.key('Digit3');assert.deepEqual(f.jumps,[8,11,14,11,8]);
 f.context.handleOverallLeaderboardModifierRelease({key:'3',code:'Digit3'});f.key('Digit3');assert.equal(f.jumps.at(-1),5);
 f.context.handleOverallLeaderboardModifierRelease({key:'Shift',code:'ShiftLeft'});f.key('Digit3');assert.equal(f.jumps.at(-1),3);
 f.key('Equal');f.context.resetOverallPageOffset();f.key('Digit2');assert.equal(f.jumps.at(-1),2);
});
test('keyup and window blur are wired to modifier-mode cleanup',()=>{
 assert.match(source,/addEventListener\('keyup',handleOverallLeaderboardModifierRelease\)/);
 assert.match(source,/addEventListener\('blur',resetOverallPageOffset\)/);
});

function pageFieldFixture(){
 const pages=[];const context=vm.createContext({overallPage:4,changeOverallPage(delta){context.overallPage=Math.max(0,Math.min(9,context.overallPage+delta));pages.push(context.overallPage+1);},jumpOverallPage(page){if(!Number.isSafeInteger(page)||page<1||page>10)return false;context.overallPage=page-1;pages.push(page);return true;}});
 vm.runInContext(source.slice(source.indexOf('  function handleOverallPageInput('),source.indexOf('  function jumpOverallPage(')),context);
 const input={id:'overallPageJump',value:'5'};
 return {context,input,pages,event(type,key,inputType){return {type,key,inputType,target:input,preventDefault(){this.prevented=true;},stopPropagation(){}};}};
}
test('page field has no spinner or up/down page shortcuts',()=>{
 const f=pageFieldFixture();
 for(const key of ['ArrowUp','ArrowDown'])assert.equal(f.context.handleOverallPageInput(f.event('keydown',key)),false);
 assert.deepEqual(f.pages,[]);
 assert.match(source,/id="overallPageJump" type="text" inputmode="numeric"/);
});
test('typing waits until change or Enter and invalid pages restore the current page',()=>{
 const f=pageFieldFixture();f.input.value='7';
 assert.equal(f.context.handleOverallPageInput(f.event('input',null,'insertText')),false);
 assert.deepEqual(f.pages,[]);
 f.context.handleOverallPageInput(f.event('change'));assert.deepEqual(f.pages,[7]);
 for(const invalid of ['','-1','1e1','3.5','100','letters']){
   f.input.value=invalid;f.context.handleOverallPageInput(f.event('change'));assert.equal(f.input.value,'7');
 }
});
test('plain 1-4 activate visible ranking favorites without changing Shift page shortcuts',()=>{
 const f=fixture();
 for(let i=1;i<=4;i++)assert.equal(f.key('Digit'+i,{shiftKey:false}),true);
 assert.deepEqual(f.favorites,[1,2,3,4]);assert.deepEqual(f.jumps,[]);
 f.key('Digit5',{shiftKey:false});f.key('Digit2',{shiftKey:false,target:new f.context.HTMLInputElement()});
 assert.deepEqual(f.favorites,[1,2,3,4]);
 f.key('Digit3');assert.deepEqual(f.jumps,[3]);
});
test('new racers get four distinct useful ranking suggestions',()=>{
 const start=source.indexOf('  function leaderboardArcadeMarkup('),end=source.indexOf('  const MIN_RANKED_TRACKS',start);
 const context=vm.createContext({readJsonStorage:()=>({}),LEADERBOARD_USAGE_KEY:'test',LEADERBOARD_LABELS:{overall:'Overall RP',events:'Event RP',topTracks:'Top Tracks',tracks:'Tracks completed'},overallCategory:'overall',escapeHtml:String});
 vm.runInContext(source.slice(start,end),context);
 const html=context.leaderboardArcadeMarkup();
 assert.deepEqual([...html.matchAll(/data-leaderboard-shortcut="([^"]+)"/g)].map(m=>m[1]),['overall','events','topTracks','tracks']);
 assert.equal((html.match(/aria-keyshortcuts=/g)||[]).length,4);
});

test('main digits and numpad activate the displayed labels, not DOM index',()=>{
 const f=fixture();f.buttons.reverse();
 for(const prefix of ['Digit','Numpad'])for(let i=1;i<=4;i++)assert.equal(f.key(prefix+i,{shiftKey:false}),true);
 assert.deepEqual(f.favorites,[1,2,3,4,1,2,3,4]);
});
test('hidden duplicates and disabled shortcuts never redirect a displayed number',()=>{
 const f=fixture();const first=f.buttons[0];
 f.buttons.unshift({...first,visible:false,click(){throw Error('hidden duplicate clicked');}});
 assert.equal(f.key('Digit1',{shiftKey:false}),true);
 first.disabled=true;assert.equal(f.key('Digit1',{shiftKey:false}),false);
 assert.deepEqual(f.favorites,[1]);
});
test('modal dialogs, editing, repeat and modified digits cannot activate favorites',()=>{
 const f=fixture();
 f.dialogs.push({visible:true});assert.equal(f.key('Numpad2',{shiftKey:false}),false);
 f.dialogs[0].visible=false;assert.equal(f.key('Numpad2',{shiftKey:false}),true);
 for(const flag of ['repeat','ctrlKey','altKey','metaKey','defaultPrevented'])assert.equal(f.key('Digit1',{shiftKey:false,[flag]:true}),false);
 for(const target of [new f.context.HTMLInputElement(),new f.context.HTMLTextAreaElement(),new f.context.HTMLSelectElement(),{isContentEditable:true},{closest:()=>({})}])assert.equal(f.key('Digit3',{shiftKey:false,target}),false);
 assert.deepEqual(f.favorites,[2]);
});
test('A/D navigation and Shift-numpad page selection retain their behavior',()=>{
 const f=fixture();f.key('KeyA',{key:'a',shiftKey:false});assert.equal(f.context.overallPage,3);
 f.key('KeyD',{key:'d',shiftKey:false});assert.equal(f.context.overallPage,4);
 f.key('Numpad3',{key:'3',shiftKey:true});assert.deepEqual(f.jumps,[3]);assert.deepEqual(f.favorites,[]);
});


test('favorite shortcuts survive compact footer collapse without activating disabled controls',()=>{
 const f=fixture();f.buttons[0].visible=false;
 assert.equal(f.key('Digit1',{shiftKey:false}),true);assert.deepEqual(f.favorites,[1]);
 f.buttons[1].disabled=true;assert.equal(f.key('Numpad2',{shiftKey:false}),false);assert.deepEqual(f.favorites,[1]);
});
