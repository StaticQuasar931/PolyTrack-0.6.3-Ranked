import assert from 'node:assert/strict';
import test from 'node:test';
import { moderatePublicName, safePublicName } from '../src/public-name-policy.js';

const mustBlock = [
  // Abusive historical/political figures and extremist references.
  'Epstein',
  'Jeffrey Epstein',
  'EpsteinRacer',
  'releaseepsteinfiles',
  'Epstein research archive',
  'HitlerRacer',
  'Adolf-Hitler',
  // Representative political figure names. Expand only against an agreed list.
  'Trump',
  'Biden',
  'Obama',
  'Political Science Racer',
  // Invite links and self-promotion, including common separator variants.
  'discord.gg/abc123',
  'discord.com/invite/abc123',
  'https://discord.gg/abc123',
  'join my discord server',
  'DiscordRacer',
  'Discord server builder',
  'snap me @racer123',
  'my snap racer123',
  'f4llow me',
  'instagram.com/racername',
  'https://www.instagram.com/racername/',
  '@racername on insta',
  'follow me on instagram',
  'my insta: racername',
  'Instagram Racer',
  'InstaRacer',
  // Explicit gender-targeted threats must be symmetric, not women-only.
  'killallmen',
  'kill all men',
  'kill-all-men',
  'killallwomen',
  'killallnonbinary',
  // Requested slur variant.
  'nga',
  'ngga',
  'n.g.g.a',
  'Racer nga',
  'NGA123',
  'Nixxer',
  'NixxerRacer',
  'niqqer',
  // Nudes and profanity embedded in otherwise ordinary-looking handles.
  'instagram/freenudes',
  'poгnhub',
  'pогnhub',
  'send-me-nudes',
  'TurboFuckRacer',
  'RacerShithead'
];

const mustAllow = [
  // Ordinary political vocabulary and neutral identity/nationality names.
  'Tonga',
  'MangaRacer',
  'Angga',
  'Nigerian Racer',
  'NigerianRacer',
  'Nix',
  'Nixer',
  'Niger',
  'Scunthorpe'
];

const mutationTargets = [
  'epstein',
  'discord',
  'instagram',
  'insta',
  'killallmen',
  'nixxer',
  'fuck'
];

function mutateName(value, mutation) {
  switch (mutation) {
    case 'mixed-case':
      return [...value].map((char, index) => index % 2 ? char.toUpperCase() : char.toLowerCase()).join('');
    case 'separators':
      return [...value].join('-');
    case 'spaced':
      return [...value].join(' ');
    case 'repeated-letter':
      return [...value].map(char => `${char}${char}`).join('');
    case 'font-style':
      // Mathematical bold lowercase letters are NFKC-compatible presentation forms.
      return [...value].map(char => String.fromCodePoint(0x1d5ee + char.charCodeAt(0) - 97)).join('');
    default:
      throw new Error(`Unknown deterministic mutation: ${mutation}`);
  }
}

const mutations = ['mixed-case', 'separators', 'spaced', 'repeated-letter', 'font-style'];
const generatedRacingNames = [
  'NeonRacer', 'TurboDrift', 'QuasarApex', 'SwiftComet',
  'SolarTrack', 'PixelRunner', 'CobaltRocket', 'MistyFalcon',
  'AuroraDash', 'GranitePilot', 'RogueClimber', 'VividSkater',
  'SableEngine', 'JadeVelocity', 'ArcticRider', 'LunarSprinter'
];

test('expansion regression: requested harmful names, promotions, and embedded profanity block', () => {
  for (const name of mustBlock) {
    const result = moderatePublicName(name);
    assert.equal(result.blocked, true, `${JSON.stringify(name)} should block; got ${result.reason || 'allowed'}`);
  }
});

test('false-positive guardrails: contextual references, ordinary words, and benign names remain allowed', () => {
  for (const name of mustAllow) {
    const result = moderatePublicName(name);
    assert.equal(result.blocked, false, `${JSON.stringify(name)} should be allowed; got ${result.reason}`);
  }
});

test('policy decisions include moderation metadata for blocked regression cases', () => {
  for (const name of mustBlock) {
    const result = moderatePublicName(name);
    if (!result.blocked) continue;
    assert.ok(result.match, `${JSON.stringify(name)} should explain its match`);
    assert.equal(typeof result.match.type, 'string', name);
    assert.equal(typeof result.match.term, 'string', name);
  }
});

test('deterministic mutation matrix blocks font, case, separator, spacing, and repeated-letter variants', () => {
  const gaps = [];
  for (const target of mutationTargets) {
    for (const mutation of mutations) {
      const name = mutateName(target, mutation);
      const result = moderatePublicName(name);
      if (!result.blocked) gaps.push(`${target} via ${mutation}: ${JSON.stringify(name)}`);
    }
  }
  assert.deepEqual(gaps, [], `unblocked deterministic mutations:\n${gaps.join('\n')}`);
});

test('fixed generated benign racing names remain allowed', () => {
  for (const name of generatedRacingNames) {
    const result = moderatePublicName(name);
    assert.equal(result.blocked, false, `${JSON.stringify(name)} should be allowed; got ${result.reason}`);
  }
});

test('links cannot use obscure domains, spaced dots, or Unicode domain disguises',()=>{
 for(const name of ['example.technology','example dot com','example[dot]com','example.сom','www.example.com','a@b.org','follow me please','play othergame instead'])assert.equal(moderatePublicName(name).blocked,true,name);
});
test('new substrings preserve real names and ordinary racing words without exempting abuse',()=>{
 for(const name of ['Fukushima','Fukuda','Fukuoka','InstantRacer','Winstanley','SkillAllTracks','Trumpeter','Nazim','Nazir'])assert.equal(moderatePublicName(name).blocked,false,name);
 for(const name of ['FukushimaFuck','InstantRacerNudes','SkillAllKillAllMen','NazimHitler','TrumpeterPorn','TrumpRacer','biden2028','NudeRacer','kurwa','scheiße'])assert.equal(moderatePublicName(name).blocked,true,name);
});

test('enclosed letter symbols cannot conceal explicit words',()=>{
 for(const start of [0x1f130,0x1f150,0x1f170,0x1f1e6])for(const word of ['fuck','nudes','hitler','nixxer']){
  const value=Array.from(word,c=>String.fromCodePoint(start+c.charCodeAt(0)-97)).join('');
  assert.equal(moderatePublicName(value).blocked,true,word+' '+start);
 }
 assert.equal(moderatePublicName('🇺🇸 Racer').blocked,false);
});
test('generated fallback names do not violate the expanded policy',()=>{
 for(let id=0;id<2000;id++){
  const name=safePublicName('fuck',String(id));assert.equal(moderatePublicName(name).blocked,false,name);
 }
});
