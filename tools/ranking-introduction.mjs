const KEY='polytrack-ranking-explanations-v1';
const seenByDocument=new WeakMap();
export function readRankingExplanations(storage){
  try{const raw=storage?.getItem(KEY);if(typeof raw==='string'&&raw.length<2048){const v=JSON.parse(raw);return {disabled:v.disabled===true,seen:Array.isArray(v.seen)?v.seen.filter(x=>typeof x==='string'&&/^[a-zA-Z]{1,32}$/.test(x)).slice(0,32):[]};}}catch{}
  return {disabled:false,seen:[]};
}
export function showRankingIntroduction({document=globalThis.document,storage,key,title,description}={}){
  if(!document?.body||!key||!description)return null;
  try{storage??=document.defaultView?.localStorage;}catch{}
  const saved=readRankingExplanations(storage),memory=seenByDocument.get(document)||new Set();
  if(saved.disabled||saved.seen.includes(key)||memory.has(key)||document.querySelector('dialog[open]'))return null;
  const previous=document.activeElement,dialog=document.createElement('dialog');dialog.className='sq-ranking-intro';
  dialog.setAttribute('aria-labelledby','sq-ranking-intro-title');
  const heading=document.createElement('h2');heading.id='sq-ranking-intro-title';heading.textContent=title;
  const text=document.createElement('p');text.textContent=description;
  const label=document.createElement('label'),disable=document.createElement('input');disable.type='checkbox';label.append(disable,' Don\'t show ranking explanations');
  const ok=document.createElement('button');ok.type='button';ok.textContent='Got it';
  dialog.append(heading,text,label,ok);document.body.append(dialog);
  const view=document.defaultView,guard=e=>{if(dialog.open)e.stopImmediatePropagation();};
  let closed=false;const close=()=>{if(closed)return;closed=true;memory.add(key);seenByDocument.set(document,memory);try{storage?.setItem(KEY,JSON.stringify({disabled:disable.checked,seen:[...new Set([...saved.seen,key])].slice(-32)}));}catch{}
    view?.removeEventListener('keydown',guard,true);view?.removeEventListener('keyup',guard,true);dialog.remove();if(previous?.isConnected)previous.focus({preventScroll:true});};
  ok.addEventListener('click',()=>{dialog.close();close();});dialog.addEventListener('close',close);
  try{dialog.showModal();view?.addEventListener('keydown',guard,true);view?.addEventListener('keyup',guard,true);ok.focus();}catch{dialog.remove();return null;}
  return {dialog,close:()=>{dialog.close();close();}};
}
