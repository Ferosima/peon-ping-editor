'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPeon } = require('../src/peon');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-editor-'));
  const peonDir = path.join(root, 'peon-ping');
  const packDir = path.join(peonDir, 'packs', 'demo');
  fs.mkdirSync(path.join(packDir, 'sounds'), { recursive: true });
  for (const f of ['hi.wav', 'done.wav', 'wait.wav']) fs.writeFileSync(path.join(packDir, 'sounds', f), 'RIFF');
  const manifest = {
    name: 'demo',
    display_name: 'Demo',
    categories: {
      'session.start': { sounds: [{ file: 'sounds/hi.wav', label: 'Hi' }] },
      'task.complete': { sounds: [{ file: 'sounds/done.wav', label: 'Done' }] },
      'input.required': { sounds: [{ file: 'sounds/wait.wav', label: 'Wait' }] },
    },
  };
  fs.writeFileSync(path.join(packDir, 'openpeon.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(peonDir, 'config.json'), JSON.stringify({ default_pack: 'demo', ide_rules: [{ ide: 'claude', pack: 'demo' }] }));
  const peon = createPeon({
    peonDir,
    packsDir: path.join(peonDir, 'packs'),
    configPath: path.join(peonDir, 'config.json'),
    movesPath: path.join(root, 'moves.json'),
    peonBin: '',
  });
  const manifestFile = path.join(packDir, 'openpeon.json');
  const where = (file) =>
    Object.entries(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).categories)
      .filter(([, c]) => c.sounds.some((s) => s.file.endsWith(file)))
      .map(([name]) => name);
  const config = () => JSON.parse(fs.readFileSync(path.join(peonDir, 'config.json'), 'utf8'));
  return { peon, manifestFile, original: fs.readFileSync(manifestFile, 'utf8'), where, config };
}

test('lists packs with their bindings', () => {
  const { peon } = setup();
  assert.deepEqual(peon.listPacks(), [{ name: 'demo', display_name: 'Demo', used_by: ['claude', 'default'], sound_count: 3 }]);
});

test('pack state shows every CESP event, including empty ones', () => {
  const { peon } = setup();
  const names = peon.packState('demo').categories.map((c) => c.name);
  assert.ok(names.includes('task.error'));
  assert.equal(peon.packState('demo').categories.find((c) => c.name === 'task.error').sounds.length, 0);
});

test('disable and enable a sound', () => {
  const { peon, config } = setup();
  assert.equal(peon.setSound('demo', 'task.complete', 'done.wav', false).ok, true);
  assert.deepEqual(config().disabled_sounds, { demo: { 'task.complete': ['done.wav'] } });
  assert.equal(peon.setSound('demo', 'task.complete', 'done.wav', true).ok, true);
  assert.equal(config().disabled_sounds, undefined);
});

test('move a sound, keep its disabled state, then move it back', () => {
  const { peon, manifestFile, original, where, config } = setup();
  peon.setSound('demo', 'input.required', 'wait.wav', false);

  assert.equal(peon.moveSound('demo', 'wait.wav', 'input.required', 'task.complete').ok, true);
  assert.deepEqual(where('wait.wav'), ['task.complete']);
  assert.ok(fs.existsSync(`${manifestFile}.orig`));
  assert.deepEqual(config().disabled_sounds.demo, { 'task.complete': ['wait.wav'] });
  const moved = peon.packState('demo').categories.find((c) => c.name === 'task.complete').sounds.find((s) => s.file === 'wait.wav');
  assert.equal(moved.moved_from, 'input.required');

  assert.equal(peon.moveSound('demo', 'wait.wav', 'task.complete', 'input.required').ok, true);
  assert.deepEqual(where('wait.wav'), ['input.required']);
  assert.deepEqual(config().disabled_sounds.demo, { 'input.required': ['wait.wav'] });
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), original);
  assert.equal(fs.existsSync(`${manifestFile}.orig`), false);
});

test('moves are re-applied after the pack manifest is overwritten', () => {
  const { peon, manifestFile, original, where } = setup();
  peon.moveSound('demo', 'hi.wav', 'session.start', 'task.complete');
  fs.writeFileSync(manifestFile, original);
  assert.deepEqual(where('hi.wav'), ['session.start']);
  peon.packState('demo');
  assert.deepEqual(where('hi.wav'), ['task.complete']);
});

test('rejects bad input', () => {
  const { peon } = setup();
  assert.equal(peon.moveSound('demo', 'hi.wav', 'session.start', '../evil').ok, false);
  assert.equal(peon.moveSound('../x', 'hi.wav', 'session.start', 'task.complete').ok, false);
  assert.equal(peon.moveSound('demo', 'nope.wav', 'session.start', 'task.complete').ok, false);
  assert.equal(peon.setSound('demo', 'session.start', 'done.wav', false).ok, false);
  assert.equal(peon.resolveAudio('demo', '../../config.json'), null);
  assert.ok(peon.resolveAudio('demo', 'sounds/hi.wav'));
});

