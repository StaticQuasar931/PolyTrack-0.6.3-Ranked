import {spawn} from 'node:child_process';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createConnection} from 'node:net';
import {prepareNativeBroker} from './local-capture-native-build.mjs';

const ownedChildren = new WeakMap();
const CLOSE_WAIT_MS = 5000;
const TREE_STOP_MS = 10000;
const PREPARE_MS = 30000;
const MAX_JOBS = 8;
// A private native helper accepts only typed ownership commands over a local pipe.
export function createCaptureProcessSupervisor({prepareHelper=prepareNativeBroker,spawnHelper=spawn,connectControl=createConnection,session=randomBytes(32).toString('hex'),now=Date.now}={}) {
  if(typeof prepareHelper!=='function'||typeof spawnHelper!=='function'||typeof connectControl!=='function'||typeof now!=='function'||!/^[a-f0-9]{64}$/.test(session))throw TypeError('Invalid supervisor transport');
  let helper,helperPid,control,bootstrapBuffer='',listening=false,helperClosed=false,state='new',sequence=0,buffer='',stderrBytes=0,readyResolve,readyReject,closeResolve,prepareTimer;
  let fault=null,disposed=false,disposal,lastReply=null,disposeCaller=null,setupDeadline;
  const preparationAbort=new AbortController();
  const pending=new Map(),leases=new Set();
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  const closed=new Promise(resolve=>{closeResolve=resolve;});
  const references=value=>{for(const item of [helper,helper?.stdout,helper?.stderr,control])item?.[value?'ref':'unref']?.();};
  const fail=error=>{
    if(fault)return;fault=error;state='failed';clearTimeout(prepareTimer);readyReject(error);
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();
    preparationAbort.abort();
    try{control?.destroy();}catch{}
    // This ChildProcess retains the exact helper process handle. Closing its
    // non-inherited Job handles kills only jobs assigned before admission.
    if(helper&&!helperClosed&&helper.pid===helperPid)try{helper.kill();}catch{}
    for(const lease of leases)lease.onFailure?.(error);
    references(true);
  };
  function line(text) {
    if(text.startsWith("PHASE ")){const p=text.split(" "),entry=pending.get(Number(p[2]));
      if(p.length!==4||p[1]!==session||!entry||entry.expected!=="RELEASED"||!/^[1-5]$/.test(p[3])||Number(p[3])<=(entry.phase||0)||now()>=entry.deadline){fail(Error("Invalid release phase"));return;}
      entry.phase=Number(p[3]);return;
    }
    if(text===`READY ${session} ${process.pid}`){if(state!=='starting'||now()>=setupDeadline){fail(Error('Duplicate, late or unexpected helper READY'));return;}state='ready';clearTimeout(prepareTimer);readyResolve();if(!leases.size)references(false);return;}
    const fields=text.split(' '),kind=fields[0];
    if(fields[1]!==session||!['OWNED','STOPPED','RELEASED','BYE','FAILED','UNCLEAN'].includes(kind)||
      fields.length!==(kind==='FAILED'?5:3)||!/^[1-9][0-9]{0,6}$/.test(fields[2]||'')) {fail(Error('Malformed helper response'));return;}
    const id=Number(fields[2]),entry=pending.get(id);
    if(!entry||now()>=entry.deadline||kind!==entry.expected&&kind!=='FAILED'&&!(kind==='UNCLEAN'&&entry.expected==='RELEASED')||
      kind==='FAILED'&&!fields.slice(3).every(value=>/^[0-9]{1,10}$/.test(value))){fail(Error('Unconfirmed, stale or unexpected helper response'));return;}
    pending.delete(id);clearTimeout(entry.timer);lastReply={kind,id,at:now()};
    if(kind==='FAILED'||kind==='UNCLEAN'){
      const error=Error(kind==='UNCLEAN'?'Owned workload left surviving descendants':'Owned job operation unconfirmed');
      if(kind==='FAILED')error.termination={step:Number(fields[3]),code:Number(fields[4])};entry.reject(error);
    }
    else entry.resolve(id);
    if(!pending.size&&!leases.size&&state==='ready')references(false);
  }
  function start(deadline) {
    if(state!=='new')return;state='starting';
    setupDeadline=Math.min(deadline,now()+PREPARE_MS);
    prepareTimer=setTimeout(()=>fail(Error('Helper preparation deadline exceeded')),Math.max(1,setupDeadline-now()));
    void (async()=>{
    try {
      const artifact=await prepareHelper({deadline:setupDeadline,signal:preparationAbort.signal});
      if(fault||state!=='starting'||now()>=setupDeadline)throw fault||Error('Helper preparation consumed work deadline');
      if(typeof artifact?.executable!=='string'||!artifact.executable)throw Error('Native helper artifact unavailable');
      const systemRoot=process.env.SystemRoot||'C:\Windows';
      helper=spawnHelper(artifact.executable,[],
        {windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{SystemRoot:systemRoot,WINDIR:systemRoot,
          TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:path.join(systemRoot,'System32'),
          CAPTURE_SETUP_DEADLINE:String(setupDeadline),CAPTURE_SESSION:session,CAPTURE_PARENT_PID:String(process.pid),CAPTURE_RUNTIME:realpathSync(process.execPath)}});
      helperPid=helper.pid;
      helper.once('error',()=>fail(Error('Helper spawn failed')));
      helper.once('close',(code,signal)=>{helperClosed=true;clearTimeout(prepareTimer);closeResolve({code,signal});if(state!=='closing'||pending.size||code!==0||signal)fail(Error('Helper closed without confirmed disposal'));else state='closed';});

      helper.stdout.on('data',chunk=>{
        if(fault)return;bootstrapBuffer+=chunk.toString('utf8');
        if(bootstrapBuffer.length>4096){fail(Error('Helper bootstrap output exceeded bound'));return;}
        let split;while((split=bootstrapBuffer.indexOf('\n'))>=0){
          const value=bootstrapBuffer.slice(0,split).replace(/\r$/,'');bootstrapBuffer=bootstrapBuffer.slice(split+1);
          if(listening||state!=='starting'||value!=='PIPE_LISTENING '+session+' '+process.pid+' '+helperPid){fail(Error('Malformed helper listener announcement'));return;}
          listening=true;
          try{control=connectControl({path:'\\\\.\\pipe\\polytrack-capture-'+process.pid+'-'+session});}
          catch{fail(Error('Helper control connection failed'));return;}
          control.on('error',()=>fail(Error('Helper control transport failed')));
          control.on('close',()=>{if(state!=='closing'&&state!=='closed'||pending.size)fail(Error('Helper control closed without confirmed disposal'));});
          control.on('data',data=>{
            if(fault)return;buffer+=data.toString('utf8');if(buffer.length>4096){fail(Error('Helper output exceeded bound'));return;}
            let end;while((end=buffer.indexOf('\n'))>=0){const reply=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);line(reply);if(fault)return;}
          });
        }
      });
      helper.stderr.on('data',chunk=>{stderrBytes+=chunk.length;fail(Error(stderrBytes>4096?'Helper stderr exceeded bound':'Helper initialization failed'));});


    }catch(error){fail(error);if(!helper){helperClosed=true;closeResolve({code:null,signal:null});}}
    })();
  }
  async function prepare({deadline=now()+PREPARE_MS}={}) {
    if(!Number.isSafeInteger(deadline)||deadline<=now())throw Error('Helper preparation deadline exhausted');
    if(disposed||fault)throw fault||Error('Helper already disposed');start(deadline);
    let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Helper preparation consumed work deadline')),Math.min(PREPARE_MS,deadline-now()));})]);}
    finally{clearTimeout(timer);}
    if(fault||state!=='ready'||now()>=deadline)throw fault||Error('Helper unavailable before target spawn');
  }
  function request(command,values,expected,timeoutMs=TREE_STOP_MS) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0)return Promise.reject(Error('Shared cleanup deadline exhausted'));
    if(fault||!['ready','closing'].includes(state)||pending.size>=16||sequence>=1000000)return Promise.reject(fault||Error('Helper request resource/state bound'));
    const id=++sequence,deadline=now()+timeoutMs;
    const message=[command,session,id,...values].join(' ')+'\n';
    if(message.length>256)return Promise.reject(Error('Helper request exceeded frame bound'));
    references(true);
    return new Promise((resolve,reject)=>{
      const started=now();let writeCallback='pending';
      const timer=setTimeout(()=>{
        const error=Error('Owned capture helper response deadline exceeded');
        error.supervisor={command,id,expected,elapsedMs:Math.max(0,now()-started),state,leaseCount:leases.size,pendingCount:pending.size,
          releasePhase:pending.get(id)?.phase||null,writeCallback,helperExitCode:helper.exitCode??null,helperSignal:helper.signalCode??null,helperClosed,
          lastReply:lastReply?{kind:lastReply.kind,id:lastReply.id,elapsedMs:Math.max(0,now()-lastReply.at)}:null,disposeCaller};
        fail(error);
      },timeoutMs);
      pending.set(id,{resolve,reject,expected,deadline,timer});
      try{control.write(message,error=>{writeCallback=error?'error':'ok';if(error)fail(Error('Helper command delivery failed'));});}catch{writeCallback='error';fail(Error('Helper command delivery failed'));}
    });
  }
  async function acquire({deadline}) {
    await prepare({deadline});if(leases.size>=MAX_JOBS)throw Error('Owned capture concurrency bound exceeded');
    const lease={job:null,registration:null,released:false,stopping:null,releasing:null,onFailure:null};leases.add(lease);references(true);
    lease.register=child=>{
      const identity=ownedChildren.get(child);
      if(!identity||identity.lease!==lease||identity.pid!==child.pid||identity.executable.toLowerCase()!==realpathSync(process.execPath).toLowerCase())throw Error('Invalid owned registration');
      lease.registration=request('OWN',[identity.pid,identity.before,identity.after],'OWNED').then(id=>{lease.job=id;return id;});
      lease.registration.catch(()=>{});return lease.registration;
    };
    lease.stop=async({deadline=now()+TREE_STOP_MS}={})=>{await lease.registration;if(lease.released||lease.job===null)throw Error('Owned registration unavailable');const budget=Math.min(TREE_STOP_MS,deadline-now());if(!lease.stopping)lease.stopping=request('STOP',[lease.job,budget],'STOPPED',budget).finally(()=>{lease.stopping=null;});return lease.stopping;};
    lease.release=({deadline=now()+CLOSE_WAIT_MS}={})=>{
      if(lease.releasing)return lease.releasing;lease.released=true;
      lease.releasing=(async()=>{
        try {if(lease.registration){await lease.registration;const budget=Math.min(CLOSE_WAIT_MS,deadline-now());await request('RELEASE',[lease.job,budget],'RELEASED',budget);}}
        finally{leases.delete(lease);if(!leases.size&&!pending.size&&state==='ready')references(false);}
      })();return lease.releasing;
    };
    return lease;
  }
  function dispose({caller='explicit'}={}) {
    if(disposal)return disposal;
    if(leases.size)return Promise.reject(Error('Cannot dispose supervisor with owned jobs'));
    disposed=true;disposeCaller=caller==='beforeExit'?'beforeExit':'explicit';
    disposal=finishDispose();return disposal;
  }
  async function finishDispose() {
    if(state==='new'){state='closed';closeResolve({code:0,signal:null});return;}
    let primary;
    try{
      if(state==='starting')await ready;
      if(state==='ready'){state='closing';await request('DISPOSE',[],'BYE',CLOSE_WAIT_MS);control.end();}
      else {try{control?.end();}catch{}}
    }catch(error){primary=error;fail(error);}
    references(true);let timer;
    try {const result=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Helper close unconfirmed')),CLOSE_WAIT_MS);})]);if(result.code!==0||result.signal||fault||primary)throw primary||fault||Error('Helper close failed');}
    catch(error){
      fail(error);clearTimeout(timer);
      if(!helperClosed){let forcedTimer;try{await Promise.race([closed,new Promise((_,reject)=>{forcedTimer=setTimeout(()=>reject(Error('Forced helper close unconfirmed')),CLOSE_WAIT_MS);})]);}finally{clearTimeout(forcedTimer);}}
      throw error;
    }
    finally{clearTimeout(timer);if(helperClosed)references(false);}
  }
  return Object.freeze({prepare,acquire,dispose});
}
const defaultSupervisor=createCaptureProcessSupervisor();
export const prepareCaptureProcessSupervisor=options=>process.platform==='win32'?defaultSupervisor.prepare(options):Promise.resolve();
export const disposeCaptureProcessSupervisor=()=>process.platform==='win32'?defaultSupervisor.dispose():Promise.resolve();
process.once('beforeExit',()=>{if(process.platform==='win32')defaultSupervisor.dispose({caller:'beforeExit'}).catch(()=>{process.exitCode=1;});});

