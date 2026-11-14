import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';
const extra=new Set(EXTRA_TRACK_IDS),rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export function profileTrackGroup(trackId,{type,legacy=false}={}){
  if(type==='official'||trackId===rolling)return 'official';
  if(extra.has(trackId)||type==='extra')return 'extra';
  if(type==='community'||legacy)return 'community';
  return 'custom';
}
export function trackCoverageSummary({saved,ranked,localOnly=false}={}){
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:null,format=v=>v.toLocaleString('en-US');saved=count(saved);ranked=count(ranked);
  if(saved===null)return 'Saved track count unavailable';
  const word=saved===1?'track':'tracks';
  if(localOnly||ranked===null)return format(saved)+' saved '+word;
  if(saved===ranked)return format(saved)+' '+word;
  return format(saved)+' saved / '+format(ranked)+' ranked';
}
