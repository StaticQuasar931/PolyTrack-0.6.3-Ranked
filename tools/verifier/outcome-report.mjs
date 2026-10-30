import fs from 'node:fs';
import path from 'node:path';

const ID=/^[a-f0-9]{64}$/;
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:'unspecified';
export function createOutcomeReport({file,root,maxRecords=20000}={}) {
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>20000)throw Error('Invalid outcome record limit');
  if(!file)return {record:()=>{},finish:()=>{}};
  if(!path.isAbsolute(file))throw Error('Outcome report must be an absolute private path');
  const repo=fs.realpathSync(root),parent=fs.realpathSync(path.dirname(file));
  const target=path.join(parent,path.basename(file)),rel=path.relative(repo,target);
  if(!rel||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep))throw Error('Outcome report must be outside repository');
  const fd=fs.openSync(target,'wx',0o600),tracks=new Map();
  let records=0,dropped=0,closed=false;
  const record=(job,result,{lane='normal',periodId,completed=false}={})=>{
    if(closed||!ID.test(job?.trackId||''))return;
    const status=token(result?.status),reason=token(result?.reason);
    const held=/manual_review|competitive_review|review_hold/.test(reason);
    const outcome=held?'held':status==='verified'?'verified':['waiting','unavailable','unavailable_final'].includes(status)?'unavailable':status;
    const track=tracks.get(job.trackId)||{trackId:job.trackId,observed:0,completed:0,outcomes:{},reasons:{}};
    track.observed++;track.completed+=Number(completed===true);
    track.outcomes[outcome]=(track.outcomes[outcome]||0)+1;track.reasons[reason]=(track.reasons[reason]||0)+1;tracks.set(job.trackId,track);
    if(records>=maxRecords-1){dropped++;return;}
    const row={type:'outcome',trackId:job.trackId,lane:lane==='event'?'event':'normal',outcome,status,reason,completed:completed===true};
    if(ID.test(job.accountId||''))row.accountId=job.accountId;
    if(ID.test(job.replayHash||''))row.replayHash=job.replayHash;
    if(Number.isSafeInteger(job.timeMs)&&job.timeMs>0)row.timeMs=job.timeMs;
    if(typeof periodId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(periodId))row.periodId=periodId;
    fs.writeSync(fd,JSON.stringify(row)+'\n');records++;
  };
  const finish=({countsComplete=false}={})=>{
    if(closed)return;closed=true;
    try{fs.writeSync(fd,JSON.stringify({type:'summary',countsComplete,records,dropped,
      completed:[...tracks.values()].reduce((n,t)=>n+t.completed,0),tracks:[...tracks.values()].sort((a,b)=>a.trackId.localeCompare(b.trackId))})+'\n');}
    finally{fs.closeSync(fd);}
  };
  return {record,finish};
}
