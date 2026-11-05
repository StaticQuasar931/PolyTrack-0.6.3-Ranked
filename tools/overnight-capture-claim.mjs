import {OVERNIGHT_SNAPSHOT} from './overnight-snapshot-plan.mjs';
import {captureRepairPolicy} from './capture-repair-plan.mjs';

const REPOSITORY='StaticQuasar931/PolyTrack-0.6.3-Ranked';
export const overnightClaimRef=({replacement=false,attempt='repair-1'}={})=>replacement?captureRepairPolicy(attempt).claimRef:`refs/tags/polytrack-oneoff-${OVERNIGHT_SNAPSHOT.date}`;

// A GitHub ref is the shared one-shot marker, including failed admitted runs.
// It adds no database request or branch and is never deleted to retry silently.
export async function acquireOvernightCaptureClaim({repository,sourceCommit,token,replacement=false,attempt='repair-1',fetchImpl=fetch}={}){
  if(repository!==REPOSITORY||typeof replacement!=='boolean'||!/^[a-f0-9]{40}$/.test(sourceCommit||'')||typeof token!=='string'||!token.trim())
    throw Error('Invalid one-time claim identity');
  const ref=overnightClaimRef({replacement,attempt}),base=`https://api.github.com/repos/${REPOSITORY}/git/`;
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json'};
  const response=await fetchImpl(base+'refs',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers,body:JSON.stringify({ref,sha:sourceCommit})});
  if(response.status===201){
    const value=await response.json();
    if(value?.ref!==ref||value?.object?.sha!==sourceCommit)throw Error('One-time claim response binding mismatch');
    return {acquired:true,ref,sourceCommit};
  }
  if(response.status!==409&&response.status!==422)throw Error('One-time claim creation failed: HTTP '+response.status);
  const existing=await fetchImpl(base+'ref/'+ref.slice(5),{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers});
  if(existing.status!==200)throw Error('One-time claim conflict could not be validated');
  const value=await existing.json();
  if(value?.ref!==ref||!/^[a-f0-9]{40}$/.test(value?.object?.sha||''))throw Error('Invalid existing one-time claim');
  return {acquired:false,ref,sourceCommit:value.object.sha};
}
