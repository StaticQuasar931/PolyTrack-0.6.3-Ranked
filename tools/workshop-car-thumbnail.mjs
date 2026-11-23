const {createNativeCarAppearance}=await import(new URL('./car-cosmetics-materials.mjs'+new URL(import.meta.url).search,import.meta.url).href);

export function createWorkshopCarThumbnail(document,load){
 const three=load(4922);
 const {eaF:Mesh,YJl:Group,G_z:Material,qUd:Camera,Pq0:Vector,PTz:Quaternion}=three;
 const Car=load(641).A,Renderer=load(1507).A,Frame=load(7929).A;
 const canvas=document.createElement('canvas');canvas.width=200;canvas.height=200;
 const renderer=new Renderer(canvas,null,false),camera=new Camera(-1,1,1,-1,.1,1e4);
 renderer.scene.add(camera);renderer.setCamera(camera);
 const car=new Car(null,{position:new Vector(),quaternion:new Quaternion()},null,null,renderer,null,null,null,null,null,null);
 car.update(0);
 const matrix=car.getChassisMatrix();let chassis;
 renderer.scene.traverse(node=>{if(node.matrix===matrix)chassis=node;});
 if(!chassis)throw Error('Native thumbnail chassis unavailable');
 camera.position.set(1000.1,1000.3,1000);camera.lookAt(new Vector(.1,.3,0));camera.zoom=.5;camera.updateProjectionMatrix();
 const cap={car,chassis,renderer,three:{Mesh,Group,Material}};
 return (style,selection)=>{
  car.setCarStyle(style);
  const appearance=createNativeCarAppearance(cap,selection,'medium');
  try{renderer.update(new Frame());return canvas.toDataURL();}
  finally{appearance.clear();}
 };
}
