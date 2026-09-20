import crypto from 'node:crypto';
export function encode(value){if(value===null)return {nullValue:null};if(value instanceof Date)return {timestampValue:value.toISOString()};if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};if(typeof value==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]))}};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid number');return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};}return {stringValue:String(value)};}
export function decode(v){if('nullValue'in v)return null;if('mapValue'in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;if('booleanValue'in v)return v.booleanValue;if('timestampValue'in v)return new Date(v.timestampValue);return v.stringValue??null;}
export async function firestoreFailure(response) {
  const error = new Error('Firestore request failed: ' + response.status);
  error.status = response.status;
  const body = await response.json().catch(() => null);
  const code = body?.error?.status;
  if (['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(code)) error.code = code;
  return error;
}
export async function connect(raw){
 const credentials=JSON.parse(raw);if(credentials.project_id!=='polytrack-052')throw Error('Unexpected Firebase project');
 const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const unsigned=b({alg:'RS256',typ:'JWT'})+'.'+b({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+1800});
 const sig=crypto.sign('RSA-SHA256',Buffer.from(unsigned),credentials.private_key).toString('base64url');
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+sig}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Firebase authentication failed: '+r.status);
 const access=(await r.json()).access_token,base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
 let requests=0;async function call(path,body){requests++;const res=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+access,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(res.status===404)return null;if(!res.ok)throw await firestoreFailure(res);return res.json();}
 return {call,get:async(collection,id)=>{const d=await call('/'+collection+'/'+encodeURIComponent(id));return d?{...d,data:decode({mapValue:{fields:d.fields||{}}})}:null;},write:(collection,id,data,prior)=>({update:{name:base.replace('https://firestore.googleapis.com/v1/','')+'/'+collection+'/'+id,fields:encode(data).mapValue.fields},currentDocument:prior?.updateTime?{updateTime:prior.updateTime}:{exists:false}}),requests:()=>requests};
}
