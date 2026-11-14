// Local draft only. No imports, automatic requests, retries, or persisted tokens.
const ORIGIN='https://polytrack-ranked-worker.staticquasar931.workers.dev';
const ACCOUNT=/^[a-f0-9]{64}$/;
const REQUEST=/^[A-Za-z0-9_-]{8,80}$/;
const POSTS=Object.freeze({'/v1/currency/claim':'rewardId','/v1/shop/purchase':'itemId','/v1/shop/equip':'itemId'});
export class ShopTransportError extends Error {
  constructor(code,{status=0,ambiguous=false,notCommitted=false}={}){super(code);this.name='ShopTransportError';this.code=code;this.status=status;this.ambiguous=ambiguous;this.notCommitted=notCommitted===true;}
}
function validate(path,method,body){
  if(typeof path!=='string')throw new ShopTransportError('invalid_shop_request');
  const url=new URL(path,ORIGIN);
  if(url.origin!==ORIGIN||url.hash||!path.startsWith('/v1/')||path.includes('\\'))throw new ShopTransportError('invalid_shop_request');
  if(method==='GET'){
    if(body!==undefined)throw new ShopTransportError('invalid_shop_request');
    if(path==='/v1/shop/catalog')return url;
    if(url.pathname==='/v1/currency/wallet'&&[...url.searchParams].length===1&&ACCOUNT.test(url.searchParams.get('accountId')||''))return url;
  }else if(method==='POST'&&Object.hasOwn(POSTS,path)){
    const field=POSTS[path];
    const quoted=path==='/v1/shop/purchase'&&body?.catalogVersion===2;
    const fields=quoted?['accountId','requestId',field,'catalogVersion','expectedPrice','expectedWalletRevision']:['accountId','requestId',field];
    if(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===fields.length&&
      Object.keys(body).every(k=>fields.includes(k))&&(!quoted||(Number.isSafeInteger(body.expectedPrice)&&body.expectedPrice>=0&&Number.isSafeInteger(body.expectedWalletRevision)&&body.expectedWalletRevision>=0))&&ACCOUNT.test(body.accountId||'')&&REQUEST.test(body.requestId||'')&&
      typeof body[field]==='string'&&/^[a-z0-9-]{1,80}$/.test(body[field]))return url;
  }
  throw new ShopTransportError('invalid_shop_request');
}
function abortable(value,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new ShopTransportError('shop_request_cancelled'));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(value).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function readJSON(response){
  const reader=response.body?.getReader();if(!reader)throw Error('missing_shop_response');
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>65536)throw Error('oversized_shop_response');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_shop_response');return value;
}
export function createShopTransport({fetch:fetcher=globalThis.fetch,getToken,revision,timeoutMs=15000}={}){
  if(!Number.isSafeInteger(revision)||revision<1||revision>1000000||typeof fetcher!=='function'||typeof getToken!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('invalid_shop_transport');
  return async({path,method='GET',body,signal}={})=>{
    const url=validate(path,method,body),encodedBody=body===undefined?undefined:JSON.stringify(body),controller=new AbortController();
    if(signal?.aborted)throw new ShopTransportError('shop_request_cancelled');
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,timeoutMs);let sent=false;
    try{
      const token=await abortable(getToken({signal:controller.signal}),controller.signal);
      if(controller.signal.aborted)throw new ShopTransportError('shop_request_cancelled');
      if(typeof token!=='string'||!token||token.length>16384||/[\r\n]/.test(token))throw new ShopTransportError('authentication_required',{status:401});
      const headers={'Accept':'application/json','Authorization':'Bearer '+token,'X-PolyTrack-Revision':String(revision)};if(method==='POST')headers['Content-Type']='application/json';
      sent=true;
      const response=await fetcher(url.href,{method,headers,body:encodedBody,signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
      let value;try{value=await readJSON(response);}catch{throw new ShopTransportError('invalid_shop_response',{status:response.status,ambiguous:method==='POST'});}
      if(!response.ok){const code=typeof value.error==='string'&&/^[a-z0-9_]{1,80}$/.test(value.error)?value.error:'shop_unavailable';throw new ShopTransportError(code,{status:response.status,ambiguous:method==='POST'&&response.status>=500&&code!=='currency_disabled',notCommitted:value.notCommitted===true&&response.status>=400&&response.status<500});}
      return value;
    }catch(error){
      if(error instanceof ShopTransportError)throw error;
      throw new ShopTransportError(controller.signal.aborted?'shop_request_cancelled':'shop_unavailable',{ambiguous:sent&&method==='POST'});
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
}
