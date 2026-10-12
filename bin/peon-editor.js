#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createServer } = require('../src/server');
const { createPeon } = require('../src/peon');
const { version } = require('../package.json');

const HELP = `peon-editor ${version}
Browser UI for peon-ping sound packs: listen, enable/disable and move sounds between events.

Usage:
  peon-editor [options]

Options:
  -p, --port <n>     Port to listen on (default 8787)
      --pack <name>  Pack to open first
      --no-open      Do not open the browser
  -v, --version      Print version
  -h, --help         Show this help

Environment:
  PEON_DIR           peon-ping install dir (default ~/.claude/hooks/peon-ping)
  PEON_EDITOR_MOVES  Where moved-sound overrides are stored
                     (default <PEON_DIR>/../peon-editor-moves.json)
  PEON_BIN           peon CLI to use for enable/disable ("" = edit config.json directly)
`;

function parseArgs(argv) {
  const opts = { port: 8787, open: true, pack: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '-p' || arg === '--port') opts.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice(7));
    else if (arg === '--pack') opts.pack = argv[++i] || '';
    else if (arg.startsWith('--pack=')) opts.pack = arg.slice(7);
    else {
      console.error(`Unknown option: ${arg}\n\n${HELP}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('Port must be a number between 1 and 65535');
    process.exit(1);
  }
  return opts;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.version) {
  console.log(version);
  process.exit(0);
}

const peon = createPeon();
if (!fs.existsSync(peon.paths.packsDir)) {
  console.error(`peon-ping packs not found at ${peon.paths.packsDir}\nInstall peon-ping or set PEON_DIR.`);
  process.exit(1);
}

const server = createServer({ port: opts.port, peon });
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${opts.port} is busy, try --port <n>` : err.message);
  process.exit(1);
});
server.listen(opts.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${opts.port}/${opts.pack ? `#${encodeURIComponent(opts.pack)}` : ''}`;
  console.log(`peon-editor: ${url}  (Ctrl+C to stop)`);
  if (opts.open) openBrowser(url);
});
