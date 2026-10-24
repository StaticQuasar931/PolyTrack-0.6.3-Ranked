import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, appendFile, mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'StaticQuasar931/PolyTrack-0.6.3-Ranked';
export const POINTER_BRANCH = 'cdn-release';
export const ASSET_BRANCH = 'cdn-assets';
export const POINTER_URL = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${POINTER_BRANCH}/release.json`;
export const POINTER_MIRRORS = ['fastly.jsdelivr.net','gcore.jsdelivr.net'].map(host => POINTER_URL.replace('cdn.jsdelivr.net',host));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function releasePlan({root, commit, read = file => readFile(path.join(root, file)), now = new Date()}) {
  if (!sha(commit)) throw Error('Expected a full commit SHA');
  const index = await read('index.html');
  const html = index.toString('utf8');
  const directory = html.match(/<meta\s+name="polytrack-snapshot"\s+content="\.\/(public-snapshots[0-9]+)\/"/i)?.[1];
  if (!directory || !html.includes('main.bundle.js') || !html.includes('polytrack_062_patch.js')) throw Error('Unsupported game entry point');
  const current = JSON.parse(await read('snapshot-current.json'));
  if (current.currentdir !== directory) throw Error('Snapshot pointer and entry point disagree');
  const probes = new Set(['index.html', 'site-version.json', 'simulation_worker.bundle.js', 'polytrack_physics.wasm', directory + '/bootstrap-fast.json']);
  for (const file of ['tools/public-snapshot-client.mjs','tools/snapshot-metadata-recovery.mjs','tools/unique-profile-name.mjs','tools/overall-local-controller.mjs','tools/overall-local-projection.mjs','tools/practice-profile.mjs','events/client.mjs']) probes.add(file);
  for (const match of html.matchAll(/\b(?:src|href)="\.\/([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(match[1]) || match[1].split('/').includes('..')) throw Error('Unsafe entry asset path');
    probes.add(match[1]);
  }
  // Native startup loads this image set eagerly; an unavailable icon can abort boot.
  const native = (await read('main.bundle.js')).toString('utf8');
  for (const image of native.match(/images\/[a-zA-Z0-9_./-]+\.(?:svg|png|jpg|webp)/g) || []) {
    if (image.split('/').includes('..')) throw Error('Unsafe native image path');
    probes.add(image);
  }
  const pack = JSON.parse(await read(directory + '/index.json'));
  const fast = JSON.parse(await read(directory + '/bootstrap-fast.json'));
  if (pack.generation !== Number(directory.slice('public-snapshots'.length))) throw Error('Snapshot generation mismatch');
  if (pack.schemaVersion !== 1 || pack.encoding !== 'gzip-xor-a7-v1' || !pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) throw Error('Invalid full snapshot index');
  if (fast.schemaVersion !== 1 || fast.generation !== pack.generation || fast.encoding !== pack.encoding || fast.compactIndexVersion !== 1 || fast.partial !== true || fast.fallbackIndex !== 'index.json' || !fast.files || typeof fast.files !== 'object' || Array.isArray(fast.files)) throw Error('Invalid fast snapshot index');
  for (const [logical,binding] of Object.entries(fast.files)) {
    const entry = pack.files[logical];
    if (!Array.isArray(binding) || binding.length !== 2 || !/^[a-f0-9]{64}$/.test(binding[0]) || !Number.isSafeInteger(binding[1]) || binding[1] < 1 || binding[1] > 2*1024*1024 || !entry || entry.path !== binding[0]+'.bin' || entry.sha256 !== binding[0] || entry.decodedBytes !== binding[1]) throw Error('Invalid fast snapshot entry: ' + logical);
  }
  for (const logical of ['overall-manifest.json', 'overall-preview.json', 'overall-pages/1.json']) {
    const entry = pack.files?.[logical];
    if (!entry || !/^[a-f0-9]{64}\.bin$/.test(entry.path) || entry.path !== entry.sha256 + '.bin') throw Error('Missing initial rankings payload: ' + logical);
    const binding = fast.files?.[logical];
    if (!Array.isArray(binding) || binding[0] !== entry.sha256 || binding[1] !== entry.decodedBytes) throw Error('Fast index rankings binding mismatch: ' + logical);
    probes.add(directory + '/' + entry.path);
  }
  const modules = [...probes].filter(file => file.endsWith('.mjs'));
  const seen = new Set();
  while (modules.length) {
    const file = modules.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = (await read(file)).toString('utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)) {
      const relative = match[1].split(/[?#]/)[0];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file),relative));
      if (target.startsWith('../') || !/^[a-zA-Z0-9_./-]+$/.test(target)) throw Error('Unsafe module dependency');
      if (!probes.has(target)) { probes.add(target); if(target.endsWith('.mjs')) modules.push(target); }
    }
    if (probes.size > 256) throw Error('Runtime graph requires review: too many release probes');
  }
  const files = [];
  for (const file of probes) {
    const bytes = await read(file);
    if (!bytes.length || bytes.length >= 20000000) throw Error('Invalid release asset: ' + file);
    if (file.endsWith('/bootstrap-fast.json') && bytes.length > 2*1024*1024) throw Error('Fast snapshot index exceeds runtime limit');
    const hash = digest(bytes);
    if (/^[a-f0-9]{64}\.bin$/.test(path.posix.basename(file)) && path.posix.basename(file) !== hash + '.bin') throw Error('Snapshot digest mismatch');
    files.push({path:file, sha256:hash});
  }
  if (files.length > 256) throw Error('Entry point requires review: too many release probes');
  return {pointer:{schemaVersion:1, repository:REPOSITORY, commit, snapshotDirectory:directory, indexSha256:digest(index), publishedAt:now.toISOString()}, files};
}

async function fetchBytes(url, fetchImpl, {retryAfterCapMs=120000}={}) {
  const response = await fetchImpl(url, {credentials:'omit', cache:'no-store', signal:AbortSignal.timeout(20000), redirect:'error'});
  if (!response.ok) {
    const error = Error('CDN HTTP ' + response.status);
    error.status = response.status;
    const detail = response.text ? (await response.text()).slice(0,400) : '';
    if (/Package size exceeded/i.test(detail)) {
      error.packageLimit = true;
      error.message = 'CDN package size limit exceeded; a smaller asset tree is required';
    }
    const retryAfter = response.headers?.get('retry-after');
    const delay = /^\d+$/.test(retryAfter || '') ? Number(retryAfter)*1000 : Date.parse(retryAfter)-Date.now();
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay,retryAfterCapMs);
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length >= 20000000) throw Error('CDN response too large');
  return bytes;
}

export async function checkReleaseFiles(plan, {fetchImpl=fetch, sleep=pause, now=Date.now, log=console.warn}={}) {
  const base = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${plan.pointer.commit}/`;
  // Bounded concurrency warms the boot path, not every replay or historical file.
  const queue = [...plan.files];
  const deadline = now() + 5*60*1000;
  const transient = error => [403,404,408,425,429].includes(error?.status) || error?.status >= 500 && error.status <= 599 || error instanceof TypeError || ['AbortError','TimeoutError'].includes(error?.name);
  const delays = [5000,15000,30000,60000];
  let stopped = false;
  await Promise.all(Array.from({length:Math.min(4,queue.length)}, async () => {
    while (queue.length && !stopped) {
      const file = queue.shift();
      let error, attempts=0;
      for (let attempt=0; attempt<5; attempt++) {
        if (stopped) return;
        if (now() >= deadline) { error=Error('CDN readiness budget exhausted'); break; }
        attempts++;
        try {
          if (digest(await fetchBytes(base + file.path, fetchImpl)) !== file.sha256) throw Error('CDN bytes differ from committed file');
          error = null; break;
        } catch (failure) {
          error = failure;
          const limit = failure.packageLimit ? 1 : transient(failure) ? 5 : 3;
          if (attempt+1 >= limit) break;
          const delay = Math.max(transient(failure) ? delays[attempt] : (attempt+1)*3000, failure.retryAfterMs || 0);
          if (now()+delay >= deadline) break;
          log(`CDN readiness: ${file.path}: ${failure.message}; attempt ${attempt+1}/${limit}, retry in ${Math.ceil(delay/1000)}s`);
          await sleep(delay);
        }
      }
      if (error) { stopped=true; throw Error('Release not advertised: ' + file.path + ' after ' + attempts + ' attempts', {cause:error}); }
    }
  }));
}

