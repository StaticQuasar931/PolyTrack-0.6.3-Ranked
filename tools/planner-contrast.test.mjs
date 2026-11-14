import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const css=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const luminance=hex=>hex.match(/../g).map(channel=>parseInt(channel,16)/255)
  .map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4)
  .reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
test('declared planner control and explanation colors retain normal-text contrast',()=>{
  for(const [foreground,background] of [['12274e','7ee7ff'],['d7f9ff','26467b'],['eef7ff','263f72']]){
    assert.ok(css.includes('#'+foreground)&&css.includes('#'+background),'declared palette exists');
    assert.ok(contrast(foreground,background)>=4.5,foreground+' on '+background);
  }
});
