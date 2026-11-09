// Imported only after the racer explicitly selects a support-issued local file.
export function validateCloudRecovery(value,{accountId,origin,pathname,now=Date.now()}={}){
 if(!value||value.version!==1||value.projectId!=='polytrack-052'||value.accountId!==accountId||
  value.origin!==origin||value.pathname!==pathname||typeof value.ownerUid!=='string'||!value.ownerUid||value.ownerUid.length>128||
  !Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+15*60000||
  typeof value.customToken!=='string'||value.customToken.length>8192)throw Error('This recovery file is expired or belongs to another racer or website.');
 let claims;try{const part=value.customToken.split('.')[1];claims=JSON.parse(atob(part.replaceAll('-','+').replaceAll('_','/')));}catch{throw Error('Invalid recovery file.');}
 if(claims.uid!==value.ownerUid||claims.aud!=='https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'||
  !Number.isSafeInteger(claims.exp)||claims.exp*1000!==value.expiresAt||!Number.isSafeInteger(claims.iat)||claims.iat*1000>now+30000||claims.exp-claims.iat>900)throw Error('Invalid recovery binding.');
 return value;
}
export async function restoreCloudSignIn(value,{auth,accountId,origin,pathname,now=Date.now(),isCurrent=()=>true}={}){
 const checked=validateCloudRecovery(value,{accountId,origin,pathname,now});
 if(!isCurrent())throw Error('The active racer changed.');
 if(auth.currentUser?.uid===checked.ownerUid)return {restored:false,alreadyCorrect:true,ownerUid:checked.ownerUid};
 // Firebase verifies the signature; the file never changes database ownership.
 const result=await auth.signInWithCustomToken(checked.customToken);
 if(!isCurrent()||result.user?.uid!==checked.ownerUid)throw Error('Sign-in was not confirmed for this racer.');
 return {restored:true,ownerUid:checked.ownerUid};
}
