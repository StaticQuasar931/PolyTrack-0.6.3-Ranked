import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LEGACY_ARCHIVE_REPLAY_EXCEPTIONS as pins, LEGACY_ARCHIVE_REPLAY_PLAN_SHA256,
  isLegacyArchiveReplayException as allowed, annotateLegacyArchiveReplayBoard as annotate,
  legacyArchiveReplayAvailabilityView as view} from './legacy-archive-replay-exceptions.mjs';

// Independent original staged JSON fixtures; no staging, network, or credential access.
const fixture = [
  {
    "sourcePath": "events/d_20260913.json",
    "board": {
      "id": "d_20260913",
      "period": {
        "id": "d_20260913",
        "trackId": "2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264",
        "startsAt": 1789257600000,
        "endsAt": 1789344000000,
        "graceMs": 86400000,
        "maxRp": 100,
        "targetMs": 19180,
        "kind": "daily",
        "entrantLimit": 200,
        "label": "Daily 2026-09-13"
      },
      "updatedAt": 1789432279937,
      "archived": true,
      "racerCount": 1,
      "entries": [
        {
          "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
          "name": "Static",
          "carStyle": "",
          "timeMs": 20594,
          "rp": 93,
          "rank": 1
        }
      ]
    }
  },
  {
    "sourcePath": "events/d_20260914.json",
    "board": {
      "id": "d_20260914",
      "period": {
        "id": "d_20260914",
        "trackId": "089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1",
        "startsAt": 1789344000000,
        "endsAt": 1789430400000,
        "graceMs": 86400000,
        "maxRp": 100,
        "targetMs": 28318,
        "kind": "daily",
        "entrantLimit": 200,
        "label": "Daily 2026-09-14"
      },
      "updatedAt": 1789518572279,
      "archived": true,
      "racerCount": 2,
      "entries": [
        {
          "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
          "name": "wah",
          "carStyle": "AAsIBgAA_wAAAAAAAAAAAA",
          "timeMs": 24417,
          "rp": 100,
          "rank": 1
        },
        {
          "accountId": "db01a6833d3fdcdd9e5c4fedc6108db55a8cab4a6620842106f4269aa9a40abb",
          "name": "Suger_Ray",
          "carStyle": "AAYLAw-LgwAAAAAAAAAAAA",
          "timeMs": 33783,
          "rp": 83,
          "rank": 2
        }
      ]
    }
  },
  {
    "sourcePath": "events/d_20260915.json",
    "board": {
      "id": "d_20260915",
      "period": {
        "id": "d_20260915",
        "trackId": "191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558",
        "startsAt": 1789430400000,
        "endsAt": 1789516800000,
        "graceMs": 86400000,
        "maxRp": 100,
        "targetMs": 33552,
        "kind": "daily",
        "entrantLimit": 200,
        "label": "Daily 2026-09-15"
      },
      "updatedAt": 1789620296510,
      "archived": true,
      "racerCount": 1,
      "entries": [
        {
          "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
          "name": "Static",
          "carStyle": "AAUFBlYxrAYGubEySxsbTg",
          "timeMs": 30977,
          "rp": 100,
          "rank": 1
        }
      ]
    }
  },
  {
    "sourcePath": "events/d_20260917.json",
    "board": {
      "id": "d_20260917",
      "period": {
        "id": "d_20260917",
        "trackId": "39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5",
        "startsAt": 1789603200000,
        "endsAt": 1789689600000,
        "graceMs": 86400000,
        "maxRp": 100,
        "targetMs": 26342,
        "kind": "daily",
        "entrantLimit": 200,
        "label": "Daily 2026-09-17"
      },
      "updatedAt": 1789782119444,
      "archived": true,
      "racerCount": 2,
      "entries": [
        {
          "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
          "name": "Tron",
          "carStyle": "AA8KAwAAAAAA_wAA_wAAAA",
          "timeMs": 28063,
          "rp": 93,
          "rank": 1
        },
        {
          "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
          "name": "wah",
          "carStyle": "AAsIBgAA_wAAAAAAAAAAAA",
          "timeMs": 34824,
          "rp": 75,
          "rank": 2
        }
      ]
    }
  },
  {
    "sourcePath": "events/d_20260918.json",
    "board": {
      "id": "d_20260918",
      "period": {
        "id": "d_20260918",
        "trackId": "fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778",
        "startsAt": 1789689600000,
        "endsAt": 1789776000000,
        "graceMs": 86400000,
        "maxRp": 100,
        "targetMs": 19997,
        "kind": "daily",
        "entrantLimit": 200,
        "label": "Daily 2026-09-18"
      },
      "updatedAt": 1789939579870,
      "archived": true,
      "racerCount": 1,
      "entries": [
        {
          "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
          "name": "Tron",
          "carStyle": "AA8KAwAAAAAA_wAAAAAA_w",
          "timeMs": 20424,
          "rp": 97,
          "rank": 1
        }
      ]
    }
  },
  {
    "sourcePath": "events/w_20260907.json",
    "board": {
      "id": "w_20260907",
      "period": {
        "id": "w_20260907",
        "trackId": "2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264",
        "startsAt": 1788739200000,
        "endsAt": 1789344000000,
        "graceMs": 86400000,
        "maxRp": 500,
        "targetMs": 19180,
        "kind": "weekly",
        "entrantLimit": 200,
        "label": "Weekly 2026-09-07"
      },
      "updatedAt": 1789432252805,
      "archived": true,
      "racerCount": 1,
      "entries": [
        {
          "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
          "name": "Static",
          "carStyle": "",
          "timeMs": 19318,
          "rp": 496,
          "rank": 1
        }
      ]
    }
  },
  {
    "sourcePath": "events/w_20260914.json",
    "board": {
      "id": "w_20260914",
      "period": {
        "id": "w_20260914",
        "trackId": "c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",
        "startsAt": 1789344000000,
        "endsAt": 1789948800000,
        "graceMs": 86400000,
        "maxRp": 500,
        "targetMs": 28696,
        "kind": "weekly",
        "racerCount": 5,
        "entrantLimit": 200,
        "label": "Weekly 2026-09-14"
      },
      "updatedAt": 1790042187804,
      "archived": true,
      "racerCount": 5,
      "entries": [
        {
          "accountId": "732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b",
          "name": "Static",
          "carStyle": "AAUFBlYxrAYGubEySxsbTg",
          "timeMs": 28799,
          "rp": 498,
          "rank": 1,
          "physicsVerified": true,
          "replayIntegrityVerified": true,
          "verifiedAt": 1793358669760,
          "runId": "3b6f0da59480bdb7f553067c499bf78db0b0f0dbb207c2299a89e274747a46ac",
          "replayHash": "be1ee961e3bcf4f02c7567503325d8c72ef6bf2e1df78f8c6e3852bb45768695",
          "runVerified": true,
          "integrityVerified": true,
          "verified": true,
          "verificationStatus": "verified",
          "eventRpEligible": true
        },
        {
          "accountId": "c928700a201b73da19a83b2248bc73f5a8e01c8983b43278fefddfd665ed98c2",
          "name": "Tron",
          "carStyle": "AA8KAwAAAAAA_wAA_wAAAA",
          "timeMs": 28904,
          "rp": 496,
          "rank": 2
        },
        {
          "accountId": "7894752096847f335a29d7067877708e1bb451e75e2a1f8797d046efc76bd852",
          "name": "wah",
          "carStyle": "AAsIBgAA_wAAAAAAAAAAAA",
          "timeMs": 29661,
          "rp": 483,
          "rank": 3
        },
        {
          "accountId": "db01a6833d3fdcdd9e5c4fedc6108db55a8cab4a6620842106f4269aa9a40abb",
          "name": "Suger_Ray",
          "carStyle": "AAYLAw-LgwAAAAAAAAAAAA",
          "timeMs": 29696,
          "rp": 483,
          "rank": 4
        },
        {
          "accountId": "5efb13094a58d882e3b2c05ddad824b638061d87a0ff3bb0dc61af37fb93f287",
          "name": "Soumynona",
          "carStyle": "AA8HAW5XCAonjBMTE25XCA",
          "timeMs": 31105,
          "rp": 461,
          "rank": 5
        }
      ]
    }
  }
];
const fresh = () => structuredClone(fixture);
const rowArgs = record => ({...record, row:record.board.entries[0]});
const canonical = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const hash = v => createHash('sha256').update(canonical(v)).digest('hex');

