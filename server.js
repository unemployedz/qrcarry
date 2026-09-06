const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Busboy = require('busboy');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const jsQR = require('jsqr');
const {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  GlobalHistogramBinarizer
} = require('@zxing/library');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_PROXY_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const MIME = {
  '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.xml':'application/xml; charset=utf-8', '.txt':'text/plain; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.avif':'image/avif', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf',
  '.mp4':'video/mp4', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav'
};

function privateIp(ip) {
  if (ip === '::1' || ip === '0.0.0.0' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip.includes(':')) return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || /^::ffff:(127|10|192\.168)\./.test(ip);
  return false;
}

async function assertPublicHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) throw new Error('Private network targets are blocked');
  const records = await dns.lookup(h, { all: true, verbatim: true });
  if (!records.length || records.some(r => privateIp(r.address))) throw new Error('Private network targets are blocked');
}

function normalizeTarget(raw) {
  const target = new URL(raw);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (target.hostname.toLowerCase() === 'roblox.com') target.hostname = 'www.roblox.com';
  return target;
}

async function getTarget(req) {
  const raw = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
  if (!raw) throw new Error('Missing url');
  const target = normalizeTarget(raw);
  await assertPublicHost(target.hostname);
  return target;
}

function proxyLink(raw, base) {
  if (!raw) return raw;
  const value = raw.trim();
  if (!value || value.startsWith('#') || /^(data:|blob:|javascript:|mailto:|tel:|about:|vbscript:)/i.test(value)) return raw;
  if (value.startsWith('/api/proxy?') || value.startsWith('/api/ws?')) return value;
  try {
    const absolute = new URL(value, base).href;
    if (!/^https?:/i.test(absolute)) return raw;
    return '/api/proxy?url=' + encodeURIComponent(absolute);
  } catch {
    return raw;
  }
}

