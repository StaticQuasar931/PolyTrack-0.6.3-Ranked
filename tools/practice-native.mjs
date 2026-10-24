// Observes native callbacks only. No engine assets, inputs, replay data or messages are changed.
const installed=new WeakMap();
const MAX_PENDING_MS=2500,MAX_PENDING_SPANS=64;
export function installPracticeObserver({require,history,accountId,bestMs=()=>0,visible=()=>true,placementAfterFinish=()=>null,onTrack=()=>{},onLeave=()=>{},schedule=setInterval,cancel=clearInterval,clock=()=>performance.now(),eventTarget=globalThis.document,windowTarget=globalThis.window}){
 const Physics=require(5220)?.A,Car=require(641)?.A;
 if(!Physics?.prototype||!Car?.prototype)throw Error('practice_native_unavailable');
 const pp=Physics.prototype,cp=Car.prototype;
 if(installed.has(pp))return installed.get(pp);
 if(pp[Symbol.for('polytrack-native-local-binding')])throw Error('practice_binding_already_active');
 for(const fn of ['addResetCallback','addFinishCallback','getCarState','getTime','hasStarted','hasFinished','getNextCheckpointIndex','dispose'])if(typeof cp[fn]!=='function')throw Error('practice_native_contract');
 if(typeof Object.getOwnPropertyDescriptor(cp,'isPaused')?.get!=='function')throw Error('practice_native_contract');
 if(typeof pp.createCar!=='function')throw Error('practice_native_contract');
 const originalCreate=pp.createCar,originalReset=cp.addResetCallback,originalFinish=cp.addFinishCallback;
 const states=new WeakMap(),attached=new WeakSet();let current=null,pending=null,stopped=false;
 const report=fn=>{try{return fn();}catch{return undefined;}};
 // getPosition() is a read-only vector API in native module 641. Missing or
 // invalid positions mean unknown motion, never stationary or proven driving.
 function position(car){const p=report(()=>car.getPosition?.());return p&&[p.x,p.y,p.z].every(Number.isFinite)?{x:p.x,y:p.y,z:p.z}:null;}
 function clearClockSegment(state){state.clockPending=0;state.wallPending=[];}
 // Reconcile worker delivery jitter only inside one uninterrupted eligible segment.
 // Old wall spans retain their own motion evidence; new motion never labels old time.
 function progressFor(state,wall,delta,moving){
  let budget=state.clockPending+delta,catchUpMs=0,catchUpMovingMs=0,catchUpStationaryMs=0;
  const spans=state.wallPending;
  while(budget>0&&spans.length){
   const span=spans[0],used=Math.min(budget,span.ms);
   budget-=used;span.ms-=used;catchUpMs+=used;
   if(span.moving===true)catchUpMovingMs+=used;
   else if(span.moving===false)catchUpStationaryMs+=used;
   if(span.ms<=0)spans.shift();
  }
  const progress=Math.min(wall,budget);budget-=progress;
  const remaining=wall-progress;
  if(remaining>0){
   const previous=spans.at(-1);
   if(previous?.moving===moving)previous.ms+=remaining;
   else spans.push({ms:remaining,moving});
  }
  let excess=spans.reduce((total,span)=>total+span.ms,0)-MAX_PENDING_MS;
  while(excess>0&&spans.length){const used=Math.min(excess,spans[0].ms);spans[0].ms-=used;excess-=used;if(spans[0].ms<=0)spans.shift();}
  // Extremely frequent manual samples keep bounded memory, sacrificing only motion detail.
  while(spans.length>MAX_PENDING_SPANS){const first=spans.shift();spans[0]={ms:first.ms+spans[0].ms,moving:null};}
  state.clockPending=Math.min(MAX_PENDING_MS,budget);
  return {progress,catchUpMs,catchUpMovingMs,catchUpStationaryMs};
 }
 function recordFinish(state){
  if(stopped||current!==state||state.finished||accountId()!==state.account)return;
  const finish=state.attempt?.finish(Number(state.car.getFinishTime?.()?.numberOfFrames??state.car.getTime()?.numberOfFrames),{reliable:state.reliable});
  if(!finish)return;
  state.finished=true;clearClockSegment(state);
  const request={accountId:state.account,trackId:state.trackId,...finish};
  Promise.resolve(report(()=>placementAfterFinish(request))).then(placement=>{
   if(!stopped&&accountId()===state.account&&placement?.accountId===state.account&&placement?.trackId===state.trackId&&placement.timeMs===finish.timeMs)report(()=>history.observePlacement?.(state.account,state.trackId,{...placement,finishedAt:finish.finishedAt}));
  }).catch(()=>{});
 }
 function sample(boundary=false){
  if(!current)return;
  if(accountId()!==current.account){const previous=current;current=null;previous.attempt?.leave();report(()=>onLeave(previous.trackId));return;}
  const rawFrame=Number(current.car.getTime()?.numberOfFrames)||0;
  const finishFrame=current.car.hasFinished()?Number(current.car.getFinishTime?.()?.numberOfFrames):0;
  const frame=finishFrame>0?Math.min(rawFrame,finishFrame):rawFrame;
  const at=clock(),delta=frame-current.frame,wall=at-current.sampleAt;current.sampleAt=at;
  const shown=visible()===true,paused=current.car.isPaused===true;
  // Lifecycle callbacks close the previous visibility interval before starting the next.
  const intervalShown=boundary?current.shown:shown&&current.shown;
  const intervalPaused=paused;
  const resumed=current.paused&&!paused&&intervalShown;
  if(resumed)clearClockSegment(current);
  const started=current.car.hasStarted()&&!current.finished;
  const p=position(current.car),previous=current.position;
  const distance=p&&previous?Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z):null;
  // Reject implausible jumps rather than interpreting a reset as movement.
  const moving=distance===null||wall<=0||distance>500*wall/1000?null:distance>0.01;
  current.position=p;
  const eligible=wall>=0&&wall<=MAX_PENDING_MS&&delta>=0&&intervalShown&&!intervalPaused&&started;
  // A frozen worker state supplies no evidence of stationary or moving time.
  const observedMotion=delta>0?moving:null;
  let credit={progress:0,catchUpMs:0,catchUpMovingMs:0,catchUpStationaryMs:0};
  const observedWall=resumed&&eligible?Math.min(wall,delta):Math.max(0,wall);
  if(eligible)credit=progressFor(current,observedWall,delta,observedMotion);
  else clearClockSegment(current);
  if(wall>MAX_PENDING_MS||wall<0||!intervalShown||intervalPaused)current.reliable=false;
  if(!current.finished)current.attempt?.observe?.(observedWall,{visible:intervalShown,paused:intervalPaused,progressing:credit.progress>0,progressingMs:credit.progress,moving:observedMotion,gap:wall>MAX_PENDING_MS||wall<0});
  if(resumed&&eligible&&wall>observedWall)current.attempt?.observe?.(wall-observedWall,{gap:true});
  if(eligible&&(credit.progress>0||credit.catchUpMs>0))current.attempt?.tick(delta,current.car.getNextCheckpointIndex(),credit.progress,credit);
  if(boundary||shown!==current.shown||paused!==current.paused)clearClockSegment(current);
  current.shown=shown;current.paused=paused;
  current.frame=frame;current.last=Math.max(current.last,frame);
  if(current.car.hasFinished())recordFinish(current);
 }
 function create(...args){
  const result=originalCreate.apply(this,args);
  if(!stopped&&args[4]==null&&result?.carState&&args[3]?.getId){const trackId=report(()=>args[3].getId());if(/^[a-f0-9]{64}$/.test(trackId||''))states.set(result.carState,{trackId,physics:this});}
  return result;
 }
 function resetRegistration(callback){
  if(!stopped&&!attached.has(this)){
   const evidence=report(()=>states.get(this.getCarState()));
   if(evidence){
    attached.add(this);report(()=>{
     if(pending&&pending.physics===evidence.physics&&pending.trackId===evidence.trackId&&pending.account===accountId()){pending.attempt?.restart(pending.last);pending=null;}
     if(current){const previous=current;sample();previous.attempt?.leave();}
     const car=this,account=accountId(),attempt=history.begin(account,evidence.trackId,bestMs(account,evidence.trackId));
     const state={...evidence,account,car,attempt,frame:Number(car.getTime()?.numberOfFrames)||0,last:0,finished:false,sampleAt:clock(),position:position(car),shown:visible()===true,paused:car.isPaused===true,reliable:true,clockPending:0,wallPending:[]};current=state;
     report(()=>onTrack(evidence.trackId));
     originalReset.call(car,()=>report(()=>{
      if(stopped||current!==state||accountId()!==account)return;
      if(state.attempt?.isCurrent?.()===false){
       state.attempt=history.begin(account,evidence.trackId,bestMs(account,evidence.trackId));
       state.finished=false;state.frame=Number(car.getTime()?.numberOfFrames)||0;state.last=0;
       state.sampleAt=clock();state.shown=visible()===true;state.paused=car.isPaused===true;
       state.position=null;state.reliable=false;clearClockSegment(state);return;
      }
      clearClockSegment(state);state.position=null;sample();clearClockSegment(state);
      if(!state.finished){state.reliable=false;state.attempt?.respawn(state.last);}
     }));
     originalFinish.call(car,()=>report(()=>{
      if(stopped||current!==state||accountId()!==account)return;
      sample();recordFinish(state);
     }));
     const dispose=car.dispose;
     car.dispose=function(...args){
      if(current===state){report(sample);clearClockSegment(state);current=null;if(!state.finished){pending=state;queueMicrotask(()=>{if(pending===state){pending=null;state.attempt?.leave();}});}
       queueMicrotask(()=>{if(!stopped&&current===null)report(()=>onLeave(state.trackId));});}
      return dispose.apply(this,args);
     };
    });
   }
  }
  return originalReset.call(this,callback);
 }
 pp.createCar=create;cp.addResetCallback=resetRegistration;
 const timer=schedule(()=>{report(sample);history.flush();},1000);
 const boundary=()=>{report(()=>sample(true));history.flush(true);};
 eventTarget?.addEventListener?.('visibilitychange',boundary);
 for(const type of ['blur','focus','pagehide'])windowTarget?.addEventListener?.(type,boundary);
 const handle={sample(){report(sample);},stop(){stopped=true;cancel(timer);eventTarget?.removeEventListener?.('visibilitychange',boundary);for(const type of ['blur','focus','pagehide'])windowTarget?.removeEventListener?.(type,boundary);if(pp.createCar===create)pp.createCar=originalCreate;if(cp.addResetCallback===resetRegistration)cp.addResetCallback=originalReset;report(sample);current?.attempt?.leave();pending?.attempt?.leave();current=null;pending=null;history.flush(true);installed.delete(pp);}};
 installed.set(pp,handle);return handle;
}
