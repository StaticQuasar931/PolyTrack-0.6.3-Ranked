import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gameSource = readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const analyticsBlock = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .find(source => source.includes('window.dataLayer = window.dataLayer || [];'));
assert.ok(analyticsBlock, 'inline analytics bootstrap exists');

function runAnalytics(pageHref, referrer) {
  const queue = [];
  const location = new URL(pageHref);
  const context = { window: { dataLayer: queue }, dataLayer: queue, location, document: { referrer, createElement: () => ({}), head: { appendChild() {} } }, URL, Date };
  vm.runInNewContext(analyticsBlock, context, { filename: 'index.html analytics bootstrap' });
  const config = queue.map(args => Array.from(args)).find(([command]) => command === 'config');
  assert.ok(config, 'GA config command exists');
  return { config: config[2], location };
}

test('pageview config explicitly sends only origin and pathname for both URL fields', () => {
  const { config, location } = runAnalytics(
    'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/?userToken=fixture-secret&track=7#private-fragment',
    'https://source.example/entry?campaign=private#source-fragment'
  );
  assert.equal(config.page_location, 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/');
  assert.equal(config.page_referrer, 'https://source.example/entry');
  assert.deepEqual(Object.keys(config).sort(), ['cookie_domain', 'page_location', 'page_referrer']);
  assert.equal(location.search, '?userToken=fixture-secret&track=7');
  assert.equal(location.hash, '#private-fragment');
  assert.equal(JSON.stringify(config).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(config).includes('campaign=private'), false);
  assert.equal(JSON.stringify(config).includes('private-fragment'), false);
});

test('empty or non-HTTP referrers do not fall back to an unsanitized browser URL', () => {
  const empty = runAnalytics('https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/?userToken=fixture-secret', '');
  assert.equal(empty.config.page_location, 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/');
  assert.equal(empty.config.page_referrer, '');
  const unsafe = runAnalytics('https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/?userToken=fixture-secret', 'javascript:alert(1)');
  assert.equal(unsafe.config.page_referrer, '');
});

test('analytics configuration does not consume or rewrite the game URL token', () => {
  const { location } = runAnalytics('https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/?userToken=game-token-fixture', '');
  assert.equal(location.searchParams.get('userToken'), 'game-token-fixture');
  assert.match(gameSource, /searchParams\.get\(['"]userToken['"]\)/);
  assert.doesNotMatch(analyticsBlock, /history\.replaceState|searchParams\.delete/);
});

for (const href of ['https://poly-track-0-6-3-rankeddd.vercel.app/', 'https://staticquasar931.github.io/another-game/', 'http://localhost:8080/']) {
  test('analytics stays off outside owned game: '+href, () => {
    const queue=[], scripts=[];
    const context={window:{dataLayer:queue},dataLayer:queue,location:new URL(href),document:{referrer:'',createElement:()=>({}),head:{appendChild:node=>scripts.push(node)}},URL,Date};
    vm.runInNewContext(analyticsBlock,context);
    assert.equal(queue.length,0);assert.equal(scripts.length,0);
  });
}

test('only the four explicitly owned Google script origins enable sanitized analytics',()=>{
  const prefix='n-ubvj6uzey5gp44qz2gmscy7oux2l5p53a4jiw2q-';
  for(let i=0;i<4;i++){
    const {config}=runAnalytics('https://'+prefix+i+'lu-script.googleusercontent.com/userCodeAppPanel?userToken=private#secret','');
    assert.equal(config.page_location,'https://'+prefix+i+'lu-script.googleusercontent.com/userCodeAppPanel');
    assert.ok(!JSON.stringify(config).includes('private'));
  }
  for(const host of [prefix+'4lu-script.googleusercontent.com',prefix+'0lu-script.googleusercontent.com.evil.test','other-script.googleusercontent.com']){
    const queue=[];const context={window:{dataLayer:queue},dataLayer:queue,location:new URL('https://'+host+'/'),document:{referrer:'',createElement:()=>({}),head:{appendChild(){assert.fail('unowned script');}}},URL,Date};
    vm.runInNewContext(analyticsBlock,context);assert.equal(queue.length,0);assert.equal(context.window.__polytrackAnalyticsAllowed,false);
  }
});