function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => `url("${proxyLink(u, base)}")`);
  css = css.replace(/@import\s+(?:url\()?\s*(["'])([^"']+)\1\s*\)?/gi, (m, q, u) => m.replace(u, proxyLink(u, base)));
  return css;
}

function rewriteHtml(html, target) {
  const base = target.href;
  html = html.replace(/<base[^>]*>/ig, '');
  // SRI hashes are invalid after proxy rewriting, so remove integrity checks for rewritten assets.
  html = html.replace(/\s(?:integrity|crossorigin|nonce)\s*=\s*(["']).*?\1/gi, '');
  html = html.replace(/\s(?:src|href|action|poster|cite|formaction|data-src|data-href)\s*=\s*(["'])(.*?)\1/gi, (m, q, v) => m.replace(v, proxyLink(v, base)));
  html = html.replace(/\s(?:src|href|action|poster|cite|formaction|data-src|data-href)\s*=\s*([^\s>]+)/gi, (m, v) => m.replace(v, proxyLink(v, base)));
  html = html.replace(/\s(?:srcset|imagesrcset)\s*=\s*(["'])(.*?)\1/gi, (m, q, v) => m.replace(v, v.split(',').map(x => { const p = x.trim().split(/\s+/); p[0] = proxyLink(p[0], base); return p.join(' '); }).join(', ')));
  html = html.replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (m, q, v) => m.replace(v, rewriteCss(v, base)));
  html = html.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => `url("${proxyLink(u, base)}")`);
  html = html.replace(/<meta([^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*)>/ig, (m) => m.replace(/url\s*=\s*([^;>]+)/i, (_, u) => `url=${proxyLink(u.trim().replace(/^['"]|['"]$/g, ''), base)}`));

  const bridge = `<script>(function(){
const BASE=${JSON.stringify(base)}, ORIGIN=location.origin;
const isProxy=u=>typeof u==='string'&&(/^(?:\\/api\\/(?:proxy|ws)\\?)/.test(u)||u.startsWith(ORIGIN+'/api/proxy?')||u.startsWith(ORIGIN+'/api/ws?'));
const P=u=>{try{if(!u||isProxy(u))return u;const a=new URL(u,BASE);if(!/^https?:$/i.test(a.protocol))return u;return '/api/proxy?url='+encodeURIComponent(a.href)}catch{return u}};
const F=window.fetch;if(F)window.fetch=function(i,o){if(typeof i==='string')i=P(i);else if(i&&i.url&&!isProxy(i.url)){try{i=new Request(P(i.url),i)}catch{}}return F.call(this,i,o)};
const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return X.call(this,m,P(u),...Array.prototype.slice.call(arguments,2))};
const B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(this,P(u),d)};
const O=window.open;if(O)window.open=function(u,n,f){return O.call(window,P(u),n,f)};
const HP=history.pushState,HR=history.replaceState;history.pushState=function(s,t,u){return HP.call(this,s,t,u&&P(u))};history.replaceState=function(s,t,u){return HR.call(this,s,t,u&&P(u))};
const origSet=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(src|href|action|poster|cite|formaction|data-src|data-href)$/i.test(n))v=P(v);return origSet.call(this,n,v)};
for(const C of [HTMLImageElement,HTMLScriptElement,HTMLIFrameElement,HTMLSourceElement,HTMLVideoElement,HTMLAudioElement]){if(!C||!C.prototype)continue;const d=Object.getOwnPropertyDescriptor(C.prototype,'src');if(d&&d.set){Object.defineProperty(C.prototype,'src',{...d,set(v){return d.set.call(this,P(v))}})}}
const lh=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'href');if(lh&&lh.set)Object.defineProperty(HTMLLinkElement.prototype,'href',{...lh,set(v){return lh.set.call(this,P(v))}});
const fix=el=>{if(!(el instanceof Element))return;for(const a of ['src','href','action','poster','cite','formaction','data-src','data-href'])if(el.hasAttribute(a)){const v=el.getAttribute(a),p=P(v);if(p&&p!==v)origSet.call(el,a,p)}};
new MutationObserver(ms=>ms.forEach(m=>m.type==='childList'?m.addedNodes.forEach(n=>{fix(n);if(n.querySelectorAll)n.querySelectorAll('[src],[href],[action],[poster],[data-src],[data-href]').forEach(fix)}):m.type==='attributes'&&fix(m.target))).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','action','poster','cite','formaction','data-src','data-href']});
window.__QR_CARRY_TARGET__=BASE;
})();</script>`;
  return html.replace(/<head([^>]*)>/i, `<head$1>${bridge}`);
}

function safeHeaders(up) {
  const out = {};
  const blocked = new Set([
    'content-security-policy','content-security-policy-report-only','x-frame-options','content-length','content-encoding','transfer-encoding',
    'set-cookie','set-cookie2','cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy','strict-transport-security',
    'permissions-policy','origin-agent-cluster'
  ]);
  for (const [k,v] of Object.entries(up)) if (v !== undefined && !blocked.has(k.toLowerCase())) out[k] = v;
  out['cache-control'] = 'no-store';
  out['access-control-allow-origin'] = '*';
  out['access-control-allow-methods'] = 'GET,HEAD,POST,OPTIONS';
  out['access-control-allow-headers'] = '*';
  return out;
}

function upstreamRequest(target, req, res, redirects=0) {
  if (redirects > MAX_REDIRECTS) { res.writeHead(508, {'content-type':'text/plain'}); return res.end('Too many redirects'); }
  const client = target.protocol === 'https:' ? https : http;
  const headers = {
    host: target.host,
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/605.1.15 QR-Cary',
    accept: req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.8',
    'accept-encoding': 'identity',
    referer: target.origin + '/'
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const request = client.request(target, {method:req.method, headers, timeout:30000}, up => {
    if ([301,302,303,307,308].includes(up.statusCode || 0) && up.headers.location) {
      let next;
      try { next = normalizeTarget(new URL(up.headers.location, target.href).href); }
      catch(e) { res.writeHead(400, {'content-type':'text/plain'}); return res.end(e.message); }
      assertPublicHost(next.hostname).then(() => upstreamRequest(next, req, res, redirects+1)).catch(e => { res.writeHead(502, {'content-type':'application/json'}); res.end(JSON.stringify({error:e.message})); });
      return;
    }
    const headersOut = safeHeaders(up.headers);
    const type = String(up.headers['content-type'] || '').toLowerCase();
    const chunks = []; let size = 0; let tooLarge = false;
    up.on('data', chunk => { size += chunk.length; if (size <= MAX_PROXY_BYTES) chunks.push(chunk); else tooLarge = true; });
    up.on('end', () => {
      if (tooLarge) { res.writeHead(413, {'content-type':'text/plain'}); return res.end('Upstream response is too large'); }
      let body = Buffer.concat(chunks);
      if (type.includes('text/html') || type.includes('application/xhtml+xml')) {
        body = Buffer.from(rewriteHtml(body.toString('utf8'), target));
        headersOut['content-type'] = 'text/html; charset=utf-8';
      } else if (type.includes('text/css')) {
        body = Buffer.from(rewriteCss(body.toString('utf8'), target));
        headersOut['content-type'] = 'text/css; charset=utf-8';
      }
      headersOut['content-length'] = body.length;
      res.writeHead(up.statusCode || 200, headersOut); res.end(body);
    });
  });
  request.on('timeout', () => request.destroy(new Error('Upstream timeout')));
  request.on('error', err => { if (!res.headersSent) { res.writeHead(502, {'content-type':'application/json','access-control-allow-origin':'*'}); res.end(JSON.stringify({error:err.message})); } else res.destroy(); });
  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(request); else request.end();
}

function rgbaToLuminance(raw) {
  const out = new Uint8ClampedArray(Math.floor(raw.length / 4));
  for (let i=0,p=0;i<out.length;i++,p+=4) out[i] = (0.299*raw[p] + 0.587*raw[p+1] + 0.114*raw[p+2]) | 0;
  return out;
}

function decodeZXing(raw,width,height) {
  const lum = rgbaToLuminance(raw);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      const source = new RGBLuminanceSource(lum, width, height);
      const reader = new MultiFormatReader(); reader.setHints(hints);
      const result = reader.decode(new BinaryBitmap(new Binarizer(source)));
      if (result && result.getText()) return result.getText();
    } catch {}
  }
  return null;
}

function decodeJsQR(raw,width,height) {
  for (const inversionAttempts of ['attemptBoth','dontInvert','onlyInvert']) {
    try {
      const result = jsQR(new Uint8ClampedArray(raw), width, height, {inversionAttempts, greyScaleWeights:{red:0.299,green:0.587,blue:0.114}});
      if (result && result.data) return result.data;
    } catch {}
  }
  return null;
}

async function decodeImageBuffer(input) {
  let source = input;
  const signature = input.subarray(4,12).toString('ascii').toLowerCase();
  if (signature.includes('heic') || signature.includes('heix') || signature.includes('heif') || signature.includes('mif1') || signature.includes('msf1')) {
    source = await heicConvert({buffer:input, format:'PNG'});
  }
  const meta = await sharp(source, {limitInputPixels:50e6}).metadata();
  if (!meta.width || !meta.height) throw new Error('Unsupported image format');
  const longest = Math.max(meta.width, meta.height);
  const sizes = [...new Set([Math.min(2600,longest), Math.min(1800,longest), Math.min(1200,longest)])].filter(Boolean);
  for (const size of sizes) {
    const base = sharp(source, {limitInputPixels:50e6}).rotate().resize({width:size,height:size,fit:'inside',withoutEnlargement:true});
    const variants = [
      base.clone().removeAlpha().raw().toBuffer({resolveWithObject:true}),
      base.clone().grayscale().normalise().sharpen().ensureAlpha().raw().toBuffer({resolveWithObject:true}),
      base.clone().grayscale().linear(1.35,-35).ensureAlpha().raw().toBuffer({resolveWithObject:true}),
      base.clone().grayscale().threshold(160).ensureAlpha().raw().toBuffer({resolveWithObject:true})
    ];
    for (const pending of variants) {
      try {
        const prepared = await pending;
        const channels = prepared.info.channels;
        let rgba;
        if (channels === 4) rgba = prepared.data;
        else if (channels === 3) {
          rgba = new Uint8ClampedArray(prepared.info.width*prepared.info.height*4);
          for(let i=0,j=0;i<prepared.data.length;i+=3,j+=4){rgba[j]=prepared.data[i];rgba[j+1]=prepared.data[i+1];rgba[j+2]=prepared.data[i+2];rgba[j+3]=255;}
        } else {
          rgba = new Uint8ClampedArray(prepared.info.width*prepared.info.height*4);
          for(let i=0,j=0;i<prepared.data.length;i++,j+=4){const v=prepared.data[i];rgba[j]=v;rgba[j+1]=v;rgba[j+2]=v;rgba[j+3]=255;}
        }
        const data = decodeJsQR(rgba, prepared.info.width, prepared.info.height) || decodeZXing(rgba, prepared.info.width, prepared.info.height);
        if (data) return data;
      } catch {}
    }
  }
  return null;
}

function decodeUpload(req,res) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) { res.writeHead(415, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'Expected multipart/form-data'})); }
  const bb = Busboy({headers:req.headers, limits:{files:1,fileSize:MAX_UPLOAD_BYTES}});
  const fileChunks = []; let sawFile=false; let tooLarge=false;
  bb.on('file', (name,file) => { sawFile=true; file.on('data', chunk => fileChunks.push(chunk)); file.on('limit', () => {tooLarge=true;}); });
  bb.on('error', err => { if (!res.headersSent) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:err.message})); } });
  bb.on('finish', async () => {
    if (tooLarge) { res.writeHead(413, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'Image is larger than 25 MB'})); }
    if (!sawFile) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'No image file received'})); }
    try {
      const data = await decodeImageBuffer(Buffer.concat(fileChunks));
      if (!data) { res.writeHead(422, {'content-type':'application/json','cache-control':'no-store'}); return res.end(JSON.stringify({error:'No QR code could be decoded. Try the original photo or a crop with the QR filling more of the image.'})); }
      res.writeHead(200, {'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'});
      res.end(JSON.stringify({data}));
    } catch(err) {
      res.writeHead(422, {'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({error:err.message || 'Unable to decode this image'}));
    }
  });
  req.pipe(bb);
}