export function includeReleaseAsset(file, snapshotDirectory) {
  const top = file.split('/')[0];
  if (/^public-snapshots\d+$/.test(top)) return top === snapshotDirectory;
  if (['.github','.gitignore','docs','AGENTS.md'].includes(top)) return false;
  if (file.startsWith('tools/verifier/') || file.startsWith('workers/ranked/test/')) return false;
  if (/\.(?:test|spec|benchmark)\.[cm]?js$/.test(file)) return false;
  return true;
}

export function assertCdnAssetSizes(entries) {
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes >= 20000000) throw Error('CDN file must be under 20,000,000 bytes: '+entry.path);
  }
}

export async function publishAssetTree(plan, git) {
  const source = plan.pointer.commit;
  const entries = git(['ls-tree','-r','-l','-z',source]).toString().split('\0').filter(Boolean);
  const selected = entries.map(line => {
    const match = /^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(line);
    if (!match) throw Error('Unsupported release Git entry');
    return {mode:match[1],hash:match[2],bytes:Number(match[3]),path:match[4]};
  }).filter(entry => includeReleaseAsset(entry.path,plan.pointer.snapshotDirectory));
  assertCdnAssetSizes(selected);
  const names = new Set(selected.map(entry=>entry.path));
  if (plan.files.some(file=>!names.has(file.path))) throw Error('Compact package excludes a required boot asset');
  const temporary = await mkdtemp(path.join(os.tmpdir(),'polytrack-cdn-index-'));
  const env = {...process.env,GIT_INDEX_FILE:path.join(temporary,'index')};
  git(['read-tree','--empty'],{env});
  git(['update-index','-z','--index-info'],{env,input:selected.map(entry=>`${entry.mode} blob ${entry.hash}\t${entry.path}\0`).join('')});
  const tree = git(['write-tree'],{env}).trim();
  // Measure the actual tar, including headers/padding, rather than only blob bytes.
  const archive = git(['archive','--format=tar','--prefix=PolyTrack-0.6.3-Ranked-'+source+'/',tree],{encoding:null,maxBuffer:50000000});
  if (archive.length >= 49000000) throw Error('Compact CDN archive still exceeds the safe 49 MB publishing budget');
  const listed = git(['ls-remote','--heads','origin','refs/heads/'+ASSET_BRANCH]).trim();
  let parent;
  if (listed) { git(['fetch','--no-tags','origin','refs/heads/'+ASSET_BRANCH]);parent=git(['rev-parse','FETCH_HEAD']).trim();if(!sha(parent))throw Error('Invalid asset parent'); }
  if (parent && git(['rev-parse',parent+'^{tree}']).trim() === tree) return {commit:parent,archiveBytes:archive.length,files:selected.length};
  const identity = {...process.env,GIT_AUTHOR_NAME:'github-actions[bot]',GIT_COMMITTER_NAME:'github-actions[bot]',GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com'};
  const commit = git(['commit-tree',tree,...(parent?['-p',parent]:[])],{env:identity,input:'CDN assets for '+source+'\n'}).trim();
  if(!sha(commit))throw Error('Invalid asset commit');
  git(['push','origin',commit+':refs/heads/'+ASSET_BRANCH]);
  return {commit,archiveBytes:archive.length,files:selected.length};
}

export const validReleasePointer = value => value?.schemaVersion === 1 && value.repository === REPOSITORY && sha(value.commit) &&
    /^[a-f0-9]{64}$/.test(value.indexSha256 || '') && /^public-snapshots[1-9]\d*$/.test(value.snapshotDirectory || '') &&
    typeof value.publishedAt==='string' && Number.isFinite(Date.parse(value.publishedAt)) &&
    (value.sourceCommit === undefined || sha(value.sourceCommit));

export function sameReleasePointer(actual, expected) {
  return validReleasePointer(actual) && actual.commit===expected.commit && actual.indexSha256===expected.indexSha256 &&
    actual.snapshotDirectory===expected.snapshotDirectory && (!expected.sourceCommit || actual.sourceCommit===expected.sourceCommit);
}

export function validPurgeState(state, now=Date.now()) {
  return state?.schemaVersion===1 && state.pointerUrl===POINTER_URL && Number.isSafeInteger(state.updatedAt) &&
    Number.isSafeInteger(state.nextPurgeAt) && state.updatedAt>=0 && state.updatedAt<=now &&
    state.nextPurgeAt>=state.updatedAt && state.nextPurgeAt<=state.updatedAt+86400000;
}

export async function pointerMirrorEvidence(expected, {fetchImpl=fetch}={}) {
  const rows=[];
  for (const url of POINTER_MIRRORS) {
    try {
      const actual=JSON.parse((await fetchBytes(url,fetchImpl)).toString('utf8'));
      rows.push({url,status:validReleasePointer(actual)?sameReleasePointer(actual,expected)?'current':'different':'invalid',
        ...(validReleasePointer(actual)?{commit:actual.commit,sourceCommit:actual.sourceCommit}:{})});
    } catch(error) { rows.push({url,status:'unavailable',httpStatus:error.status}); }
  }
  return rows;
}

export async function refreshReleasePointer(expected, {fetchImpl=fetch, sleep=pause, now=Date.now, log=console.warn,
  getCurrentPointer, purgeState, savePurgeState=async()=>{}, inspectMirrors=true}={}) {
  if (!validReleasePointer(expected)) throw Error('Invalid expected release pointer');
  const started=now(),deadline=started+240000,delays=[5000,10000,20000,30000,45000,60000,60000,60000];
  let failure, attempts=0, purges=0;
  const state = retryAfterMs => {const at=now();return {schemaVersion:1,pointerUrl:POINTER_URL,updatedAt:at,nextPurgeAt:at+retryAfterMs};};
  const save = async retryAfterMs => {try {await savePurgeState(state(retryAfterMs));} catch {log('Optional purge cooldown checkpoint unavailable.');}};
  const deferred = async (reason,retryAfterMs) => {
    const mirrors=inspectMirrors?await pointerMirrorEvidence(expected,{fetchImpl}):[];
    return {confirmed:false,status:'deferred',reason,retryAfterMs,attempts,purges,elapsedMs:now()-started,mirrors};
  };
  const authority = async () => {
    if (!getCurrentPointer) return null;
    try {
      const current=await getCurrentPointer();
      if (!validReleasePointer(current)) throw Object.assign(Error('Invalid authoritative pointer'),{integrityFailure:true});
      return sameReleasePointer(current,expected)?null:{confirmed:false,status:'superseded',reason:'authoritative-pointer-changed',
        attempts,purges,elapsedMs:now()-started,current};
    } catch(error) {
      if(error.integrityFailure)throw error;
      return {confirmed:false,status:'deferred',reason:'pointer-authority-unavailable',retryAfterMs:900000,
        attempts,purges,elapsedMs:now()-started};
    }
  };
  // Compare the real loader URL, not a cache-busted URL that could hide stale clients.
  for (let attempt=0; attempt<9 && now()<deadline; attempt++) {
    attempts++;
    const changed=await authority();
    if(changed)return changed;
    try {
      const actual=JSON.parse((await fetchBytes(POINTER_URL,fetchImpl)).toString('utf8'));
      if (!validReleasePointer(actual)) throw Object.assign(Error('Invalid CDN release pointer; refusing confirmation'),{integrityFailure:true});
      if (sameReleasePointer(actual,expected)) {
        const changed=await authority();
        if(changed)return changed;
        return {confirmed:true,attempts,purges,elapsedMs:now()-started};
      }
      failure=Error('Release pointer has not propagated');
    } catch (error) {
      if (error.integrityFailure || error.packageLimit) throw error;
      failure=error;
    }
    if (!purges && now()<deadline) {
      if(validPurgeState(purgeState,now()) && now()<purgeState.nextPurgeAt) return deferred('purge-cooldown',purgeState.nextPurgeAt-now());
      purges++;
      await save(900000);
      try {
        const purge=JSON.parse((await fetchBytes(POINTER_URL.replace('://cdn.','://purge.'),fetchImpl,{retryAfterCapMs:86400000})).toString('utf8'));
        const pathState=purge.paths?.[new URL(POINTER_URL).pathname];
        if (pathState?.throttled===true) {
          const seconds=Number(pathState.throttlingReset);
          const retryAfterMs=Number.isFinite(seconds)&&seconds>0?Math.min(seconds*1000,86400000):3600000;
          await save(retryAfterMs);
          return deferred('purge-throttled',retryAfterMs);
        }
        // The checkpoint is a conservative client-side limit, not a provider freshness promise.
        await save(3600000);
        if (purge.status!=='finished') log('CDN pointer purge acknowledged but not finished; checking actual content.');
      } catch (error) {
        if (error.status===429) {
          const retryAfterMs=error.retryAfterMs || 3600000;
          await save(retryAfterMs);
          return deferred('purge-rate-limited',retryAfterMs);
        }
        log('CDN pointer purge unavailable; checking actual content within the existing deadline.');
      }
    }
    const delay=delays[attempt];
    if (!delay || now()+delay>=deadline) break;
    log(`CDN pointer is not current yet; check ${attempts}/9, retry in ${delay/1000}s. No Firebase requests.`);
    await sleep(delay);
  }
  const changed=await authority();
  if(changed)return changed;
  const mirrors=inspectMirrors?await pointerMirrorEvidence(expected,{fetchImpl}):[];
  throw Object.assign(Error('Pointer published, but canonical loader CDN propagation could not be confirmed. Mirrors are diagnostic only. Rerun only Publish CDN release; do not repeat snapshot capture or verification.',{cause:failure}),
    {code:'CDN_PROPAGATION_PENDING',attempts,purges,elapsedMs:now()-started,mirrors});
}

export async function publishRelease({root=process.cwd(), branch=process.env.DEFAULT_BRANCH, repository=process.env.GITHUB_REPOSITORY,
  git=(args, options={}) => execFileSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:20000000, ...options}),
  check=checkReleaseFiles, refresh=refreshReleasePointer, now=new Date(), refreshOnly=false, refreshOptions={}}={}) {
  if (repository !== REPOSITORY || branch !== 'main') throw Error('Only the canonical main branch can publish releases');
  git(['fetch','--no-tags','origin','refs/heads/main']);
  const commit = git(['rev-parse','FETCH_HEAD']).trim();
  if (!sha(commit)) throw Error('Invalid main commit');
  if (git(['rev-parse','HEAD']).trim() !== commit) throw Object.assign(Error('main moved since checkout; this publication job is superseded'),{code:'CDN_SOURCE_SUPERSEDED'});
  // Hash Git blobs, not checkout line endings or uncommitted working files.
  const plan = await releasePlan({root,commit,now,read:async file=>Buffer.from(git(['show',commit + ':' + file],{encoding:null}))});
  const listed = git(['ls-remote','--heads','origin','refs/heads/' + POINTER_BRANCH]).trim();
  let parent = null, previous = null;
  if (listed) {
    git(['fetch','--no-tags','origin','refs/heads/' + POINTER_BRANCH]);
    parent = git(['rev-parse','FETCH_HEAD']).trim();
    if (!sha(parent)) throw Error('Invalid pointer history');
    previous = JSON.parse(git(['show',parent + ':release.json']));
    if (!validReleasePointer(previous)) throw Error('Invalid existing release pointer');
    const previousSource = previous.sourceCommit || previous.commit;
    if (!sha(previousSource)) throw Error('Invalid existing source commit');
    if (previousSource !== commit) {
      // Do not let a slow/older job roll back an already-published descendant.
      git(['fetch','--no-tags','origin',previousSource]);
      git(['merge-base','--is-ancestor',previousSource,commit]);
    }
  }
  let assets;
  const alreadyPublished=previous?.sourceCommit===commit && previous.indexSha256===plan.pointer.indexSha256 && previous.snapshotDirectory===plan.pointer.snapshotDirectory;
  if (alreadyPublished) {
    assets={commit:previous.commit};
  } else assets=await publishAssetTree(plan,git);
  plan.pointer={...plan.pointer,sourceCommit:commit,commit:assets.commit};
  plan.assetPackage=assets;
  // Assets exist remotely before probing; the public pointer still names the old release.
  // An advertised immutable package passed this gate before its pointer was pushed.
  // CDN-only repair can reuse that proof. A new source always runs full validation.
  if (!refreshOnly || !alreadyPublished) await check(plan);
  plan.assetChecks=refreshOnly && alreadyPublished ? 'previously-published-immutable-package' : 'validated';
  // Main may advance while the immutable package is warming. Never advertise obsolete work.
  git(['fetch','--no-tags','origin','refs/heads/main']);
  const latest=git(['rev-parse','FETCH_HEAD']).trim();
  if(!sha(latest))throw Error('Invalid latest main commit');
  if(latest!==commit)throw Object.assign(Error('main advanced during CDN asset validation; this publication job is superseded'),{code:'CDN_SOURCE_SUPERSEDED'});
  if (previous?.commit !== plan.pointer.commit || previous.sourceCommit !== plan.pointer.sourceCommit || previous.indexSha256 !== plan.pointer.indexSha256 || previous.snapshotDirectory !== plan.pointer.snapshotDirectory) {
    const blob = git(['hash-object','-w','--stdin'], {input:JSON.stringify(plan.pointer)+'\n'}).trim();
    const tree = git(['mktree'], {input:'100644 blob ' + blob + '\trelease.json\n'}).trim();
    const env = {...process.env,GIT_AUTHOR_NAME:'github-actions[bot]',GIT_COMMITTER_NAME:'github-actions[bot]',
      GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com'};
    const next = git(['commit-tree',tree,...(parent?['-p',parent]:[])], {input:'Publish CDN release ' + commit + '\n',env}).trim();
    if (!sha(next)) throw Error('Invalid pointer commit');
    // Fast-forward only: races fail safely instead of overwriting another release.
    git(['push','origin',next + ':refs/heads/' + POINTER_BRANCH]);
  }
  const getCurrentPointer=async()=>{
    git(['fetch','--no-tags','origin','refs/heads/'+POINTER_BRANCH]);
    const head=git(['rev-parse','FETCH_HEAD']).trim();
    if(!sha(head))throw Object.assign(Error('Invalid authoritative pointer history'),{integrityFailure:true});
    let pointer;
    try{pointer=JSON.parse(git(['show',head+':release.json']));}
    catch{throw Object.assign(Error('Invalid authoritative pointer JSON'),{integrityFailure:true});}
    return pointer;
  };
  plan.propagation=await refresh(plan.pointer,{...refreshOptions,getCurrentPointer});
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if (args.length>1 || args.some(arg=>arg!=='--refresh-only')) throw Error('Expected optional --refresh-only');
  try {
    const stateFile=process.env.CDN_PURGE_STATE_FILE;
    let purgeState;
    if(stateFile){try{purgeState=JSON.parse(await readFile(stateFile,'utf8'));}catch{}}
    const savePurgeState=async state=>{
      if(!stateFile)return;
      await mkdir(path.dirname(stateFile),{recursive:true});
      await writeFile(stateFile,JSON.stringify(state)+'\n');
    };
    const plan = await publishRelease({refreshOnly:args.includes('--refresh-only'),refreshOptions:{purgeState,savePurgeState}});
    const deferred=plan.propagation?.status==='deferred';
    const superseded=plan.propagation?.status==='superseded';
    if(!deferred&&!superseded&&plan.propagation?.confirmed!==true)throw Error('CDN refresh returned no explicit confirmation');
    const status=deferred?'deferred':superseded?'superseded':'confirmed';
    const summary = `${deferred?'CDN propagation deferred. The published files are intact, but CDN freshness is NOT confirmed.':superseded?'CDN publication superseded by a changed authoritative pointer. This job does NOT confirm that replacement.':'CDN release confirmed at this checking edge only, not globally.'}\nAssets: ${plan.pointer.commit}\nSource: ${plan.pointer.sourceCommit}\nSnapshot: ${plan.pointer.snapshotDirectory}\nAsset archive bytes: ${plan.assetPackage.archiveBytes ?? 'reused'}\nBoot asset gate: ${plan.assetChecks} (${plan.files.length} assets). Pointer purges: ${plan.propagation?.purges ?? 0}. No Firebase requests.\n${deferred?`Reason: ${plan.propagation.reason}. Cooldown: about ${Math.ceil(plan.propagation.retryAfterMs/60000)} minutes. The CDN-only schedule retries automatically; do not repeat snapshot capture or verification.\n`:''}${plan.propagation.mirrors?.length?'Mirror diagnostics (not loader confirmation): '+JSON.stringify(plan.propagation.mirrors)+'\n':''}`;
    if (deferred) console.warn('::warning::Mutable CDN pointer refresh is deferred, NOT confirmed. See reason/cooldown; retry CDN-only, never capture or verification.');
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`cdn_status=${status}\n`);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    if(error.code==='CDN_SOURCE_SUPERSEDED'){
      const summary='CDN publication superseded: '+error.message+'. No pointer rollback or freshness confirmation. Wait for the newer CDN-only job; no capture/verification retry.\n';
      if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'cdn_status=superseded\n');
      if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
      console.warn(summary);
    }else{
    if (error.code==='CDN_PROPAGATION_PENDING' && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      '## CDN Propagation Pending\nThe immutable files and GitHub release pointer were published. Canonical loader CDN freshness was not confirmed, so this job remains failed. Mirror evidence is diagnostic only: '+JSON.stringify(error.mirrors || [])+'. Retry **Publish CDN release** only after cooldown; the CDN-only schedule also retries without Firebase access. Do not rerun verification or snapshot capture for this error.\n');
    throw error;
    }
  }
}
