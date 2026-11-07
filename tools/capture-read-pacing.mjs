export const CAPTURE_READ_PACER=Symbol('polytrack-private-capture-pacing');
const ORIGIN='https://polytrack-ranked-worker.staticquasar931.workers.dev';
export function createCaptureReadPacer({now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let tail=Promise.resolve(),lastRequest=-Infinity,lastEvent=-Infinity;const held=new Set();
  return {async reserve(input){
    const url=new URL(input);if(url.origin!==ORIGIN)return ()=>{};
    const track=url.pathname==='/v1/snapshot/track',event=url.pathname.startsWith('/v1/events/');
    let unlock;const previous=tail;tail=new Promise(resolve=>unlock=resolve);await previous;
    try{
      for(;;){const at=now();for(const item of held)if(!item.pending&&at-item.at>=61000)held.delete(item);
        let wait=Math.max(0,lastRequest+250-at,event?lastEvent+1500-at:0);
        if(track&&held.size>=8){const completed=[...held].filter(x=>!x.pending);wait=Math.max(wait,completed.length?Math.max(1,Math.min(...completed.map(x=>x.at))+61000-at):25);}
        if(wait){await sleep(wait);continue;}break;
      }
      const at=now();lastRequest=at;if(event)lastEvent=at;const item=track?{at,pending:true}:null;if(item)held.add(item);
      let done=false;return status=>{if(done)return;done=true;if(item){if(status===404){item.pending=false;item.at=now();}else held.delete(item);}};
    }finally{unlock();}
  }};
}
