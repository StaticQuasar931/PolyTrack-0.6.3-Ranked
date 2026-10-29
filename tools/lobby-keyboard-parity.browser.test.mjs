import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const source=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function handleLobbyShortcut('),end=source.indexOf('  let nativeTopSelectToken=',start);
assert.ok(start>0&&end>start);
test('Space activates the focused menu button, not Play; background shortcut remains available',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent('<button id="garage"><span>Garage</span></button><button id="play">Play</button>');
    await page.evaluate(code=>{
      window.clicks=[];
      for(const button of document.querySelectorAll('button'))button.onclick=()=>clicks.push(button.id);
      const handle=new Function('isStartMenuHotkeyContext','findLobbyAction','isElementVisible',code+';return handleLobbyShortcut;')(
        ()=>true,()=>document.getElementById('play'),()=>true);
      window.addEventListener('keydown',handle,true);
    },source.slice(start,end));
    await page.locator('#garage').focus();await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(()=>clicks),['garage']);
    await page.locator('#play').focus();await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(()=>clicks),['garage','play']);
    await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(()=>clicks),['garage','play','play']);
  }finally{await browser.close();}
});
