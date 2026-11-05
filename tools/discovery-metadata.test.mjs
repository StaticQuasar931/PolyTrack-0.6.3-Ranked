import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const html=read('index.html'),about=read('about.html');
const canonical='https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/';
function meta(name){const tag=html.match(new RegExp('<meta (?:name|property)="'+name+'" content="([^"]+)"'));assert.ok(tag,name);return tag[1];}
test('search and social descriptions identify the same community game',()=>{
  assert.match(html,/<title>PolyTrack 0\.6\.3 Ranked/);
  assert.equal(meta('description'),meta('og:description'));assert.equal(meta('description'),meta('twitter:description'));
  assert.equal(meta('og:url'),canonical);assert.match(html,new RegExp('<link rel="canonical" href="'+canonical+'"'));
  assert.match(meta('description'),/Kodub/);assert.match(meta('description'),/community mod/);
});
test('structured metadata is valid, credited and does not invent reviews',()=>{
  const body=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);assert.ok(body);
  const value=JSON.parse(body[1]);assert.equal(value['@type'],'VideoGame');assert.equal(value.url,canonical);
  assert.equal(value.description,meta('description'));assert.equal(value.creator.name,'Kodub');
  assert.equal(value.isBasedOn,'https://www.kodub.com/apps/polytrack');assert.equal(value.isAccessibleForFree,true);
  assert.equal(value.aggregateRating,undefined);assert.equal(value.review,undefined);
});
test('crawlable about content credits the official game and visible features',()=>{
  assert.match(about,/<h1>PolyTrack Ranked<\/h1>/);assert.match(about,/https:\/\/www\.kodub\.com\/apps\/polytrack/);
  for(const term of ['Extra Tracks','Ghosts','route planning','community mod','not Kodub'])assert.ok(about.includes(term),term);
  assert.match(html,/<noscript>[\s\S]*href="\.\/about\.html"/);
  for(const page of ['index.html','about.html'])assert.ok(read('sitemap.xml').includes(canonical+(page==='index.html'?'':page)));
});
test('social preview dimensions and local manifest assets exist',()=>{
  const imageUrl=new URL(meta('og:image'));assert.equal(imageUrl.origin,new URL(canonical).origin);
  const bytes=fs.readFileSync(new URL('../images/cover1920x1080.png',import.meta.url));
  assert.equal(bytes.readUInt32BE(16),Number(meta('og:image:width')));assert.equal(bytes.readUInt32BE(20),Number(meta('og:image:height')));
  const manifest=JSON.parse(read('manifest.json'));for(const icon of manifest.icons)assert.ok(fs.existsSync(new URL('../'+icon.src,import.meta.url)));
});
test('default contributor tests use built-in offline contracts, not the absent upstream source runner',()=>{
  const pkg=JSON.parse(read('package.json'));assert.match(pkg.scripts.test,/node --test/);
  assert.match(pkg.scripts.test,/discovery-metadata\.test\.mjs/);assert.doesNotMatch(pkg.scripts.test,/jest|update-public-snapshot|run\.mjs/);
});
