'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createPeon } = require('./peon');

const { version: VERSION } = require('../package.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aiff': 'audio/aiff' };
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.icns': 'image/x-icns' };
const MAX_BODY = 64 * 1024;
const str = (v) => String(v ?? '');

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer({ peon = createPeon() } = {}) {
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    // Only answer to our own address: a page on another domain that re-points its DNS at 127.0.0.1
    // (DNS rebinding) sends its own Host header and gets nothing
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(String(req.headers.host || '').toLowerCase())) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      // Versioned favicon URL: browsers cache favicons (and failed fetches) hard, so a new version must look new
      const body = Buffer.from(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replaceAll('/favicon.png', `/favicon.png?v=${VERSION}`));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/packs') {
      sendJson(res, 200, peon.listPacks());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, peon.status());
      return;
    }

    const reads = { '/api/quiet': () => peon.quiet(), '/api/folders': () => peon.folders(), '/api/mobile': () => peon.mobile() };
    if (req.method === 'GET' && reads[url.pathname]) {
      sendJson(res, 200, reads[url.pathname]());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      sendJson(res, 200, peon.notifications());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tools') {
      sendJson(res, 200, peon.toolBindings());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/registry') {
      try {
        sendJson(res, 200, await peon.registry({ refresh: url.searchParams.has('refresh') }));
      } catch (err) {
        sendJson(res, 502, { error: `Could not load the pack registry: ${err.message}` });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pack') {
      const state = peon.packState(url.searchParams.get('name') || '');
      sendJson(res, state ? 200 : 404, state || { error: 'not found' });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/api/icon' || url.pathname === '/favicon.png' || url.pathname === '/favicon.ico')) {
      const file = url.pathname === '/api/icon' ? peon.packIcon(url.searchParams.get('pack') || '') : peon.peonIcon();
      const type = IMAGE_TYPES[path.extname(file || '').toLowerCase()];
      if (!file || !type) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/audio') {
      const file = peon.resolveAudio(url.searchParams.get('pack') || '', url.searchParams.get('path') || '');
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': AUDIO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    const actions = {
      '/api/toggle': (p) => peon.setSound(str(p.pack), str(p.category), str(p.file), Boolean(p.enabled)),
      '/api/move': (p) => peon.moveSound(str(p.pack), str(p.file), str(p.from), str(p.to), str(p.before)),
      '/api/tools': (p) => peon.bindTool(str(p.tool), str(p.pack)),
      '/api/default': (p) => peon.setDefaultPack(str(p.pack)),
      '/api/sounds': (p) => peon.setSoundsOn(Boolean(p.on)),
      '/api/volume': (p) => peon.setVolume(p.volume),
      '/api/event': (p) => peon.setEvent(str(p.category), Boolean(p.enabled)),
      '/api/notifications': (p) => peon.setNotifications(p),
      '/api/notifications/test': () => peon.testNotification(),
      '/api/quiet': (p) => peon.setQuiet(p),
      '/api/folders/bind': (p) => peon.bindFolder(p.pattern, str(p.pack)),
      '/api/folders/unbind': (p) => peon.unbindFolder(p.pattern),
      '/api/folders/silence': (p) => peon.silenceFolder(p.pattern, Boolean(p.silenced)),
      '/api/mobile': (p) => peon.setMobile(p),
      '/api/mobile/enabled': (p) => peon.setMobileEnabled(Boolean(p.on)),
      '/api/mobile/test': () => peon.testMobile(),
      '/api/install': (p) => peon.installPack(str(p.pack)),
      '/api/remove': (p) => peon.removePack(str(p.pack)),
    };

    if (req.method === 'POST' && actions[url.pathname]) {
      const origin = req.headers.origin;
      if (origin && !hosts.some((h) => origin === `http://${h}`)) {
        res.writeHead(403).end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJson(res, 400, { ok: false, message: 'bad request' });
        return;
      }
      const result = await actions[url.pathname](payload);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    res.writeHead(404).end();
  });
  return server;
}

module.exports = { createServer };
