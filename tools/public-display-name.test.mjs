import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDisplayName} from './public-display-name.mjs';

test('public names preserve normal names and remove unsafe display characters',()=>{
  assert.equal(publicDisplayName('Static'), 'Static');
  assert.equal(publicDisplayName('  Racer\u202e<>\n  '), 'Racer');
  assert.equal(publicDisplayName(null), 'Racer');
  assert.equal(publicDisplayName('a'.repeat(100)).length,24);
});

test('obvious offensive names and disguised common variants use a neutral display name',()=>{
  for(const value of ['fuck','sh1t','Master of Baiting','Gildedisass','www.example.com','https://example.com'])assert.equal(publicDisplayName(value),'Racer');
  assert.equal(publicDisplayName('Classical Racer'),'Classical Racer');
});
