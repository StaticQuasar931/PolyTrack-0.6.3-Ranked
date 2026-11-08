import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));let server,browser,base;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Event award presentation</title>');return;}
    if(!/^\/(events|tools)\/[a-z0-9-]+\.mjs$/.test(name)){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,name.slice(1))));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

test('real first paint and cached redraw keep compact ERP separate from native verification',{timeout:45000},async t=>{
  const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());let external=0;
  await page.route('**/*',route=>{if(route.request().url().startsWith(base+'/'))return route.continue();external++;return route.abort();});
  await page.goto(base);
  await page.evaluate(async()=>{
    const hash=n=>n.toString(16).padStart(64,'0'),trackId=hash(20),period={id:'snapshot77_shape',kind:'kodub',trackId,startsAt:1000,endsAt:10000};
    Date.now=()=>4000;
    const normal=(id,time,replay)=>({accountId:hash(id),trackId,timeMs:time,replayHash:hash(replay),verified:true,runVerified:true});
    // Snapshot77 timing/RP examples are anonymized; no profile names or live source reads.
    const rows=[normal(1,51459,31),normal(2,52165,32),normal(3,600000,33),normal(4,55000,34)];
    const award=(row,time,rp,replayHash)=>({accountId:row.accountId,runId:hash(40),timeMs:time,rp,replayHash,
      submittedAt:2000,verified:true,runVerified:true,eventRpEligible:true,pending:false,verificationStatus:'verified'});
    const board={id:period.id,period,complete:true,totalEntries:2,entries:[award(rows[0],51459,489,rows[0].replayHash),award(rows[1],52423,465,hash(35))],
      pendingPlaybacks:[{accountId:rows[3].accountId,runId:hash(41),timeMs:54000,replayHash:hash(36),submittedAt:2100,
        pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'}]};
    document.body.innerHTML='<div class="leaderboard-ui"></div>';
    const host=document.querySelector('.leaderboard-ui');let reads=0,live=0,resolve;
    const {createNormalKodubErpDecorator}=await import('/events/client.mjs');
    const decorator=createNormalKodubErpDecorator({normalEventSnapshotEpoch:()=>77,normalKodubPeriod:()=>period,
      currentTrackId:()=>trackId,accountId:()=>hash(99),formatTime:value=>'time-'+value,
      readStaticEventSnapshot:()=>{reads++;return new Promise(done=>{resolve=done;});},
      readSnapshot:()=>{live++;throw Error('Live event read forbidden');}});
    const before=JSON.stringify(rows);
    function render(){
      host.replaceChildren();
      for(const row of rows){
        const button=document.createElement('button');button.className='main';
        button.dataset.sqRacerAccountId=row.accountId;button.dataset.sqRacerReplayHash=row.replayHash;
        button.innerHTML='<div class="left"><p class="position">1</p><p class="time"></p></div><span class="name">Racer</span><span class="verified-state"><img data-native-proof alt="Verified"><span data-native-status>Verified</span></span>';
        button.querySelector('.time').textContent='time-'+row.timeMs;host.append(button);decorator.decorate(button,row,trackId);
      }
    }
    const frame=()=>new Promise(done=>requestAnimationFrame(()=>done()));
    render();await frame();window.initial={visible:[...host.querySelectorAll('.sq-normal-kodub-erp')].filter(node=>!node.hidden).length,
      nativeStatuses:[...host.querySelectorAll('[data-native-status]')].map(node=>node.textContent)};
    resolve(board);await frame();
    const inspect=()=>({labels:[...host.querySelectorAll('.sq-normal-kodub-erp')].map(node=>node.textContent),
      titles:[...host.querySelectorAll('.sq-normal-kodub-erp')].map(node=>node.title),
      states:[...host.querySelectorAll('.sq-normal-kodub-erp')].map(node=>node.dataset.status),
      nativeIcons:host.querySelectorAll('[data-native-proof]').length,extraIcons:host.querySelectorAll('.sq-normal-kodub-erp img').length,
      backgrounds:[...host.querySelectorAll('.sq-normal-kodub-erp')].map(node=>node.style.backgroundImage),
      reads,live,rowsUnchanged:JSON.stringify(rows)===before});
    window.first=inspect();render();await frame();window.cached=inspect();
  });
  const result=await page.evaluate(()=>({initial,first,cached}));
  assert.equal(result.initial.visible,0);assert.deepEqual(result.initial.nativeStatuses,Array(4).fill('Verified'));
  for(const view of [result.first,result.cached]){
    assert.deepEqual(view.labels,['489 ERP','Event PB \u00b7 465 ERP','No event result','Event PB \u00b7 ERP pending']);
    assert.deepEqual(view.states,['awarded','awarded','none','pending']);
    assert.match(view.titles[1],/time-52423/);assert.doesNotMatch(view.titles[1],/time-52165/);
    assert.match(view.titles[3],/time-54000/);assert.equal(view.nativeIcons,4);assert.equal(view.extraIcons,0);
    assert.deepEqual(view.backgrounds,['','','','']);assert.equal(view.reads,1);assert.equal(view.live,0);assert.equal(view.rowsUnchanged,true);
  }
  assert.equal(external,0);
});