function serveStatic(req,res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/health') { res.writeHead(200, {'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}); return res.end('ok'); }
  const relative = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, relative));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err,st) => {
    if (!err && st.isFile()) { const ext=path.extname(file).toLowerCase(); res.writeHead(200, {'content-type':MIME[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-cache':'public, max-age=3600'}); return fs.createReadStream(file).pipe(res); }
    if (!path.extname(relative)) { const fallback=path.join(ROOT,'index.html'); return fs.createReadStream(fallback).on('error',()=>{res.writeHead(404);res.end('Not found')}).pipe(res); }
    res.writeHead(404); res.end('Not found');
  });
}

const server = http.createServer(async (req,res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'access-control-allow-origin':'*','access-control-allow-methods':'GET,HEAD,POST,OPTIONS','access-control-allow-headers':'*'}); return res.end(); }
  if (req.url.startsWith('/api/decode')) return decodeUpload(req,res);
  if (req.url.startsWith('/api/proxy')) {
    try { const target=await getTarget(req); return upstreamRequest(target,req,res); }
    catch(e) { res.writeHead(400, {'content-type':'application/json','access-control-allow-origin':'*'}); return res.end(JSON.stringify({error:e.message})); }
  }
  if (req.url.startsWith('/api/ws')) { res.writeHead(426, {'content-type':'text/plain'}); return res.end('WebSocket proxy requires an upgraded connection'); }
  return serveStatic(req,res);
});

