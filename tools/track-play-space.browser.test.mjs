import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const source=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  let trackLeaderboardSpaceHeld=false;');
const end=source.indexOf('  function shortcutDigit(',start);
assert.ok(start>0&&end>start);
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});

async function fixture(t,event=false){
  const page=await browser.newPage();t.after(()=>page.close());await page.route('**/*',route=>route.abort());
  await page.setContent(`<section class="track-info-ui" hidden><aside class="side-panel"><button class="play" id="wrongPlay">Play hidden track</button></aside></section>
    <section class="track-info-ui" id="track"><div class="leaderboard-ui ${event?'sq-event-board':''}">
    <div class="container"><button class="main selected" aria-pressed="true"><span>Racer</span></button></div>
    <button id="filters">Filters</button></div><aside class="side-panel"><button class="play" id="play">Play</button><button id="watch">Watch</button></aside>
    <input id="search"><textarea></textarea><select><option>First</option><option>Second</option></select><div contenteditable="true">Edit</div></section>`);
  await page.evaluate(code=>{
    window.counts={play:0,wrong:0,row:0,watch:0,filters:0,legacy:0};
    const row=document.querySelector('button.main');
    row.onclick=()=>{counts.row++;row.classList.toggle('selected');};
    // Reproduce both browser activation and a target-level custom key handler.
    row.addEventListener('keydown',event=>{if(event.key===' '){counts.legacy++;row.click();}});
    row.addEventListener('keyup',event=>{if(event.key===' '){counts.legacy++;row.click();}});
    document.getElementById('play').onclick=()=>{counts.play++;if(window.hideOnPlay)document.getElementById('track').hidden=true;};
    document.getElementById('wrongPlay').onclick=()=>counts.wrong++;
    for(const id of ['watch','filters'])document.getElementById(id).onclick=()=>counts[id]++;
    const visible=node=>!!node?.isConnected&&node.getClientRects().length>0;
    const api=new Function('isElementVisible',code+';return {handle:handleTrackLeaderboardPlayShortcut,reset:()=>{trackLeaderboardSpaceHeld=false;}};')(visible);
    window.addEventListener('keydown',api.handle,true);window.addEventListener('keyup',api.handle,true);
    window.addEventListener('blur',api.reset);
  },source.slice(start,end));
  return page;
}

for(const event of [false,true])test(`${event?'event':'normal'} racer focus: Space plays once without changing selections; Enter toggles the racer`,async t=>{
  const page=await fixture(t,event);await page.locator('button.main').focus();await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(()=>counts),{play:1,wrong:0,row:0,watch:0,filters:0,legacy:0});
  assert.equal(await page.locator('button.main').evaluate(row=>row.classList.contains('selected')),true);
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>counts.row),1);
  await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>counts.play),2);
  assert.equal(await page.evaluate(()=>counts.row),1);
});

test('held Space cannot launch repeatedly or activate a racer on keyup after Play changes screens',async t=>{
  const page=await fixture(t);await page.evaluate(()=>{hideOnPlay=true;});await page.locator('button.main').focus();
  await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.up('Space');
  assert.deepEqual(await page.evaluate(()=>counts),{play:1,wrong:0,row:0,watch:0,filters:0,legacy:0});
});

test('a held Space after window blur cannot toggle a racer or launch again',async t=>{
  const page=await fixture(t);await page.locator('button.main').focus();
  await page.keyboard.down('Space');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.keyboard.down('Space');await page.keyboard.up('Space');
  assert.deepEqual(await page.evaluate(()=>counts),{play:1,wrong:0,row:0,watch:0,filters:0,legacy:0});
});

test('disabled or loading Play does not toggle racers instead',async t=>{
  const page=await fixture(t);
  for(const state of ['disabled','aria-disabled','hidden']){
    await page.evaluate(state=>{const play=document.getElementById('play');play.disabled=state==='disabled';play.hidden=state==='hidden';play.setAttribute('aria-disabled',String(state==='aria-disabled'));},state);
    await page.locator('button.main').focus();await page.keyboard.press('Space');
  }
  assert.deepEqual(await page.evaluate(()=>counts),{play:0,wrong:0,row:0,watch:0,filters:0,legacy:0});
});

test('releasing Space cannot confirm a replay dialog opened by Play',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    document.getElementById('play').onclick=()=>{
      counts.play++;
      const dialog=document.createElement('dialog');dialog.innerHTML='<button>Continue</button>';
      dialog.firstElementChild.onclick=()=>counts.legacy++;
      document.body.append(dialog);dialog.showModal();dialog.firstElementChild.focus();
    };
  });
  await page.locator('button.main').focus();await page.keyboard.down('Space');await page.keyboard.up('Space');
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.equal(await page.evaluate(()=>counts.play),1);assert.equal(await page.evaluate(()=>counts.legacy),0);
  await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>counts.legacy),1);
});

test('typing, modifiers, Overall, dialogs and other focused buttons keep their normal behavior',async t=>{
  const page=await fixture(t);
  for(const selector of ['input','textarea','[contenteditable]']){await page.locator(selector).focus();await page.keyboard.press('Space');}
  assert.equal(await page.locator('input').inputValue(),' ');
  for(const id of ['watch','filters']){await page.locator('#'+id).focus();await page.keyboard.press('Space');}
  assert.equal(await page.evaluate(()=>counts.watch),1);assert.equal(await page.evaluate(()=>counts.filters),1);
  await page.locator('button.main').focus();await page.keyboard.press('Control+Space');
  assert.equal(await page.evaluate(()=>counts.play),0);
  for(const markup of ['<dialog open><button>Continue</button></dialog>','<section role="dialog" aria-modal="true"><button>Continue</button></section>','<section id="overallLeaderboardPanel"><button>Continue</button></section>']){
    await page.evaluate(markup=>{const host=document.createElement('div');host.id='modalHost';host.innerHTML=markup;document.body.append(host);},markup);
    await page.locator('#modalHost button').focus();await page.keyboard.press('Space');
    assert.equal(await page.evaluate(()=>counts.play),0);await page.locator('#modalHost').evaluate(host=>host.remove());
  }
  await page.locator('input').evaluate(input=>input.blur());await page.keyboard.press('Space');
  assert.equal(await page.evaluate(()=>counts.play),1);
});

test('capture listeners are installed before bubble shortcuts and reset held keys on blur',()=>{
  assert.match(source,/window\.addEventListener\('keydown',handleTrackLeaderboardPlayShortcut,true\)/);
  assert.match(source,/window\.addEventListener\('keyup',handleTrackLeaderboardPlayShortcut,true\)/);
  assert.match(source,/window\.addEventListener\('blur',\(\)=>\{trackLeaderboardSpaceHeld=false;\}\)/);
});
