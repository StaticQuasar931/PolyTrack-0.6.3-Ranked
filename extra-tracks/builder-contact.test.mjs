import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILDER_DISCORD_URL, BUILDER_EMAIL, builderContactDraft, builderContactMailto, mountBuilderContact} from './builder-contact.mjs';
class Node {
  constructor(document, tag) {this.document=document;this.tagName=tag.toUpperCase();this.children=[];this.attributes=new Map();this.listeners=new Map();this.hidden=false;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];} get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  setAttribute(name,value){this.attributes.set(name,value);}getAttribute(name){return this.attributes.get(name);}
  addEventListener(name,handler){this.listeners.set(name,handler);}async click(){await this.listeners.get('click')?.();}
  focus(){this.document.activeElement=this;}
}
function fixture(options={}){const document={createElement:tag=>new Node(document,tag)};const root=document.createElement('div');const api=mountBuilderContact({document,root,...options});return {document,root,api};}
const walk=node=>[node,...node.children.flatMap(walk)];
const cls=(root,name)=>walk(root).find(n=>n.className===name);

test('confirmed public contacts and backup mailto contain only a short blank checklist',()=>{
  assert.equal(BUILDER_DISCORD_URL,'https://discord.gg/jW2az4AQUH');assert.equal(BUILDER_EMAIL,'StaticQuasar931Games@gmail.com');
  const url=new URL(builderContactMailto());assert.equal(url.protocol,'mailto:');assert.equal(url.pathname,BUILDER_EMAIL);
  assert.equal(url.searchParams.get('body'),builderContactDraft());assert.equal(url.searchParams.has('cc'),false);assert.equal(url.searchParams.has('bcc'),false);
  assert.ok(builderContactDraft().length<1000);assert.match(builderContactDraft(),/contributor roles/);assert.match(builderContactDraft(),/port or adaptation/);
});
test('mounting contact makes no download or back action and exposes safe click-only links',()=>{
  let actions=0;const {root,api}=fixture({onDownload:()=>actions++,onBack:()=>actions++});assert.equal(actions,0);
  const discord=cls(root,'sq-builder-discord');assert.equal(discord.href,BUILDER_DISCORD_URL);assert.equal(discord.rel,'noopener noreferrer');assert.equal(discord.referrerPolicy,'no-referrer');
  assert.equal(cls(root,'sq-builder-email').href,builderContactMailto());assert.equal(cls(root,'sq-builder-review-help').open,undefined);
  assert.equal(cls(root,'sq-builder-review-note').textContent,'Credits and featuring are reviewed. Ports must credit original creators.');api.destroy();
});
test('checklist download is user initiated, single-flight and reports nothing sent',async()=>{
  let release,calls=0;const {root,api}=fixture({onDownload:draft=>{assert.equal(draft,builderContactDraft());calls++;return new Promise(resolve=>{release=resolve;});}});
  const button=cls(root,'sq-builder-download');const pending=button.click();await button.click();assert.equal(calls,1);assert.equal(button.disabled,true);
  release();await pending;assert.equal(button.disabled,false);assert.match(cls(root,'sq-builder-contact-status').textContent,/Nothing was sent/);api.destroy();
});
test('default download uses only a local blob and revokes it after the user click',async()=>{
  const {document,root,api}=fixture();let blobs=0,clicks=0,revokes=0;
  document.defaultView={Blob:class{constructor(parts){assert.equal(parts.join(''),builderContactDraft());blobs++;}},URL:{createObjectURL(){return 'blob:local-checklist';},revokeObjectURL(url){assert.equal(url,'blob:local-checklist');revokes++;}},fetch(){throw Error('No network allowed');}};
  const create=document.createElement;document.createElement=tag=>{const node=create(tag);if(tag==='a')node.click=()=>{clicks++;assert.equal(node.href,'blob:local-checklist');};return node;};
  assert.equal(blobs,0);await cls(root,'sq-builder-download').click();assert.deepEqual([blobs,clicks,revokes],[1,1,1]);api.destroy();
});
test('back is explicit and a late download cannot mutate a destroyed view',async()=>{
  let backs=0,release;const {root,api}=fixture({onBack:()=>backs++,onDownload:()=>new Promise(resolve=>{release=resolve;})});
  await cls(root,'sq-builder-back').click();assert.equal(backs,1);const status=cls(root,'sq-builder-contact-status');const pending=cls(root,'sq-builder-download').click();api.destroy();release();await pending;
  assert.equal(status.hidden,true);assert.equal(root.children.length,0);
});
