export const NAME_CLAIMS_COLLECTION = '0.6.2_name_claims';

// Firestore Rules lower() folds ASCII only. Preserve other scripts identically on both sides.
export const foldPublicName = name => name.replace(/[A-Z]/g, letter => letter.toLowerCase());

export async function publicNameKey(name, crypto = globalThis.crypto) {
  if (typeof name !== 'string' || !name.length || name.length > 24) throw new TypeError('Invalid public name');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(foldPublicName(name)));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

function ownershipError() {
  return Object.assign(new Error('This racer belongs to a different cloud session.'), {code:'account-session-conflict'});
}

// Call after reading the profile and any PB documents, before scheduling other writes.
// Unchanged profiles do not need a registry read. Name changes claim/release atomically.
export async function claimProfileName({tx, db, accountId, ownerUid, previous = null, requestedName, now = Date.now(), crypto = globalThis.crypto, isNameAllowed = () => true}) {
  if (!accountId || !ownerUid || typeof accountId !== 'string' || accountId.length > 128) throw ownershipError();
  if (previous && (previous.ownerUid !== ownerUid || previous.accountId !== accountId)) throw ownershipError();
  if (typeof requestedName !== 'string' || !requestedName.trim() || requestedName.length > 24 || /[\u0000-\u001f\u007f]/.test(requestedName)) {
    throw Object.assign(new Error('Choose a valid racer name.'), {code:'invalid-public-name'});
  }
  if (previous?.name === requestedName && previous?.nickname === requestedName) return requestedName;
  const claims = db.collection(NAME_CLAIMS_COLLECTION), read = new Map();
  async function inspect(name) {
    const key = await publicNameKey(name, crypto);
    if (!read.has(key)) {
      const ref = claims.doc(key);let snapshot;
      try{snapshot=await tx.get(ref);}catch(cause){
        if(!['permission-denied','firestore/permission-denied'].includes(cause?.code))throw cause;
        throw Object.assign(new Error('Name registry is not available to this client.',{cause}),{code:cause.code,nameClaimReadDenied:true});
      }
      read.set(key, {key, ref, data:snapshot.exists ? snapshot.data() : null});
    }
    return read.get(key);
  }
  const candidates = [requestedName];
  if (previous?.name && previous.name !== requestedName && previous.name.length <= 24 && isNameAllowed(previous.name)) candidates.push(previous.name);
  // Use the full account ID for suffixes, not its shared/truncated prefix.
  const accountBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId));
  const accountHash = Array.from(new Uint8Array(accountBytes), value => value.toString(16).padStart(2,'0')).join('');
  for (const length of [4,6,8,12,16]) candidates.push(requestedName.slice(0,23-length)+'-'+accountHash.slice(0,length));
  let selected = null, name = '';
  for (const candidate of candidates) {
    if (!isNameAllowed(candidate)) continue;
    const claim = await inspect(candidate);
    if (!claim.data || claim.data.accountId === accountId) { selected = claim; name = candidate; break; }
  }
  if (!selected) throw Object.assign(new Error('That name is unavailable. Choose another name.'), {code:'public-name-unavailable'});
  const old = previous?.nickname ? await inspect(previous.nickname) : null;
  if (!selected.data || selected.data.name !== name) tx.set(selected.ref, {
    accountId, name, createdAt:selected.data?.createdAt ?? now
  });
  if (old?.key !== selected.key && old?.data?.accountId === accountId) tx.delete(old.ref);
  return name;
}

// Rollout bridge only: the active server rules still decide whether any profile write is legal.
// No network/quota/conflict failure is downgraded, and claims are read before any writes.
export async function claimProfileNameWithLegacyBridge(options){
  try{return {name:await claimProfileName(options),legacy:false};}
  catch(error){
    if(error.nameClaimReadDenied===true)return {name:options.requestedName,legacy:true};
    throw error;
  }
}
