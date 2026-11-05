// A bounded isolate-local circuit breaker, not a global quota ledger.
// Successful probes release their reservations; only confirmed absent documents
// spend the window allowance. Pending probes cannot oversubscribe that allowance.
export function createPublicMissGuard({now=Date.now,windowMs=60000,perClient=10,total=50,maxClients=256}={}) {
  const fresh=at=>({epoch:at,misses:0,pending:0,clients:new Map(),pendingClients:new Map()});
  let state=fresh(now());
  const reset=()=>{
    const at=now();
    if(at<state.epoch||at-state.epoch>=windowMs)state=fresh(at);
  };
  const permits=client=>{
    reset();
    return state.misses+state.pending<total&&
      (state.clients.get(client)||0)+(state.pendingClients.get(client)||0)<perClient&&
      (state.clients.has(client)||state.pendingClients.has(client)||
        new Set([...state.clients.keys(),...state.pendingClients.keys()]).size<maxClients);
  };
  const missing=client=>{
    reset();state.misses++;
    if(state.clients.has(client)||state.clients.size<maxClients)
      state.clients.set(client,(state.clients.get(client)||0)+1);
  };
  return Object.freeze({
    permits,
    missing,
    reserve(client){
      if(!permits(client))return null;
      const held=state;let finished=false;
      held.pending++;held.pendingClients.set(client,(held.pendingClients.get(client)||0)+1);
      return absent=>{
        if(finished)return;finished=true;
        held.pending--;
        const remaining=held.pendingClients.get(client)-1;
        if(remaining)held.pendingClients.set(client,remaining);else held.pendingClients.delete(client);
        reset();
        // A late response from an expired window must not charge a newer window.
        if(absent===true&&state===held)missing(client);
      };
    },
    size(){reset();return state.clients.size;}
  });
}