test('exact 12 frozen tuples pin original rows, full periods and source boards', () => {
  assert.equal(pins.length, 12);
  assert.equal(new Set(pins.map(p => p.sourcePath + '/' + p.accountId)).size, 12);
  assert.match(LEGACY_ARCHIVE_REPLAY_PLAN_SHA256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(pins));
  for (const pin of pins) {
    assert.ok(Object.isFrozen(pin));
    const record = fixture.find(r => r.sourcePath === pin.sourcePath);
    const row = record.board.entries.find(r => r.accountId === pin.accountId);
    assert.equal(hash(row), pin.rowSha256);
    assert.equal(hash(record.board.period), pin.periodSha256);
    assert.equal(hash(record.board), pin.boardSha256);
    assert.ok(allowed({...record, row}));
  }
});

test('annotation preserves every original field and never invents verification', () => {
  const records = fresh(), before = structuredClone(records);
  let count = 0;
  for (const record of records) {
    const result = annotate(record);
    assert.deepEqual(annotate({...record, board:result}), result);
    assert.deepEqual({...result, entries:record.board.entries}, record.board);
    result.entries.forEach((row, i) => {
      const {replayUnavailable, ...original} = row;
      if (replayUnavailable === true) count++;
      assert.deepEqual(original, record.board.entries[i]);
      assert.equal(Object.hasOwn(row, 'verified'), Object.hasOwn(original, 'verified'));
      assert.equal(Object.hasOwn(row, 'verificationStatus'), Object.hasOwn(original, 'verificationStatus'));
    });
  }
  assert.equal(count, 12);
  assert.deepEqual(records, before);
});

