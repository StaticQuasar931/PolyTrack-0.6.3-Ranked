import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.bin':'application/octet-stream'};

// Read-only, loopback-only preview. No production requests and all Firebase writes reject.
export async function startResponsiveServer({baseline=false}={}){
  const baselineFiles=new Set(['index.html','home-ui.css','polytrack_062_patch.js','events/client.mjs','events/events.css','tools/practice-profile.mjs','extra-tracks/catalog-ui.mjs','extra-tracks/catalog.css']);
  const prior=new Map();
  const readText=relative=>{
    if(!baseline||!baselineFiles.has(relative))return fs.readFileSync(path.join(root,relative),'utf8');
    if(!prior.has(relative))prior.set(relative,execFileSync('git',['show','HEAD:'+relative],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024}));
    return prior.get(relative);
  };
  const fixture=fs.readFileSync(new URL('./native-ranked-audit-fixture.mjs',import.meta.url),'utf8');
  const bootstrap=vm.runInNewContext(fixture.match(/const FIREBASE_AUDIT_BOOTSTRAP = (`[\s\S]*?`);/)[1]);
  const server=http.createServer((req,res)=>{
    try{
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:");
      if(pathname==='/'||pathname==='/index.html'){
        const html=readText('index.html').replace('<head>','<head><script>window.__ptNativeRankedAuditRejectWrites=true;'+bootstrap+'</script>');
        res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
      }
      const file=path.resolve(root,'.'+pathname);
      if(!file.startsWith(path.resolve(root)+path.sep)){res.writeHead(403);return res.end();}
      res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
      const relative=path.relative(root,file).replaceAll(path.sep,'/');
      if(baseline&&baselineFiles.has(relative))return res.end(readText(relative));
      fs.createReadStream(file).on('error',()=>{if(!res.headersSent)res.writeHead(404);res.end();}).pipe(res);
    }catch{res.writeHead(500);res.end('Offline audit resource unavailable');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
