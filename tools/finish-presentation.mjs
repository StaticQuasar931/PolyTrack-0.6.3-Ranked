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
   const match=/^(\d+)(?:st|nd|rd|th)?$/i.exec(node.textContent.replace(/[\s\u202f]/g,''));
   const value=match&&finishOrdinal(Number(match[1]));
   if(!value)return;
   const label=node.title||value.label;
   if(node.getAttribute('aria-label')!==label)node.setAttribute('aria-label',label);
  };
  const observer=new document.defaultView.MutationObserver(update);
  observed.set(node,observer);update();
  observer.observe(node,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title']});
 }
}
