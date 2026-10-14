#!/usr/bin/env node
/*
 * TikTok LIVE → ALTTPR Snes9x bridge.
 *
 * Listens to your TikTok LIVE (gifts, likes, follows, shares) and sends the
 * matching effect to the game page over a WebSocket on this computer.
 *
 * Two ways to hear the LIVE ("source" in mapping.json):
 *   "tikfinity" (default, free): the TikFinity desktop app connects to TikTok
 *       and the bridge reads its Events API on port 21213. The bridge itself
 *       listens on 21214 (the game's default address).
 *   "direct": the bridge connects to TikTok itself with tiktok-live-connector.
 *       That needs a sign-server key ("signServer" + "signApiKey"), which
 *       Euler Stream and tik.tools both charge for.
 *
 *   npm install
 *   node bridge.mjs                 # uses mapping.json
 *   node bridge.mjs --test          # no TikTok: type commands to fake events
 *
 * Then in the game: ⋯ menu → Crowd effects → turn on (address
 * ws://localhost:21214). Every gift that arrives is printed with its name, so
 * you can add it to mapping.json.
 *
 * Needs Node 20+. The WebSocket server is built in (no extra packages); the
 * only dependency is tiktok-live-connector, which is loaded only when not in
 * --test mode.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TEST = args.includes('--test');
const cfgPath = (() => { const i = args.indexOf('--config'); return i >= 0 ? args[i + 1] : path.join(HERE, 'mapping.json'); })();

let cfg = loadConfig();
function loadConfig() {
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  c.source = String(c.source || 'tikfinity').toLowerCase();
  c.tikfinityPort ??= 21213;
  // TikFinity's Events API already uses 21213, so the bridge uses 21214.
  c.port ??= 21214;
  if (c.source === 'tikfinity' && c.port === c.tikfinityPort) c.port = c.tikfinityPort + 1;
  c.gifts ??= {};
  c.giftsLower = Object.fromEntries(Object.entries(c.gifts).map(([k, v]) => [String(k).toLowerCase(), v]));
  return c;
}
// Edit mapping.json while it runs: changes apply right away.
fs.watchFile(cfgPath, { interval: 1000 }, () => {
  try { cfg = loadConfig(); log('mapping.json reloaded'); sendDurations(); } catch (e) { log('mapping.json has an error, kept the old one: ' + e.message); }
});

function log(...m) { console.log(new Date().toLocaleTimeString(), ...m); }

// ── tiny WebSocket server (text frames only, which is all we need) ─────────
const clients = new Set();
let knownEffects = null;   // ids the game reported in its hello

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ticker') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(TICKER_HTML); return; }
  if (url.pathname === '/ticker.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(tickerData())); return; }
  if (url.pathname.startsWith('/icons/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice(7)));
    const file = path.join(HERE, 'icons', name);
    if (/\.(png|gif|webp|jpe?g)$/i.test(name) && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'image/' + name.split('.').pop().toLowerCase().replace('jpg', 'jpeg'), 'cache-control': 'max-age=60' });
      fs.createReadStream(file).pipe(res); return;
    }
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`ALTTPR crowd bridge. Game pages connected: ${clients.size}\nScrolling gift list for OBS: http://localhost:${cfg.port}/ticker\n`);
});

server.on('upgrade', (req, socket) => {
  const origin = req.headers.origin || '';
  const allowed = cfg.allowedOrigins ?? ['https://hugecrankhank.github.io', 'http://localhost', 'http://127.0.0.1'];
  if (origin && !allowed.some((o) => origin === o || origin.startsWith(o + ':') || origin.startsWith(o + '/'))) {
    log(`refused a connection from ${origin} (add it to "allowedOrigins" in mapping.json if it's yours)`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const client = { socket, buf: Buffer.alloc(0) };
  clients.add(client);
  log(`game connected (${clients.size} open)`);
  sendTo(client, { type: 'status', text: TEST ? 'Bridge in test mode' : (liveText || 'Bridge connected') });
  socket.on('data', (d) => { client.buf = Buffer.concat([client.buf, d]); readFrames(client); });
  const bye = () => { if (clients.delete(client)) log(`game disconnected (${clients.size} open)`); };
  socket.on('close', bye); socket.on('error', bye);
});

function readFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let data = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const m = b.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
    c.buf = b.subarray(need);
    if (op === 0x8) { c.socket.end(); return; }                       // close
    if (op === 0x9) { writeFrame(c.socket, data, 0xA); continue; }    // ping → pong
    if (op === 0x1) onGameMessage(data.toString('utf8'));
  }
}
function writeFrame(socket, payload, op = 0x1) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n])
    : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  socket.write(Buffer.concat([head, payload]));
}
function sendTo(c, msg) { try { writeFrame(c.socket, Buffer.from(JSON.stringify(msg))); } catch {} }
function broadcast(msg) { for (const c of clients) sendTo(c, msg); }

function onGameMessage(text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (m.type === 'hello') {
    knownEffects = new Set((m.effects || []).map((e) => e.id));
    for (const e of m.effects || []) if (e.name) effectNames[e.id] = e.name;
    sendDurations();
    const named = [...new Set(Object.values(cfg.gifts).concat(cfg.follow, cfg.share, cfg.likes?.effect).filter(Boolean))];
    for (const id of named) {
      if (knownEffects.has(id)) continue;
      const fix = resolveEffect(id);
      log(fix ? `mapping.json: "${id}" isn't an effect name, using "${fix}" (fix the spelling to silence this)`
              : `mapping.json: "${id}" isn't an effect the game has. Type "list" in --test mode to see them all.`);
    }
  } else if (m.type === 'applied') {
    log(`  ✓ applied ${m.effect}${m.user ? ' for ' + m.user : ''}`);
  }
}

// ── turning TikTok events into effects ─────────────────────────────────────
const cooldown = new Map();   // user → last time, for follows/shares (spam guard)

// Forgive capital letters and small typos in mapping.json ("bombs_None",
// "cucoo_storm"): pick the one effect within 2 letters of what was written.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function resolveEffect(id) {
  if (!knownEffects || knownEffects.has(id)) return id;
  const want = String(id).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (knownEffects.has(want)) return want;
  let best = null, bestD = 3, tie = false;
  for (const k of knownEffects) {
    const dist = editDistance(want, k);
    if (dist < bestD) { best = k; bestD = dist; tie = false; } else if (dist === bestD) tie = true;
  }
  return best && !tie ? best : null;
}

function fire(effect, user, label, count = 1) {
  if (!effect) return;
  const resolved = resolveEffect(effect);
  if (!resolved) { log(`  ! unknown effect "${effect}" (check mapping.json)`); return; }
  effect = resolved;
  if (!clients.size) { log(`  (no game connected, dropped ${effect})`); return; }
  broadcast({ type: 'effect', effect, user, label, count: Math.min(count, cfg.maxPerGift ?? 5) });
  log(`  → ${effect} x${count} ${user ? 'from ' + user : ''} ${label ? '(' + label + ')' : ''}`);
}

function onGift(user, giftName, giftId, count) {
  const e = cfg.giftsLower[String(giftName || '').toLowerCase()] ?? cfg.gifts[String(giftId)];
  log(`gift: ${user} sent "${giftName}" (id ${giftId}) x${count}${e ? '' : ' — not mapped'}`);
  fire(e, user, `${giftName}${count > 1 ? ' x' + count : ''}`, count);
}

let likeBank = 0;
function onLike(user, n) {
  const l = cfg.likes; if (!l?.effect || !l.every) return;
  likeBank += n;
  while (likeBank >= l.every) { likeBank -= l.every; fire(l.effect, user, `${l.every} likes`); }
}
function onSocial(kind, user) {
  const effect = cfg[kind]; if (!effect) return;
  const key = kind + ':' + user, now = Date.now();
  if (now - (cooldown.get(key) || 0) < 10 * 60 * 1000) return;   // once per viewer per 10 min
  cooldown.set(key, now);
  log(`${kind}: ${user}`);
  fire(effect, user, kind === 'follow' ? 'Followed' : 'Shared');
}

// ── durations and the scrolling gift list ──────────────────────────────────
// "durations" in mapping.json changes how long timed effects last; the game
// is told whenever it connects or the file is saved.
function sendDurations() { broadcast({ type: 'durations', secs: cfg.durations || {} }); }

// Effect names for the gift list (the game sends its own names when it connects).
const effectNames = {
  heal_full: 'Full heal', heal_1: '+1 heart', hurt_2: '-2 hearts', hp_1: 'Down to 1 heart',
  magic_full: 'Refill magic', magic_drain: 'Drain magic', rupees_plus: '+50 rupees', rupees_minus: '-50 rupees',
  bombs_plus: '+10 bombs', bombs_none: 'Lose all bombs', arrows_plus: '+10 arrows', arrows_none: 'Lose all arrows',
  enemy_spawn: 'Extra enemy', insta_kill: 'Instant death', ice: 'Ice physics', cucco_storm: 'Cucco attack', invert: 'Inverted D-pad',
  no_sword: 'No sword', no_item: 'No Y item', swap_by: 'B and Y swapped', one_hit: 'One-heart mode',
  no_magic: 'Magic locked', sprite_roll: 'Random sprite', sprite_fav: 'Random favourite sprite',
  msu_roll: 'Random MSU pack', seed_roll: 'New seed!',
};
const defaultSecs = { ice: 20, cucco_storm: 30, invert: 20, no_sword: 20, no_item: 20, swap_by: 20, one_hit: 30, no_magic: 30 };

function tickerData() {
  const t = cfg.ticker || {};
  const labels = t.labels || {};
  const icons = (() => { try { return fs.readdirSync(path.join(HERE, 'icons')); } catch { return []; } })();
  const iconFor = (gift) => {
    const want = gift.toLowerCase();
    return icons.find((f) => f.replace(/\.[^.]+$/, '').toLowerCase() === want) || null;
  };
  const items = [];
  for (const [gift, raw] of Object.entries(cfg.gifts || {})) {
    const id = resolveEffect(raw) || raw;
    const secs = id in defaultSecs ? (+(cfg.durations || {})[id] > 0 ? +cfg.durations[id] : defaultSecs[id]) : 0;
    items.push({ gift, label: labels[id] || effectNames[id] || id, secs, icon: iconFor(gift) ? '/icons/' + encodeURIComponent(iconFor(gift)) : null });
  }
  if (t.showLikes !== false && cfg.likes?.effect && cfg.likes?.every)
    items.push({ gift: `${cfg.likes.every} likes`, label: labels[cfg.likes.effect] || effectNames[cfg.likes.effect] || cfg.likes.effect, secs: 0, icon: null, emoji: '❤' });
  for (const kind of ['follow', 'share']) if (t.showSocial !== false && cfg[kind])
    items.push({ gift: kind === 'follow' ? 'Follow' : 'Share', label: labels[cfg[kind]] || effectNames[cfg[kind]] || cfg[kind], secs: 0, icon: null, emoji: kind === 'follow' ? '➕' : '↗' });
  return { title: t.title ?? 'GIFT EFFECTS', speed: t.speed || 70, items };
}

const TICKER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Gift effects</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* For OBS / TikTok LIVE Studio browser sources. ?height=80 sets the bar
     height, ?bg=0 makes the bar background transparent, ?speed=90 overrides
     the scroll speed (pixels per second). */
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body { font: 700 calc(var(--h) * .36)/1 system-ui, "Segoe UI", sans-serif; color: #fff; --h: 72px; }
  .bar { display: flex; align-items: center; height: var(--h); background: rgba(8,10,14,.88); border-top: 2px solid #e3b341; border-bottom: 2px solid #e3b341; box-sizing: border-box; }
  .bar.clear { background: transparent; border-color: transparent; }
  .title { flex: none; height: 100%; display: flex; align-items: center; padding: 0 .7em; background: #e3b341; color: #111; letter-spacing: .06em; font-size: .8em; z-index: 1; }
  .view { flex: 1; overflow: hidden; height: 100%; }
  .track { display: flex; width: max-content; height: 100%; align-items: center; will-change: transform; }
  .item { display: flex; align-items: center; gap: .35em; padding: 0 1.1em; white-space: nowrap; text-shadow: 0 2px 3px #000; }
  .item img { height: calc(var(--h) * .78); width: auto; }
  .item .em { font-size: 1.3em; }
  .item .eq { color: #e3b341; }
  .item .secs { color: #9fb3c8; font-size: .75em; font-weight: 600; }
  .dot { color: #e3b341; opacity: .6; }
  .off { color: #9fb3c8; padding: 0 1em; font-size: .7em; }
</style></head><body>
<div class="bar" id="bar"><div class="title" id="title"></div><div class="view"><div class="track" id="track"></div></div></div>
<script>
const q = new URLSearchParams(location.search);
if (q.get('height')) document.body.style.setProperty('--h', (+q.get('height') || 72) + 'px');
if (q.get('bg') === '0') document.getElementById('bar').classList.add('clear');
const track = document.getElementById('track'), titleEl = document.getElementById('title');
let last = '', x = 0, speed = 70, half = 0, prev = performance.now();
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function build(d) {
  speed = +q.get('speed') || d.speed || 70;
  titleEl.textContent = d.title || ''; titleEl.style.display = d.title ? '' : 'none';
  const one = d.items.map((i) => '<span class="item">' +
    (i.icon ? '<img src="' + i.icon + '" alt="">' : '<span class="em">' + esc(i.emoji || '🎁') + '</span>') +
    esc(i.gift) + ' <span class="eq">=</span> ' + esc(i.label) + (i.secs ? ' <span class="secs">' + i.secs + 's</span>' : '') +
    '</span><span class="dot">◆</span>').join('');
  // two copies side by side, so the loop is seamless
  track.innerHTML = one + one;
  requestAnimationFrame(() => { half = track.scrollWidth / 2; });
}
async function poll() {
  try {
    const r = await fetch('/ticker.json', { cache: 'no-store' });
    const t = await r.text();
    if (t !== last) { last = t; build(JSON.parse(t)); }
  } catch (e) { if (!last) track.innerHTML = '<span class="off">Waiting for the bridge…</span>'; }
  setTimeout(poll, 4000);
}
function step(now) {
  const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
  if (half > 0) { x -= speed * dt; if (-x >= half) x += half; track.style.transform = 'translateX(' + x.toFixed(1) + 'px)'; }
  requestAnimationFrame(step);
}
poll(); requestAnimationFrame(step);
</script></body></html>`;

// ── TikFinity source ───────────────────────────────────────────────────────
// TikFinity (free desktop app) connects to your LIVE itself and re-sends every
// event on ws://localhost:21213 as {"event": "gift", "data": {...}}. The bridge
// listens to that, so no sign server or API key is needed. Node 20 has no
// built-in WebSocket client, so this is a small one on top of node:net.
function startTikFinity() {
  const port = cfg.tikfinityPort;
  let warned = false;
  function connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('upgrade', (res, socket) => {
      warned = false;
      liveText = 'Connected to TikFinity';
      log(`connected to TikFinity on port ${port}. Gifts, likes, follows and shares will come through while you're live.`);
      broadcast({ type: 'status', text: liveText });
      const conn = { socket, buf: Buffer.alloc(0) };
      socket.on('data', (d) => { conn.buf = Buffer.concat([conn.buf, d]); readClientFrames(conn); });
      const lost = () => {
        if (conn.gone) return; conn.gone = true;
        liveText = 'TikFinity disconnected';
        broadcast({ type: 'status', text: liveText });
        log('lost TikFinity, retrying in 5s'); setTimeout(connect, 5000);
      };
      socket.on('close', lost); socket.on('error', lost);
    });
    req.on('response', (res) => { log(`TikFinity answered with HTTP ${res.statusCode} instead of a WebSocket. Retrying in 10s.`); res.resume(); setTimeout(connect, 10000); });
    req.on('error', () => {
      if (!warned) {
        log(`can't reach TikFinity on port ${port}. Open TikFinity, connect it to your TikTok, and check`);
        log('its Events API / WebSocket port is ' + port + '. Retrying every 5s quietly.');
        warned = true;
      }
      liveText = 'Waiting for TikFinity'; setTimeout(connect, 5000);
    });
    req.end();
  }
  connect();
}

function readClientFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + len) return;
    const data = b.subarray(off, off + len);
    c.buf = b.subarray(off + len);
    if (op === 0x0 || op === 0x1) {
      // TikFinity sends whole messages; continuation frames are joined just in case
      c.text = (c.text || '') + data.toString('utf8');
      if (b[0] & 0x80) { const t = c.text; c.text = ''; onTikFinity(t); }
    } else if (op === 0x9) writeClientFrame(c.socket, data, 0xA);   // ping → pong
    else if (op === 0x8) { c.socket.end(); return; }
  }
}
function writeClientFrame(socket, payload, op) {   // client frames must be masked
  const mask = crypto.randomBytes(4), n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]);
  const body = Buffer.from(payload); for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  try { socket.write(Buffer.concat([head, mask, body])); } catch {}
}

