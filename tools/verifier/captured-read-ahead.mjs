/** Bounded read-ahead, ordered consumption, and no abandoned I/O on failure. */
export async function* capturedReadAhead(values, read, concurrency=4) {
  if (!Array.isArray(values) || typeof read !== 'function' ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw Error('Invalid captured read-ahead bounds');
  }
  const pending=new Map();let next=0;
  const fill=()=>{
    while(next<values.length && pending.size<concurrency) {
      const index=next++;
      // Every rejection is observed immediately, even behind an earlier slow read.
      pending.set(index,Promise.resolve().then(()=>read(values[index],index)).then(
        value=>({value}),error=>({error,failed:true})));
    }
  };
  try {
    fill();
    for(let index=0;index<values.length;index++) {
      const result=await pending.get(index);pending.delete(index);
      if(result.failed)throw result.error;
      yield result.value;
      fill();
    }
  } finally {await Promise.all(pending.values());}
}
