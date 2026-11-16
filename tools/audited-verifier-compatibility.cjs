'use strict';

const {verifierFingerprint:actualFingerprint}=require('./verifier/verify.cjs');
const OLD='4a52404b07cb6a78944c5073de19a46cefc7f73efd82bb56490abe1b2f35d79f';
const CURRENT='22dee8233571960694a09ff1f6934454cacbee1e2010aff81a02de369a91f5f3';
const ENGINE='7203ead74e290932abafe7f45ae5d121b5e1488b788f7dbe9ea95c8eb30d1ed1';
const VERSION='polytrack-native-bounded-v1';
const ADDED_TRACK='b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f';
const HASH=/^[a-f0-9]{64}$/;

// Audited release394 (7685e42f) only added Magician's geometry row. All seven
// other inputs and all93 previous rows are unchanged. Dynamic trusted tracks
// keep their existing independent content/geometry/review gates at the caller.
// No engine/version aliasing, reverse relation, new-track exception or future
// verifier compatibility is granted by this single directional relation.
function verifierFingerprintsCompatible(witness,current,context={}){
  if(!HASH.test(witness||'')||!HASH.test(current||''))return false;
  if(witness===current)return true;
  return actualFingerprint===CURRENT&&witness===OLD&&current===CURRENT&&
    context.witnessEngineDigest===ENGINE&&context.currentEngineDigest===ENGINE&&
    context.witnessVerifierVersion===VERSION&&context.currentVerifierVersion===VERSION&&
    HASH.test(context.trackId||'')&&context.trackId!==ADDED_TRACK;
}

module.exports={verifierFingerprintsCompatible};