// WebSocket compatibility bridge for sites that use ws/wss for live updates.
const wss = new WebSocket.Server({noServer:true});
wss.on('connection',(client,target) => {
  const upstream = new WebSocket(target, {headers:{'user-agent':'Mozilla/5.0 QR-Cary'}});
  upstream.on('open',()=>client.send(JSON.stringify({type:'qr-carry-open'})));
  upstream.on('message',(data,isBinary)=>client.send(data,{binary:isBinary}));
  upstream.on('close',(code,reason)=>client.close(code,reason));
  upstream.on('error',()=>client.close());
  client.on('message',(data,isBinary)=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(data,{binary:isBinary});});
  client.on('close',()=>upstream.close());
});
server.on('upgrade',(req,socket,head)=>{
  try {
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(u.pathname!=='/api/ws') return socket.destroy();
    const raw=u.searchParams.get('url'); if(!raw) return socket.destroy();
    const target=normalizeTarget(raw); if(!['http:','https:'].includes(target.protocol)) return socket.destroy();
    const wsTarget=(target.protocol==='https:'?'wss:':'ws:')+'//'+target.host+target.pathname+target.search;
    assertPublicHost(target.hostname).then(()=>wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,wsTarget))).catch(()=>socket.destroy());
  } catch { socket.destroy(); }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`QR Carry listening on 0.0.0.0:${PORT}`));
