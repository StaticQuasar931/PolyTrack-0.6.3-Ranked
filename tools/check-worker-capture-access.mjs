import {createWorkerCaptureFetch} from './worker-capture-fetch.mjs';

// The probe validates the private signer without touching Firestore.
export async function checkWorkerCaptureAccess({fetchImpl=createWorkerCaptureFetch(),requiredReadGuard=null}={}) {
  const response=await fetchImpl('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/capture-auth',
    {headers:{Origin:'https://staticquasar931.github.io'}});
  if(response.status!==204)throw Error('Private snapshot capture authentication failed before database access (HTTP '+response.status+')');
  if(requiredReadGuard!==null&&(requiredReadGuard!=='combined-v1'||response.headers?.get('X-PolyTrack-Capture-Read-Guard')!==requiredReadGuard))
    throw Error('Required deployed capture read guard is unavailable; do not capture');
}
