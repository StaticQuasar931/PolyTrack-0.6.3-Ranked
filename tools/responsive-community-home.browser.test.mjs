import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const bundle = await read('main.bundle.js');
const native = [...bundle.matchAll(/push\(\[e\.id,("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'),/g)]
  .map(match => match[1])
  .filter(css => css.includes('.menu-ui > .main-buttons-container {') || css.includes('.track.track-of-the-week {'))
  .map(css => JSON.parse(css.startsWith('"') ? css : '"' + css.slice(1, -1).replaceAll('\\\'','\'').replace(/(?<!\\)"/g, '\\"') + '"'));
assert.equal(native.length, 2, 'native lobby and track-selection styles');
const patch = await read('polytrack_062_patch.js');
const injected = [...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)]
  .map(match => JSON.parse(match[1]));
const styles = await Promise.all(['events/events.css','home-ui.css','responsive-ui.css','practice-responsive.css'].map(read));
const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="150"%3E%3Crect width="300" height="150" fill="teal"/%3E%3C/svg%3E'.replaceAll('"', '%22');
const art = (cls = '') => '<img class="' + cls + '" src="' + image + '">';
const support = kind => '<button class="button sq-event-card" data-event-kind="' + kind + '"><span class="sq-event-thumb">' + art() + '</span><span class="sq-event-record"><time>00:24.531</time><span class="sq-record-placement">#12</span></span><span><small>' + kind + ' event</small><strong>Winter 5</strong><span class="sq-event-card-details"><small>Up to 500 Event RP</small><small>Resets Sun 17:00</small></span></span></button>';

test('bounded home and Community Events layout through Chromebook and phone resizes', {timeout: 120000}, async t => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage({hasTouch: true, isMobile: true, serviceWorkers: 'block'});
    await page.route('**/*', route => route.abort());
    const tiles = ['Garage','Editor','Settings','Multiplayer','Play','Ranked'].map(label =>
      '<button class="button button-image">' + art() + '<p>' + label + '</p></button>').join('');
    const versions = ['0.6.3','0.6.2','0.6.0','0.5.1','0.4.2','0.3.0'].map(label =>
      '<button class="button">' + label + '</button>').join('');
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
      <style>body{margin:0}#ui{position:fixed;inset:0}.hidden,[hidden]{display:none!important}.button{font:inherit}
      ${styles.join('\n')} ${native.join('\n')} ${injected.join('\n')}</style>
      <div id="ui"><div class="menu-ui"><div class="logo"></div><div class="main-buttons-container">${tiles}</div>
      <div class="info"><a class="staticFunPill">More games</a><a>Credits</a><a>Terms &amp; Privacy</a><div class="social-links"><a>Socials</a></div></div>
      <div class="track-selection-ui hidden"><div class="bar"><button class="button">Back</button><div class="search-bar-container"><input aria-label="Search"></div></div>
      <div class="image-button-container"><button class="button">Official</button><button class="button">Community</button><button class="button">Custom</button></div>
      <div class="tracks-container open"><div class="wrapper">
      <div class="image-button-container community-track-versions">${versions}<button hidden class="button">Hidden version</button></div>
      <section class="sq-featured-events sq-event-track-group"><h2 class="sq-featured-heading">Events</h2><button class="button sq-events-entry">Event standings</button>
      <div class="track track-of-the-week sq-kodub-weekly"><button class="button">${art('cover')}<div class="track-of-the-week-info">
      <div class="title">Wintertide Circuit</div><div class="author">By Community Creator</div><div class="time-remaining">6d 23h 59m 59s</div><div class="date-range">Nov 15 - Nov 22 12:00 PM</div>
      <div class="personal-best"><div>00:24.531</div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div>
      <div class="track sq-permanent-track"><button class="button">${art('thumbnail')}<div class="track-title"><p>Rolling Hills</p></div>
      <div class="record">00:24.531</div><small class="sq-permanent-note">Normal RP + up to 10,101 Event RP<br>Permanent event</small></button></div>
      <div class="sq-event-track-buttons">${support('weekly')}${support('daily')}</div></section>
      <div class="community-track-group">${Array.from({length: 20}, () => '<div class="track"><button class="button">' + art('thumbnail') + '<div class="track-title"><p>Community track</p></div></button></div>').join('')}</div>
      </div></div></div></div></div>`);
    const cdp = await page.context().newCDPSession(page);
    for (const [width,height] of [[1366,768],[1280,800],[390,844],[844,390],[320,568],[568,320],[1920,1080]]) {
      const label = width + 'x' + height;
      await page.setViewportSize({width,height});
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {insets: {left: height < 500 ? 32 : 0, right: height < 500 ? 32 : 0, top: 0, bottom: 0}});
      await page.evaluate(({width,height}) => {
        const scale = Math.min(1, width / 1150, height / 800);
        const s = document.documentElement.style;
        s.setProperty('--sq-menu-fit-scale', scale);
        s.setProperty('--ui-scale-factor', scale);
        document.querySelector('.main-buttons-container').classList.remove('hidden');
        document.querySelector('.menu-ui > .info').classList.remove('hidden');
        document.querySelector('.track-selection-ui').classList.add('hidden');
      }, {width,height});
      const home = await page.locator('.main-buttons-container > button').evaluateAll(nodes => {
        const footer = document.querySelector('.menu-ui > .info').getBoundingClientRect();
        return nodes.map(node => {
          const r = node.getBoundingClientRect();
          return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, height:r.height, footer:footer.top};
        });
      });
      assert.equal(home.length, 6, label);
      for (const tile of home) {
        const inset = height < 500 ? 32 : 0;
        assert.ok(tile.left >= inset - 1 && tile.right <= width - inset + 1 && tile.top >= 0 && tile.bottom <= tile.footer + 1 && tile.height >= 44,
          label + ' home tile bounds: ' + JSON.stringify(tile));
      }
      if (width === 1366) assert.ok(home[0].height < 175, label + ' compact laptop tiles');
      if (width === 1920) assert.equal(home[0].height, 200, label + ' normal desktop tiles');
      await page.evaluate(() => {
        document.querySelector('.main-buttons-container').classList.add('hidden');
        document.querySelector('.menu-ui > .info').classList.add('hidden');
        document.querySelector('.track-selection-ui').classList.remove('hidden');
      });
      assert.equal(await page.locator('.main-buttons-container').isVisible(), false);
      const events = await page.evaluate(() => {
        const select = selector => document.querySelector(selector);
        const rect = element => element.getBoundingClientRect().toJSON();
        const feature = select('.sq-featured-events');
        const kodub = feature.querySelector('.sq-kodub-weekly');
        const scroll = select('.tracks-container.open');
        const cards = [...feature.querySelectorAll(':scope > .track > button, .sq-event-card')];
        const details = kodub.querySelector('.track-of-the-week-info');
        const tabs = [...document.querySelectorAll('.community-track-versions > button:not([hidden])')];
        scroll.scrollTop = scroll.scrollHeight;
        const canScroll = scroll.scrollTop > 0;
        scroll.scrollTop = 0;
        return {
          cardBoxes: cards.map(rect), feature: rect(feature), details: rect(details),
          padding: Number.parseFloat(getComputedStyle(details).paddingInlineStart),
          text: [...details.children].map(rect), cover: rect(kodub.querySelector('.cover')),
          overflow: [feature,kodub,details,scroll].map(node => node.scrollWidth - node.clientWidth),
          tabs: tabs.map(rect), hiddenVersion: select('.community-track-versions > [hidden]').getClientRects().length,
          canScroll, scrollHeight: rect(scroll).height,
        };
      });
      assert.equal(events.cardBoxes.length, 4, label);
      assert.ok(events.overflow.every(n => n <= 1), label + ' horizontal overflow: ' + events.overflow);
      assert.ok(events.canScroll && events.scrollHeight > 100, label + ' usable track scroller');
      assert.equal(events.hiddenVersion, 0, label + ' hidden versions stay hidden');
      for (const box of events.cardBoxes) assert.ok(box.left >= -1 && box.right <= width + 1, label + ' card within viewport');
      for (const box of events.text) assert.ok(box.top >= events.details.top - 1 && box.bottom <= events.details.bottom + 1, label + ' event text within details');
      if (width !== 1920) assert.ok(events.tabs.every(tab => tab.height >= 43.9 && tab.height <= 60), label + ' compact, tappable version controls');
      if (width === 1280) assert.equal(events.padding, 24, label + ' preserves desktop details padding');
      if (width === 1366) assert.ok(events.cardBoxes.every(box => Math.abs(box.top - events.cardBoxes[0].top) <= 1), label + ' single event row');
      if (height < 500) assert.ok(events.cover.right <= events.details.left + 1, label + ' side-by-side landscape feature');
      if (height > width) {
        assert.ok(events.cover.bottom <= events.details.top + 1, label + ' stacked portrait feature');
        assert.ok(events.cardBoxes.slice(1).every(box => box.height <= 221), label + ' compact supporting cards');
      }
      if (width === 390) assert.equal(events.cardBoxes[1].top, events.cardBoxes[2].top, label + ' two supporting cards share a row');
      t.diagnostic(label + ': tile height ' + Math.round(home[0].height) + 'px, credit gap ' +
        Math.round(Math.min(...home.map(tile => tile.footer - tile.bottom))) + 'px, scroller ' +
        Math.round(events.scrollHeight) + 'px, event heights ' + events.cardBoxes.map(box => Math.round(box.height)).join('/') + 'px');
    }
  } finally {
    await browser.close();
  }
});
