/** Closed, low-poly visual geometry in local mount space. No physics meshes. */
const cache=new Map();
function convex(points,faces){
 const center=[0,1,2].map(axis=>points.reduce((n,p)=>n+p[axis],0)/points.length),out=[];
 for(const face of faces){const [a,b,c]=face.map(i=>points[i]),u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],middle=[0,1,2].map(i=>(a[i]+b[i]+c[i])/3-center[i]);const indices=normal.reduce((n,x,i)=>n+x*middle[i],0)<0?[face[0],face[2],face[1]]:face;for(const i of indices)out.push(...points[i]);}
 return new Float32Array(out);
}
const boxFaces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[1,5,6],[1,6,2],[0,3,7],[0,7,4]];
const box=(w,h,d,x=0,y=h/2,z=0)=>convex([[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]].map(p=>[x+p[0]*w/2,y+p[1]*h/2,z+p[2]*d/2]),boxFaces);
function cylinder(radius,height,y,segments){const p=[],f=[];for(const h of [y,y+height])for(let i=0;i<segments;i++)p.push([Math.cos(i/segments*Math.PI*2)*radius,h,Math.sin(i/segments*Math.PI*2)*radius]);p.push([0,y,0],[0,y+height,0]);for(let i=0;i<segments;i++){const n=(i+1)%segments;f.push([segments*2,i,n],[segments*2+1,n+segments,i+segments],[i,i+segments,n+segments],[i,n+segments,n]);}return convex(p,f);}
const part=(positions,color,emissive=0,decal=false)=>Object.freeze({positions,color,emissive,decal,triangles:positions.length/9});
const stickerShapes={
 apex:[[0xe0f7ff,[[5,25],[12,7],[17,7],[10,25]]],[0x31d5ec,[[14,25],[21,7],[26,7],[19,25]]]],
 checker:[...[0,1,2,3,4,5,6,7].map(i=>{const x=4+i%4*6,y=10+Math.floor(i/4)*6;return [(i+Math.floor(i/4))%2?0x233451:0xf2f7ff,[[x,y],[x+6,y],[x+6,y+6],[x,y+6]]];})],
 bolt:[[0x191f38,[[12,4],[26,4],[20,13],[27,13],[9,29],[12,19],[5,19]]],[0xffd45e,[[13,6],[22,6],[16,15],[22,15],[12,24],[15,17],[8,17]]]],
 roundel:[[0x202e54,[[16,4],[24,7],[28,16],[24,25],[16,28],[8,25],[4,16],[8,7]]],[0xeff5fc,[[16,7],[22,9],[25,16],[22,23],[16,25],[10,23],[7,16],[10,9]]],[0xee5d53,[[12,12],[21,12],[21,15],[17,15],[16,22],[13,22],[15,15],[12,15]]]],
 comet:[[0x57cbeb,[[4,20],[21,7],[26,11],[13,22]]],[0xf2f8ff,[[10,25],[25,10],[29,15],[17,26]]]],
 ridge:[[0x223a6a,[[3,24],[12,8],[17,16],[21,10],[29,24]]],[0xfcf1d0,[[8,15],[12,8],[16,15],[12,13]]]],
 'solar-flare':[[0x512028,[[16,3],[25,7],[29,16],[25,25],[16,29],[7,25],[3,16],[7,7]]],[0xff9044,[[16,6],[22,10],[26,16],[22,22],[16,26],[10,22],[6,16],[10,10]]],[0xfff1c7,[[17,8],[19,14],[25,16],[18,18],[15,24],[14,18],[8,16],[14,14]]]],
 'tide-mark':[[0x163855,[[4,9],[14,4],[28,9],[28,21],[18,28],[4,23]]],[0x4ce0c2,[[5,15],[13,9],[18,9],[27,15],[19,14],[13,17],[5,21]]],[0xe4fbf7,[[10,23],[18,17],[22,16],[27,18],[22,20],[18,24]]]],
 laurel:[[0xecd28a,[[15,25],[8,22],[4,14],[5,6],[9,16],[15,22]]],[0xecd28a,[[17,25],[24,22],[28,14],[27,6],[23,16],[17,22]]],[0xf7e7b6,[[16,5],[21,12],[16,19],[11,12]]]]
};
export function carStickerIcon(id){return (stickerShapes[id]||[]).map(([color,points])=>'<polygon fill="#'+color.toString(16).padStart(6,'0')+'" stroke="none" points="'+points.map(p=>p.join(',')).join(' ')+'"/>').join('');}
export function carAttachmentParts(category,id,density='low'){
 const key=category+':'+id+':'+density;if(cache.has(key))return cache.get(key);if(!['low','medium','high'].includes(density))throw Error('Invalid visual density');
 const dark=0x243545,metal=0xb5ccd3,cyan=0x7ee7ff,gold=0xe5b862,parts=[];const add=(g,c,e=0,decal=false)=>parts.push(part(g,c,e,decal));
 if(id==='none')return [];
 if(category==='accessory'){
  if(id==='fin'){add(box(.09,.02,.36),dark);add(convex([[-.012,.02,-.22],[.012,.02,-.22],[-.012,.02,.22],[.012,.02,.22],[-.008,.19,-.13],[.008,.19,-.13],[-.008,.07,.16],[.008,.07,.16]],[[0,2,3],[0,3,1],[4,5,7],[4,7,6],[0,1,5],[0,5,4],[2,6,7],[2,7,3],[1,3,7],[1,7,5],[0,4,6],[0,6,2]]),cyan);}
  else if(id==='beacon'){add(box(.16,.025,.16),dark);add(cylinder(.065,.105,.025,density==='low'?6:density==='medium'?8:12),0xffba59,.38);add(box(.06,.012,.06,0,.136),metal);}
  else if(id==='aerial'){add(box(.065,.02,.065),dark);add(box(.012,.27,.012,0,.155),metal);add(box(.023,.025,.023,0,.3),cyan);}
  else if(id==='roofbox'){for(const x of [-.1,.1])for(const z of [-.15,.15])add(box(.035,.028,.045,x,.014,z),dark);add(box(.29,.115,.43,0,.085),0x7296ad);add(box(.28,.016,.42,0,.15),metal);}
  else if(id==='crown'){for(const x of [-.13,.13])add(box(.03,.035,.22,x),gold);for(const z of [-.1,.1])add(box(.28,.035,.03,0,.0175,z),gold);for(const x of [-.1,0,.1])add(box(.035,x===0?.16:.12,.035,x,.035+(x===0?.16:.12)/2,.1),gold);}
  else if(id==='halo'){for(const x of [-.15,.15])for(const z of [-.18,.18])add(box(.023,.035,.023,x,.0175,z),dark);for(const x of [-.15,.15])add(box(.025,.025,.39,x,.0475),cyan,.55);for(const z of [-.185,.185])add(box(.29,.025,.025,0,.0475,z),cyan,.55);}
  else throw Error('Unknown roof visual');
 }else if(category==='sticker'){
  const shapes=stickerShapes[id];if(!shapes)throw Error('Unknown sticker');
  for(const [layer,[color,points]] of shapes.entries()){
   const y=.002+layer*.0001,vertices=points.map(([x,z])=>[(x-16)/136,y,(z-16)/136]),out=[];
   // Fan triangulation is only used for convex shapes; concave stickers use an SVG-style outline triangulated below.
   const remaining=vertices.map((_,i)=>i),cross=(a,b,c)=>(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);
   const sign=Math.sign(vertices.reduce((n,a,i)=>{const b=vertices[(i+1)%vertices.length];return n+a[0]*b[2]-a[2]*b[0];},0));
   while(remaining.length>2){let found=false;for(let i=0;i<remaining.length;i++){const a=vertices[remaining[(i+remaining.length-1)%remaining.length]],b=vertices[remaining[i]],c=vertices[remaining[(i+1)%remaining.length]];
    if(cross(a,b,c)*sign<=0||remaining.some(j=>{const p=vertices[j];return p!==a&&p!==b&&p!==c&&[cross(a,b,p),cross(b,c,p),cross(c,a,p)].every(v=>v*sign>=0);}))continue;
    out.push(...a,...(sign>0?c:b),...(sign>0?b:c));remaining.splice(i,1);found=true;break;
   }if(!found)throw Error('Invalid sticker polygon');}
   add(new Float32Array(out),color,0,true);
  }
 }else if(category==='emblem'){
  if(id==='crest'){for(const [w,d,y,color]of [[.045,.06,.002,dark],[.032,.047,.0025,gold]])add(new Float32Array([0,y,-d,-w,y,0,0,y,d,0,y,-d,0,y,d,w,y,0]),color,0,true);}
  else if(id==='diamond')add(convex([[0,.07,0],[.065,0,0],[0,-.07,0],[-.065,0,0],[0,.07,.012],[.065,0,.012],[0,-.07,.012],[-.065,0,.012]],boxFaces),gold);
  else if(id==='chevron'){add(convex([[-.1,.035,0],[0,-.035,0],[.1,.035,0],[-.1,.035,.014],[0,-.035,.014],[.1,.035,.014]],[[0,2,1],[3,4,5],[0,1,4],[0,4,3],[1,2,5],[1,5,4],[2,0,3],[2,3,5]]),cyan);}
  else throw Error('Unknown nose emblem');
 }else if(category==='front'){
  if(id==='rearbar'){add(box(.36,.045,.025,0,0,.0125),dark);add(box(.3,.016,.012,0,0,.031),cyan,.2);}
  else if(id==='splitter'){add(box(.56,.025,.08,0,0,.035),dark);add(box(.52,.009,.025,0,-.009,.075),cyan);}
  else if(id==='lamps'){add(box(.4,.025,.025,0,0,.0125),dark);for(const x of [-.14,.14])add(box(.07,.07,.04,x,.018,.035),0xffe7a5,.3);}
  else throw Error('Unknown front accessory');
 }else throw Error('Unknown attachment category');
 const result=Object.freeze(parts);cache.set(key,result);return result;
}
export function carAttachmentFrames(positions,indices){
 if(!positions?.length||positions.length%3)throw Error('Invalid native body vertices');
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<positions.length;i++){if(!Number.isFinite(positions[i]))throw Error('Nonfinite native vertex');min[i%3]=Math.min(min[i%3],positions[i]);max[i%3]=Math.max(max[i%3],positions[i]);}
 const faces=[],ix=indices||Array.from({length:positions.length/3},(_,i)=>i);
 for(let i=0;i+2<ix.length;i+=3){const p=[ix[i],ix[i+1],ix[i+2]].map(index=>{if(!Number.isInteger(index)||index<0||index*3+2>=positions.length)throw Error('Invalid native face');return Array.from(positions.slice(index*3,index*3+3));}),u=p[1].map((v,a)=>v-p[0][a]),v=p[2].map((v,a)=>v-p[0][a]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],area=Math.hypot(...n);if(area<1e-8)continue;faces.push({p,normal:n.map(v=>v/area),area,center:[0,1,2].map(a=>(p[0][a]+p[1][a]+p[2][a])/3)});}
 const frame=(axis,filter)=>{let selected=faces.filter(filter);if(!selected.length)throw Error('No safe native attachment surface');const top=Math.max(...selected.map(f=>f.center[axis]));selected=selected.filter(f=>f.center[axis]>=top-.015);const area=selected.reduce((n,f)=>n+f.area,0),point=[0,1,2].map(a=>selected.reduce((n,f)=>n+f.center[a]*f.area,0)/area),normal=[0,1,2].map(a=>selected.reduce((n,f)=>n+f.normal[a]*f.area,0)/area),length=Math.hypot(...normal);const vertices=selected.flatMap(f=>f.p);return Object.freeze({point,normal:normal.map(v=>v/length),width:Math.max(...vertices.map(p=>p[0]))-Math.min(...vertices.map(p=>p[0])),depth:Math.max(...vertices.map(p=>p[2]))-Math.min(...vertices.map(p=>p[2]))});};
 // Intersect triangles with the actual body centerline, independent of triangulation/face area.
 const centerX=(min[0]+max[0])/2,centerline=filter=>{
  const candidates=[];for(const f of faces.filter(filter)){const cut=[];for(let i=0;i<3;i++){const a=f.p[i],b=f.p[(i+1)%3];if(Math.abs(a[0]-centerX)<1e-6)cut.push(a);if((a[0]-centerX)*(b[0]-centerX)<0){const t=(centerX-a[0])/(b[0]-a[0]);cut.push([centerX,a[1]+t*(b[1]-a[1]),a[2]+t*(b[2]-a[2])]);}}if(cut.length>=2){const lo=Math.min(...cut.map(p=>p[2])),hi=Math.max(...cut.map(p=>p[2]));if(hi-lo>1e-5){const z=(lo+hi)/2,y=f.p[0][1]-(f.normal[0]*(centerX-f.p[0][0])+f.normal[2]*(z-f.p[0][2]))/f.normal[1];candidates.push({f,lo,hi,y});}}}
  if(!candidates.length)return null;candidates.sort((a,b)=>b.y-a.y);const best=candidates[0],coplanar=candidates.filter(c=>c.f.normal.reduce((n,x,i)=>n+x*best.f.normal[i],0)>.999&&Math.abs(c.f.p[0].reduce((n,x,i)=>n+(x-best.f.p[0][i])*best.f.normal[i],0))<.002),z=(Math.min(...coplanar.map(c=>c.lo))+Math.max(...coplanar.map(c=>c.hi)))/2,n=best.f.normal,y=best.f.p[0][1]-(n[0]*(centerX-best.f.p[0][0])+n[2]*(z-best.f.p[0][2]))/n[1],vertices=coplanar.flatMap(c=>c.f.p);
  return Object.freeze({point:[centerX,y,z],normal:[...n],width:Math.max(...vertices.map(p=>p[0]))-Math.min(...vertices.map(p=>p[0])),depth:Math.max(...coplanar.map(c=>c.hi))-Math.min(...coplanar.map(c=>c.lo))});
 };
 const roof=centerline(f=>f.normal[1]>.65&&f.center[1]>=min[1]+(max[1]-min[1])*.55);if(!roof)throw Error('No centered native roof surface');
 const hood=centerline(f=>f.normal[1]>.65&&f.center[2]>(min[2]+max[2])/2+(max[2]-min[2])*.12);
 const rearFaces=faces.filter(f=>f.normal[2]<-.7&&f.center[1]>min[1]+(max[1]-min[1])*.4);let rear=null;if(rearFaces.length){const f=rearFaces.sort((a,b)=>a.center[2]-b.center[2])[0];rear={point:[centerX,f.center[1],f.center[2]],normal:[...f.normal],width:Math.max(...f.p.map(p=>p[0]))-Math.min(...f.p.map(p=>p[0]))};}
 return Object.freeze({bounds:{min,max},roof,hood,rear,front:frame(2,f=>f.normal[2]>.55&&f.center[2]>=max[2]-(max[2]-min[2])*.15)});
}
