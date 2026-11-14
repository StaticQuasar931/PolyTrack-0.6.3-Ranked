import test from 'node:test';
import assert from 'node:assert/strict';
import {installNativeCarHooks} from './native-car-hooks.mjs';
function fixture(){
  const screen={},callbacks=[],document={body:{},getElementById:()=>screen,querySelector:()=>null,addEventListener(){},removeEventListener(){}};
  class Car{constructor(matrix){this.matrix=matrix;}getChassisMatrix(){return this.matrix;}setCarStyle(){}setVisible(){}addFinishCallback(){}dispose(){this.disposed=true;}}
  class Renderer{constructor(canvas){this.canvas=canvas;this.scene={children:[],add(...nodes){this.children.push(...nodes);return this;}};}addMaterial(){return 'native-result';}}
  class Profile{getCurrentUserProfile(){return {token:'fixture-only'};}setCarStyle(){}}
  const runtime={created:cap=>callbacks.push(cap),carDisposed:car=>callbacks.push({disposed:car}),tick(){},saved(){},open(){},close(){}};
  const window={document,queueMicrotask,MutationObserver:class{observe(){}disconnect(){}}};
  const modules={641:{A:Car},1507:{A:Renderer},2522:{A:Profile},4922:{eaF:class{},YJl:class{},G_z:class{}}};
  return {window,Car,Renderer,Profile,screen,callbacks,runtime,load:id=>modules[id]};
}
test('visual hooks identify exact local car matrix, never thumbnail or unrelated scene nodes',()=>{const f=fixture(),before=f.Car.prototype.addFinishCallback,adapter=installNativeCarHooks({window:f.window,require:f.load,runtime:f.runtime});const renderer=new f.Renderer(f.screen),matrix={},chassis={matrix,children:[]};assert.equal(renderer.addMaterial({}),'native-result');renderer.scene.add({matrix:{},children:[chassis]});new f.Car({}).addFinishCallback(()=>{});assert.equal(f.callbacks.length,0);const car=new f.Car(matrix);car.addFinishCallback(()=>{});assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0].chassis,chassis);assert.equal(f.callbacks[0].car,car);const thumbnail=new f.Renderer({});thumbnail.addMaterial({});const other={};thumbnail.scene.add({matrix:other,children:[]});new f.Car(other).addFinishCallback(()=>{});assert.equal(f.callbacks.length,1);car.dispose();assert.equal(f.callbacks[1].disposed,car);adapter.dispose();assert.equal(f.Car.prototype.addFinishCallback,before);assert.equal(f.window.__polytrackNativeCarVisualHooks,undefined);});
test('installation is idempotent and cleanup never overwrites a later extension',()=>{const f=fixture(),adapter=installNativeCarHooks({window:f.window,require:f.load,runtime:f.runtime});assert.equal(installNativeCarHooks({window:f.window,require:f.load,runtime:f.runtime}),adapter);const later=function(){};f.Car.prototype.setVisible=later;adapter.dispose();assert.equal(f.Car.prototype.setVisible,later);});
