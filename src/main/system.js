'use strict';

// Her hands on the PC, for what you ask her (chat.js, out loud or typed): the music, the volume,
// launching an app from the Start menu, opening a web page. Windows only, through a small
// PowerShell helper (system.ps1) started on first use and kept running, so a "volume 30" lands
// at once. She never gets a free hand: only these few things, and an app is only ever launched
// from the Start menu's own list.

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// in the installed app it sits next to the app archive (asarUnpack), where PowerShell can read it
const SCRIPT = path.join(__dirname, 'system.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const TIMEOUT_MS = 12000;
const APPS_TTL_MS = 5 * 60 * 1000;

let child = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

function helper() {
  if (child) return child;
  child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, String(process.pid),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let res;
    try {
      res = JSON.parse(line);
    } catch {
      return;
    }
    const call = pending.get(res.id);
    if (!call) return;
    pending.delete(res.id);
    clearTimeout(call.timer);
    if (res.error) call.reject(new Error(res.error));
    else call.resolve(res);
  });
  child.stderr.on('data', (d) => console.error('[capri] system:', String(d).trim()));
  const gone = () => {
    child = null;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('system helper stopped'));
    }
    pending.clear();
  };
  child.on('exit', gone);
  child.on('error', gone);
  return child;
}

function call(op, args = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('windows only'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('system helper timed out'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    helper().stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  });
}

const simple = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

// ---------- music ----------

const MEDIA = new Set(['play', 'pause', 'toggle', 'next', 'previous', 'stop']);

// What's playing: { title, artist, album, app, status } or null.
async function playing() {
  return (await call('playing')).playing || null;
}

async function media(action) {
  if (!MEDIA.has(action)) throw new Error(`unknown media action ${action}`);
  const res = await call('media', { action });
  return { playing: res.playing || null, keys: Boolean(res.keys) };
}

// ---------- volume ----------

// The apps with a slider in Windows' volume mixer: [{ name, level, muted, active }]
async function sessions() {
  return (await call('sessions')).sessions || [];
}

// change: { set: 0-100, delta: ±n, mute: true/false }, all optional (none: just read it).
// app: one app's own slider, by its name as said ("spotify", "AM Music"); else the whole PC's.
// Resolves with { level, muted, app } ("app" empty for the PC), or { missing: true }.
async function volume({ app = '', set, delta, mute } = {}) {
  const change = {
    set: Number.isFinite(set) ? Math.round(set) : undefined,
    delta: Number.isFinite(delta) ? Math.round(delta) : undefined,
    mute: typeof mute === 'boolean' ? mute : undefined,
  };
  if (!app) return call('volume', change);
  const key = simple(app);
  const found = (await sessions()).find((s) => simple(s.name) === key)
    || (await sessions()).find((s) => key.length >= 3 && (simple(s.name).includes(key) || key.includes(simple(s.name))));
  if (!found) return { missing: true };
  return call('volume', { app: found.name, ...change });
}

// ---------- apps ----------

let appsCache = null; // { at, list: [{ name, id }] }

// The Start menu: everything that can be launched, [{ name, id }].
async function launchables() {
  if (appsCache && Date.now() - appsCache.at < APPS_TTL_MS) return appsCache.list;
  const list = (await call('apps')).apps || [];
  appsCache = { at: Date.now(), list };
  return list;
}

// Uninstallers and help files are in the Start menu too: never those.
const NOT_APPS = /uninstall|désinstall|desinstal|deinstal|readme|lisez|help|aide|documentation|release notes|website|site web/i;

// The Start menu entry that `wanted` names ("spotify", "le bloc-notes", "vs code").
async function findLaunchable(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = (await launchables()).filter((a) => !NOT_APPS.test(a.name));
  const score = (app) => {
    const name = simple(app.name);
    if (name === key) return 100;
    if (name.startsWith(key)) return 80 - (name.length - key.length) / 10; // "spotify" -> "Spotify Premium"
    if (key.startsWith(name) && name.length >= 3) return 60;
    // "code" -> "Visual Studio Code": a whole word of its name
    const words = app.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).map(simple).filter(Boolean);
    if (words.includes(key)) return 50 - words.length;
    if (key.length >= 4 && name.includes(key)) return 30 - (name.length - key.length) / 10;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

// Launches a Start menu entry, by its id, only if it's still in the list.
async function launch(id) {
  const app = (await launchables()).find((a) => a.id === id);
  if (!app) throw new Error('not in the Start menu');
  await call('launch', { appId: app.id });
  return { name: app.name };
}

// ---------- the web ----------

// A web address as said ("youtube.com", "https://x.y/z"), or null when it isn't one.
// Only http(s): never file:, javascript: or an app's own protocol.
function webAddress(text) {
  let s = String(text || '').trim().replace(/^<|>$/g, '');
  if (!s || /\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d+/.test(s)) return null; // another scheme
    s = `https://${s}`;
  }
  try {
    const url = new URL(s);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Looking something up: on the web, or on a site she knows how to search.
const SEARCH = {
  web: 'https://www.google.com/search?q=',
  youtube: 'https://www.youtube.com/results?search_query=',
  music: 'https://music.youtube.com/search?q=',
  wikipedia: 'https://www.wikipedia.org/search-redirect.php?search=',
  maps: 'https://www.google.com/maps/search/',
  images: 'https://www.google.com/search?tbm=isch&q=',
};

function searchUrl(site, query) {
  return (SEARCH[site] || SEARCH.web) + encodeURIComponent(String(query || '').trim().slice(0, 200));
}

// Something to listen to ("daft punk"): looked up in Spotify when it's installed (its own
// search, which doesn't start playing by itself), else on YouTube Music.
async function musicSearch(query) {
  const q = String(query || '').trim().slice(0, 200);
  const spotify = process.platform === 'win32' && (await findLaunchable('spotify').catch(() => null));
  if (spotify && /spotify/i.test(spotify.name)) return { url: `spotify:search:${encodeURIComponent(q)}`, where: 'Spotify' };
  return { url: searchUrl('music', q), where: 'YouTube Music' };
}

function stop() {
  child?.stdin.end();
  child?.kill();
  child = null;
}

module.exports = {
  playing, media, sessions, volume, launchables, findLaunchable, launch, webAddress, searchUrl, musicSearch, stop,
};
