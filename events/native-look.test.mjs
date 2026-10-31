import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {finishOrdinal} from '../tools/finish-presentation.mjs';
import {eventOwnPlacementPresentation,eventSidebarPlacementPresentation,renderEventPersonalBest,
  decorateEventRowPresentation} from './client.mjs';

const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const bundle=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
function dom(){
  const doc={createElement:tag=>element(tag),createTextNode:textContent=>({nodeType:3,textContent})};
  function element(tagName='div'){
    return {nodeType:1,tagName:tagName.toUpperCase(),ownerDocument:doc,childNodes:[],attributes:{},dataset:{},
      append(...nodes){this.childNodes.push(...nodes);},replaceChildren(...nodes){this.childNodes=nodes;},
      setAttribute(key,value){this.attributes[key]=value;},
      set textContent(value){this.childNodes=[doc.createTextNode(String(value))];},
      get textContent(){return this.childNodes.map(node=>node.textContent).join('');}};
  }
  return {doc,element};
}

test('event row ordinal structure matches the actual shipped native renderer and inherits its suffix styling',()=>{
  const start=bundle.indexOf('il=function(e,t,n,i,r,a,s,o,l,c,h,z){'),end=bundle.indexOf(',rl=function e()',start);
  assert.ok(start>=0&&end>start);const native=bundle.slice(start,end);
  assert.match(native,/v\.textContent=Qe\(e\)/);assert.match(native,/const A=document.createElement\("span"\);A.textContent=Je\(e\),v.appendChild\(A\)/);
  assert.match(bundle,/\.position > span \{\\n\\tfont-size: 20px;\\n\\topacity: 0\.3;/);
  const {element}=dom();
  for(const rank of [1,2,3,4,11,12,13,21,22,23,101,111,112,113,1001]){
    const position=element('p'),button={ownerDocument:position.ownerDocument,querySelector:selector=>selector==='.left .position'?position:null};
    const source={rank,rp:42},before=structuredClone(source);decorateEventRowPresentation(button,source);
    assert.equal(position.childNodes[0].nodeType,3);
    assert.equal(position.childNodes[0].textContent,String(rank).replace(/\B(?=(\d{3})+(?!\d))/g,'\u202f'));
    assert.equal(position.childNodes[1].tagName,'SPAN');assert.equal(position.childNodes[1].textContent,finishOrdinal(rank).suffix);
    assert.equal(position.childNodes[1].className,undefined);assert.deepEqual(source,before);
  }
  assert.doesNotMatch(css,/\.sq-event-ordinal-suffix/,'no event-only large/sans-serif suffix override');
});

test('preview cards retain compact placement boxes while sidebar uses ordinals and a truthful loaded-field percentile',()=>{
  const place={rank:4,knownFieldSize:200,provisional:false},before=structuredClone(place);
  assert.equal(eventOwnPlacementPresentation(place).text,'4/200');
  assert.match(eventOwnPlacementPresentation(place).className,/sq-record-placement/);
  assert.equal(eventSidebarPlacementPresentation(place).text,'4th (2%)');
  assert.equal(eventSidebarPlacementPresentation({...place,rank:1}).text,'1st (0.5%)');
  assert.equal(eventSidebarPlacementPresentation({...place,rank:11}).text,'11th (5.5%)');
  assert.equal(eventSidebarPlacementPresentation({...place,knownFieldSize:241,provisional:true}).text,'4th* (1.6598%)');
  assert.match(eventSidebarPlacementPresentation(place).title,/200 loaded racers/);
  assert.equal(eventSidebarPlacementPresentation({rank:4}).text,'4th');
  assert.equal(eventSidebarPlacementPresentation({rank:0}),null);assert.deepEqual(place,before);
});

test('event personal-best DOM matches native timer/span and trophy/text/faded-percent rows without badge fonts',()=>{
  assert.match(bundle,/r\.innerHTML='<img src="images\/trophy\.svg">'/);
  const {element}=dom(),host=element(),placement=eventSidebarPlacementPresentation({rank:4,knownFieldSize:200});
  renderEventPersonalBest(host,{timeText:'00:20.759',placement});
  const [timer,result]=host.childNodes;
  assert.equal(timer.childNodes[0].tagName,'IMG');assert.equal(timer.childNodes[0].src,'images/timer.svg');
  assert.equal(timer.childNodes[1].tagName,'SPAN');assert.equal(timer.childNodes[1].textContent,'00:20.759');
  assert.equal(result.childNodes[0].src,'images/trophy.svg');assert.equal(result.childNodes[1].nodeType,3);
  assert.equal(result.childNodes[1].textContent,'4th');assert.equal(result.childNodes[2].className,'faded');
  assert.equal(result.childNodes[2].textContent,' (2%)');assert.equal(result.textContent,'4th (2%)');
  assert.ok(result.childNodes.every(node=>!String(node.className).includes('sq-event-place')));
  renderEventPersonalBest(host,{timeText:'---',placement:null,hasRecord:false});
  assert.equal(host.childNodes[0].childNodes[1].className,'faded');assert.equal(host.childNodes[1].textContent,'---');
  renderEventPersonalBest(host,{timeText:'00:20.000',placement:null,pending:true});
  assert.equal(host.childNodes[1].textContent,'Waiting');
});

test('Rolling Hills featured label and event preview placement boxes remain scoped and native-looking',()=>{
  assert.match(css,/\.sq-permanent-track>\.button:before\{content:'PERMANENT EVENT'/);
  assert.match(css,/\.sq-event-record>\.sq-event-place\{[\s\S]*?background:#263b73;[\s\S]*?ForcedSquare/);
  assert.match(css,/\.sq-event-record>\.sq-event-place\.gold\{background:#8a6818/);
});
