import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const workflow = fs.readFileSync(new URL('../.github/workflows/sync-kodub-weekly.yml', import.meta.url), 'utf8');
test('alias refresh follows successful capture, is nonblocking and stages only the catalog alongside captured files', () => {
  const capture = workflow.indexOf('run: node tools/sync-kodub-weekly.mjs');
  const alias = workflow.indexOf('name: Refresh canonical archive catalog aliases');
  const commit = workflow.indexOf('name: Commit changed capture');
  assert.ok(capture >= 0 && alias > capture && commit > alias);
  const step = workflow.slice(alias, workflow.indexOf('      - name:', alias));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /node extra-tracks\/build-kodub-archive.mjs --write/);
  assert.match(workflow, /git add events\/kodub\s+if \[ \"\$ARCHIVE_ALIASES_OUTCOME\" = \"success\" \]; then\s+git add -- extra-tracks\/catalog.json/);
  assert.match(workflow, /archive_aliases.outcome == 'failure'/);
  assert.doesNotMatch(workflow, /pin-engine|git add extra-tracks\/track-data/);
});


test('the actual capture publication script stages catalog only on success and still publishes capture after alias failure', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kodub-capture-stage-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const commit = workflow.slice(workflow.indexOf('      - name: Commit changed capture'));
  const match = /run: \|\r?\n([\s\S]*?)(?=^  [a-z_]+:)/m.exec(commit);
  assert.ok(match);
  const script = match[1].replace(/^          /gm, '');
  const mocks = 'git(){ printf "git %s\\n" "$*" >> calls; if [ "$1" = diff ]; then return 1; fi; return 0; }\nnode(){ printf "node %s\\n" "$*" >> calls; return 0; }\n';
  for (const outcome of ['success', 'failure', 'skipped']) {
    fs.writeFileSync(path.join(directory, 'calls'), ''); fs.writeFileSync(path.join(directory, 'output'), '');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', mocks + script], {
      cwd: directory, encoding: 'utf8', env: {...process.env, ARCHIVE_ALIASES_OUTCOME: outcome, GITHUB_OUTPUT: 'output', DEFAULT_BRANCH: 'main'}
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(path.join(directory, 'calls'), 'utf8');
    assert.match(calls, /git add events\/kodub/);
    assert.equal(calls.includes('git add -- extra-tracks/catalog.json'), outcome === 'success');
    assert.match(calls, /git commit -m Sync Kodub weekly fallback/);
    assert.match(calls, /node tools\/push-public-capture.mjs/);
    assert.equal(fs.readFileSync(path.join(directory, 'output'), 'utf8'), 'changed=true\n');
  }
});