export function terminateOwnedCaptureTree(child,{isRunning,deadline}) {
  const identity=ownedChildren.get(child);
  if(!identity||!isRunning()||child.pid!==identity.pid||!Number.isSafeInteger(child.pid)||child.pid<=0)return;
  if(process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}return;}
  if(!identity.lease)throw Error('Owned process has no prepared supervisor');
  return identity.lease.stop({deadline});
}

// No workload starts until the native helper has acknowledged this exact root.
// The token and pipe are retained by the parent and never forwarded to the job.
function gatedNodeSource(token) {
  return `const {spawn}=require('node:child_process');const token=${JSON.stringify(token)};
let job=null,started=false,queue=[],bytes=0;const hold=setInterval(()=>{},1000);
function bad(){process.exit(1)}
process.on('message',m=>{
 if(m?.type==='capture-supervisor-start'){
  if(started||m.token!==token||m.file!==process.execPath||!Array.isArray(m.args)||m.args.some(a=>typeof a!=='string'))return bad();started=true;
  job=spawn(m.file,m.args,{stdio:['inherit','inherit','inherit','ipc'],windowsHide:true,env:{...process.env,...(m.nodeOptions===undefined?{}:{NODE_OPTIONS:m.nodeOptions}),...(m.nodePath===undefined?{}:{NODE_PATH:m.nodePath})}});
  job.on('message',v=>{if(process.connected)process.send(v,()=>{});});job.on('error',()=>{if(process.connected)process.send({type:'capture-supervisor-job-failed',token},()=>{});});
  job.on('close',(code,signal)=>{if(code!==0||signal){if(process.connected)process.send({type:'capture-supervisor-job-failed',token},()=>{});return;}clearInterval(hold);if(process.connected)process.disconnect();});
  for(const v of queue)job.send(v,()=>{});queue=[];return;
 }
 if(!started){if(m?.type==='abort'){clearInterval(hold);process.exitCode=1;if(process.connected)process.disconnect();return;}bytes+=Buffer.byteLength(JSON.stringify(m));if(queue.length>=8||bytes>16*1024*1024)return bad();queue.push(m);}
 else if(job?.connected)job.send(m,()=>{});
});
process.on('disconnect',()=>{if(!started){clearInterval(hold);return;}if(job?.connected)job.send({type:'abort',reason:'parent-eof'},()=>{});});`;
}