const changes = {
  time:r => r.board.entries[0].timeMs++,
  account:r => r.board.entries[0].accountId = 'a'.repeat(64),
  rank:r => r.board.entries[0].rank++,
  name:r => r.board.entries[0].name += 'changed',
  date:r => r.board.entries[0].submittedAt = 123,
  verification:r => r.board.entries[0].verified = true,
  falseVerification:r => r.board.entries[0].verified = false,
  pending:r => r.board.entries[0].pending = true,
  period:r => r.board.period.endsAt++,
  track:r => r.board.period.trackId = 'a'.repeat(64),
  periodId:r => r.board.period.id = 'd_20261106',
  boardId:r => r.board.id = 'd_20261106',
  source:r => r.sourcePath = 'archives/d_20260913.json',
  active:r => r.board.archived = false,
  missingArchiveFlag:r => delete r.board.archived,
  boardMetadata:r => r.board.updatedAt++,
  newRow:r => r.board.entries.push({...r.board.entries[0], accountId:'b'.repeat(64)}),
};
for (const [name, change] of Object.entries(changes)) test(name + ' drift is never excepted', () => {
  const records = fresh(); change(records[0]);
  assert.equal(allowed(rowArgs(records[0])), false);
  assert.throws(() => view(records), /missing or changed target/);
});

test('availability-only filtering counts 12 and preserves original source records', () => {
  const records = fresh(), before = structuredClone(records);
  const result = view(records);
  assert.equal(result.originalBoards, records);
  assert.equal(result.exempted, 12);
  assert.equal(result.replayAvailabilityBoards.reduce((n, b) => n + b.entries.length, 0),
    records.reduce((n, r) => n + r.board.entries.length, 0) - 12);
  assert.deepEqual(records, before);
  const annotated = records.map(r => ({...r, board:annotate(r)}));
  assert.equal(view(annotated).exempted, 12);
  const survivor = result.replayAvailabilityBoards.flatMap(b => b.entries);
  assert.equal(survivor.length, 1);
  assert.equal(survivor[0].replayUnavailable, undefined);
});

test('missing boards, missing rows, duplicate boards and duplicate rows fail closed', () => {
  assert.throws(() => view([]), /missing or changed target/);
  assert.throws(() => view(fresh().slice(1)), /missing or changed target/);
  const missing = fresh(); missing[0].board.entries = [];
  assert.throws(() => view(missing), /missing or changed target/);
  const duplicate = fresh(); duplicate.push(structuredClone(duplicate[0]));
  assert.throws(() => view(duplicate), /duplicate exception target/);
  const rows = fresh(); rows[0].board.entries.push(structuredClone(rows[0].board.entries[0]));
  assert.equal(allowed(rowArgs(rows[0])), false);
  assert.throws(() => view(rows), /missing or changed target/);
});

test('unknown and live boards remain checked, spoofed and pending flags rejected', () => {
  const unknown = {sourcePath:'events/d_20261106.json', board:{id:'d_20261106', archived:false,
    period:{id:'d_20261106',trackId:'a'.repeat(64)},entries:[{accountId:'c'.repeat(64),timeMs:123}]}};
  assert.equal(allowed(rowArgs(unknown)), false);
  assert.deepEqual(annotate(unknown), unknown.board);
  const result = view([...fresh(), unknown]);
  assert.deepEqual(result.replayAvailabilityBoards.at(-1), unknown.board);
  unknown.board.entries[0].replayUnavailable = true;
  assert.throws(() => view([...fresh(), unknown]), /unrecognized annotation/);
  const pending = fresh(); pending[0].board.pendingPlaybacks = [{...pending[0].board.entries[0], replayUnavailable:true}];
  assert.throws(() => annotate(pending[0]), /pending playback/);
  const invalid = fresh(); invalid[0].board.entries[0].replayUnavailable = false;
  assert.equal(allowed(rowArgs(invalid[0])), false);
  assert.throws(() => annotate(invalid[0]), /unrecognized annotation/);
});
