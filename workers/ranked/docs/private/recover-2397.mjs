// PRIVATE operator utility. No target, credentials, or live execution on import.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const MAX_CALLS=15;
const PACE=30000, WALL=15*60000, TIMEOUT=15000;
const stop=code=>{const error=new Error(code);error.code=code;throw error;};
async function boundedJson(response) {
  if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))stop('STOP_RESPONSE_TYPE');
  if(!response.body)stop('STOP_RESPONSE_BODY');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>4096){await reader.cancel();stop('STOP_RESPONSE_SIZE');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{stop('STOP_RESPONSE_JSON');}
}

export async function runBoundedRecovery(input,{token,expectedWorkerOrigin,fetchImpl=fetch,
  now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onProgress=()=>{}}={}) {
  if(!input||input.expectedCount!==2397||input.sourceCount!==1900||input.recoverExpired!==true||
    typeof input.trackId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(input.trackId)||
    typeof input.generation!=='string'||!/^[a-f0-9]{64}$/.test(input.generation)||
    typeof input.checkpointVersion!=='string'||!input.checkpointVersion||input.checkpointVersion.length>128)stop('STOP_INPUT');
  let target,origin;
  try{target=new URL(input.workerOrigin);origin=new URL(input.allowedOrigin);}catch{stop('STOP_ORIGIN');}
  if(target.origin!==expectedWorkerOrigin||target.origin!==input.workerOrigin||target.protocol!=='https:'||
    !/^polytrack-ranked-worker\.[a-z0-9-]+\.workers\.dev$/.test(target.hostname)||
    target.username||target.password||target.search||target.hash||target.pathname!=='/'||
    origin.protocol!=='https:'||origin.origin!==input.allowedOrigin)stop('STOP_ORIGIN');
  if(typeof token!=='string'||token.length<16||token.length>4096||/[\r\n]/.test(token))stop('STOP_AUTH_INPUT');
  const started=now();if(!Number.isSafeInteger(started)||started<0)stop('STOP_CLOCK');
  let generation=input.generation,checkpointVersion=input.checkpointVersion,previousCount=0;
  let deadline=started+WALL,previousClock=started,calls=0,sourceDeadline;
  const clock=()=>{const time=now();if(!Number.isSafeInteger(time)||time<previousClock)stop('STOP_CLOCK');previousClock=time;return time;};
  for(let index=0;index<MAX_CALLS;index++) {
    if(clock()>=deadline)stop('STOP_DEADLINE');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.min(TIMEOUT,deadline-clock()));
    let body;
    try {
      calls++;
      const response=await fetchImpl(new URL('/v1/admin/track-build/continue',target),{
        method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,
        headers:{Origin:input.allowedOrigin,'X-Admin-Token':token,'Content-Type':'application/json'},
        body:JSON.stringify({trackId:input.trackId,generation,checkpointVersion,recoverExpired:index===0})});
      if(response.status!==200){await response.body?.cancel();stop('STOP_HTTP_NON_200');}
      body=await boundedJson(response);
    } catch(error) {
      if(error.code?.startsWith('STOP_'))throw error;
      stop('STOP_AMBIGUOUS_TRANSPORT');
    } finally {clearTimeout(timer);}
    if(clock()>=deadline)stop('STOP_DEADLINE');
    if(!body||typeof body.pending!=='boolean'||typeof body.complete!=='boolean'||body.pending===body.complete)
      stop('STOP_RESPONSE_CONTRACT');
    if(body.complete) {
      if(!Number.isSafeInteger(body.revision)||body.revision<1)stop('STOP_RESPONSE_CONTRACT');
      const result={complete:true,calls,elapsedMs:clock()-started,independentRowCountAudit:false};
      onProgress(result);return result;
    }
    if(typeof body.generation!=='string'||!/^[a-f0-9]{64}$/.test(body.generation)||
      (index===0?body.generation===generation:body.generation!==generation)||
      typeof body.checkpointVersion!=='string'||!body.checkpointVersion||body.checkpointVersion.length>128||
      body.checkpointVersion===checkpointVersion||!Number.isSafeInteger(body.sourceCount)||
      body.sourceCount<=previousCount||body.sourceCount>2397||body.sourceCount-previousCount>(index===0?100:200)||
      body.continueAfterMs!==PACE||!Number.isSafeInteger(body.deadlineAt)||body.deadlineAt<=clock()||
      body.deadlineAt>clock()+50*60000||(sourceDeadline!==undefined&&body.deadlineAt!==sourceDeadline))
      stop('STOP_RESPONSE_FENCE');
    sourceDeadline=body.deadlineAt;deadline=Math.min(deadline,sourceDeadline);
    generation=body.generation;checkpointVersion=body.checkpointVersion;previousCount=body.sourceCount;
    onProgress({calls,pending:true,sourceCount:previousCount});
    if(calls===MAX_CALLS)stop('STOP_CALL_LIMIT');
    if(clock()+PACE>=deadline)stop('STOP_DEADLINE');
    await sleep(PACE);
  }
  stop('STOP_CALL_LIMIT');
}

async function main() {
  if(process.env.POLYTRACK_ALLOW_SCOPED_RECOVERY!=='2397_MAX15')stop('STOP_NOT_ARMED');
  if(process.argv.length!==3)stop('STOP_INPUT_PATH');
  const bytes=await readFile(process.argv[2]);if(bytes.length>4096)stop('STOP_INPUT_SIZE');
  const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  await runBoundedRecovery(input,{token:process.env.POLYTRACK_ADMIN_TOKEN,
    expectedWorkerOrigin:process.env.POLYTRACK_EXPECTED_WORKER_ORIGIN,
    onProgress:summary=>process.stdout.write(JSON.stringify(summary)+'\n')});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{process.stderr.write((/^STOP_[A-Z0-9_]+$/.test(error.code||'')?error.code:'STOP_LOCAL_OR_AMBIGUOUS')+'\n');process.exitCode=1;});
}
