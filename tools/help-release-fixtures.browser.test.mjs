import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const RELEASE_FIXTURE={number:225,version:'0.6.3',revision:194,preparedAt:'2026-10-01T12:00:00.000Z',notes:['Offline fixture only. Final notes belong to release integration.']};
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

test('release age stays accurate while open, after sleep, on rebind and after clock changes',{timeout:30000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  const requests=[];await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const infoSource=await fs.readFile(new URL('./release-info.mjs',import.meta.url),'utf8')+await fs.readFile(new URL('./site-updates.mjs',import.meta.url),'utf8');
  const helpSource=await fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8');
  await page.setContent('<main></main>');
  await page.addScriptTag({content:(infoSource+helpSource.replace(/^const \{(?:parseReleasePreparedAt|releaseUpdateAge,formatReleaseUpdateAge)\}=await import\([^\n]+;\r?\n/gm,'')).replace(/\bexport /g,'')+'\nwindow.helpAPI={renderHelpControls,bindHelpControls};'});
  await page.evaluate(()=>{
    const nativeSet=window.setTimeout,nativeClear=window.clearTimeout;
    window.ageTimers=new Map();let id=-1;
    window.setTimeout=(callback,delay,...args)=>{
      if(callback.name!=='updateAge')return nativeSet(callback,delay,...args);
      const handle=id--;window.ageTimers.set(handle,{callback,delay});return handle;
    };
    window.clearTimeout=handle=>{if(!window.ageTimers.delete(handle))nativeClear(handle);};
    window.fixtureTime=Date.parse('2026-10-01T12:00:00.000Z');Date.now=()=>window.fixtureTime;
    window.advanceAge=elapsed=>{window.fixtureTime=Date.parse('2026-10-01T12:00:00.000Z')+elapsed;for(const [id,{callback}] of [...window.ageTimers]){window.ageTimers.delete(id);callback();}};
    window.renderFixture=(preparedAt,publication={})=>{
      window.cleanup?.();
      document.querySelector('main').innerHTML=window.helpAPI.renderHelpControls({...publication,release:{number:225,revision:194,preparedAt,notes:['Offline fixture only.']}});
      window.cleanup=window.helpAPI.bindHelpControls(document.querySelector('main'));
    };
    window.renderFixture('2026-10-01T12:00:00.000Z',{installedCommit:'a'.repeat(40),
      verifiedSiteCommitMetadata:{repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',commit:'a'.repeat(40),committedAt:'2026-10-01T12:00:00Z'}});
  });
  const age=page.locator('[data-hc-release-age]');
  await page.locator('[data-hc-view="release"]').click();
  for(const [elapsed,text] of [[0,'less than a minute ago'],[60000,'1 minute ago'],[3600000,'1 hour ago'],[86400000,'1 day ago'],[604800000,'7 days ago'],[1209600000,'14 days ago'],[-1,'Device clock is before commit time']]){
    await page.evaluate(elapsed=>window.advanceAge(elapsed),elapsed);
    assert.equal(await age.textContent(),text);
    assert.equal(await page.evaluate(()=>window.ageTimers.size),1);
  }
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0);
  await page.evaluate(()=>{
    window.fixtureTime=Date.parse('2026-10-01T12:00:00.000Z')+7200000;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await age.textContent(),'2 hours ago');
  await page.evaluate(()=>{window.cleanup=window.helpAPI.bindHelpControls(document.querySelector('main'));});
  assert.equal(await page.evaluate(()=>window.ageTimers.size),1,'rebind does not duplicate local timer');
  await page.evaluate(()=>{window.cleanup();window.cleanup();});
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0);
  await page.evaluate(()=>{
    window.renderFixture('2026-10-01T12:00:00.000Z',{installedCommit:'a'.repeat(40),
      verifiedSiteCommitMetadata:{repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',commit:'a'.repeat(40),publishedAt:'2026-10-02T12:00:00Z'}});
    window.advanceAge(86400000+3600000);
  });
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0,'hidden Release does not keep a timer');
  await page.locator('[data-hc-view="release"]').click();
  assert.equal(await age.textContent(),'1 hour ago');
  assert.equal(await page.locator('.hc-release-age .hc-eyebrow').textContent(),'UPDATED');
  assert.equal(await age.getAttribute('title'),await page.evaluate(()=>`Updated: ${new Date('2026-10-02T12:00:00Z').toLocaleString()}`));
  await page.evaluate(()=>window.advanceAge(86400000+7200000));
  assert.equal(await age.textContent(),'2 hours ago');
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0,'focus cannot restart a suspended page');
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  assert.equal(await page.evaluate(()=>window.ageTimers.size),1);
  await page.locator('[data-hc-view="controls"]').click();
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0);
  await page.evaluate(()=>window.renderFixture(undefined));
  assert.equal(await age.textContent(),'Publication time unavailable');
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0,'missing dates do not start a timer');
  await page.evaluate(()=>window.renderFixture('2026-10-01T12:00:00.000Z'));
  await page.evaluate(()=>{document.querySelector('main').remove();window.advanceAge(180000);});
  assert.equal(await page.evaluate(()=>window.ageTimers.size),0,'detached Help stops rescheduling');
  assert.deepEqual(requests,[]);
});

test('Help fixtures render at phone, landscape and desktop sizes with no network',{timeout:90000},async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const context=await browser.newContext({hasTouch:true,serviceWorkers:'block'});
  const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();
  const [source,css,font]=await Promise.all([
    fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8'),
    fs.readFile(new URL('../help-controls.css',import.meta.url),'utf8'),
    fs.readFile(new URL('../forced_square.woff2',import.meta.url))
  ]);
  const proposal=process.env.HELP_CSS_PROPOSAL?await fs.readFile(process.env.HELP_CSS_PROPOSAL,'utf8'):'';
  const output=process.env.HELP_RELEASE_EVIDENCE;
  if(output)await fs.mkdir(output,{recursive:true});
  for(const [width,height] of [[1366,900],[844,390],[390,844],[320,568]]){
    await page.setViewportSize({width,height});
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#09142c}main{max-width:1040px;margin:auto}</style><p style="margin:0;padding:8px;color:white;font:12px sans-serif;text-align:center">Offline fixture: sample preparation time and notes, not a published release.</p><main></main>');
    await page.addStyleTag({content:'@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font.toString('base64')+')}'+css+proposal});
    await page.addScriptTag({content:(await fs.readFile(new URL('./release-info.mjs',import.meta.url),'utf8')+await fs.readFile(new URL('./site-updates.mjs',import.meta.url),'utf8')+source.replace(/^const \{(?:parseReleasePreparedAt|releaseUpdateAge,formatReleaseUpdateAge)\}=await import\([^\n]+;\r?\n/gm,'')).replace(/\bexport /g,'')+'\nwindow.helpAPI={renderHelpControls,bindHelpControls};'});
    await page.evaluate(release=>{
      const root=document.querySelector('main');
      root.innerHTML=window.helpAPI.renderHelpControls({idPrefix:'fixture',release,bindings:{VehicleAccelerate:['KeyI','ArrowUp']}});
      window.cleanup=window.helpAPI.bindHelpControls(root);
    },RELEASE_FIXTURE);
    await page.evaluate(()=>document.fonts.ready);
    await page.locator('.hc-header').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    const metrics=await page.evaluate(()=>{
      const root=document.querySelector('[data-help-controls]'),first=root.querySelector('.hc-row'),label=first.querySelector('dt');
      const description=root.querySelector('.hc-row dt small'),keys=first.querySelector('kbd');
      return {viewport:innerWidth,firstControlTop:Math.round(first.getBoundingClientRect().top),labelFont:getComputedStyle(label).fontSize,descriptionFont:getComputedStyle(description).fontSize,keyFont:getComputedStyle(keys).fontSize,drivingHeight:Math.round(root.querySelector('[data-hc-group="driving"]').getBoundingClientRect().height)};
    });
    t.diagnostic(JSON.stringify({helpOpening:metrics,cssProposal:Boolean(proposal)}));
    assert.ok(parseFloat(metrics.labelFont)>=22,'control labels remain readable');
    assert.ok(parseFloat(metrics.descriptionFont)>=19,'descriptions remain readable');
    assert.ok(parseFloat(metrics.keyFont)>=20,'key labels remain readable');
    const clearAlignment=await page.locator('.hc-search-field').evaluate(field=>{
      const button=field.querySelector('[data-hc-clear]'),box=field.getBoundingClientRect(),clear=button.getBoundingClientRect();
      return {end:box.right-clear.right,top:clear.top-box.top,bottom:box.bottom-clear.bottom,radius:getComputedStyle(field).borderRadius};
    });
    for(const edge of ['end','top','bottom'])assert.ok(Math.abs(clearAlignment[edge]-1)<=0.5,`Clear is flush with the field's inner ${edge} at ${width}: ${JSON.stringify(clearAlignment)}`);
    assert.equal(clearAlignment.radius,'0px');
    if(output)await page.screenshot({path:join(output,`help-opening-${width}.png`)});
    assert.equal(await page.locator('.hc-track-quick').count(),0);
    const searchGuide=await page.locator('[data-hc-row="overall-search"]').textContent();
    for(const example of ['>3.19 (selected ranking)','playtime:>42h','rank:<=10','h/m/s/d/w','Missing data is excluded'])assert.ok(searchGuide.includes(example),example);
    for(const field of ['score/rp','tracks','wins','weight','players','pbs','official','community','average','podium'])assert.ok(searchGuide.includes(field),field);
    await page.keyboard.down('i');
    assert.ok(await page.locator('[data-hc-key="I"].is-pressed').count()>0,'keys react immediately without a focus click');
    await page.keyboard.up('i');
    assert.ok(await page.locator('[data-hc-row="VehicleAccelerate"]').textContent().then(text=>text.includes('Custom')));
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('[data-hc-search]').evaluate(node=>node===document.activeElement),true);
    await page.locator('[data-hc-topic-select]').selectOption('tracks');
    await page.locator('[data-hc-search]').fill('shift custom');
    assert.equal(await page.locator('[data-hc-row]:visible').count(),1);
    await page.locator('[data-hc-clear]').click();
    assert.equal(await page.locator('[data-hc-search]').evaluate(node=>node===document.activeElement),true,'Clear returns focus to search');
    assert.equal(await page.locator('[data-hc-clear]').isDisabled(),true);
    await page.locator('[data-hc-results-title]').evaluate(node=>{node.tabIndex=-1;node.focus();});
    await page.keyboard.down('Shift');await page.keyboard.down('1');
    assert.equal(await page.locator('[data-hc-row="track-tab-direct"] [data-hc-key="1"].is-pressed').count(),1);
    await page.keyboard.up('1');await page.keyboard.up('Shift');
    await page.emulateMedia({reducedMotion:'reduce'});
    const motion=await page.locator('.hc-header').evaluate(node=>getComputedStyle(node).animationName);
    assert.equal(motion,'none');
    await page.keyboard.down('Shift');
    assert.ok(await page.locator('[data-hc-key="Shift"].is-pressed:visible').count()>0,'key feedback survives reduced motion');
    await page.keyboard.up('Shift');
    await page.locator('[data-hc-search]').focus();
    const focus=await page.locator('[data-hc-search]').evaluate(node=>({width:parseFloat(getComputedStyle(node).outlineWidth),style:getComputedStyle(node).outlineStyle}));
    assert.ok(focus.width>=2&&focus.style!=='none','keyboard search focus remains visible');
    await page.evaluate(()=>{for(const node of document.querySelectorAll('[data-hc-group]')){node.hidden=false;node.open=true;for(const row of node.querySelectorAll('[data-hc-row]'))row.hidden=false;}});
    const controlsOverflow=await page.evaluate(()=>[...document.querySelectorAll('.hc-row,.hc-keycaps,.hc-group')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.className));
    assert.deepEqual(controlsOverflow,[],`all control rows fit at ${width}x${height}`);
    await page.locator('[data-hc-topic-select]').selectOption('tracks');
    await page.evaluate(()=>scrollTo(0,0));
    if(output)await page.screenshot({path:join(output,`help-controls-${width}.png`),fullPage:true});
    await page.locator('[data-hc-view="release"]').tap();
    const release=page.locator('[data-hc-panel="release"]');
    assert.equal(await release.isVisible(),true);
    const releaseLayout=await release.evaluate(node=>({
      technicalOpen:node.querySelector('.hc-release-technical').open,
      ageTop:node.querySelector('.hc-release-age').getBoundingClientRect().top,
      notesFont:parseFloat(getComputedStyle(node.querySelector('ul')).fontSize),
      detailFont:parseFloat(getComputedStyle(node.querySelector('.hc-release-note')).fontSize)
    }));
    assert.equal(releaseLayout.technicalOpen,false,'technical version numbers are not expanded by default');
    assert.ok(releaseLayout.notesFont>=22&&releaseLayout.detailFont>=19,'Release details use readable text');
    assert.equal(await release.locator('h3').textContent(),'PolyTrack Ranked - Update '+RELEASE_FIXTURE.number);
    assert.equal(await release.locator('.hc-release-meta').isVisible(),false);
    assert.equal(await release.locator('[data-hc-release-age]').getAttribute('title'),'','preparation alone must not supply a public date tooltip');
    await release.locator('.hc-release-technical summary').click();
    assert.ok((await release.locator('.hc-release-meta').textContent()).includes('Game version'+RELEASE_FIXTURE.version+'Client revision'+RELEASE_FIXTURE.revision));
    assert.doesNotMatch(await release.textContent(),/countdown|unlocks/i);
    assert.equal(await page.locator('.hc-track-quick').count(),0);
    assert.equal(await release.locator('dt').filter({hasText:/^Commit$/}).count(),0);
    const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.hc-release-meta > div')].filter(node=>node.scrollWidth>node.clientWidth+1).length}));
    assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));assert.equal(overflow.rows,0);
    await page.evaluate(()=>scrollTo(0,0));
    if(output)await page.screenshot({path:join(output,`help-release-${width}.png`),fullPage:true});
    await page.evaluate(()=>window.cleanup());
    await page.emulateMedia({reducedMotion:'no-preference'});
  }
  assert.deepEqual(requests,[],'no external or local network requests, including Firebase');
});
