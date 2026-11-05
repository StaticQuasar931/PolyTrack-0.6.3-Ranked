import {createHash,createPublicKey,publicEncrypt,constants} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkerCaptureFetch} from './worker-capture-fetch.mjs';

const endpoint='https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/capture-auth';
const fingerprint=value=>createHash('sha256').update(value).digest('hex');

// This capability can request only public signing keys and the zero-database probe.
export async function diagnoseCaptureAccess({serviceAccount=process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,
  recipientPublicKey=process.env.CAPTURE_DIAGNOSTIC_RECIPIENT_KEY,
  fetchImpl=globalThis.fetch,now=Date.now}={}){
  let account;
  try{account=typeof serviceAccount==='string'?JSON.parse(serviceAccount):serviceAccount;
    if(account?.type!=='service_account'||account.project_id!=='polytrack-052'||
      !/^[A-Za-z0-9._-]+@polytrack-052\.iam\.gserviceaccount\.com$/.test(account.client_email||'')||
      !/^[A-Za-z0-9_-]{1,128}$/.test(account.private_key_id||''))throw Error();
  }catch{throw Error('Invalid configured capture identity');}
  const result={issuerFingerprint:fingerprint(account.client_email),keyFingerprint:fingerprint(account.private_key_id),
    publishedKey:null,probes:[],firestoreReads:0,firestoreWrites:0};
  if(recipientPublicKey){
    if(typeof recipientPublicKey!=='string'||recipientPublicKey.length>6144||recipientPublicKey.includes('PRIVATE'))throw Error('Invalid diagnostic recipient');
    const recipient=createPublicKey(recipientPublicKey);
    if(recipient.asymmetricKeyType!=='rsa'||recipient.asymmetricKeyDetails.modulusLength<2048||recipient.asymmetricKeyDetails.modulusLength>4096)throw Error('Invalid diagnostic recipient');
    result.recipientFingerprint=createHash('sha256').update(recipient.export({format:'der',type:'spki'})).digest('hex');
    result.issuerEnvelope=publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(account.client_email)).toString('base64');
  }
  const keys=await fetchImpl('https://www.googleapis.com/service_accounts/v1/jwk/'+encodeURIComponent(account.client_email),
    {method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),credentials:'omit'});
  if(keys.status===200){
    const body=await keys.json();
    result.publishedKey=Array.isArray(body?.keys)&&body.keys.some(key=>key?.kid===account.private_key_id);
  }else result.keyServiceStatus=keys.status;
  for(const offsetMs of [0,-2000]){
    const capture=createWorkerCaptureFetch({serviceAccount:account,fetchImpl,now:()=>now()+offsetMs});
    const response=await capture(endpoint,{headers:{Origin:'https://staticquasar931.github.io'}});
    result.probes.push({offsetMs,status:response.status,serverDate:response.headers.get('date')});
    if(response.status===204)break;
  }
  result.authenticated=result.probes.some(probe=>probe.status===204);
  return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  diagnoseCaptureAccess().then(result=>{console.log(JSON.stringify(result));if(!result.authenticated)process.exitCode=1;},
    ()=>{console.error('Capture-access diagnostic failed; no database access attempted.');process.exitCode=1;});
}
