'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REGISTRY_URL = 'https://peonping.github.io/registry/index.json';
const REGISTRY_TTL_MS = 10 * 60 * 1000;
// pack-download.sh runs curl without timeouts, so a stuck file would hang the request forever
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const PACK_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

const CATEGORY_HINTS = {
  'session.start': 'Session started',
  'task.acknowledge': 'Prompt acknowledged',
  'task.complete': 'Agent finished',
  'task.error': 'Tool error',
  'input.required': 'Needs permission or an answer',
  'resource.limit': 'Usage or context limit hit',
  'user.spam': 'Too many prompts in a row',
};

// Tool ids as peon-ping's ide_rules understand them (see normalize_ide_id in peon.sh)
const TOOLS = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  codex: 'OpenAI Codex',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  opencode: 'OpenCode',
  kiro: 'Kiro',
  'kiro-ide': 'Kiro IDE',
  kilo: 'Kilo CLI',
  amp: 'Amp',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
  deepagents: 'DeepAgents',
  openclaw: 'OpenClaw',
  rovodev: 'Rovo Dev CLI',
  omp: 'oh-my-pi',
  qwen: 'Qwen Code',
  iflow: 'iFlow CLI',
  trae: 'Trae',
  eca: 'ECA',
  grok: 'Grok Build',
};
const TOOL_ALIASES = {
  'claude-code': 'claude',
  claudecode: 'claude',
  'openai-codex': 'codex',
  'open-code': 'opencode',
  'deep-agents': 'deepagents',
  'open-claw': 'openclaw',
  rovo: 'rovodev',
  'oh-my-pi': 'omp',
  pi: 'omp',
  'qwen-code': 'qwen',
  'iflow-cli': 'iflow',
  'grok-build': 'grok',
};
// Always listed in the UI, even with no binding yet
const PINNED_TOOLS = ['claude', 'copilot', 'cursor', 'codex'];

const PATCH_MARKER = 'x_sounds_ui_patched';

const NOTIFY = {
  styles: ['overlay', 'standard'],
  themes: ['neon', 'glass', 'sakura', 'jarvis'],
  positions: ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'],
  templates: ['stop', 'permission', 'error', 'idle', 'question'],
};
// Themed overlays are separate scripts that peon-ping's installer does not download
const THEME_URL = 'https://raw.githubusercontent.com/PeonPing/peon-ping/v{version}/scripts/mac-overlay-{theme}.js';

async function defaultFetchRegistry() {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolvePaths(env = process.env) {
  const peonDir = expandHome(
    env.PEON_DIR || env.CLAUDE_PEON_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'hooks', 'peon-ping'),
  );
  return {
    peonDir,
    packsDir: path.join(peonDir, 'packs'),
    configPath: path.join(peonDir, 'config.json'),
    movesPath: expandHome(env.PEON_EDITOR_MOVES || path.join(path.dirname(peonDir), 'peon-editor-moves.json')),
    peonBin: env.PEON_BIN === undefined ? findPeonBin(peonDir) : env.PEON_BIN,
  };
}

// Started from PeonBar or launchd the editor gets a bare PATH, where `which peon` finds nothing.
// The `peon` command is peon-ping's peon.sh, so run that script from the install dir directly.
function findPeonBin(peonDir) {
  const script = path.join(peonDir, 'peon.sh');
  if (fs.existsSync(script)) return script;
  const which = spawnSync('which', ['peon'], { encoding: 'utf8', env: CHILD_ENV });
  return which.status === 0 ? which.stdout.trim() : '';
}

// peon.sh needs python3 and curl; prefer Homebrew's and ~/.local/bin over a bare system PATH
const CHILD_ENV = {
  ...process.env,
  PATH: [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
};

function peonCommand(bin, args) {
  return bin.endsWith('.sh') ? ['/bin/bash', [bin, ...args]] : [bin, args];
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  // Write through a symlinked config (Nix, dotfile managers) instead of replacing the link with a file
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // does not exist yet
  }
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

function basename(file) {
  return path.basename(String(file || ''));
}

function normalizeTool(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[ _]/g, '-');
  return TOOL_ALIASES[key] || key;
}

function runAsync(bin, args, { input = '', timeout = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const [cmd, argv] = peonCommand(bin, args);
    const proc = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: CHILD_ENV });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      out += `\nTimed out after ${Math.round(timeout / 1000)}s`;
    }, timeout);
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, message: out.trim() });
    });
    proc.stdin.end(input);
  });
}

