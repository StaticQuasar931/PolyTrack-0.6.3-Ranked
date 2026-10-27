import {createHash} from 'node:crypto';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';

// Publication checks only: no network, physics verdicts, or changes to eligibility.
export async function eventReplayCoverage(boards, read) {
  const result={known:0,published:0,missing:0,invalid:0,indexed:0,complete:true,periods:[]};
  for(const board of boards){
    if(!board?.period?.id||!Array.isArray(board.entries))continue;
    const period=board.period,summary={periodId:period.id,archived:board.archived===true,known:0,published:0,missing:0,invalid:0,indexed:0};
    for(const [entries,pending] of [[board.entries,false],[board.pendingPlaybacks||[],true]])for(const entry of entries){
      summary.known++;
      const file=pending?`event-playbacks/${period.id}/${entry.runId}.json`:`event-replays/${period.id}/${entry.accountId}.json`;
      let value;try{value=await read(file);}catch{summary.missing++;continue;}
      if(!value){summary.missing++;continue;}
      try{
        if(value.periodId!==period.id||value.trackId!==period.trackId||value.accountId!==entry.accountId||value.timeMs!==entry.timeMs||value.frames!==entry.timeMs||
          !/^[a-f0-9]{64}$/.test(value.runId||'')||entry.runId&&entry.runId!==value.runId||entry.replayHash&&entry.replayHash!==value.replayHash||
          typeof value.replay!=='string'||value.replay.length>65536||value.frames>300000||
          typeof value.carStyle!=='string'||value.carStyle.length>256||
          createHash('sha256').update(value.replay).digest('hex')!==value.replayHash)throw Error('binding');
        if(pending&&(value.pending!==true||value.verified!==false||value.eventRpEligible!==false||value.submittedAt!==entry.submittedAt))throw Error('pending binding');
        const structure=await validatePublicReplayForPublication(value.replay,value.frames);
        if(!structure.indexedPlaybackWithinBudget||structure.inflatedBytes>30015||structure.transitions>10000||structure.maxChannelTransitions>4096)throw Error('playback limits');
        if(structure.legacyWork>30000000)summary.indexed++;
        summary.published++;
      }catch{summary.invalid++;}
    }
    for(const key of ['known','published','missing','invalid','indexed'])result[key]+=summary[key];
    result.periods.push(summary);
  }
  result.complete=result.missing===0&&result.invalid===0;
  return result;
}
