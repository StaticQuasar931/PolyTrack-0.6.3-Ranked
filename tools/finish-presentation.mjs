const observed=new WeakMap();
export function finishOrdinal(position){
 if(!Number.isSafeInteger(position)||position<1)return null;
 const last=position%100,suffix=last>=11&&last<=13?'th':({1:'st',2:'nd',3:'rd'}[position%10]||'th');
 return {number:String(position),suffix,label:String(position)+suffix+' place'};
}
export function enhanceFinishAnnouncers(document){
 for(const node of document.querySelectorAll('.time-announcer-ui > .current > .position')){
  if(observed.has(node))continue;
  const update=()=>{
   const text=node.textContent.replace(/[\s\u202f]/g,'');
   const match=/^(\d+)(?:st|nd|rd|th|x|×)?$/i.exec(text),value=match&&finishOrdinal(Number(match[1]));
   if(!value)return;
   // Event results own their suffix and provisional/field-size explanation.
   if(node.querySelector('.sq-event-ordinal-suffix')){node.setAttribute('aria-label',node.title||value.label);return;}
   node.setAttribute('aria-label',value.label);
   if(node.children.length===2&&node.firstElementChild?.className==='sq-finish-number'&&node.lastElementChild?.textContent===value.suffix)return;
   const number=document.createElement('span'),suffix=document.createElement('sup');
   number.className='sq-finish-number';number.textContent=value.number;
   suffix.className='sq-finish-ordinal';suffix.textContent=value.suffix;
   // Keep the number native, but do not shrink ForcedSquare's angular suffix glyphs.
   suffix.style.fontFamily='Arial,sans-serif';suffix.style.fontStyle='normal';
   suffix.style.fontVariant='normal';suffix.style.letterSpacing='normal';
   node.replaceChildren(number,suffix);
  };
  const observer=new document.defaultView.MutationObserver(update);
  observed.set(node,observer);update();observer.observe(node,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title']});
 }
}
