const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Busboy = require('busboy');
const sharp = require('sharp');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, GlobalHistogramBinarizer } = require('@zxing/library');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_PROXY_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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

function normalizeTarget(raw){
  const target=new URL(raw);
  if(!['http:','https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');

  // Roblox QR/deferred links are app/deep links. Resolve their web destination first.
  if(target.hostname.toLowerCase()==='ro.blox.com' && target.pathname.toLowerCase().startsWith('/ebh5')){
    const web=target.searchParams.get('af_web_dp');
    if(web){
      const decoded=new URL(web);
      if(['http:','https:'].includes(decoded.protocol)) return decoded;
    }
  }

  // Canonicalize Roblox root so the proxy receives the normal web host.
  if(target.hostname.toLowerCase()==='roblox.com') target.hostname='www.roblox.com';
  return target;
}

async function getTarget(req){
  const raw=new URL(req.url,`http://${req.headers.host}`).searchParams.get('url');
  if(!raw) throw new Error('Missing url');
  const target=normalizeTarget(raw);
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

  // Keep relative navigation and browser APIs inside the proxy.
  const bridge=`<script>(function(){const BASE=${JSON.stringify(base)};const P=u=>{try{const a=new URL(u,BASE);if(!/^https?:$/i.test(a.protocol))return u;return '/api/proxy?url='+encodeURIComponent(a.href)}catch{return u}};const F=window.fetch;window.fetch=function(i,o){if(typeof i==='string')i=P(i);else if(i&&i.url){try{i=new Request(P(i.url),i)}catch{}}return F.call(this,i,o)};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return X.call(this,m,P(u),...Array.prototype.slice.call(arguments,2))};const B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(this,P(u),d)};const O=window.open;window.open=function(u,n,f){return O.call(window,P(u),n,f)};window.__QR_CARRY_TARGET__=BASE;})();</script>`;
  return html.replace(/<head([^>]*)>/i,`<head$1>${bridge}`);
}

function safeHeaders(up){
  const out={};
  const blocked=new Set(['content-security-policy','content-security-policy-report-only','x-frame-options','content-length','content-encoding','transfer-encoding','set-cookie','cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy','strict-transport-security']);
  for(const [k,v] of Object.entries(up)) if(v!==undefined&&!blocked.has(k.toLowerCase())) out[k]=v;
  out['cache-control']='no-store';
  out['access-control-allow-origin']='*';
  out['access-control-allow-methods']='GET,HEAD,POST,OPTIONS';
  out['access-control-allow-headers']='*';
  return out;
}

function upstreamRequest(target, req, res, redirects=0){
  if(redirects>7){res.writeHead(508,{'content-type':'text/plain'});return res.end('Too many redirects');}
  const client=target.protocol==='https:'?https:http;
  const headers={
    'host':target.host,
    'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 QR-Cary',
    'accept':req.headers.accept||'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':req.headers['accept-language']||'en-US,en;q=0.8',
    'accept-encoding':'identity',
    'referer':target.origin+'/'
  };
  if(req.headers['content-type']) headers['content-type']=req.headers['content-type'];
  const request=client.request(target,{method:req.method,headers,timeout:25000},up=>{
    if([301,302,303,307,308].includes(up.statusCode||0)&&up.headers.location){
      let next;try{next=normalizeTarget(new URL(up.headers.location,target.href).href);}catch(e){res.writeHead(400,{'content-type':'text/plain'});return res.end(e.message);}
      assertPublicHost(next.hostname).then(()=>upstreamRequest(next,req,res,redirects+1)).catch(e=>{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));});return;
    }
    const headersOut=safeHeaders(up.headers);
    const type=String(up.headers['content-type']||'').toLowerCase();
    const chunks=[];let size=0;let tooLarge=false;
    up.on('data',chunk=>{size+=chunk.length;if(size<=MAX_PROXY_BYTES)chunks.push(chunk);else tooLarge=true;});
    up.on('end',()=>{
      if(tooLarge){res.writeHead(413,{'content-type':'text/plain'});return res.end('Upstream response is too large');}
      let body=Buffer.concat(chunks);
      if(type.includes('text/html')){body=Buffer.from(rewriteHtml(body.toString('utf8'),target));headersOut['content-type']='text/html; charset=utf-8';}
      else if(type.includes('text/css')){body=Buffer.from(rewriteCss(body.toString('utf8'),target));headersOut['content-type']='text/css; charset=utf-8';}
      headersOut['content-length']=body.length;
      res.writeHead(up.statusCode||200,headersOut);res.end(body);
    });
  });
  request.on('timeout',()=>request.destroy(new Error('Upstream timeout')));
  request.on('error',err=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify({error:err.message}));}else res.destroy();});
  if(req.method!=='GET'&&req.method!=='HEAD') req.pipe(request); else request.end();
}

