import {createHash} from 'node:crypto';

// Availability policy only. These pins confer no verification or eligibility authority.
// Hashes cover canonical JSON (recursively sorted object keys; array order preserved).
const canonical = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const LEGACY_ARCHIVE_REPLAY_PLAN_SHA256 = '18e8d40f187ea6836f0c87fd0bc1849335e9c149a5d79c2519f83205a20be8b8';
export const LEGACY_ARCHIVE_REPLAY_EXCEPTIONS = Object.freeze([
  {
    "periodId": "d_20260913",
    "trackId": "2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264",
    "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
    "timeMs": 20594,
    "sourcePath": "events/d_20260913.json",
    "rowSha256": "950ed78f41a0c1e8d55194600afab5a7b23e552ce1ca086878d6f22c9b09b415",
    "periodSha256": "aaf500085d5fc46c59bdf6b46144c14b3582f1940cff35c5fae1c1039cf7718f",
    "boardSha256": "675b5d46061ee23e9d03e35ce54b5075a347182953dc1553a9d607e39958951d"
  },
  {
    "periodId": "d_20260914",
    "trackId": "089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1",
    "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
    "timeMs": 24417,
    "sourcePath": "events/d_20260914.json",
    "rowSha256": "c10058f18c856597d6105ebcec1ff4e628e5636fb659fc6f49d2b58e2d6fb23c",
    "periodSha256": "ea196712586e3e031881492938f699127a8b9ba34a766284e3c2d406e9850e08",
    "boardSha256": "86064769a81d1793b68c42737850b4c4701ca39c03f9ac8e9bc289f87e149d19"
  },
  {
    "periodId": "d_20260914",
    "trackId": "089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1",
    "accountId": "db01a6833d3fdcdd9e5c4fedc6108db55a8cab4a6620842106f4269aa9a40abb",
    "timeMs": 33783,
    "sourcePath": "events/d_20260914.json",
    "rowSha256": "4bab0a4f6bd8682a5ad997d9f27b1e37f11a70fcccef8e96cc9a541aa9b319ed",
    "periodSha256": "ea196712586e3e031881492938f699127a8b9ba34a766284e3c2d406e9850e08",
    "boardSha256": "86064769a81d1793b68c42737850b4c4701ca39c03f9ac8e9bc289f87e149d19"
  },
  {
    "periodId": "d_20260915",
    "trackId": "191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558",
    "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
    "timeMs": 30977,
    "sourcePath": "events/d_20260915.json",
    "rowSha256": "dd0d34ae942186721341d7e46a95e2b8d5bcf2437b2345bc2b2c5c270759f0c3",
    "periodSha256": "b6bc689bef1b2ed91531184211d458c2064679acf0e351591851105e59505efe",
    "boardSha256": "b49a4791040b6d540697c5fe1a15f299107d277709fd8e386c66411c95da426a"
  },
  {
    "periodId": "d_20260917",
    "trackId": "39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5",
    "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
    "timeMs": 28063,
    "sourcePath": "events/d_20260917.json",
    "rowSha256": "5f6b1b48cbe66bb64b82bd4b15795b253c4016f36ad9f67fd1257e2a2fad80af",
    "periodSha256": "d58936eab1d19f0a69f15faa00211d753bc449bcf454d73ec0e3632733e08bf5",
    "boardSha256": "e8ce38c94b58935fb8ab60874b8ea90032f76c7705d566fa89845a8736dc9657"
  },
  {
    "periodId": "d_20260917",
    "trackId": "39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5",
    "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
    "timeMs": 34824,
    "sourcePath": "events/d_20260917.json",
    "rowSha256": "27677876a3e690a9d8072cac2129d3a9f39ba5c535848f2bdffe1580e1ef1e21",
    "periodSha256": "d58936eab1d19f0a69f15faa00211d753bc449bcf454d73ec0e3632733e08bf5",
    "boardSha256": "e8ce38c94b58935fb8ab60874b8ea90032f76c7705d566fa89845a8736dc9657"
  },
  {
    "periodId": "d_20260918",
    "trackId": "fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778",
    "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
    "timeMs": 20424,
    "sourcePath": "events/d_20260918.json",
    "rowSha256": "c3147940dfbf74594a559a3f217ad4b17af4f4c4f14e98f44e1312d2d045fca6",
    "periodSha256": "1905c1979a718f1611eebaa0ed6523397e122065a30f62fd37248fa3c2ed5132",
    "boardSha256": "ea0813520d2fc8006c88ebc8ceb2e117c8bb9dd18134670d85366a1e6bb24a5f"
  },
  {
    "periodId": "w_20260907",
    "trackId": "2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264",
    "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
    "timeMs": 19318,
    "sourcePath": "events/w_20260907.json",
    "rowSha256": "1509771eadf65a09f7c9250dd3860cd767c9ea77f2e0896b5ff9a4a565959d2e",
    "periodSha256": "a55c5dd2c07185ae0b94ea329f413d79682f41ace9200f78e15775459a946a69",
    "boardSha256": "71b7c38f741ec014e9f768472a1900efb15219e3832fde934616577a18283d5f"
  },
  {
    "periodId": "w_20260914",
    "trackId": "c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",
    "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
    "timeMs": 28904,
    "sourcePath": "events/w_20260914.json",
    "rowSha256": "0d56b1f956999602218af160c11514eb87904b055004b1c819f5c27785019b47",
    "periodSha256": "e26134623ae510752c3aae33e8878cc641cb984e616143420242931a816852d9",
    "boardSha256": "6f3a8aa79d39f16ced0055c01274abc4de98c0d409191003e94636e3c5641b53"
  },
  {
    "periodId": "w_20260914",
    "trackId": "c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",
    "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
    "timeMs": 29661,
    "sourcePath": "events/w_20260914.json",
    "rowSha256": "67148fd7bee5e228977aa6e1bf1abd091decdec2e22bcc4fa84eaeda6304e3da",
    "periodSha256": "e26134623ae510752c3aae33e8878cc641cb984e616143420242931a816852d9",
    "boardSha256": "6f3a8aa79d39f16ced0055c01274abc4de98c0d409191003e94636e3c5641b53"
  },
  {
    "periodId": "w_20260914",
    "trackId": "c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",
    "accountId": "db01a6833d3fdcdd9e5c4fedc6108db55a8cab4a6620842106f4269aa9a40abb",
    "timeMs": 29696,
    "sourcePath": "events/w_20260914.json",
    "rowSha256": "13c584d32f91feed2989ca9e019ae67bfce2cded753f6f29820f089b19672025",
    "periodSha256": "e26134623ae510752c3aae33e8878cc641cb984e616143420242931a816852d9",
    "boardSha256": "6f3a8aa79d39f16ced0055c01274abc4de98c0d409191003e94636e3c5641b53"
  },
  {
    "periodId": "w_20260914",
    "trackId": "c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",
    "accountId": "5efb13094a58d882e3b2c05ddad824b638061d87a0ff3bb0dc61af37fb93f287",
    "timeMs": 31105,
    "sourcePath": "events/w_20260914.json",
    "rowSha256": "11e323cca6ea5b4351368529707d60121f44dd5d213190f1845b8ea58a7fb766",
    "periodSha256": "e26134623ae510752c3aae33e8878cc641cb984e616143420242931a816852d9",
    "boardSha256": "6f3a8aa79d39f16ced0055c01274abc4de98c0d409191003e94636e3c5641b53"
  }
].map(pin => Object.freeze(pin)));
const fail = message => { throw Error('Legacy archive replay exception: ' + message); };

function originalRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!Object.hasOwn(row, 'replayUnavailable')) return row;
  if (row.replayUnavailable !== true) fail('invalid annotation');
  const {replayUnavailable, ...original} = row;
  return original;
}

// sourcePath must be the caller's actual manifest/file path, never inferred from a row.
// Accepts original or already annotated boards; every other original field is pinned.
export function isLegacyArchiveReplayException({sourcePath, board, row} = {}) {
  try {
    if (board?.archived !== true || !Array.isArray(board.entries) || !row ||
        board.id !== board.period?.id) return false;
    const pin = LEGACY_ARCHIVE_REPLAY_EXCEPTIONS.find(pin =>
      pin.sourcePath === sourcePath && pin.periodId === board.id &&
      pin.trackId === board.period.trackId && pin.accountId === row.accountId && pin.timeMs === row.timeMs);
    if (!pin || digest(board.period) !== pin.periodSha256 || digest(originalRow(row)) !== pin.rowSha256) return false;
    if (board.entries.filter(entry => entry?.accountId === pin.accountId).length !== 1) return false;
    if (!board.entries.some(entry => digest(originalRow(entry)) === pin.rowSha256)) return false;
    return digest({...board, entries:board.entries.map(originalRow)}) === pin.boardSha256;
  } catch { return false; }
}

// Pure publication projection: no input mutation, fabricated replay, verdict, or date.
export function annotateLegacyArchiveReplayBoard({sourcePath, board} = {}) {
  if (!Array.isArray(board?.entries)) fail('board entries required');
  const entries = board.entries.map(row => {
    const allowed = isLegacyArchiveReplayException({sourcePath, board, row});
    if (Object.hasOwn(row, 'replayUnavailable') && !allowed) fail('unrecognized annotation');
    return allowed ? {...row, replayUnavailable:true} : row;
  });
  if ((board.pendingPlaybacks || []).some(row => Object.hasOwn(row, 'replayUnavailable')))
    fail('pending playback cannot be excepted');
  return {...board, entries};
}

// ONLY pass replayAvailabilityBoards to eventReplayCoverage. Never publish/persist
// that filtered view or use it for standings, row-presence, or verification checks.
// Input records are {sourcePath, board}; originalBoards retains those exact records.
export function legacyArchiveReplayAvailabilityView(originalBoards) {
  if (!Array.isArray(originalBoards)) fail('source board records required');
  const seen = new Set();
  const replayAvailabilityBoards = originalBoards.map(record => {
    const {sourcePath, board} = record || {};
    const annotated = annotateLegacyArchiveReplayBoard({sourcePath, board});
    const entries = annotated.entries.filter(row => {
      if (!isLegacyArchiveReplayException({sourcePath, board:annotated, row})) return true;
      const key = sourcePath + '/' + row.accountId;
      if (seen.has(key)) fail('duplicate exception target');
      seen.add(key);
      return false;
    });
    return {...annotated, entries};
  });
  for (const pin of LEGACY_ARCHIVE_REPLAY_EXCEPTIONS)
    if (!seen.has(pin.sourcePath + '/' + pin.accountId)) fail('missing or changed target: ' + pin.periodId + '/' + pin.accountId);
  return {originalBoards, replayAvailabilityBoards, exempted:seen.size};
}