test('tool bindings: list, bind, rebind, unbind, default pack', () => {
  const { peon, config } = setup();
  const tools = peon.toolBindings();
  assert.equal(tools.default_pack, 'demo');
  assert.deepEqual(
    tools.tools.map((t) => [t.id, t.pack]),
    [['claude', 'demo'], ['copilot', ''], ['cursor', ''], ['codex', '']],
  );
  assert.ok(tools.known.some((t) => t.id === 'gemini'));

  assert.equal(peon.bindTool('Copilot', 'demo').ok, true);
  assert.equal(peon.bindTool('claude-code', 'demo').ok, true);
  assert.deepEqual(config().ide_rules, [{ ide: 'copilot', pack: 'demo' }, { ide: 'claude', pack: 'demo' }]);

  assert.equal(peon.bindTool('claude', '').ok, true);
  assert.deepEqual(config().ide_rules, [{ ide: 'copilot', pack: 'demo' }]);

  assert.equal(peon.bindTool('gemini', 'demo').ok, true);
  assert.ok(peon.toolBindings().tools.some((t) => t.id === 'gemini' && t.pack === 'demo'));

  assert.equal(peon.bindTool('copilot', 'nope').ok, false);
  assert.equal(peon.bindTool('../x', 'demo').ok, false);
  assert.equal(peon.setDefaultPack('nope').ok, false);
  assert.equal(peon.setDefaultPack('demo').ok, true);
});

test('registry lists packs with install state and preview urls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-editor-reg-'));
  const peonDir = path.join(root, 'peon-ping');
  fs.mkdirSync(path.join(peonDir, 'packs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(peonDir, 'packs', 'demo', 'openpeon.json'), '{"categories":{}}');
  fs.writeFileSync(path.join(peonDir, 'config.json'), '{"default_pack":"demo"}');
  const fetchRegistry = async () => ({
    packs: [
      { name: 'demo', source_repo: 'me/demo', source_ref: 'v1', source_path: '.', preview_sounds: ['a b.wav'] },
      { name: 'ua-memes', display_name: 'Українські меми', language: 'uk', source_repo: 'x/y', source_ref: 'v1', source_path: 'packs/ua' , preview_sounds: ['hi.wav'] },
      { name: '../evil' },
    ],
  });
  const peon = createPeon(
    { peonDir, packsDir: path.join(peonDir, 'packs'), configPath: path.join(peonDir, 'config.json'), movesPath: path.join(root, 'm.json'), peonBin: '' },
    { fetchRegistry },
  );
  const list = await peon.registry();
  assert.deepEqual(list.map((p) => [p.name, p.installed, p.is_default]), [['demo', true, true], ['ua-memes', false, false]]);
  assert.equal(list[0].previews[0], 'https://raw.githubusercontent.com/me/demo/v1/sounds/a%20b.wav');
  assert.equal(list[1].previews[0], 'https://raw.githubusercontent.com/x/y/v1/packs/ua/sounds/hi.wav');
  assert.equal((await peon.installPack('../evil')).ok, false);
  assert.equal((await peon.installPack('ua-memes')).ok, false); // no peon CLI in tests
  assert.equal((await peon.removePack('nope')).ok, false);
});

test('a file shared by several events: no false "moved" tags, moves pick the right copy', () => {
  const { peon, manifestFile, where } = setup();
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  m.categories['task.complete'].sounds.push({ file: 'sounds/hi.wav', label: 'Hi again' });
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  const original = fs.readFileSync(manifestFile, 'utf8');

  const tags = () => peon.packState('demo').categories.flatMap((c) => c.sounds.filter((s) => s.moved_from).map((s) => `${c.name}:${s.file}`));
  assert.deepEqual(tags(), []);

  assert.equal(peon.moveSound('demo', 'hi.wav', 'task.complete', 'session.start').ok, false); // already there
  assert.equal(peon.moveSound('demo', 'hi.wav', 'task.complete', 'input.required').ok, true);
  assert.deepEqual(where('hi.wav').sort(), ['input.required', 'session.start']);
  assert.deepEqual(tags(), ['input.required:hi.wav']);

  assert.equal(peon.moveSound('demo', 'hi.wav', 'input.required', 'task.complete').ok, true);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), original);
  assert.deepEqual(tags(), []);
});

test('legacy moves (target only) still apply', () => {
  const { peon, where } = setup();
  const movesPath = peon.paths.movesPath;
  fs.writeFileSync(movesPath, JSON.stringify({ demo: { 'done.wav': 'task.error' } }));
  const state = peon.packState('demo');
  assert.deepEqual(where('done.wav'), ['task.error']);
  assert.equal(state.categories.find((c) => c.name === 'task.error').sounds[0].moved_from, 'task.complete');
});

