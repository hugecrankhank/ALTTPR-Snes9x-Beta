#!/usr/bin/env node
/*
 * TikTok LIVE → ALTTPR Snes9x bridge.
 *
 * Listens to your TikTok LIVE (gifts, likes, follows, shares) and sends the
 * matching effect to the game page over a WebSocket on this computer.
 *
 *   npm install
 *   node bridge.mjs                 # uses mapping.json
 *   node bridge.mjs --test          # no TikTok: type commands to fake events
 *
 * Then in the game: ⋯ menu → Crowd effects → turn on (address
 * ws://localhost:21213). Every gift that arrives is printed with its name, so
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
  c.port ??= 21213;
  c.gifts ??= {};
  c.giftsLower = Object.fromEntries(Object.entries(c.gifts).map(([k, v]) => [String(k).toLowerCase(), v]));
  return c;
}
// Edit mapping.json while it runs: changes apply right away.
fs.watchFile(cfgPath, { interval: 1000 }, () => {
  try { cfg = loadConfig(); log('mapping.json reloaded'); } catch (e) { log('mapping.json has an error, kept the old one: ' + e.message); }
});

function log(...m) { console.log(new Date().toLocaleTimeString(), ...m); }

// ── tiny WebSocket server (text frames only, which is all we need) ─────────
const clients = new Set();
let knownEffects = null;   // ids the game reported in its hello

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`ALTTPR crowd bridge. Game pages connected: ${clients.size}\n`);
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
    const bad = Object.values(cfg.gifts).concat(cfg.follow, cfg.share, cfg.likes?.effect).filter((id) => id && !knownEffects.has(id));
    if (bad.length) log('mapping.json names effects the game does not have: ' + [...new Set(bad)].join(', '));
  } else if (m.type === 'applied') {
    log(`  ✓ applied ${m.effect}${m.user ? ' for ' + m.user : ''}`);
  }
}

// ── turning TikTok events into effects ─────────────────────────────────────
const cooldown = new Map();   // user → last time, for follows/shares (spam guard)

function fire(effect, user, label, count = 1) {
  if (!effect) return;
  if (knownEffects && !knownEffects.has(effect)) { log(`  ! unknown effect "${effect}" (check mapping.json)`); return; }
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
  if (TEST) startTest(); else startTikTok();
});
server.on('error', (e) => { log(e.code === 'EADDRINUSE' ? `port ${cfg.port} is in use (bridge already running?)` : e.message); process.exit(1); });
