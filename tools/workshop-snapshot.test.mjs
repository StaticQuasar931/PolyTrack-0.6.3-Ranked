import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureWorkshopStyles,WORKSHOP_DOCUMENTS} from './capture-workshop-styles.mjs';
import {encodeWorkshopStyle,readWorkshopStyle,WORKSHOP_STYLE_COLLECTION,workshopThumbnailSelection} from './public-workshop-style.mjs';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';

const id='a'.repeat(64),at=1700000000000;
const style=encodeWorkshopStyle({accessory:'crown',finish:'neon',front:'rearbar',sticker:'race-number',stickerLayout:{number:12,size:'large',position:'left'},paid:true});
test('Workshop selections are bounded, compact and carry no reward or ranking claims',()=>{
 assert.equal(JSON.parse(style).rear,'rearbar');
 assert.equal(readWorkshopStyle(style),style);
 for(const value of [style+' ',JSON.stringify({accessory:'crown',crownTier:'gold'}),'{"finish":"unknown"}','{"accessory":"crown","accessory":"fin"}'])assert.equal(readWorkshopStyle(value),undefined);
 assert.equal(workshopThumbnailSelection(style,{medals:{silver:2}}).crownTier,'silver');
 assert.equal(workshopThumbnailSelection(style,{}).accessory,undefined);
 assert.equal(workshopThumbnailSelection(encodeWorkshopStyle({sticker:'rank-number'}),{rank:2,provisional:true}).sticker,undefined);
});

test('bounded delta packages the saved car in profiles and the directory and publishes clears',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workshop-snapshot-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=name=>path.join(root,name);
 await fs.mkdir(file('profiles'));
 await fs.writeFile(file('profiles/'+id+'.json'),JSON.stringify({accountId:id,name:'Racer',updatedAt:at,workshopStyle:'not-authority'}));
 await fs.writeFile(file('overall.json'),JSON.stringify({entries:[{userId:id,rank:2,medals:{silver:1}}]}));
 const row=(stamp,workshopStyle)=>({document:{name:WORKSHOP_DOCUMENTS+WORKSHOP_STYLE_COLLECTION+'/'+id,fields:{updatedAt:{integerValue:String(stamp)},workshopStyle:{stringValue:workshopStyle}}}});
 let requests=0;
 const first=await captureWorkshopStyles(root,async(_,options)=>{
  requests++;assert.equal(JSON.parse(options.body).structuredQuery.limit,50);return Response.json([row(at,style)]);
 });
 assert.equal(first.documentReads,1);
 await buildProfileSnapshotResults(root);
 const get=async name=>JSON.parse(await fs.readFile(file(name),'utf8'));
 const profilePath='profile-results/'+id+'.json';
 assert.equal((await get(profilePath)).publicProfile.workshopStyle,style);
 assert.equal((await get('racer-directory.json')).entries[id].workshopStyle,style);
 assert.deepEqual((await get('racer-directory.json')).entries[id].cosmeticContext.medals,{silver:1});
 await captureWorkshopStyles(root,async(_,options)=>{
  requests++;const start=JSON.parse(options.body).structuredQuery.startAt;
  assert.equal(start.values[0].integerValue,String(at));
  return Response.json([row(at+1,'')]);
 });
 await buildProfileSnapshotResults(root);
 assert.equal((await get(profilePath)).publicProfile.workshopStyle,undefined);
 assert.equal((await get('racer-directory.json')).entries[id].workshopStyle,undefined);
 assert.equal(requests,2);
});
