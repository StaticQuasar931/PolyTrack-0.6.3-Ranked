import test from'node:test';import assert from'node:assert/strict';import{profilePodiumProgress}from'./profile-podium-progress.mjs';
const zero={medals:{gold:0,silver:0,bronze:0}},options={isEligible:()=>true,trackName:id=>'Track '+id};
test('unknown medals are not treated as no podiums',()=>assert.equal(profilePodiumProgress({},[],options).kind,'unknown'));
test('earned counts keep the medal view',()=>assert.equal(profilePodiumProgress({medals:{gold:1,silver:0,bronze:0}},[],options).kind,'earned'));
test('closest eligible result provides an account-specific next target',()=>{const r=profilePodiumProgress(zero,[{trackId:'a',rank:11,fieldSize:600},{trackId:'b',rank:4,fieldSize:9}],options);assert.equal(r.trackId,'b');assert.equal(r.detail,'Track b · #4 to top 3')});
test('pending podiums never invent a cloud acknowledgement for local PBs',()=>{const f={trackId:'a',rank:2,fieldSize:20,runVerified:false};assert.match(profilePodiumProgress(zero,[f],options).detail,/not verified/);assert.match(profilePodiumProgress(zero,[{...f,localPending:true}],options).label,/saved locally/)});
test('ineligible and unknown results cannot supply a podium target',()=>assert.equal(profilePodiumProgress(zero,[{trackId:'a',rank:4,fieldSize:4},{trackId:'b',rank:null,fieldSize:100}],options).kind,'first'));