test('status, mute, volume and event switches', () => {
  const { peon, config } = setup();
  assert.equal(peon.status().sounds_on, true);
  assert.equal(peon.setSoundsOn(false).ok, true);
  assert.equal(peon.status().sounds_on, false);
  assert.equal(peon.setSoundsOn(true).ok, true);
  assert.equal(peon.status().sounds_on, true);
  assert.equal(peon.setVolume(0.734).ok, true);
  assert.equal(config().volume, 0.73);
  assert.equal(peon.setVolume(2).ok, false);
  assert.equal(peon.setEvent('task.acknowledge', false).ok, true);
  assert.equal(peon.status().events.find((e) => e.name === 'task.acknowledge').enabled, false);
  assert.equal(peon.setEvent('nope', true).ok, false);
});

test('a dropped sound lands where it was dropped, and reordering survives a pack update', () => {
  const { peon, manifestFile, original } = setup();
  const m = JSON.parse(original);
  m.categories['task.complete'].sounds.push({ file: 'sounds/yay.wav' }, { file: 'sounds/ok.wav' });
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  const pristine = fs.readFileSync(manifestFile, 'utf8');
  const files = (cat) => peon.packState('demo').categories.find((c) => c.name === cat).sounds.map((s) => s.file);

  assert.deepEqual(files('task.complete'), ['done.wav', 'yay.wav', 'ok.wav']);
  assert.equal(peon.moveSound('demo', 'hi.wav', 'session.start', 'task.complete', 'yay.wav').ok, true);
  assert.deepEqual(files('task.complete'), ['done.wav', 'hi.wav', 'yay.wav', 'ok.wav']);

  assert.equal(peon.moveSound('demo', 'ok.wav', 'task.complete', 'task.complete', 'done.wav').ok, true);
  assert.deepEqual(files('task.complete'), ['ok.wav', 'done.wav', 'hi.wav', 'yay.wav']);

  fs.writeFileSync(manifestFile, pristine); // e.g. `peon update`
  assert.deepEqual(files('task.complete'), ['ok.wav', 'done.wav', 'hi.wav', 'yay.wav']);
  assert.deepEqual(files('session.start'), []);

  // Undo everything: the manifest goes back byte-for-byte
  peon.moveSound('demo', 'hi.wav', 'task.complete', 'session.start');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(peon.paths.movesPath, 'utf8')).demo.order), ['task.complete']);
  assert.deepEqual(JSON.parse(fs.readFileSync(peon.paths.movesPath, 'utf8')).demo.order['task.complete'], ['ok.wav', 'done.wav', 'yay.wav']);
  peon.moveSound('demo', 'ok.wav', 'task.complete', 'task.complete');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), pristine);
  assert.equal(fs.existsSync(`${manifestFile}.orig`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(peon.paths.movesPath, 'utf8')), {});
});

test('notification settings: read, validate, save', async () => {
  const { peon, config } = setup();
  const n = peon.notifications();
  assert.equal(n.enabled, true);
  assert.equal(n.position, 'top-center');
  assert.equal(n.theme, 'neon');

  assert.equal((await peon.setNotifications({ position: 'bottom-right', dismiss_seconds: 0, title: 'Work', title_ide: true, templates: { stop: '{project} done' } })).ok, true);
  const cfg = config();
  assert.equal(cfg.notification_position, 'bottom-right');
  assert.equal(cfg.notification_dismiss_seconds, 0);
  assert.equal(cfg.notification_title_override, 'Work');
  assert.deepEqual(cfg.notification_templates, { stop: '{project} done' });

  assert.equal((await peon.setNotifications({ templates: { stop: '' } })).ok, true);
  assert.equal(config().notification_templates, undefined);
  assert.equal((await peon.setNotifications({ enabled: false })).ok, true);
  assert.equal(config().desktop_notifications, false);

  assert.equal((await peon.setNotifications({ position: 'middle' })).ok, false);
  assert.equal((await peon.setNotifications({ dismiss_seconds: -1 })).ok, false);
  assert.equal((await peon.setNotifications({ templates: { nope: 'x' } })).ok, false);
  assert.equal((await peon.setNotifications({ theme: 'pink' })).ok, false);
  assert.equal(config().notification_position, 'bottom-right');
});

test('finds peon.sh in the install dir without relying on PATH', () => {
  const { resolvePaths } = require('../src/peon');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peon-editor-bin-'));
  fs.writeFileSync(path.join(dir, 'peon.sh'), '#!/bin/bash\n');
  assert.equal(resolvePaths({ PEON_DIR: dir, PATH: '/nonexistent' }).peonBin, path.join(dir, 'peon.sh'));
  assert.equal(resolvePaths({ PEON_DIR: dir, PEON_BIN: '' }).peonBin, '');
});

test('writes through a symlinked config.json', () => {
  const { peon, config } = setup();
  const cfgPath = peon.paths.configPath;
  const real = `${cfgPath}.real`;
  fs.renameSync(cfgPath, real);
  fs.symlinkSync(real, cfgPath);
  assert.equal(peon.setVolume(0.3).ok, true);
  assert.equal(fs.lstatSync(cfgPath).isSymbolicLink(), true);
  assert.equal(config().volume, 0.3);
});
