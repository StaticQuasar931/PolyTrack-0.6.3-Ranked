'use strict';

const {verifierFingerprint:actualFingerprint}=require('./verifier/verify.cjs');
const OLD='4a52404b07cb6a78944c5073de19a46cefc7f73efd82bb56490abe1b2f35d79f';
const MAGICIANS_CATALOG='22dee8233571960694a09ff1f6934454cacbee1e2010aff81a02de369a91f5f3';
const CURRENT='3fd07e5bdf54fec2e699e88e6e507c9cff77eb4f152ce4afd429e0e728625553';
const ENGINE='7203ead74e290932abafe7f45ae5d121b5e1488b788f7dbe9ea95c8eb30d1ed1';
const VERSION='polytrack-native-bounded-v1';
const ADDED_TRACK='b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f';
const UPLINK='99fe53184c661a29a6b9125af16897c54c6ce228df05b22b8f3cd504ff9e8b37';
const HASH=/^[a-f0-9]{64}$/;

// The two audited catalog changes only added Magician's and then Uplink geometry.
// All seven code inputs and earlier geometry rows are unchanged. Each older
// fingerprint remains barred from tracks whose exception it did not contain.
// Independent content, geometry, replay and review gates remain mandatory.
// No engine/version aliasing, reverse relation or future fingerprint is allowed.
function verifierFingerprintsCompatible(witness,current,context={}){
  if(!HASH.test(witness||'')||!HASH.test(current||''))return false;
  if(witness===current)return true;
  return actualFingerprint===CURRENT&&[OLD,MAGICIANS_CATALOG].includes(witness)&&current===CURRENT&&
    context.witnessEngineDigest===ENGINE&&context.currentEngineDigest===ENGINE&&
    context.witnessVerifierVersion===VERSION&&context.currentVerifierVersion===VERSION&&
    HASH.test(context.trackId||'')&&context.trackId!==UPLINK&&
    (witness!==OLD||context.trackId!==ADDED_TRACK);
}

module.exports={verifierFingerprintsCompatible};