function onTikFinity(text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  const ev = String(m.event || m.type || '').toLowerCase();
  const d = m.data || {};
  const user = d.uniqueId || d.user?.uniqueId || d.nickname || d.user?.nickname || 'someone';
  if (ev === 'gift') {
    const giftType = d.giftType ?? d.giftDetails?.giftType;
    if (giftType === 1 && d.repeatEnd === false) return;   // streak still going: wait for the final count
    const name = d.giftName || d.giftDetails?.giftName || d.extendedGiftInfo?.name || '';
    onGift(user, name, d.giftId, d.repeatCount || 1);
  } else if (ev === 'like') onLike(user, d.likeCount || 1);
  else if (ev === 'follow') onSocial('follow', user);
  else if (ev === 'share') onSocial('share', user);
  else if (ev === 'social') {
    const kind = String(d.displayType || d.label || '').toLowerCase();
    if (kind.includes('follow')) onSocial('follow', user);
    else if (kind.includes('share')) onSocial('share', user);
  } else if (ev === 'streamend') {
    liveText = 'TikTok LIVE ended'; broadcast({ type: 'status', text: liveText }); log(liveText);
  }
}

// ── TikTok connection ──────────────────────────────────────────────────────
let liveText = '';
async function startTikTok() {
  if (!cfg.username || cfg.username === 'your_tiktok_username') {
    log('Set "username" in mapping.json to your TikTok name (without @). Or run with --test.'); process.exit(1);
  }
  // TikTok connections must be signed by an outside "sign server". Euler Stream
  // (the library default) now wants a paid plan for this, so the default here
  // is tik.tools, which has a free key. "signServer" in mapping.json can be
  // "tiktools", "euler", or a full https:// URL of any compatible server.
  const SIGN_SERVERS = { tiktools: 'https://api.tik.tools', euler: 'https://api.eulerstream.com' };
  const signChoice = String(cfg.signServer || 'tiktools');
  const signUrl = SIGN_SERVERS[signChoice.toLowerCase()] || signChoice;
  const key = String(cfg.signApiKey || '').trim();
  if (!/^https:\/\//.test(signUrl)) {
    log(`"signServer" in mapping.json should be "tiktools", "euler", or an https:// address (got "${signChoice}").`); process.exit(1);
  }
  if (!key || key === 'paste_your_key_here') {
    log('No "signApiKey" in mapping.json. Get a free key at https://tik.tools/login,');
    log('paste it into mapping.json as "signApiKey", then start the bridge again.'); process.exit(1);
  }
  // The library reads these when it loads, so set them before importing it.
  process.env.SIGN_API_URL = signUrl;
  process.env.SIGN_API_KEY = key;

  let TikTokLiveConnection, SignConfig;
  try { ({ TikTokLiveConnection, SignConfig } = await import('tiktok-live-connector')); }
  catch { log('tiktok-live-connector is not installed. Run "npm install" in this folder first.'); process.exit(1); }
  if (SignConfig) { SignConfig.basePath = signUrl; SignConfig.apiKey = key; }
  log(`signing TikTok connections through ${new URL(signUrl).host}`);

  // Extended gift info is a separate TikTok lookup that often fails; gift names
  // already arrive with each gift, so it's not needed.
  const conn = new TikTokLiveConnection(cfg.username, { enableExtendedGiftInfo: false, signApiKey: key });

  conn.on('gift', (d) => {
    const type = d.giftDetails?.giftType;
    if (type === 1 && !d.repeatEnd) return;         // streak still going: wait for the final count
    const name = d.giftDetails?.giftName || d.extendedGiftInfo?.name || '';
    onGift(d.user?.uniqueId || d.user?.nickname || 'someone', name, d.giftId, d.repeatCount || 1);
  });
  conn.on('like', (d) => onLike(d.user?.uniqueId || 'someone', d.likeCount || 1));
  conn.on('follow', (d) => onSocial('follow', d.user?.uniqueId || 'someone'));
  conn.on('share', (d) => onSocial('share', d.user?.uniqueId || 'someone'));
  conn.on('disconnected', () => { liveText = 'TikTok disconnected'; broadcast({ type: 'status', text: liveText }); log(liveText + ', retrying in 30s'); setTimeout(go, 30000); });
  conn.on('streamEnd', () => { liveText = 'TikTok LIVE ended'; broadcast({ type: 'status', text: liveText }); log(liveText); });
  conn.on('error', (e) => log('TikTok error:', e?.info || e?.exception?.message || e));

  async function go() {
    try {
      const state = await conn.connect();
      liveText = `Live as @${cfg.username}`;
      log(`connected to @${cfg.username}'s LIVE (room ${state.roomId})`);
      broadcast({ type: 'status', text: liveText });
    } catch (e) {
      const msg = e?.message || String(e);
      liveText = 'Waiting for TikTok LIVE';
      if (/plan|api key|apikey|unauthori[sz]ed|forbidden|\b40[123]\b/i.test(msg)) {
        log(`the sign server refused the connection (${msg}). Check "signApiKey" in mapping.json. Retrying in 30s.`);
      } else {
        log(`couldn't join @${cfg.username}'s LIVE (${msg}). Are you live? Retrying in 30s.`);
      }
      setTimeout(go, 30000);
    }
  }
  go();
}

