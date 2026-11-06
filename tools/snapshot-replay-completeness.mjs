import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {eventReplayCoverage} from './event-replay-coverage.mjs';
import {LEGACY_ARCHIVE_REPLAY_EXCEPTIONS, legacyArchiveReplayAvailabilityView} from './legacy-archive-replay-exceptions.mjs';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';

const HASH=/^[a-f0-9]{64}$/;
const PERIOD=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES=256*1024*1024,MAX_BOARDS=1024,MAX_ROWS=100000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// This is a publication barrier, not verification authority or a cloud repair.
export async function snapshotReplayCompleteness(directory){
  const root=await fs.realpath(directory);
  let bytes=0,rows=0;
  const report={schemaVersion:1,complete:false,referencedBoardsMissing:0,normal:{known:0,available:0,missing:0,invalid:0},
    derived:{known:0,available:0,missing:0,invalid:0},
    events:{known:0,published:0,missing:0,invalid:0,indexed:0,complete:true,periods:[]},backendReads:0,backendWrites:0};
  async function read(relative,limit=2*1024*1024){
    if(typeof relative!=='string'||!relative.endsWith('.json')||relative.split('/').some(s=>!s||s==='.'||s==='..')||!/^[A-Za-z0-9._/-]+$/.test(relative))throw Error('Unsafe replay audit path');
    const file=path.join(root,...relative.split('/'));
    const stat=await fs.lstat(file);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>limit||bytes+stat.size>MAX_BYTES)throw Error('Invalid replay audit file');
    const actual=await fs.realpath(file);
    if(!actual.startsWith(root+path.sep))throw Error('Replay audit escaped staging');
    const body=await fs.readFile(file);bytes+=body.length;
    if(body.length>limit||bytes>MAX_BYTES)throw Error('Replay audit byte limit');
    return JSON.parse(body.toString('utf8'));
  }
  async function files(lane,valid){
    const folder=path.join(root,lane);
    let stat;try{stat=await fs.lstat(folder);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    if(stat.isSymbolicLink()||!stat.isDirectory()||!(await fs.realpath(folder)).startsWith(root+path.sep))throw Error('Invalid replay audit directory');
    const names=(await fs.readdir(folder)).filter(n=>n.endsWith('.json')).sort();
    if(names.length>MAX_BOARDS||names.some(n=>!valid.test(n)))throw Error('Invalid replay audit board list');
    return names.map(n=>lane+'/'+n);
  }
  const normalFiles=await files('tracks',/^[a-f0-9]{64}\.json$/);
  const eventFiles=await files('events',/^[A-Za-z0-9_-]{1,64}\.json$/);
  const archiveFiles=await files('archives',/^[A-Za-z0-9_-]{1,64}\.json$/);
  const present=new Set([...normalFiles,...eventFiles,...archiveFiles]);
  let manifest;try{manifest=await read('manifest.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(manifest?.pendingPlaybackCoverage!==undefined){
    const pending=manifest.pendingPlaybackCoverage,keys=['known','published','missing','failed','deferred'];
    if(!object(pending)||keys.some(key=>!Number.isSafeInteger(pending[key])||pending[key]<0||pending[key]>MAX_ROWS)||
        pending.known!==pending.published+pending.missing||pending.missing!==pending.failed+pending.deferred||
        pending.complete!==(pending.missing===0))throw Error('Invalid pending replay capture coverage');
    // Capture may omit unplayable waiting previews from cached boards. That is
    // not permission to turn missing source inputs into a complete publication.
    report.pendingCapture={...Object.fromEntries(keys.map(key=>[key,pending[key]])),complete:pending.complete};
  }
  for(const [lane,records] of [['tracks',manifest?.tracks],['events',manifest?.events]]){
    if(records===undefined)continue;
    if(!object(records))throw Error('Invalid replay audit manifest');
    for(const [id,record] of Object.entries(records)){
      if(record?.path===null)continue;
      const validId=lane==='tracks'?HASH.test(id):PERIOD.test(id);
      if(!validId||record?.path!==`${lane}/${id}.json`)throw Error('Invalid replay audit manifest binding');
      if(!present.has(record.path))report.referencedBoardsMissing++;
    }
  }
  const normalBindings=new Map();
  const checkRows=count=>{rows+=count;if(!Number.isSafeInteger(count)||count<0||rows>MAX_ROWS)throw Error('Replay audit row limit');};
  for(const file of normalFiles){
    const board=await read(file,32*1024*1024),trackId=file.slice(7,-5);
    if(!object(board)||board.trackId!==trackId||!Array.isArray(board.entries))throw Error('Invalid replay audit normal board');
    checkRows(board.entries.length);
    for(const entry of board.entries){
      report.normal.known++;
      if(!object(entry)||!HASH.test(entry.accountId||'')||entry.trackId!==trackId||
        !integer(entry.uploadId)||!integer(entry.timeMs)||!integer(entry.frames??entry.raceTimeFrames)||
        (entry.frames??entry.raceTimeFrames)>4000000||!HASH.test(entry.replayHash||'')){
        report.normal.invalid++;continue;
      }
      const frames=entry.frames??entry.raceTimeFrames;
      if(entry.frames!==undefined&&entry.frames!==frames||entry.raceTimeFrames!==undefined&&entry.raceTimeFrames!==frames){report.normal.invalid++;continue;}
      const key=trackId+'_'+entry.accountId;
      if(normalBindings.has(key))throw Error('Duplicate normal replay audit binding');
      const source={entry,available:false};normalBindings.set(key,source);
      let canonical,recording;
      try{
        canonical=await read(`canonical/${trackId}/${entry.accountId}.json`);
        recording=await read(`recordings/${entry.uploadId}.json`);
      }catch(e){if(e.code==='ENOENT')report.normal.missing++;else report.normal.invalid++;continue;}
      try{
        if(!object(canonical)||!object(recording)||canonical.accountId!==entry.accountId||canonical.trackId!==trackId||
          canonical.uploadId!==entry.uploadId||canonical.timeMs!==entry.timeMs||canonical.frames!==frames||
          canonical.raceTimeFrames!==undefined&&canonical.raceTimeFrames!==frames||canonical.replayHash!==entry.replayHash||
          recording.accountId!==entry.accountId||recording.trackId!==trackId||recording.frames!==frames||
          recording.raceTimeFrames!==undefined&&recording.raceTimeFrames!==frames||
          recording.uploadId!==undefined&&recording.uploadId!==entry.uploadId||recording.timeMs!==undefined&&recording.timeMs!==entry.timeMs||
          recording.replayHash!==entry.replayHash||typeof recording.recording!=='string'||digest(recording.recording)!==entry.replayHash)throw Error('Replay binding mismatch');
        const structure=await validatePublicReplayForPublication(recording.recording,frames);
        if(!structure.indexedPlaybackWithinBudget)throw Error('Replay playback budget');
        source.available=true;
        report.normal.available++;
      }catch{report.normal.invalid++;}
    }
  }
  const boards=[], sourceBoards=[];
  for(const file of [...eventFiles,...archiveFiles]){
    const board=await read(file,32*1024*1024),id=path.posix.basename(file,'.json');
    if(!object(board))throw Error('Invalid replay audit event board');
    if(file.startsWith('archives/')&&!Object.hasOwn(board,'entries')){
      if(!object(board)||!Array.isArray(board.periods))throw Error('Invalid replay audit archive catalog');
      continue;
    }
    // Permanent standings reuse exact normal-board inputs, not event payloads.
    if(id==='permanent-rolling-hills'&&board?.kind==='permanent'&&board.id===id&&HASH.test(board.trackId||'')&&Array.isArray(board.entries)){
      checkRows(board.entries.length);
      for(const entry of board.entries){
        report.derived.known++;
        const source=normalBindings.get(board.trackId+'_'+entry?.accountId);
        if(!source?.available){report.derived.missing++;continue;}
        if(entry.trackId!==board.trackId||entry.timeMs!==source.entry.timeMs||entry.frames!==(source.entry.frames??source.entry.raceTimeFrames)||entry.replayHash!==source.entry.replayHash)report.derived.invalid++;
        else report.derived.available++;
      }
      continue;
    }
    if(!object(board)||!object(board.period)||!PERIOD.test(board.period.id||'')||board.period.id!==id||
      !HASH.test(board.period.trackId||'')||!Array.isArray(board.entries)||
      board.pendingPlaybacks!==undefined&&!Array.isArray(board.pendingPlaybacks))throw Error('Invalid replay audit event board');
    const entries=[...board.entries,...(board.pendingPlaybacks||[])];checkRows(entries.length);
    if(entries.some(e=>!object(e)||!HASH.test(e.accountId||'')||!integer(e.timeMs)||e.runId!==undefined&&!HASH.test(e.runId)))throw Error('Invalid replay audit event entry');
    boards.push(board);sourceBoards.push({sourcePath:file,board});
  }
  const hasLegacy=sourceBoards.some(({board})=>board.entries.some(row=>row.replayUnavailable===true));
  let availabilityBoards=boards;
  if(hasLegacy){const view=legacyArchiveReplayAvailabilityView(sourceBoards);availabilityBoards=view.replayAvailabilityBoards;report.legacyReplayUnavailable=view.exempted;}
  report.events=await eventReplayCoverage(availabilityBoards,relative=>read(relative));
  report.complete=report.referencedBoardsMissing===0&&report.normal.missing===0&&report.normal.invalid===0&&report.events.complete&&report.derived.missing===0&&report.derived.invalid===0&&report.pendingCapture?.complete!==false;
  return report;
}

export async function assertSnapshotReplayCompleteness(directory){
  const coverage=await snapshotReplayCompleteness(directory);
  if(!coverage.complete){
    const error=Error(`Snapshot publication blocked: normal replays missing ${coverage.normal.missing}, invalid ${coverage.normal.invalid}; event replays missing ${coverage.events.missing}, invalid ${coverage.events.invalid}; captured pending inputs missing ${coverage.pendingCapture?.missing||0}; derived replays missing ${coverage.derived.missing}, invalid ${coverage.derived.invalid}; referenced boards missing ${coverage.referencedBoardsMissing}. Retain the previous snapshot and resume from the captured checkpoint; do not recapture automatically.`);
    error.code='SNAPSHOT_REPLAYS_INCOMPLETE';error.coverage=coverage;throw error;
  }
  return coverage;
}
