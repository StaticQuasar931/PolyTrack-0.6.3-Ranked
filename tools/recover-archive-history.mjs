import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Offline recovery only. The explicit output must be separate from the source.
export async function recoverArchiveHistory(repo, output) {
  repo = path.resolve(repo); output = path.resolve(output);
  if (output === repo || output.startsWith(repo + path.sep)) throw Error('Output must be outside the read-only repo.');
  const read = async relative => JSON.parse(await fs.readFile(path.join(repo, relative), 'utf8'));
  const git = args => execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\', '/')}`, '-C', repo, ...args], {encoding:'utf8', maxBuffer:32*1024*1024});
  const selections = new Map(), boards = new Map(), archives = new Map();
  const catalog = await read('events/public-catalog.json');
  const consider = (value, recoverOnly = false) => {
    if (!/^kodub_\d+$/.test(value?.id || '') || value.kind !== 'kodub') return;
    if (!Number.isSafeInteger(value.endsAt) || value.id !== `kodub_${value.endsAt}` || value.startsAt !== value.endsAt - 604800000 || !/^[a-f0-9]{64}$/.test(value.trackId || '')) return;
    const prior = archives.get(value.id);
    if (prior && prior.trackId !== value.trackId) throw Error(`Conflicting saved track: ${value.id}`);
    if (prior && recoverOnly) return;
    archives.set(value.id, {...prior, ...value});
  };
  for (const period of [...catalog.periods, ...catalog.archives]) consider(period);
  const directory = path.join(repo, 'local-reports/snapshot-history');
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.snapshot.gz'));
  if (files.length > 200) throw Error('Too many saved generations.');
  let decoded = 0;
  for (const name of files) {
    const pack = JSON.parse(gunzipSync(await fs.readFile(path.join(directory, name)), {maxOutputLength:256*1024*1024}));
    const keys = Object.keys(pack.index?.files || pack.files);
    for (const key of keys.filter(key => /^(events\/kodub_\d+|archives\/\d{4}-\d{2})\.json$/.test(key))) {
      const ref = pack.index?.files[key];
      const encoded = pack.files[ref?.path || key];
      if (typeof encoded !== 'string') continue;
      let bytes = Buffer.from(encoded, 'base64');
      // Generation packs store published gzip-XOR blobs; legacy files are JSON.
      if (pack.index) bytes = bytes.map(byte => byte ^ 0xa7);
      const value = JSON.parse(pack.index ? gunzipSync(bytes, {maxOutputLength:16*1024*1024}) : bytes.toString('utf8'));
      decoded++;
      for (const period of value.periods || []) consider(period, true);
      if (value.period) {
        consider(value.period, true);
        if (value.archived === true) boards.set(value.period.id, true);
      }
    }
  }
  const revisions = git(['log', '--format=%H', '--', 'events/kodub/current.json']).trim().split(/\s+/).filter(Boolean);
  if (revisions.length > 520) throw Error('Too many weekly captures.');
  for (const revision of revisions.reverse()) {
    const current = JSON.parse(git(['show', `${revision}:events/kodub/current.json`])).current;
    const endsAt = Date.parse(current?.endTime);
    if (!Number.isSafeInteger(endsAt) || !/^[a-f0-9]{64}$/.test(current?.trackId || '')) continue;
    const id = `kodub_${endsAt}`;
    if (selections.has(id) && selections.get(id).trackId !== current.trackId) throw Error('Conflicting weekly selection.');
    selections.set(id, {...current});
  }
  const trusted = await read('events/kodub/trusted-tracks.json');
  const missingCodes = [];
  for (const [id, selection] of selections) {
    const endsAt = Date.parse(selection.endTime);
    if (!catalog.periods.some(period => period.id === id)) {
      const prior = archives.get(id);
      consider({...prior, id, kind:'kodub', trackId:selection.trackId, trackName:selection.name,
        author:selection.author, environment:selection.environment, lastModified:selection.lastModified,
        startsAt:endsAt-604800000, endsAt, archived:true,
        thumbnailUrl:`events/kodub/${selection.thumbnailUrl}`,
        ...(!prior ? {historyOnly:true, maxRp:0} : {})});
    }
    const match = /^assets\/([a-f0-9]{64})\.track$/.exec(selection.trackUrl || '');
    if (!match) { missingCodes.push(id); continue; }
    let bytes;
    try { bytes = await fs.readFile(path.join(repo, 'events/kodub', selection.trackUrl)); }
    catch { missingCodes.push(id); continue; }
    if (bytes.length > 262144 || createHash('sha256').update(bytes).digest('hex') !== match[1] || !/^PolyTrack[0-9A-Za-z+/_=-]+$/.test(bytes.toString('utf8'))) throw Error('Invalid saved track code.');
    if (!trusted.some(row => row.trackId === selection.trackId && row.codeHash === match[1])) trusted.push({trackId:selection.trackId, codeHash:match[1], assetPath:selection.trackUrl});
  }
  const ended = [...archives.values()].filter(period => !catalog.periods.some(live => live.id === period.id));
  const merged = new Map(catalog.archives.map(period => [period.id, period]));
  for (const period of ended) merged.set(period.id, period);
  const write = async (relative, value) => {
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), {recursive:true});
    await fs.writeFile(target, JSON.stringify(value, null, 2)+'\n');
  };
  await write('events/public-catalog.json', {...catalog, archives:[...merged.values()].sort((a,b) => b.endsAt-a.endsAt || a.id.localeCompare(b.id))});
  await write('events/kodub/trusted-tracks.json', trusted);
  await write('events/kodub/selections.json', [...selections.values()]);
  const report = {head:git(['rev-parse','HEAD']).trim(), snapshotPacks:files.length, decodedArchiveFiles:decoded,
    gitWeeklyCaptures:revisions.length, closedKodubPeriods:ended.length, finalKodubBoards:[...boards.keys()].sort(),
    selectionOnly:ended.filter(period => period.historyOnly).map(period => period.id), missingCodes,
    networkRequests:0, limitations:'No locally captured selections before 2026-09-13. Selection-only weeks have no recovered final standings, Event RP, or archived event replays.'};
  await write('tools/archive-recovery-evidence.json', report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Usage: node recover-archive-history.mjs READ_ONLY_REPO STAGING_OUTPUT');
  console.log(JSON.stringify(await recoverArchiveHistory(process.argv[2], process.argv[3]), null, 2));
}
