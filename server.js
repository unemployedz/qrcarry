const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_PROXY_BYTES = 15 * 1024 * 1024;

const MIME = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp4':'video/mp4','.webm':'video/webm'
};

function privateIp(ip){
  if(ip === '::1' || ip === '0.0.0.0' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m=ip.match(/^172\.(\d+)\./); if(m && +m[1]>=16 && +m[1]<=31) return true;
  if(ip.includes(':')) return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
  return false;
}

async function assertPublicHost(hostname){
  const h=hostname.toLowerCase();
  if(h==='localhost'||h.endsWith('.localhost')) throw new Error('Private network targets are blocked');
  const records=await dns.lookup(h,{all:true,verbatim:true});
  if(!records.length || records.some(r=>privateIp(r.address))) throw new Error('Private network targets are blocked');
}

async function getTarget(req){
  const raw=new URL(req.url,`http://${req.headers.host}`).searchParams.get('url');
  if(!raw) throw new Error('Missing url');
  const target=new URL(raw);
  if(!['http:','https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  await assertPublicHost(target.hostname);
  return target;
}

function proxyLink(raw, base){
  if(!raw) return raw;
  const value=raw.trim();
  if(!value || value.startsWith('#') || /^(data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) return raw;
  try {
    const absolute=new URL(value,base).href;
    if(!/^https?:/i.test(absolute)) return raw;
    return '/api/proxy?url='+encodeURIComponent(absolute);
  } catch { return raw; }
}

function rewriteCss(css, base){
  css=css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,(m,q,u)=>`url("${proxyLink(u,base)}")`);
  css=css.replace(/@import\s+(?:url\()?\s*(["'])([^"']+)\1\s*\)?/gi,(m,q,u)=>m.replace(u,proxyLink(u,base)));
  return css;
}

function rewriteHtml(html,target){
  const base=target.href;
  html=html.replace(/<base[^>]*>/ig,'');
  html=html.replace(/\s(?:src|href|action|poster|cite|formaction)\s*=\s*(["'])(.*?)\1/gi,(m,q,v)=>m.replace(v,proxyLink(v,base)));
  html=html.replace(/\s(?:src|href|action|poster|cite|formaction)\s*=\s*([^\s>]+)/gi,(m,v)=>m.replace(v,proxyLink(v,base)));
  html=html.replace(/\s(?:srcset)\s*=\s*(["'])(.*?)\1/gi,(m,q,v)=>m.replace(v,v.split(',').map(x=>{const p=x.trim().split(/\s+/);p[0]=proxyLink(p[0],base);return p.join(' ')}).join(', ')));
  html=html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,(m,q,u)=>`url("${proxyLink(u,base)}")`);
  html=html.replace(/<meta([^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*)>/ig,(m,a)=>m.replace(/url\s*=\s*([^;>]+)/i,(_,u)=>`url=${proxyLink(u.trim().replace(/^['"]|['"]$/g,''),base)}`));
  const bridge=`<script>(function(){const BASE=${JSON.stringify(base)};const P=u=>{try{const a=new URL(u,BASE);return '/api/proxy?url='+encodeURIComponent(a.href)}catch{return u}};const F=window.fetch;window.fetch=function(i,o){if(typeof i==='string')i=P(i);else if(i&&i.url){try{i=new Request(P(i.url),i)}catch{}}return F.call(this,i,o)};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return X.call(this,m,P(u),...Array.prototype.slice.call(arguments,2))};const B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(this,P(u),d)};window.__QR_CARRY_TARGET__=BASE;})();</script>`;
  return html.replace(/<head([^>]*)>/i,`<head$1>${bridge}`);
}

function safeHeaders(up){
  const out={};
  for(const [k,v] of Object.entries(up)) if(v!==undefined && !['content-security-policy','content-security-policy-report-only','x-frame-options','content-length','content-encoding','transfer-encoding','set-cookie','cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy'].includes(k.toLowerCase())) out[k]=v;
  out['cache-control']='no-store';
  out['access-control-allow-origin']='*';
  out['access-control-allow-methods']='GET,HEAD,POST,OPTIONS';
  out['access-control-allow-headers']='*';
  return out;
}

function upstreamRequest(target, req, res, redirects=0){
  if(redirects>5){res.writeHead(508,{'content-type':'text/plain'});return res.end('Too many redirects');}
  const client=target.protocol==='https:'?https:http;
  const headers={
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (QR Carry proxy)',
    'accept': req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.8',
    'accept-encoding':'identity'
  };
  const request=client.request(target,{method:req.method,headers,timeout:20000},up=>{
    if([301,302,303,307,308].includes(up.statusCode||0) && up.headers.location){
      const next=new URL(up.headers.location,target.href); if(!['http:','https:'].includes(next.protocol)){res.writeHead(400);return res.end('Unsupported redirect');}
      assertPublicHost(next.hostname).then(()=>upstreamRequest(next,req,res,redirects+1)).catch(e=>{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}); return;
    }
    const headersOut=safeHeaders(up.headers);
    const type=String(up.headers['content-type']||'').toLowerCase();
    const chunks=[];let size=0;let tooLarge=false;
    up.on('data',chunk=>{size+=chunk.length;if(size<=MAX_PROXY_BYTES)chunks.push(chunk);else tooLarge=true;});
    up.on('end',()=>{
      if(tooLarge){res.writeHead(413,{'content-type':'text/plain'});return res.end('Upstream response is too large');}
      let body=Buffer.concat(chunks);
      if(type.includes('text/html')){let html=body.toString('utf8');html=rewriteHtml(html,target);body=Buffer.from(html);headersOut['content-type']='text/html; charset=utf-8';}
      else if(type.includes('text/css')){body=Buffer.from(rewriteCss(body.toString('utf8'),target));headersOut['content-type']='text/css; charset=utf-8';}
      headersOut['content-length']=body.length;
      res.writeHead(up.statusCode||200,headersOut);res.end(body);
    });
  });
  request.on('timeout',()=>request.destroy(new Error('Upstream timeout')));
  request.on('error',err=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify({error:err.message}));}else res.destroy();});
  if(req.method!=='GET'&&req.method!=='HEAD') req.pipe(request); else request.end();
}

function serveStatic(req,res){
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host}`).pathname)}catch{res.writeHead(400);return res.end('Bad request');}
  if(pathname==='/health'){res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});return res.end('ok');}
  let relative=pathname==='/'?'/index.html':pathname;
  const file=path.normalize(path.join(ROOT,relative));
  if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end('Forbidden');}
  fs.stat(file,(err,st)=>{
    if(!err&&st.isFile()){const ext=path.extname(file).toLowerCase();res.writeHead(200,{'content-type':MIME[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-cache':'public, max-age=3600'});return fs.createReadStream(file).pipe(res);}
    if(!path.extname(relative)){const fallback=path.join(ROOT,'index.html');return fs.createReadStream(fallback).on('error',()=>{res.writeHead(404);res.end('Not found')}).pipe(res);}
    res.writeHead(404);res.end('Not found');
  });
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,HEAD,POST,OPTIONS','access-control-allow-headers':'*'});return res.end();}
  if(req.url.startsWith('/api/proxy')){try{const target=await getTarget(req);return upstreamRequest(target,req,res);}catch(e){res.writeHead(400,{'content-type':'application/json','access-control-allow-origin':'*'});return res.end(JSON.stringify({error:e.message}));}}
  serveStatic(req,res);
});

server.listen(PORT,'0.0.0.0',()=>console.log(`QR Carry listening on 0.0.0.0:${PORT}`));
