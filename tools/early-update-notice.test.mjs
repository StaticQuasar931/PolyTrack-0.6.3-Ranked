import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installEarlyUpdateNotice} from './early-update-notice.mjs';
import {RELEASE_INFO} from './release-info.mjs';

function fixture() {
  let options, changed, safe=false;
  const ui={children:[],querySelector:()=>null};
  const document={body:{},visibilityState:'visible',activeElement:null,
    getElementById:()=>ui,querySelector:()=>null,querySelectorAll:()=>[],
    defaultView:{getComputedStyle:node=>node.style,
      MutationObserver:class {constructor(callback){changed=callback;}observe(){}}}};
  let resumes=0,checks=0;
  const notice={resume:()=>{resumes++;}};
  const handle=installEarlyUpdateNotice({document,release:RELEASE_INFO,
    installInstalledRevisionNotice:value=>{options=value;return notice;},
    canUpdateFromGameMenu:actual=>{assert.equal(actual,document);checks++;return safe;}});
  return {document,ui,options,handle,notice,changed:()=>changed([{target:ui}]),
    allow:()=>{safe=true;},get resumes(){return resumes;},get checks(){return checks;}};
}
const conflict=(hidden=false)=>({hidden,style:{display:'block',visibility:'visible',opacity:'1'},
  getClientRects:()=>[{width:100,height:100}]});

test('starts during empty boot and real native loading without granting any updater permission',()=>{
  const f=fixture();assert.equal(f.handle,f.notice);assert.equal(f.options.isReady(),true);
  assert.equal(f.options.isInitialLoading(),true);
  f.ui.children=[{matches:selector=>selector.includes('.menu-ui.loading-screen')}];
  assert.equal(f.options.isInitialLoading(),true);assert.equal(f.checks,0);
  assert.equal(f.options.isIdle(),false,'normal menus retain their separate safety guard');
  assert.equal(f.options.revision,RELEASE_INFO.revision);f.changed();assert.equal(f.resumes,1);
});

test('boot exception permanently ends on non-loading UI and never resumes for later track loading',()=>{
  const f=fixture();f.ui.children=[{matches:()=>false}];assert.equal(f.options.isInitialLoading(),false);
  f.ui.children=[{matches:()=>true}];assert.equal(f.options.isInitialLoading(),false);
  f.allow();assert.equal(f.options.isIdle(),false);
  f.document.querySelector=selector=>selector==='.main-buttons-container'?{}:null;
  assert.equal(f.options.isIdle(),true);
});

test('nested gameplay/editor ownership permanently vetoes the initial loading exception',()=>{
  const f=fixture();f.ui.querySelector=()=>({});assert.equal(f.options.isInitialLoading(),false);
  f.ui.querySelector=()=>null;assert.equal(f.options.isInitialLoading(),false);
});

test('hidden pages, visible dialogs and text entry defer early changelog',()=>{
  const f=fixture();f.document.visibilityState='hidden';assert.equal(f.options.isInitialLoading(),false);
  f.document.visibilityState='visible';f.document.activeElement={matches:()=>true};assert.equal(f.options.isInitialLoading(),false);
  f.document.activeElement=null;f.document.querySelectorAll=()=>[conflict()];assert.equal(f.options.isInitialLoading(),false);
});

test('precreated hidden native menus and hidden ancestors are not active dialogs',()=>{
  const f=fixture(),node=conflict(true);f.document.querySelectorAll=()=>[node];assert.equal(f.options.isInitialLoading(),true);
  node.hidden=false;node.parentElement=conflict();node.parentElement.style.display='none';assert.equal(f.options.isInitialLoading(),true);
  node.parentElement=null;node.style.visibility='hidden';assert.equal(f.options.isInitialLoading(),true);
  node.style.visibility='visible';node.style.opacity='0';assert.equal(f.options.isInitialLoading(),true);
  node.style.opacity='1';assert.equal(f.options.isInitialLoading(),false);
});
test('entry is async, versioned, and shares the patch notice module identity', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes(`<script type="module" async src="./tools/early-update-notice.mjs?v=${RELEASE_INFO.revision}"></script>`));
  const module = readFileSync(new URL('./early-update-notice.mjs', import.meta.url), 'utf8');
  assert.match(module, /new URL\(import\.meta\.url\)\.search/);
  assert.doesNotMatch(module, /installSiteUpdates\(|fetch\(|firebase/i);
});

test('CDN readiness graph retains the real early entry, versioned dependencies and release history', async () => {
  const {releasePlan, includeReleaseAsset} = await import('./publish-cdn-release.mjs');
  const {fileURLToPath} = await import('node:url');
  const {createHash} = await import('node:crypto');
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Planning is read-only. A synthetic SHA avoids Git and never publishes anything.
  const plan = await releasePlan({root, commit:'a'.repeat(40)});
  const required = new Set(plan.files.map(file => file.path));
  const entry = 'tools/early-update-notice.mjs';
  const source = readFileSync(new URL('./early-update-notice.mjs', import.meta.url), 'utf8');
  const dependencies = [...source.matchAll(/import\(versioned\('([^']+)'\)\)/g)].map(match =>
    fileURLToPath(new URL(match[1], new URL(entry, new URL('../', import.meta.url)))).slice(root.length).replaceAll('\\', '/'));
  assert.deepEqual(dependencies, ['tools/site-updates.mjs', 'tools/release-info.mjs', 'tools/site-update-menu-state.mjs']);
  for (const file of [entry, ...dependencies, 'tools/release-history.mjs']) {
    const probe = plan.files.find(probe => probe.path === file);
    assert.ok(probe, file + ' must be a CDN readiness probe');
    assert.equal(probe.sha256, createHash('sha256').update(readFileSync(new URL(file, new URL('../', import.meta.url)))).digest('hex'));
    assert.equal(includeReleaseAsset(file, plan.pointer.snapshotDirectory, required), true, file + ' must survive CDN tree filtering');
  }
  for (const file of ['tools/early-update-notice.test.mjs', 'tools/early-update-notice.browser.test.mjs']) {
    assert.equal(required.has(file), false);
    assert.equal(includeReleaseAsset(file, plan.pointer.snapshotDirectory, required), false);
  }
});
