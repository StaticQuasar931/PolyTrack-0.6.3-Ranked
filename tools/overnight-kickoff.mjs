import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Preserve an explicit tombstone: an old runbook must not dispatch a duplicate.
export async function kickoffOvernightSnapshot(){
  throw Error('Hosted overnight kickoff is disabled. Use the tested local-overnight-capture.mjs runner and its local readiness receipt.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  kickoffOvernightSnapshot().catch(error=>{console.error(error.message);process.exitCode=1;});
