// A bounded isolate-local circuit breaker, not a global quota ledger.
// Only confirmed absent documents spend this allowance; legitimate new tracks
// do not need a static registry or a new persistent database counter.
export function createPublicMissGuard({now=Date.now,windowMs=60000,perClient=10,total=50,maxClients=256}={}) {
  let epoch=now(),misses=0;
  const clients=new Map();
  const reset=()=>{
    const at=now();
    if(at<epoch||at-epoch>=windowMs){epoch=at;misses=0;clients.clear();}
  };
  return Object.freeze({
    permits(client){reset();return misses<total&&(clients.get(client)||0)<perClient&&
      (clients.has(client)||clients.size<maxClients);},
    missing(client){reset();misses++;if(clients.has(client)||clients.size<maxClients)
      clients.set(client,(clients.get(client)||0)+1);},
    size(){reset();return clients.size;}
  });
}