// ── test mode: fake events from the keyboard ───────────────────────────────
function startTest() {
  log('TEST MODE. Commands:');
  log('  <effect_id>            e.g. heal_full, invert, rupees_minus');
  log('  gift <name> [count]    e.g. gift Rose 3   (uses mapping.json)');
  log('  like <n> | follow | share | list');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (!cmd) return;
    if (cmd === 'gift') {
      const count = /^\d+$/.test(rest.at(-1) || '') ? +rest.pop() : 1;
      onGift('tester', rest.join(' '), 0, count);
    } else if (cmd === 'like') onLike('tester', +(rest[0] || 1));
    else if (cmd === 'follow' || cmd === 'share') { cooldown.clear(); onSocial(cmd, 'tester'); }
    else if (cmd === 'list') log(knownEffects ? [...knownEffects].join(', ') : 'connect the game first to see its effects');
    else fire(cmd, 'tester', '');
  });
}

server.listen(cfg.port, '127.0.0.1', () => {
  log(`bridge listening on ws://localhost:${cfg.port}`);
  log(`scrolling gift list for OBS: http://localhost:${cfg.port}/ticker`);
  if (TEST) startTest();
  else if (cfg.source === 'tikfinity') startTikFinity();
  else if (cfg.source === 'direct') startTikTok();
  else { log(`"source" in mapping.json should be "tikfinity" or "direct" (got "${cfg.source}").`); process.exit(1); }
});
server.on('error', (e) => { log(e.code === 'EADDRINUSE' ? `port ${cfg.port} is in use (bridge already running?)` : e.message); process.exit(1); });