function decodeWithZXing(raw,width,height){
  const luminance=new Uint8Array(width*height);
  for(let i=0,p=0;i<luminance.length;i++,p+=4){
    luminance[i]=((raw[p]*0.299)+(raw[p+1]*0.587)+(raw[p+2]*0.114))&255;
  }
  const hints=new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER,true);
  const sources=[new RGBLuminanceSource(luminance,width,height)];
  for(const source of sources){
    for(const Binarizer of [HybridBinarizer,GlobalHistogramBinarizer]){
      try{
        const reader=new MultiFormatReader();reader.setHints(hints);
        const result=reader.decode(new BinaryBitmap(new Binarizer(source)),hints);
        if(result?.getText()) return result.getText();
      }catch{}
    }
  }
  return null;
}

function decodeUpload(req,res){
  const contentType=String(req.headers['content-type']||'');
  if(!contentType.toLowerCase().startsWith('multipart/form-data')){res.writeHead(415,{'content-type':'application/json'});return res.end(JSON.stringify({error:'Expected multipart/form-data'}));}
  const bb=Busboy({headers:req.headers,limits:{files:1,fileSize:MAX_UPLOAD_BYTES}});
  let fileChunks=[];let sawFile=false;let tooLarge=false;
  bb.on('file',(name,file)=>{sawFile=true;file.on('data',chunk=>fileChunks.push(chunk));file.on('limit',()=>{tooLarge=true});});
  bb.on('error',err=>{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:err.message}));});
  bb.on('finish',async()=>{
    if(tooLarge){res.writeHead(413,{'content-type':'application/json'});return res.end(JSON.stringify({error:'Image is larger than 20 MB'}));}
    if(!sawFile){res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:'No image file received'}));}
    try{
      const input=Buffer.concat(fileChunks);
      const image=sharp(input,{limitInputPixels:40e6});
      const meta=await image.metadata();
      if(!meta.width||!meta.height) throw new Error('Unsupported image format');
      const scale=Math.min(1,2400/Math.max(meta.width,meta.height));
      const prepared=await sharp(input,{limitInputPixels:40e6}).rotate().resize({width:Math.max(1,Math.round(meta.width*scale)),height:Math.max(1,Math.round(meta.height*scale)),fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      let data=decodeWithZXing(prepared.data,prepared.info.width,prepared.info.height);
      if(!data){
        const gray=await sharp(input,{limitInputPixels:40e6}).rotate().resize({width:Math.max(1,Math.round(meta.width*scale)),height:Math.max(1,Math.round(meta.height*scale)),fit:'inside',withoutEnlargement:true}).grayscale().raw().toBuffer({resolveWithObject:true});
        const rgba=new Uint8Array(gray.info.width*gray.info.height*4);for(let i=0;i<gray.data.length;i++){const v=gray.data[i];const p=i*4;rgba[p]=v;rgba[p+1]=v;rgba[p+2]=v;rgba[p+3]=255;}data=decodeWithZXing(rgba,gray.info.width,gray.info.height);
      }
      if(!data){res.writeHead(422,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({error:'No QR code could be decoded'}));}
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify({data}));
    }catch(err){res.writeHead(422,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:err.message||'Unable to decode image'}));}
  });
  req.pipe(bb);
}

function serveStatic(req,res){
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host}`).pathname)}catch{res.writeHead(400);return res.end('Bad request');}
  if(pathname==='/health'){res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});return res.end('ok');}
  const relative=pathname==='/'?'/index.html':pathname;
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
  if(req.url.startsWith('/api/decode')) return decodeUpload(req,res);
  if(req.url.startsWith('/api/proxy')){try{const target=await getTarget(req);return upstreamRequest(target,req,res);}catch(e){res.writeHead(400,{'content-type':'application/json','access-control-allow-origin':'*'});return res.end(JSON.stringify({error:e.message}));}}
  serveStatic(req,res);
});

server.listen(PORT,'0.0.0.0',()=>console.log(`QR Carry listening on 0.0.0.0:${PORT}`));
