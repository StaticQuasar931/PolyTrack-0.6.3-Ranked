// Positions must already be in chassis space. Use an actual upward surface, not a bounding-box guess.
export function roofAttachment(positions,indices){
  if(!positions?.length||positions.length%3)throw Error('Invalid chassis vertices');
  const triangles=indices||Array.from({length:positions.length/3},(_,i)=>i);let minY=Infinity,maxY=-Infinity;
  for(let i=1;i<positions.length;i+=3){if(!Number.isFinite(positions[i]))throw Error('Invalid roof vertex');minY=Math.min(minY,positions[i]);maxY=Math.max(maxY,positions[i]);}
  const faces=[];
  for(let i=0;i+2<triangles.length;i+=3){const a=triangles[i]*3,b=triangles[i+1]*3,c=triangles[i+2]*3;if([a,b,c].some(n=>!Number.isInteger(n)||n<0||n+2>=positions.length))throw Error('Invalid roof face');
    const u=[positions[b]-positions[a],positions[b+1]-positions[a+1],positions[b+2]-positions[a+2]],v=[positions[c]-positions[a],positions[c+1]-positions[a+1],positions[c+2]-positions[a+2]],n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],area=Math.hypot(...n);
    const y=(positions[a+1]+positions[b+1]+positions[c+1])/3;
    if(area>1e-8&&n[1]/area>.6&&y>=minY+(maxY-minY)*.55)faces.push({x:(positions[a]+positions[b]+positions[c])/3,y,z:(positions[a+2]+positions[b+2]+positions[c+2])/3,area});
  }
  if(!faces.length)throw Error('No safe roof surface');
  const top=Math.max(...faces.map(f=>f.y)),band=Math.max(.015,(maxY-minY)*.1);
  const face=faces.filter(f=>f.y>=top-band).sort((a,b)=>b.area-a.area||b.y-a.y)[0];return Object.freeze({x:face.x,y:face.y-.003,z:face.z});
}
