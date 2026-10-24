import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, appendFile, mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'StaticQuasar931/PolyTrack-0.6.3-Ranked';
export const POINTER_BRANCH = 'cdn-release';
export const ASSET_BRANCH = 'cdn-assets';
export const POINTER_URL = `https://cdn.jsdelivr.net/gh/${REPOSITORY}@${POINTER_BRANCH}/release.json`;
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
  for (const file of ['tools/public-snapshot-client.mjs','tools/snapshot-metadata-recovery.mjs','events/client.mjs']) probes.add(file);
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

async function fetchBytes(url, fetchImpl) {
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
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay,120000);
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

export async function refreshReleasePointer(expected, {fetchImpl=fetch, sleep=pause}={}) {
  let failure;
  // A purge acknowledgment is not proof of propagation: read and compare the pointer.
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const purge = JSON.parse((await fetchBytes(POINTER_URL.replace('://cdn.', '://purge.'), fetchImpl)).toString('utf8'));
      if (purge.status !== 'finished') throw Error('Pointer purge not finished');
      await sleep(3000);
      const actual = JSON.parse((await fetchBytes(POINTER_URL, fetchImpl)).toString('utf8'));
      if (actual.repository !== REPOSITORY || actual.commit !== expected.commit || actual.indexSha256 !== expected.indexSha256 || actual.snapshotDirectory !== expected.snapshotDirectory || expected.sourceCommit && actual.sourceCommit !== expected.sourceCommit) throw Error('Release pointer has not propagated');
      return;
    } catch (error) { failure=error; if (attempt<2) await sleep(20000); }
  }
  throw Error('Pointer published, but CDN propagation could not be confirmed; rerun Publish CDN release', {cause:failure});
}

export async function publishRelease({root=process.cwd(), branch=process.env.DEFAULT_BRANCH, repository=process.env.GITHUB_REPOSITORY,
  git=(args, options={}) => execFileSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:20000000, ...options}),
  check=checkReleaseFiles, refresh=refreshReleasePointer, now=new Date()}={}) {
  if (repository !== REPOSITORY || branch !== 'main') throw Error('Only the canonical main branch can publish releases');
  git(['fetch','--no-tags','origin','refs/heads/main']);
  const commit = git(['rev-parse','FETCH_HEAD']).trim();
  if (!sha(commit) || git(['rev-parse','HEAD']).trim() !== commit) throw Error('main moved since checkout; rerun publication');
  // Hash Git blobs, not checkout line endings or uncommitted working files.
  const plan = await releasePlan({root,commit,now,read:async file=>Buffer.from(git(['show',commit + ':' + file],{encoding:null}))});
  const listed = git(['ls-remote','--heads','origin','refs/heads/' + POINTER_BRANCH]).trim();
  let parent = null, previous = null;
  if (listed) {
    git(['fetch','--no-tags','origin','refs/heads/' + POINTER_BRANCH]);
    parent = git(['rev-parse','FETCH_HEAD']).trim();
    if (!sha(parent)) throw Error('Invalid pointer history');
    previous = JSON.parse(git(['show',parent + ':release.json']));
    if (previous.repository !== REPOSITORY || !sha(previous.commit)) throw Error('Invalid existing release pointer');
    const previousSource = previous.sourceCommit || previous.commit;
    if (!sha(previousSource)) throw Error('Invalid existing source commit');
    if (previousSource !== commit) {
      // Do not let a slow/older job roll back an already-published descendant.
      git(['fetch','--no-tags','origin',previousSource]);
      git(['merge-base','--is-ancestor',previousSource,commit]);
    }
  }
  let assets;
  if (previous?.sourceCommit === commit && previous.indexSha256 === plan.pointer.indexSha256 && previous.snapshotDirectory === plan.pointer.snapshotDirectory) {
    assets={commit:previous.commit};
  } else assets=await publishAssetTree(plan,git);
  plan.pointer={...plan.pointer,sourceCommit:commit,commit:assets.commit};
  plan.assetPackage=assets;
  // Assets exist remotely before probing; the public pointer still names the old release.
  await check(plan);
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
  await refresh(plan.pointer);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = await publishRelease();
  const summary = `CDN release confirmed: ${plan.pointer.commit}\nSource: ${plan.pointer.sourceCommit}\nSnapshot: ${plan.pointer.snapshotDirectory}\nAsset archive bytes: ${plan.assetPackage.archiveBytes ?? 'reused'}\nValidated ${plan.files.length} immutable boot assets. Purged one mutable release pointer. No Firebase requests.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
