const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return false;
}

function targetFrom(req) {
  const raw = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url');
  if (!raw) throw new Error('Missing url');
  const target = new URL(raw);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (isPrivateHost(target.hostname)) throw new Error('Private network targets are blocked');
  return target;
}

function requestTarget(target, req, res) {
  const client = target.protocol === 'https:' ? https : http;
  const headers = { 'user-agent': req.headers['user-agent'] || 'QRCarry/1.0', 'accept': req.headers.accept || '*/*', 'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.8' };
  const upstream = client.request(target, { method: req.method, headers, timeout: 15000 }, upstreamRes => {
    const out = { ...upstreamRes.headers };
    delete out['x-frame-options'];
    delete out['content-security-policy'];
    delete out['content-security-policy-report-only'];
    delete out['content-length'];
    out['cache-control'] = 'no-store';
    out['access-control-allow-origin'] = '*';

    const type = String(upstreamRes.headers['content-type'] || '').toLowerCase();
    if (type.includes('text/html') && !String(upstreamRes.headers['content-encoding'] || '')) {
      const chunks=[]; upstreamRes.on('data', c => chunks.push(c));
      upstreamRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        const base = target.href.replace(/"/g, '&quot;');
        html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
        html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/ig, '');
        const body = Buffer.from(html);
        out['content-type'] = 'text/html; charset=utf-8'; out['content-length'] = body.length;
        res.writeHead(upstreamRes.statusCode || 200, out); res.end(body);
      });
    } else {
      res.writeHead(upstreamRes.statusCode || 200, out); upstreamRes.pipe(res);
    }
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', err => { if (!res.headersSent) { res.writeHead(502, {'content-type':'application/json','access-control-allow-origin':'*'}); res.end(JSON.stringify({error: err.message})); } else res.destroy(); });
  upstream.end();
}

const server = http.createServer((req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('ok'); }
  if (req.url.startsWith('/api/proxy')) {
    try { return requestTarget(targetFrom(req), req, res); } catch (e) { res.writeHead(400, {'content-type':'application/json','access-control-allow-origin':'*'}); return res.end(JSON.stringify({error:e.message})); }
  }
  res.writeHead(404, {'content-type':'text/plain'}); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`QR Carry proxy listening on ${PORT}`));