/**
 * Spawn one owned capture child. options.stdio must be an array containing one
 * 'ipc' entry (for example ['ignore', logFd, logFd, 'ipc']). No shell is used.
 * At timeout send {type:'abort', reason:'timeout'}, then allow graceMs (10s by
 * default) for the worker's finally blocks before terminating its owned tree.
 * Resolve {status: exitCode, signal, timedOut}; callers MUST reject timedOut or
 * status !== 0, including a cooperative late exit with status 0.
 * recoverAfterTimeout(result) runs once, only after close and successful forced
 * termination if needed. Spawn, IPC configuration, termination, missing close,
 * and recovery errors reject. An unconfirmed close never permits recovery.
 * spawnImpl and killTree(child, {isRunning}) are trusted test/caller adapters.
 */
export function runBoundedCaptureProcess({file,args=[],options={},timeoutMs,graceMs=10000,
  spawnImpl=spawn,killTree=terminateOwnedCaptureTree,recoverAfterTimeout,supervisor=null}={}) {
  const workStarted=performance.now(),workDeadline=Date.now()+timeoutMs;
  return new Promise((resolve,reject)=>{
    if(typeof file!=='string'||!file||!Array.isArray(args)||args.some(value=>typeof value!=='string')||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647||
      !Number.isSafeInteger(graceMs)||graceMs<0||graceMs>2147483647||
      typeof spawnImpl!=='function'||typeof killTree!=='function'||
      (supervisor!==null&&typeof supervisor?.acquire!=='function')||
      (recoverAfterTimeout!==undefined&&typeof recoverAfterTimeout!=='function')) {
      reject(TypeError('Invalid bounded capture process configuration'));return;
    }
    const stdio=options.stdio??['ignore','ignore','ignore','ipc'];
    if(!Array.isArray(stdio)||stdio.filter(value=>value==='ipc').length!==1){reject(TypeError('Capture stdio requires exactly one IPC channel'));return;}
    const {timeout:ignoredTimeout,signal:ignoredSignal,killSignal:ignoredKillSignal,...spawnOptions}=options;
    const gated=supervisor!==null||(process.platform==='win32'&&killTree===terminateOwnedCaptureTree);
    const workLeft=()=>Math.floor(Math.min(workDeadline-Date.now(),timeoutMs-(performance.now()-workStarted)));
    let executable=file;
    if(gated){try{executable=realpathSync(file);if(executable.toLowerCase()!==realpathSync(process.execPath).toLowerCase())throw Error('Supervised runtime must match parent runtime');}catch(error){reject(error);return;}}
    const launch=lease=>{
      if(gated&&workLeft()<=0){lease.release().catch(()=>{});reject(Error('Preparation exhausted original work deadline'));return;}
      const token=lease?randomBytes(32).toString('hex'):null,jobEnvironment=spawnOptions.env??process.env;
      const gateEnvironment=Object.create(null),preloads=Object.create(null);
      // Match Node's Windows lexicographic, case-insensitive environment choice,
      // including inherited keys and a first value that is undefined.
      const keys=[];for(const key in jobEnvironment)keys.push(key);
      for(const key of keys.sort()){
        const name=process.platform==='win32'?key.toUpperCase():key;
        if(name==='NODE_OPTIONS'||name==='NODE_PATH'){
          if(!Object.hasOwn(preloads,name))preloads[name]=jobEnvironment[key];
        }else gateEnvironment[key]=jobEnvironment[key];
      }
      let child,registration=Promise.resolve(),exited=false,closed=false,settled=false,failing=false,timedOut=false,admitted=false;
      let deadlineTimer,graceTimer,closeTimer,terminationTimer,termination,cleanupWall,cleanupMono,closedResolve;
      const childClosed=new Promise(resolve=>{closedResolve=resolve;});
      const beginCleanup=(limit=15000)=>{if(cleanupWall===undefined){cleanupWall=Date.now()+limit;cleanupMono=performance.now()+limit;}};
      const cleanupLeft=()=>Math.max(0,Math.floor(Math.min(cleanupWall-Date.now(),cleanupMono-performance.now())));
      const cleanupDeadline=()=>Date.now()+cleanupLeft();
      const clear=()=>{clearTimeout(deadlineTimer);clearTimeout(graceTimer);clearTimeout(closeTimer);clearTimeout(terminationTimer);};
      const waitBounded=async(promise,limit,message)=>{
        const remaining=Math.min(limit,cleanupLeft());if(remaining<=0)throw Error('Shared cleanup deadline exhausted');
        let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Error(message)),remaining);})]);}finally{clearTimeout(timer);}
      };
      const finish=()=>{clear();if(closed)ownedChildren.delete(child);};
      const running=()=>!exited&&!closed&&!settled&&!failing&&child.exitCode==null&&child.signalCode==null;
      const fail=error=>{
        if(settled||failing)return;
        if(!lease){settled=true;finish();reject(error);return;}
        failing=true;beginCleanup();clear();
        try{if(child.connected)child.send({type:'abort',reason:'supervisor-failure'},()=>{});}catch{}
        void (async()=>{
          let confirmed=true;
          try{
            if(lease.job!==null&&!lease.released)await waitBounded(lease.stop({deadline:cleanupDeadline()}),TREE_STOP_MS,'Owned failure cleanup exceeded deadline');
            else if(!admitted&&!closed&&child.pid===ownedChildren.get(child)?.pid){child.kill();}
          }catch{confirmed=false;}
          try{if(!closed)await waitBounded(childClosed,CLOSE_WAIT_MS,'Failed owned gate close unconfirmed');}catch{confirmed=false;}
          try{await waitBounded(lease.release({deadline:cleanupDeadline()}),CLOSE_WAIT_MS,'Failed owned release unconfirmed');}catch{confirmed=false;}
          if(error&&typeof error==='object')error.cleanupConfirmed=confirmed;settled=true;finish();reject(error);
        })();
      };
      const before=Date.now();
      try{child=spawnImpl(file,lease?['-e',gatedNodeSource(token)]:args,{...spawnOptions,...(lease?{env:gateEnvironment}:{}),stdio,shell:false,windowsHide:true,detached:process.platform!=='win32'});}
      catch(error){lease?.release().catch(()=>{});reject(error);return;}
      ownedChildren.set(child,{pid:child.pid,parent:process.pid,before,after:Date.now(),executable,lease});
      const force=()=>{
        if(!running()||termination)return;beginCleanup();
        const stop=Promise.resolve().then(()=>{if(running())return killTree(child,{isRunning:running,deadline:cleanupDeadline()});});
        termination=Promise.race([stop,new Promise((_,no)=>{terminationTimer=setTimeout(()=>no(Error('Owned capture tree termination deadline exceeded')),Math.min(TREE_STOP_MS,cleanupLeft()));})]);
        termination.then(()=>{
          clearTimeout(terminationTimer);
          if(!closed&&!settled&&!failing){clearTimeout(closeTimer);closeTimer=setTimeout(()=>fail(Error('Capture tree termination did not produce child close')),Math.min(CLOSE_WAIT_MS,cleanupLeft()));}
        },fail);
      };
      child.on('message',value=>{if(lease&&value?.type==='capture-supervisor-job-failed'&&value.token===token)force();});
      child.once('error',fail);
      child.once('exit',()=>{
        exited=true;clearTimeout(deadlineTimer);clearTimeout(graceTimer);clearTimeout(closeTimer);beginCleanup();
        if(!closed&&!settled&&!failing)closeTimer=setTimeout(()=>fail(Error('Capture exited without closing its output handles')),Math.min(CLOSE_WAIT_MS,cleanupLeft()));
      });
      child.once('close',async(status,signal)=>{
        closed=true;closedResolve();clearTimeout(deadlineTimer);clearTimeout(graceTimer);clearTimeout(closeTimer);beginCleanup();
        if(settled||failing)return;
        try{
          await waitBounded(registration,TREE_STOP_MS,'Owned registration unconfirmed at close');
          await termination;
          if(lease)await waitBounded(lease.release({deadline:cleanupDeadline()}),CLOSE_WAIT_MS,'Owned release unconfirmed');
          if(settled||failing)return;
          const result={status,signal:signal??null,timedOut};
          if(timedOut&&recoverAfterTimeout)await recoverAfterTimeout(result);
          if(settled||failing)return;settled=true;finish();resolve(result);
        }catch(error){fail(error);}
      });
      if(lease){
        lease.onFailure=fail;
        try{registration=lease.register(child);}catch(error){registration=Promise.reject(error);}
        registration.then(()=>{
          if(settled||failing||timedOut||workLeft()<=0){if(child.connected)child.send({type:'abort',reason:'admission-expired'},()=>{});return;}
          if(!child.connected){fail(Error('Owned gate disconnected before workload admission'));return;}
          admitted=true;
          try{child.send({type:'capture-supervisor-start',token,file:process.execPath,args,nodeOptions:preloads.NODE_OPTIONS,nodePath:preloads.NODE_PATH},error=>{if(error)fail(error);});}catch(error){fail(error);}
        }).catch(fail);
      }
      deadlineTimer=setTimeout(()=>{
        if(!running())return;timedOut=true;graceTimer=setTimeout(force,graceMs);
        try{if(child.connected&&typeof child.send==='function')child.send({type:'abort',reason:'timeout'},()=>{});}catch{}
      },gated?Math.max(0,workLeft()):timeoutMs);
    };
    if(gated)(supervisor||defaultSupervisor).acquire({deadline:workDeadline}).then(launch,reject);
    else launch(null);
  });
}
