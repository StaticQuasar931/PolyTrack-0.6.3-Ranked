import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

test('featured card geometry: full-height artwork, shared footers, centered equal-height PBs', {skip: !process.env.CHROME_PATH, timeout: 30000}, async () => {
  const root = process.env.SOURCE_ROOT || process.cwd();
  const css = await fs.readFile(process.env.CARD_CSS || path.join(root, 'events/events.css'), 'utf8');
  const bundle = await fs.readFile(path.join(root, 'main.bundle.js'), 'utf8');
  const pos = bundle.indexOf('.track.track-of-the-week');
  const native = Function('return '+bundle.slice(bundle.lastIndexOf("push([e.id,'",pos)+11,bundle.indexOf("',",pos)+1))();
  const other = await Promise.all(['home-ui.css', 'responsive-ui.css', 'practice-responsive.css'].map(f => fs.readFile(path.join(root, f), 'utf8')));
  const font = (await fs.readFile(path.join(root, 'forced_square.woff2'))).toString('base64');
  const weekly = JSON.parse(await fs.readFile(path.join(root, 'events/kodub/current.json'), 'utf8')).current;
  const art = 'data:image/webp;base64,' + (await fs.readFile(path.join(root, 'events/kodub', weekly.coverUrl))).toString('base64');
  const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const timerIcon = 'data:image/svg+xml;base64,'+(await fs.readFile(path.join(root,'images/timer.svg'))).toString('base64');
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="teal"/></svg>').toString('base64');
  const support = kind => `<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${image}"></span></span><span class="sq-event-record"><time>00:24.531</time><span class="sq-record-placement">#12</span></span><span><small>${kind} EVENT</small><strong>Winter 5</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 10,000 Event RP</small><small class="sq-event-reset">Resets Sun 17:00</small></span></span></button>`;
  const html = `<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;background:#111d40;color:white;font-family:ForcedSquare}.button{background:#28346a;color:white;border:0;font:inherit}.track-of-the-week-info{display:flex;flex-direction:column}${[native,css,...other].join('\n')}</style><div id="ui"><main class="track-selection-ui"><div class="tracks-container open"><div class="wrapper"><section class="sq-featured-events"><h2 class="sq-featured-heading">Events</h2><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><img class="cover" src="${art}"><div class="track-of-the-week-info"><div class="title">${escape(weekly.name)}</div><div class="author">By ${escape(weekly.author)}</div><div class="time-remaining">6d 23h 59m 59s</div><div class="date-range">Nov 15 - Nov 22 12:00 PM</div><div class="personal-best"><div><img src="${timerIcon}"><span>00:24.531</span></div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div><div class="track sq-permanent-track"><button class="button"><img class="thumbnail" src="${image}"><div class="track-title"><p>Rolling Hills</p></div><div class="record">00:24.531</div><small class="sq-permanent-note">Normal RP + up to 10,101 Event RP\nPermanent event · no reset</small></button></div><div class="sq-event-track-buttons">${support('weekly')}${support('daily')}</div></section></div></div></main></div>`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'event-card-browser-'));
  const executable = process.env.CHROME_PATH;
  const browser = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir='+profile, 'about:blank'], {windowsHide:true, stdio:['ignore','ignore','pipe']});
  let socket;
  try {
    const url = await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(Error('Browser startup timeout: '+output)),15000);
      let output=''; browser.stderr.on('data', chunk => {output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
      browser.once('error',reject);
    });
    socket = new WebSocket(url);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let sequence=0;const pending=new Map();
    socket.onmessage=e=>{const value=JSON.parse(e.data),p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(Error(JSON.stringify(value.error))):p.resolve(value.result);}};
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const call=(method,params)=>send(method,params,sessionId);
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await call('Network.enable');await call('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await call('Page.navigate',{url:'data:text/html;base64,'+Buffer.from(html).toString('base64')});
    await evaluate('Promise.all([...document.images].map(i=>i.decode())).then(()=>document.fonts.ready).then(()=>true)');
    for(const [width,height] of [[320,568],[390,844],[701,900],[1280,800],[844,390],[1366,768],[1920,1080],[2543,1440]]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const g=await evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};const wrapper=document.querySelector('.sq-kodub-weekly'),card=wrapper.firstElementChild,img=card.querySelector('img'),info=card.querySelector('.track-of-the-week-info');const cards=[...document.querySelectorAll('.sq-featured-events>.track>.button,.sq-event-card')];const feet=[...document.querySelectorAll('.sq-permanent-note,.sq-event-card-details')];return {card:rect(card),wrapper:rect(wrapper),img:rect(img),ratio:img.naturalWidth/img.naturalHeight,fit:getComputedStyle(img).objectFit,info:rect(info),align:getComputedStyle(info).textAlign,cards:cards.map(rect),order:cards.map(e=>({id:e.closest('.sq-kodub-weekly')?'kodub':e.closest('.sq-permanent-track')?'rhr':e.dataset.eventKind,...rect(e)})),reward:{...rect(info.querySelector('.sq-kodub-reward')),position:getComputedStyle(info.querySelector('.sq-kodub-reward')).position},records:[...document.querySelectorAll('.sq-permanent-track .record,.sq-event-card>.sq-event-record')].map(e=>({top:getComputedStyle(e).borderTopWidth,bottom:getComputedStyle(e).borderBottomWidth})),feet:feet.map(e=>({rect:rect(e),card:rect(e.closest('button')),align:getComputedStyle(e).textAlign})),pb:[...card.querySelectorAll('.personal-best>div')].map(rect),panelOverflow:wrapper.scrollWidth>wrapper.clientWidth+1,contents:[...info.children].map(rect),textOverflow:[...info.children].some(e=>e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1),overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
      const label=width+'x'+height;
      if(width>=1201){
        const spacing=await evaluate(`(()=>{const p=document.querySelector('.track-of-the-week-info'),style=getComputedStyle(p),title=p.querySelector('.title').getBoundingClientRect(),reward=p.querySelector('.sq-kodub-reward').getBoundingClientRect();return {edge:parseFloat(style.paddingLeft),top:parseFloat(style.paddingTop),contentHeight:reward.bottom-title.top,height:p.getBoundingClientRect().height};})()`);
        assert.ok(spacing.edge>=24,label+' comfortable horizontal edge padding');
        assert.ok(g.info.width>=360,label+' native-sized metadata retains reserved width');
        assert.equal(spacing.top,20,label+' consistent vertical edge padding');
        const gaps=await evaluate(`(()=>{const rows=[...document.querySelector('.track-of-the-week-info').children].map(e=>e.getBoundingClientRect());return rows.slice(1).map((r,i)=>r.top-rows[i].bottom);})()`);
        assert.deepEqual(gaps.map(gap=>Math.round(gap)),[0,25,0,18,8],label+' native grouped spacing, without auto-fill gaps');
      }
      const compact=width<=900||width<=1200&&height<=500;
      for(const c of g.cards.slice(compact?1:0))assert.ok(Math.abs(c.height-(compact?g.cards[1].height:g.card.height))<1,label+' same outer height');
      assert.equal(g.textOverflow,false,label+' no hidden text inside metadata elements');
      assert.equal(g.fit,'contain');assert.ok(Math.abs(g.img.width/g.img.height-g.ratio)<.01,label+' no letterbox or crop');
      if(compact){
        assert.ok(Math.abs(g.img.width-g.card.width)<1,label+' full-width natural-ratio art');
        assert.ok(Math.abs(g.img.bottom-g.info.y)<1,label+' stacked panels touch');
        assert.ok(g.info.x>=-1&&g.info.right<=width+1,label+' phone details inside viewport');
        assert.ok(g.contents.every(r=>r.x>=g.info.x-1&&r.right<=g.info.right+1&&r.y>=g.info.y-1&&r.bottom<=g.info.bottom+1),label+' titles/time/footer inside details');
        assert.equal(g.panelOverflow,false,label+' no horizontal card scrolling');
      }else{
        assert.ok(Math.abs(g.img.height-g.card.height)<1,label+' full-height art');
        assert.ok(Math.abs(g.img.right-g.info.x)<1,label+' touching panels');
      }
      assert.ok(g.img.y>=g.wrapper.y-1&&g.img.bottom<=g.wrapper.bottom+1,label+' art not clipped vertically');
      assert.ok(g.info.right<=g.card.right+1,label+' complete details remain inside scrollable button '+JSON.stringify(g));
      assert.ok(g.contents.every(r=>r.x>=g.info.x-1&&r.right<=g.info.right+1&&r.y>=g.info.y-1&&r.bottom<=g.info.bottom+1),label+' all text fits inside the details panel');
      if(width>=1201)assert.ok(g.card.width<=g.wrapper.width+1,label+' desktop details visible without scrolling');
      assert.equal(g.reward.position,'static',label+' reward in normal flow');
      assert.ok(Math.abs((g.reward.x+g.reward.right)/2-(g.info.x+g.info.right)/2)<1,label+' reward centered in details');
      assert.ok(g.records.every(r=>r.top==='0px'&&r.bottom==='0px'),label+' no double record divider');
      if(width>=1201){
        const order=[...g.order].sort((a,b)=>Math.abs(a.y-b.y)>1?a.y-b.y:a.x-b.x).map(r=>r.id);
        assert.deepEqual(order,width>=1701?['kodub','rhr','daily','weekly']:['kodub','daily','rhr','weekly'],label+' requested visual order');
        if(width<1701){assert.ok(g.wrapper.width-g.img.width<=361,label+' bounded details width');assert.ok(Math.abs((g.wrapper.x+g.wrapper.right)/2-width/2)<10,label+' centered full-row card');}
      }
      assert.equal(g.align,'center');assert.ok(g.pb.length===1&&g.pb[0].height>=30,label+' native PB row remains legible');
      const offsets=g.feet.map(f=>f.card.bottom-f.rect.bottom);
      assert.ok(Math.max(...offsets)-Math.min(...offsets)<1,label+' footer baseline');
      assert.ok(g.feet.every(f=>f.align==='center'),label+' centered footers');
      assert.equal(g.overflow,false,label+' no page overflow');
      console.log(label,JSON.stringify({height:g.card.height,artWidth:g.img.width,footerOffsets:offsets}));
      if(width===390&&process.env.CARD_MOBILE_SCREENSHOT){const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.CARD_MOBILE_SCREENSHOT,Buffer.from(shot.data,'base64'));}
    }
    if(process.env.CARD_SCREENSHOT){const shot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.CARD_SCREENSHOT,Buffer.from(shot.data,'base64'));}
  } finally {
    socket?.close();browser.kill();
    await Promise.race([new Promise(resolve=>browser.exitCode!==null?resolve():browser.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
    await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
