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
const part=(positions,color,emissive=0)=>Object.freeze({positions,color,emissive,triangles:positions.length/9});
export function carAttachmentParts(category,id,density='low'){
 const key=category+':'+id+':'+density;if(cache.has(key))return cache.get(key);if(!['low','medium','high'].includes(density))throw Error('Invalid visual density');
 const dark=0x243545,metal=0xb5ccd3,cyan=0x7ee7ff,gold=0xe5b862,parts=[];const add=(g,c,e=0)=>parts.push(part(g,c,e));
 if(id==='none')return [];
 if(category==='accessory'){
  if(id==='fin'){add(box(.09,.02,.36),dark);add(convex([[-.012,.02,-.22],[.012,.02,-.22],[-.012,.02,.22],[.012,.02,.22],[-.008,.19,-.13],[.008,.19,-.13],[-.008,.07,.16],[.008,.07,.16]],[[0,2,3],[0,3,1],[4,5,7],[4,7,6],[0,1,5],[0,5,4],[2,6,7],[2,7,3],[1,3,7],[1,7,5],[0,4,6],[0,6,2]]),cyan);}
  else if(id==='beacon'){add(box(.16,.025,.16),dark);add(cylinder(.065,.105,.025,density==='low'?6:density==='medium'?8:12),0xffba59,.38);add(box(.06,.012,.06,0,.136),metal);}
  else if(id==='aerial'){add(box(.065,.02,.065),dark);add(box(.012,.27,.012,0,.155),metal);add(box(.023,.025,.023,0,.3),cyan);}
  else if(id==='roofbox'){for(const x of [-.1,.1])for(const z of [-.15,.15])add(box(.035,.028,.045,x,.014,z),dark);add(box(.29,.115,.43,0,.085),0x7296ad);add(box(.28,.016,.42,0,.15),metal);}
  else if(id==='crown'){for(const x of [-.13,.13])add(box(.03,.035,.22,x),gold);for(const z of [-.1,.1])add(box(.28,.035,.03,0,.0175,z),gold);for(const x of [-.1,0,.1])add(box(.035,x===0?.16:.12,.035,x,.035+(x===0?.16:.12)/2,.1),gold);}
  else if(id==='halo'){for(const x of [-.15,.15])for(const z of [-.18,.18])add(box(.023,.035,.023,x,.0175,z),dark);for(const x of [-.15,.15])add(box(.025,.025,.39,x,.0475),cyan,.55);for(const z of [-.185,.185])add(box(.29,.025,.025,0,.0475,z),cyan,.55);}
  else throw Error('Unknown roof visual');
 }else if(category==='emblem'){
  if(id==='diamond')add(convex([[0,.07,0],[.065,0,0],[0,-.07,0],[-.065,0,0],[0,.07,.012],[.065,0,.012],[0,-.07,.012],[-.065,0,.012]],boxFaces),gold);
  else if(id==='chevron'){add(convex([[-.1,.035,0],[0,-.035,0],[.1,.035,0],[-.1,.035,.014],[0,-.035,.014],[.1,.035,.014]],[[0,2,1],[3,4,5],[0,1,4],[0,4,3],[1,2,5],[1,5,4],[2,0,3],[2,3,5]]),cyan);}
  else throw Error('Unknown nose emblem');
 }else if(category==='front'){
  if(id==='splitter'){add(box(.56,.035,.1,0,-.09,.05),dark);add(box(.52,.012,.035,0,-.105,.095),cyan);}
  else if(id==='lamps'){add(box(.4,.025,.025,0,-.07,.025),dark);for(const x of [-.14,.14])add(box(.07,.07,.05,x,-.055,.06),0xffe7a5,.3);}
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
 return Object.freeze({bounds:{min,max},roof:frame(1,f=>f.normal[1]>.65&&f.center[1]>=min[1]+(max[1]-min[1])*.55),front:frame(2,f=>f.normal[2]>.55&&f.center[2]>=max[2]-(max[2]-min[2])*.15)});
}
