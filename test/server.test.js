'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPeon } = require('../src/peon');
const { createServer } = require('../src/server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-editor-http-'));
  const peonDir = path.join(root, 'peon-ping');
  const packDir = path.join(peonDir, 'packs', 'demo');
  fs.mkdirSync(path.join(packDir, 'sounds'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'sounds', 'hi.wav'), 'RIFFdata');
  fs.writeFileSync(
    path.join(packDir, 'openpeon.json'),
    JSON.stringify({ name: 'demo', categories: { 'session.start': { sounds: [{ file: 'sounds/hi.wav', label: 'Hi' }] } } }),
  );
  fs.writeFileSync(path.join(peonDir, 'config.json'), '{}');
  return createPeon({
    peonDir,
    packsDir: path.join(peonDir, 'packs'),
    configPath: path.join(peonDir, 'config.json'),
    movesPath: path.join(root, 'moves.json'),
    peonBin: '',
  });
}

test('HTTP API', async (t) => {
  const server = createServer({ port: 0, peon: fixture() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /peon-editor/);

  assert.deepEqual((await (await fetch(base + '/api/packs')).json()).map((p) => p.name), ['demo']);
  assert.equal((await fetch(base + '/api/pack?name=demo')).status, 200);
  assert.equal((await fetch(base + '/api/pack?name=nope')).status, 404);

  const audio = await fetch(base + '/audio?pack=demo&path=sounds%2Fhi.wav');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(base + '/audio?pack=demo&path=..%2F..%2Fconfig.json')).status, 404);

  const toggled = await post('/api/toggle', { pack: 'demo', category: 'session.start', file: 'hi.wav', enabled: false });
  assert.equal(toggled.status, 200);
  const moved = await post('/api/move', { pack: 'demo', file: 'hi.wav', from: 'session.start', to: 'task.complete' });
  assert.equal(moved.status, 200);
  assert.equal((await post('/api/move', { pack: 'demo', file: 'hi.wav', from: 'task.complete', to: 'nope' })).status, 400);
  assert.equal((await post('/api/toggle', {}, { Origin: 'http://evil.example' })).status, 403);

  assert.equal((await (await fetch(base + '/api/tools')).json()).tools[0].id, 'claude');
  assert.equal((await post('/api/tools', { tool: 'copilot', pack: 'demo' })).status, 200);
  assert.equal((await post('/api/tools', { tool: 'copilot', pack: 'nope' })).status, 400);
  assert.equal((await post('/api/default', { pack: 'demo' })).status, 200);
  assert.equal((await post('/api/tools', { tool: 'copilot', pack: '' }, { Origin: 'http://evil.example' })).status, 403);
});