function previewUrl(entry, file) {
  const repo = String(entry.source_repo || '');
  const ref = String(entry.source_ref || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(ref) || !file) return '';
  const sub = String(entry.source_path || '.').replace(/^\.\/?|\/$/g, '');
  const base = ['https://raw.githubusercontent.com', repo, ref, sub].filter(Boolean).join('/');
  return `${base}/sounds/${encodeURIComponent(basename(file))}`;
}

function createPeon(paths = resolvePaths(), { fetchRegistry = defaultFetchRegistry } = {}) {
  const { packsDir, configPath, movesPath, peonBin } = paths;

  function manifestPath(pack) {
    if (!pack || pack.includes('/') || pack.includes('\\') || pack.startsWith('.')) return null;
    for (const name of ['openpeon.json', 'manifest.json']) {
      const file = path.join(packsDir, pack, name);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  function loadManifest(pack) {
    const file = manifestPath(pack);
    return file ? readJson(file, null) : null;
  }

  function loadConfig() {
    return readJson(configPath, {});
  }

  function installedPacks() {
    if (!fs.existsSync(packsDir)) return [];
    return fs
      .readdirSync(packsDir)
      .filter((p) => manifestPath(p))
      .sort();
  }

  function listPacks() {
    const cfg = loadConfig();
    const defaultPack = cfg.default_pack || cfg.active_pack;
    return installedPacks().map((name) => {
      const manifest = loadManifest(name) || {};
      const usedBy = (cfg.ide_rules || []).filter((r) => r.pack === name).map((r) => normalizeTool(r.ide));
      if (defaultPack === name) usedBy.push('default');
      const files = new Set();
      for (const cat of Object.values(manifest.categories || {})) for (const s of cat.sounds || []) files.add(basename(s.file));
      return { name, display_name: manifest.display_name || name, used_by: usedBy, sound_count: files.size };
    });
  }

  // peon-editor-moves.json: { [pack]: { moves: { [file]: { from, to } }, order: { [event]: [file, ...] } } }
  // `from` is the event the sound has in the untouched manifest. A file can sit in several events of one pack
  // (peon reuses lines), so `from` pins which copy moved. `order` keeps the position a sound was dropped at.
  function loadEdits(pack) {
    const raw = readJson(movesPath, {})[pack] || {};
    const legacy = !('moves' in raw) && !('order' in raw);
    const moves = {};
    for (const [file, value] of Object.entries(legacy ? raw : raw.moves || {})) {
      if (value && typeof value === 'object') moves[file] = value;
      // Older versions stored only the target event
      else if (typeof value === 'string') moves[file] = { from: legacyOrigin(pack, file), to: value };
    }
    return { moves, order: legacy ? {} : raw.order || {} };
  }

  function saveEdits(pack, { moves, order }) {
    const all = readJson(movesPath, {});
    for (const [cat, files] of Object.entries(order)) {
      // Drop sounds that have since left this event, then forget orders that match the pack's own
      const members = originalOrder(pack, cat, moves);
      const kept = files.filter((f) => members.includes(f));
      const effective = [...kept, ...members.filter((f) => !kept.includes(f))];
      if (!kept.length || sameList(effective, members)) delete order[cat];
      else order[cat] = kept;
    }
    if (Object.keys(moves).length || Object.keys(order).length) all[pack] = { moves, order };
    else delete all[pack];
    writeJson(movesPath, all);
  }

  function loadMoves(pack) {
    return loadEdits(pack).moves;
  }

  function untouchedManifest(pack) {
    const manifestFile = manifestPath(pack);
    return (manifestFile && (readJson(`${manifestFile}.orig`, null) || readJson(manifestFile, {}))) || {};
  }

  function legacyOrigin(pack, file) {
    for (const [catName, cat] of Object.entries(untouchedManifest(pack).categories || {})) {
      if ((cat.sounds || []).some((s) => basename(s.file) === file)) return catName;
    }
    return '';
  }

  // Where moved sounds would land with no custom order: the event's own sounds, then arrivals at the end
  function originalOrder(pack, cat, moves) {
    const own = (((untouchedManifest(pack).categories || {})[cat] || {}).sounds || [])
      .map((s) => basename(s.file))
      .filter((f) => !(moves[f] && moves[f].from === cat));
    const arrivals = Object.entries(moves).filter(([, m]) => m.to === cat).map(([f]) => f);
    return [...own, ...arrivals.filter((f) => !own.includes(f))];
  }

  function sameList(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  function applyMoves(pack) {
    const file = manifestPath(pack);
    const { moves, order } = loadEdits(pack);
    if (!file || (!Object.keys(moves).length && !Object.keys(order).length)) return;
    const manifest = readJson(file, null);
    if (!manifest) return;
    const categories = (manifest.categories ||= {});
    const before = JSON.stringify(categories);
    for (const [base, { from, to }] of Object.entries(moves)) {
      const source = (categories[from] || {}).sounds || [];
      const idx = source.findIndex((s) => basename(s.file) === base);
      if (idx === -1) continue;
      const [entry] = source.splice(idx, 1);
      const target = ((categories[to] ||= {}).sounds ||= []);
      if (!target.some((s) => basename(s.file) === base)) target.push(entry);
    }
    for (const [cat, files] of Object.entries(order)) {
      const sounds = (categories[cat] || {}).sounds;
      if (!sounds) continue;
      const rank = (s) => {
        const i = files.indexOf(basename(s.file));
        return i === -1 ? files.length : i;
      };
      // Array.prototype.sort is stable, so sounds missing from `order` keep their relative place at the end
      sounds.sort((x, y) => rank(x) - rank(y));
    }
    if (manifest[PATCH_MARKER] && JSON.stringify(categories) === before) return;
    if (!manifest[PATCH_MARKER]) fs.copyFileSync(file, `${file}.orig`);
    manifest[PATCH_MARKER] = true;
    writeJson(file, manifest);
  }

  function restoreOriginal(pack) {
    const file = manifestPath(pack);
    if (!file || !fs.existsSync(`${file}.orig`)) return;
    if (!(readJson(file, {}) || {})[PATCH_MARKER]) return;
    fs.renameSync(`${file}.orig`, file);
  }

  function packState(pack) {
    if (!installedPacks().includes(pack)) return null;
    applyMoves(pack);
    const manifest = loadManifest(pack);
    if (!manifest) return null;
    const cfg = loadConfig();
    const disabled = (cfg.disabled_sounds || {})[pack] || {};
    const flags = cfg.categories || {};
    const moves = loadMoves(pack);
    const manifestCats = manifest.categories || {};
    const ordered = [...Object.keys(CATEGORY_HINTS), ...Object.keys(manifestCats).filter((c) => !(c in CATEGORY_HINTS))];
    return {
      name: pack,
      display_name: manifest.display_name || pack,
      categories: ordered.map((catName) => {
        const off = new Set(disabled[catName] || []);
        return {
          name: catName,
          hint: CATEGORY_HINTS[catName] || '',
          category_enabled: flags[catName] !== false,
          sounds: ((manifestCats[catName] || {}).sounds || []).map((sound) => {
            const base = basename(sound.file);
            const move = moves[base];
            return {
              file: base,
              path: String(sound.file || ''),
              label: sound.label || '',
              enabled: !off.has(base),
              moved_from: move && move.to === catName ? move.from : '',
              missing: !resolveAudio(pack, String(sound.file || ''), manifest),
            };
          }),
        };
      }),
    };
  }

  function resolveAudio(pack, soundPath, manifest = loadManifest(pack)) {
    if (!manifest) return null;
    const known = new Set();
    for (const cat of Object.values(manifest.categories || {})) {
      for (const sound of cat.sounds || []) known.add(String(sound.file || ''));
    }
    if (!known.has(soundPath)) return null;
    const root = fs.realpathSync(path.join(packsDir, pack));
    for (const candidate of [path.join(root, soundPath), path.join(root, 'sounds', basename(soundPath))]) {
      let real;
      try {
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (real.startsWith(root + path.sep) && fs.statSync(real).isFile()) return real;
    }
    return null;
  }

  // peon-ping's own icon, used as the favicon. Read from the local install so this repo ships no game art.
  function peonIcon() {
    const file = path.join(paths.peonDir, 'docs', 'peon-icon.png');
    return fs.existsSync(file) ? file : null;
  }

  // Same lookup as peon-ping's notify.sh: manifest "icon", then icon.png in the pack, then the peon icon
  function packIcon(pack) {
    const fallback = path.join(paths.peonDir, 'docs', 'peon-icon.png');
    if (!installedPacks().includes(pack)) return fs.existsSync(fallback) ? fallback : null;
    const root = fs.realpathSync(path.join(packsDir, pack));
    const manifest = loadManifest(pack) || {};
    for (const candidate of [manifest.icon && path.join(root, String(manifest.icon)), path.join(root, 'icon.png')]) {
      if (!candidate) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (real.startsWith(root + path.sep) && fs.statSync(real).isFile()) return real;
      } catch {
        // not there, try the next one
      }
    }
    return fs.existsSync(fallback) ? fallback : null;
  }

  function soundInCategory(pack, category, file) {
    const manifest = loadManifest(pack) || {};
    const sounds = ((manifest.categories || {})[category] || {}).sounds || [];
    return sounds.some((s) => basename(s.file) === file);
  }

  function writeDisabled(pack, category, file, enabled) {
    const cfg = loadConfig();
    const all = (cfg.disabled_sounds ||= {});
    const packMap = (all[pack] ||= {});
    const current = new Set(packMap[category] || []);
    if (enabled) current.delete(file);
    else current.add(file);
    if (current.size) packMap[category] = [...current].sort();
    else delete packMap[category];
    if (!Object.keys(packMap).length) delete all[pack];
    if (!Object.keys(all).length) delete cfg.disabled_sounds;
    writeJson(configPath, cfg);
  }

  function setSound(pack, category, file, enabled) {
    if (!installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (!soundInCategory(pack, category, file)) return { ok: false, message: `"${file}" is not in ${pack}/${category}` };
    if (peonBin) return runPeon(['sounds', enabled ? 'enable' : 'disable', category, file, `--pack=${pack}`]);
    writeDisabled(pack, category, file, enabled);
    return { ok: true, message: `${enabled ? 'enabled' : 'disabled'} ${file} in ${pack}/${category}` };
  }

  function runPeon(args) {
    const [cmd, argv] = peonCommand(peonBin, args);
    const proc = spawnSync(cmd, argv, {
      env: CHILD_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { ok: proc.status === 0, message: `${proc.stdout || ''}${proc.stderr || ''}`.trim() };
  }

  function toolBindings() {
    const cfg = loadConfig();
    const rules = new Map();
    for (const rule of cfg.ide_rules || []) {
      const id = normalizeTool(rule.ide);
      if (id && !rules.has(id)) rules.set(id, rule.pack || '');
    }
    const recent = readJson(path.join(paths.peonDir, '.state.json'), {}).recent_ide_sources || {};
    const seen = new Set(Object.keys(recent).map(normalizeTool));
    const ids = [...new Set([...PINNED_TOOLS, ...rules.keys(), ...seen])];
    return {
      default_pack: cfg.default_pack || cfg.active_pack || 'peon',
      tools: ids.map((id) => ({ id, name: TOOLS[id] || id, pack: rules.get(id) || '', seen: seen.has(id) })),
      known: Object.entries(TOOLS)
        .filter(([id]) => !ids.includes(id))
        .map(([id, name]) => ({ id, name })),
    };
  }

  // pack === '' removes the binding, so the tool falls back to the default pack
  function bindTool(tool, pack) {
    const id = normalizeTool(tool);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, message: `Bad tool id "${tool}"` };
    if (pack && !installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (peonBin) return runPeon(pack ? ['packs', 'ide-bind', id, pack] : ['packs', 'ide-unbind', id]);
    const cfg = loadConfig();
    const rules = (cfg.ide_rules || []).filter((r) => normalizeTool(r.ide) !== id);
    if (pack) rules.push({ ide: id, pack });
    cfg.ide_rules = rules;
    writeJson(configPath, cfg);
    return { ok: true, message: pack ? `bound ${pack} to ${id}` : `unbound ${id}` };
  }

  function setDefaultPack(pack) {
    if (!installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (peonBin) return runPeon(['packs', 'use', pack]);
    const cfg = loadConfig();
    cfg.default_pack = pack;
    delete cfg.active_pack;
    writeJson(configPath, cfg);
    return { ok: true, message: `default pack: ${pack}` };
  }

  // before: file to place the sound in front of within `to` ('' = end). from === to just reorders.
  function moveSound(pack, file, from, to, before = '') {
    if (!installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (!(to in CATEGORY_HINTS)) return { ok: false, message: `Unknown event "${to}"` };
    if (!soundInCategory(pack, from, file)) return { ok: false, message: `"${file}" is not in ${from}` };
    if (from !== to && soundInCategory(pack, to, file)) return { ok: false, message: `"${file}" already plays on ${to}` };
    if (before === file) return { ok: true, message: '' };

    const edits = loadEdits(pack);
    if (from !== to) {
      const origin = (edits.moves[file] && edits.moves[file].from) || from;
      if (origin === to) delete edits.moves[file];
      else edits.moves[file] = { from: origin, to };
    }
    const current = (((loadManifest(pack) || {}).categories || {})[to] || {}).sounds || [];
    const list = current.map((s) => basename(s.file)).filter((f) => f !== file);
    const at = before ? list.indexOf(before) : -1;
    list.splice(at === -1 ? list.length : at, 0, file);
    edits.order[to] = list;
    saveEdits(pack, edits);

    restoreOriginal(pack);
    applyMoves(pack);
    if (from === to) return { ok: true, message: `${file}: reordered in ${to}` };

    const cfg = loadConfig();
    const packDisabled = (cfg.disabled_sounds || {})[pack] || {};
    if ((packDisabled[from] || []).includes(file)) {
      packDisabled[from] = packDisabled[from].filter((f) => f !== file);
      if (!packDisabled[from].length) delete packDisabled[from];
      packDisabled[to] = [...new Set([...(packDisabled[to] || []), file])].sort();
      writeJson(configPath, cfg);
    }
    return { ok: true, message: `${file}: ${from} → ${to}` };
  }

  function status() {
    const cfg = loadConfig();
    const flags = cfg.categories || {};
    return {
      sounds_on: !fs.existsSync(path.join(paths.peonDir, '.paused')),
      volume: typeof cfg.volume === 'number' ? cfg.volume : 0.5,
      default_pack: cfg.default_pack || cfg.active_pack || 'peon',
      events: Object.keys(CATEGORY_HINTS).map((name) => ({ name, hint: CATEGORY_HINTS[name], enabled: flags[name] !== false })),
    };
  }

  function setSoundsOn(on) {
    if (peonBin) return runPeon([on ? 'resume' : 'pause']);
    const file = path.join(paths.peonDir, '.paused');
    if (on) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, '');
    return { ok: true, message: on ? 'sounds on' : 'sounds muted' };
  }

  function setVolume(volume) {
    const v = Math.round(Number(volume) * 100) / 100;
    if (!Number.isFinite(v) || v < 0 || v > 1) return { ok: false, message: 'Volume must be between 0 and 1' };
    if (peonBin) return runPeon(['volume', String(v)]);
    const cfg = loadConfig();
    cfg.volume = v;
    writeJson(configPath, cfg);
    return { ok: true, message: `volume ${v}` };
  }

  // peon-ping has no CLI for this; the peon-ping-config skill edits the same key
  function setEvent(category, enabled) {
    if (!(category in CATEGORY_HINTS)) return { ok: false, message: `Unknown event "${category}"` };
    const cfg = loadConfig();
    (cfg.categories ||= {})[category] = Boolean(enabled);
    writeJson(configPath, cfg);
    return { ok: true, message: `${category} ${enabled ? 'on' : 'off'}` };
  }

  function notifications() {
    const cfg = loadConfig();
    const theme = NOTIFY.themes.includes(cfg.overlay_theme) ? cfg.overlay_theme : 'neon';
    const templates = cfg.notification_templates || {};
    return {
      enabled: cfg.desktop_notifications !== false,
      style: cfg.notification_style === 'standard' ? 'standard' : 'overlay',
      theme,
      theme_installed: theme === 'neon' || fs.existsSync(themeScript(theme)),
      position: NOTIFY.positions.includes(cfg.notification_position) ? cfg.notification_position : 'top-center',
      dismiss_seconds: Number.isInteger(cfg.notification_dismiss_seconds) ? cfg.notification_dismiss_seconds : 4,
      all_screens: cfg.notification_all_screens !== false,
      close_button: cfg.notification_close_button !== false,
      stacking: cfg.notification_stacking !== false,
      title: cfg.notification_title_override || '',
      title_ide: Boolean(cfg.notification_title_ide),
      templates: Object.fromEntries(NOTIFY.templates.map((k) => [k, typeof templates[k] === 'string' ? templates[k] : ''])),
      options: NOTIFY,
    };
  }

  function themeScript(theme) {
    return path.join(paths.peonDir, 'scripts', `mac-overlay-${theme}.js`);
  }

  async function ensureTheme(theme) {
    if (theme === 'neon' || fs.existsSync(themeScript(theme))) return null;
    const version = (fs.existsSync(path.join(paths.peonDir, 'VERSION')) ? fs.readFileSync(path.join(paths.peonDir, 'VERSION'), 'utf8') : '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return `Unknown peon-ping version, cannot fetch the ${theme} theme`;
    try {
      const res = await fetchText(THEME_URL.replace('{version}', version).replace('{theme}', theme));
      fs.mkdirSync(path.dirname(themeScript(theme)), { recursive: true });
      fs.writeFileSync(themeScript(theme), res);
      return null;
    } catch (err) {
      return `Could not download the ${theme} theme: ${err.message}`;
    }
  }

  // Every key is validated; anything not in the patch is left alone
  async function setNotifications(patch) {
    const cfg = loadConfig();
    const p = patch || {};
    const bool = (v) => v === true || v === false;
    if ('style' in p) {
      if (!NOTIFY.styles.includes(p.style)) return { ok: false, message: `Unknown style "${p.style}"` };
      cfg.notification_style = p.style;
    }
    if ('theme' in p) {
      if (!NOTIFY.themes.includes(p.theme)) return { ok: false, message: `Unknown theme "${p.theme}"` };
      const err = await ensureTheme(p.theme);
      if (err) return { ok: false, message: err };
      cfg.overlay_theme = p.theme;
    }
    if ('position' in p) {
      if (!NOTIFY.positions.includes(p.position)) return { ok: false, message: `Unknown position "${p.position}"` };
      cfg.notification_position = p.position;
    }
    if ('dismiss_seconds' in p) {
      const n = Number(p.dismiss_seconds);
      if (!Number.isInteger(n) || n < 0 || n > 600) return { ok: false, message: 'Dismiss time must be 0–600 seconds' };
      cfg.notification_dismiss_seconds = n;
    }
    for (const [key, cfgKey] of [['all_screens', 'notification_all_screens'], ['close_button', 'notification_close_button'], ['stacking', 'notification_stacking'], ['title_ide', 'notification_title_ide']]) {
      if (!(key in p)) continue;
      if (!bool(p[key])) return { ok: false, message: `${key} must be true or false` };
      cfg[cfgKey] = p[key];
    }
    if ('title' in p) {
      const title = String(p.title ?? '').trim();
      if (title.length > 60) return { ok: false, message: 'Title is limited to 60 characters' };
      cfg.notification_title_override = title;
    }
    if ('templates' in p) {
      const tpls = { ...(cfg.notification_templates || {}) };
      for (const [k, v] of Object.entries(p.templates || {})) {
        if (!NOTIFY.templates.includes(k)) return { ok: false, message: `Unknown template "${k}"` };
        const text = String(v ?? '').trim();
        if (text.length > 200) return { ok: false, message: 'Templates are limited to 200 characters' };
        if (text) tpls[k] = text;
        else delete tpls[k];
      }
      if (Object.keys(tpls).length) cfg.notification_templates = tpls;
      else delete cfg.notification_templates;
    }
    if ('enabled' in p && !bool(p.enabled)) return { ok: false, message: 'enabled must be true or false' };
    writeJson(configPath, cfg);
    if ('enabled' in p && (cfg.desktop_notifications !== false) !== p.enabled) {
      // on/off goes through the CLI so peon-ping's adapters pick it up too
      if (peonBin) return runPeon(['notifications', p.enabled ? 'on' : 'off']);
      cfg.desktop_notifications = p.enabled;
      writeJson(configPath, cfg);
    }
    return { ok: true, message: 'Saved' };
  }

  async function testNotification() {
    if (!peonBin) return { ok: false, message: 'Sending a test needs peon.sh from peon-ping' };
    return runAsync(peonBin, ['notifications', 'test'], { timeout: 20000 });
  }

  // ---- Quiet: when peon-ping keeps sounds to itself ------------------------------------------
  const QUIET_BOOLS = ['meeting_detect', 'focus_detect', 'headphones_only', 'suppress_sound_when_tab_focused'];
  const FOCUS_MODES = ['all', 'sound', 'notifications'];

  function quiet() {
    const cfg = loadConfig();
    const out = Object.fromEntries(QUIET_BOOLS.map((k) => [k, String(cfg[k]).toLowerCase() === 'true']));
    out.focus_detect_mode = FOCUS_MODES.includes(cfg.focus_detect_mode) ? cfg.focus_detect_mode : 'all';
    return out;
  }

  // peon-ping has no CLI for these keys, so they are written to config.json like the peon-ping-config skill does
  function setQuiet(patch) {
    const cfg = loadConfig();
    for (const [key, value] of Object.entries(patch || {})) {
      if (QUIET_BOOLS.includes(key)) {
        if (typeof value !== 'boolean') return { ok: false, message: `${key} must be true or false` };
        cfg[key] = value;
      } else if (key === 'focus_detect_mode') {
        if (!FOCUS_MODES.includes(value)) return { ok: false, message: `Unknown focus mode "${value}"` };
        cfg[key] = value;
      } else {
        return { ok: false, message: `Unknown setting "${key}"` };
      }
    }
    writeJson(configPath, cfg);
    return { ok: true, message: 'Saved' };
  }

  // ---- Folders: a pack per project, or silence ---------------------------------------------
  function cleanPattern(value) {
    const pattern = String(value ?? '').trim();
    if (!pattern || pattern.length > 300 || /[\n\r\0]/.test(pattern)) return null;
    return pattern;
  }

  // Projects Claude Code has opened (paths only), to suggest instead of typing them
  function projectSuggestions() {
    const home = os.homedir();
    const seen = new Set();
    const claudeJson = readJson(path.join(home, '.claude.json'), {}) || {};
    const candidates = [
      ...Object.keys(claudeJson.projects || {}),
      ((readJson(path.join(paths.peonDir, '.state.json'), {}) || {}).last_active || {}).cwd,
    ];
    for (const dir of candidates) {
      if (typeof dir !== 'string' || !dir.startsWith('/') || dir === home || dir.includes('/.claude/worktrees/')) continue;
      if (fs.existsSync(dir)) seen.add(dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir);
    }
    return [...seen].sort();
  }

  function folders() {
    const cfg = loadConfig();
    return {
      rules: (cfg.path_rules || []).filter((r) => r && r.pattern).map((r) => ({ pattern: String(r.pattern), pack: String(r.pack || '') })),
      silenced: (cfg.exclude_dirs || []).filter((p) => typeof p === 'string'),
      suggestions: projectSuggestions(),
    };
  }

  function bindFolder(value, pack) {
    const pattern = cleanPattern(value);
    if (!pattern) return { ok: false, message: 'Enter a folder path or pattern' };
    if (!installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (peonBin) return runPeon(['packs', 'bind', pack, '--pattern', pattern]);
    const cfg = loadConfig();
    const rules = (cfg.path_rules || []).filter((r) => r.pattern !== pattern);
    rules.push({ pattern, pack });
    cfg.path_rules = rules;
    writeJson(configPath, cfg);
    return { ok: true, message: `${pattern} → ${pack}` };
  }

  function unbindFolder(value) {
    const pattern = cleanPattern(value);
    if (!pattern) return { ok: false, message: 'Missing folder' };
    if (peonBin) return runPeon(['packs', 'unbind', '--pattern', pattern]);
    const cfg = loadConfig();
    cfg.path_rules = (cfg.path_rules || []).filter((r) => r.pattern !== pattern);
    writeJson(configPath, cfg);
    return { ok: true, message: `removed ${pattern}` };
  }

  function silenceFolder(value, silenced) {
    const pattern = cleanPattern(value);
    if (!pattern) return { ok: false, message: 'Enter a folder path or pattern' };
    if (peonBin) return runPeon(['packs', 'exclude', silenced ? 'add' : 'remove', pattern]);
    const cfg = loadConfig();
    const dirs = (cfg.exclude_dirs || []).filter((p) => p !== pattern);
    if (silenced) dirs.push(pattern);
    cfg.exclude_dirs = dirs;
    writeJson(configPath, cfg);
    return { ok: true, message: silenced ? `silenced ${pattern}` : `unsilenced ${pattern}` };
  }

  // ---- Phone: ntfy / Pushover / Telegram ---------------------------------------------------
  const NTFY_PRIORITIES = ['', 'max', 'urgent', 'high', 'default', 'low', 'min'];
  const mask = (v) => (v ? `${String(v).slice(0, 4)}…` : '');

  // Secrets never leave the server: tokens are reported as set or not, ids are masked
  function mobile() {
    const mn = loadConfig().mobile_notify || {};
    return {
      service: ['ntfy', 'pushover', 'telegram'].includes(mn.service) ? mn.service : '',
      enabled: Boolean(mn.service) && mn.enabled !== false,
      ntfy: { topic: mn.service === 'ntfy' ? String(mn.topic || '') : '', server: String(mn.server || 'https://ntfy.sh'), priority: String(mn.priority || ''), token_set: Boolean(mn.token) },
      pushover: { user_key: mn.service === 'pushover' ? mask(mn.user_key) : '' },
      telegram: { chat_id: mn.service === 'telegram' ? mask(mn.chat_id) : '' },
    };
  }

  function field(value, name, { max = 200, optional = false } = {}) {
    const v = String(value ?? '').trim();
    if (!v && optional) return { v: '' };
    if (!v) return { error: `${name} is required` };
    if (v.length > max || /\s/.test(v)) return { error: `${name} looks wrong (no spaces, up to ${max} characters)` };
    return { v };
  }

  async function setMobile(p = {}) {
    if (!peonBin) return { ok: false, message: 'Phone notifications need peon.sh from peon-ping' };
    let args;
    if (p.service === 'ntfy') {
      const topic = field(p.topic, 'Topic', { max: 64 });
      const server = field(p.server, 'Server', { optional: true });
      const token = field(p.token, 'Token', { optional: true });
      const err = topic.error || server.error || token.error;
      if (err) return { ok: false, message: err };
      if (server.v && !/^https?:\/\//.test(server.v)) return { ok: false, message: 'Server must start with https://' };
      if (!NTFY_PRIORITIES.includes(String(p.priority || ''))) return { ok: false, message: 'Unknown priority' };
      args = ['mobile', 'ntfy', topic.v];
      if (server.v) args.push(`--server=${server.v}`);
      if (token.v) args.push(`--token=${token.v}`);
      if (p.priority) args.push(`--priority=${p.priority}`);
    } else if (p.service === 'pushover') {
      const user = field(p.user_key, 'User key', { max: 64 });
      const token = field(p.app_token, 'App token', { max: 64 });
      if (user.error || token.error) return { ok: false, message: user.error || token.error };
      args = ['mobile', 'pushover', user.v, token.v];
    } else if (p.service === 'telegram') {
      const bot = field(p.bot_token, 'Bot token', { max: 100 });
      const chat = field(p.chat_id, 'Chat id', { max: 32 });
      if (bot.error || chat.error) return { ok: false, message: bot.error || chat.error };
      args = ['mobile', 'telegram', bot.v, chat.v];
    } else {
      return { ok: false, message: 'Pick ntfy, Pushover or Telegram' };
    }
    // Setting up sends a test push, which can take a few seconds
    const result = await runAsync(peonBin, args, { timeout: 30000 });
    return { ok: result.ok, message: result.ok ? 'Phone notifications set up — check your phone for a test' : result.message };
  }

  function setMobileEnabled(on) {
    if (!peonBin) return { ok: false, message: 'Phone notifications need peon.sh from peon-ping' };
    return runPeon(['mobile', on ? 'on' : 'off']);
  }

  async function testMobile() {
    if (!peonBin) return { ok: false, message: 'Phone notifications need peon.sh from peon-ping' };
    return runAsync(peonBin, ['mobile', 'test'], { timeout: 30000 });
  }

  let registryCache = null;

  async function loadRegistry(force = false) {
    if (force || !registryCache || Date.now() - registryCache.at > REGISTRY_TTL_MS) {
      const data = await fetchRegistry();
      registryCache = { at: Date.now(), packs: Array.isArray(data && data.packs) ? data.packs : [] };
    }
    return registryCache.packs;
  }

  async function registry({ refresh = false } = {}) {
    const installed = new Set(installedPacks());
    const cfg = loadConfig();
    const defaultPack = cfg.default_pack || cfg.active_pack;
    return (await loadRegistry(refresh))
      .filter((p) => PACK_NAME.test(String(p.name || '')))
      .map((p) => ({
        name: p.name,
        display_name: p.display_name || p.name,
        description: p.description || '',
        language: p.language || '',
        tags: Array.isArray(p.tags) ? p.tags : [],
        sound_count: p.sound_count || 0,
        size: p.total_size_bytes || 0,
        quality: p.quality || '',
        trust_tier: p.trust_tier || '',
        author: (p.author && (p.author.name || p.author.github)) || '',
        updated: p.updated || p.added || '',
        previews: (p.preview_sounds || []).map((f) => previewUrl(p, f)).filter(Boolean),
        installed: installed.has(p.name),
        is_default: p.name === defaultPack,
      }));
  }

  async function installPack(pack) {
    if (!PACK_NAME.test(pack)) return { ok: false, message: `Bad pack name "${pack}"` };
    if (!peonBin) return { ok: false, message: 'Installing packs needs peon.sh from peon-ping' };
    const known = await loadRegistry().catch(() => null);
    if (known && !known.some((p) => p.name === pack)) return { ok: false, message: `"${pack}" is not in the registry` };
    const result = await runAsync(peonBin, ['packs', 'install', pack]);
    // pack-download.sh exits 0 even when some files failed, so check the result on disk
    if (result.ok && !installedPacks().includes(pack)) return { ok: false, message: result.message || 'Install failed' };
    return result;
  }

  async function removePack(pack) {
    if (!installedPacks().includes(pack)) return { ok: false, message: `Pack "${pack}" is not installed` };
    if (!peonBin) return { ok: false, message: 'Removing packs needs peon.sh from peon-ping' };
    // `peon packs remove` asks "Remove N pack(s)? [y/N]" on stdin
    const result = await runAsync(peonBin, ['packs', 'remove', pack], { input: 'y\n', timeout: 30000 });
    if (result.ok && installedPacks().includes(pack)) return { ok: false, message: result.message || 'Remove failed' };
    return result;
  }

  return {
    paths,
    registry,
    installPack,
    removePack,
    listPacks,
    packState,
    resolveAudio,
    packIcon,
    peonIcon,
    setSound,
    moveSound,
    installedPacks,
    toolBindings,
    bindTool,
    status,
    notifications,
    setNotifications,
    testNotification,
    quiet,
    setQuiet,
    folders,
    bindFolder,
    unbindFolder,
    silenceFolder,
    mobile,
    setMobile,
    setMobileEnabled,
    testMobile,
    setSoundsOn,
    setVolume,
    setEvent,
    setDefaultPack,
  };
}

module.exports = { createPeon, resolvePaths, normalizeTool, CATEGORY_HINTS, TOOLS };
