/*
 * Crowd effects for the Snes9x player: lets TikTok LIVE viewers change the
 * game. Gifts, likes, follows and shares arrive from the TikTok bridge
 * (crowd/bridge/bridge.mjs, run on the streaming PC) over a WebSocket; each
 * one names an effect from the list below, which is queued and applied when
 * Link is in normal play (not in a menu, text box or transition).
 *
 * The ROM is never changed. Effects either write ALTTP's RAM (hearts, magic,
 * rupees, bombs, arrows) or change the buttons the game sees (inverted
 * D-pad, no sword...). The tracker reads the same RAM, so it follows along.
 *
 *   CrowdEffects.trigger('heal_full', 'someone')   // test from the console
 *   CrowdEffects.list()                            // ids and names
 *
 * Settings (bridge address, on/off) are in the emulator menu under
 * "Crowd effects". The bridge address defaults to ws://localhost:21213.
 */
(function (root) {
  'use strict';

  var SETTINGS_KEY = 's9x-crowd-settings';
  var cfg = { enabled: false, url: 'ws://localhost:21213', feed: true };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}
  function saveCfg() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch (e) {} }

  // ── ALTTP RAM (offsets into the 128 KB WRAM, i.e. $7E0000 = 0) ─────────
  var A = {
    MODE: 0x0010, SUBMODE: 0x0011,     // main game module / its step
    FROZEN: 0x02E4,                    // nonzero: Link can't move (text, cutscene)
    BOMBS: 0xF343, ARROWS: 0xF377,
    RUPEES: 0xF360,                    // 16-bit target; the HUD counts toward it
    HP_MAX: 0xF36C, HP: 0xF36D,        // 8 per heart
    MAGIC: 0xF36E,                     // 0x80 = full meter
    HP_FILL: 0xF372, MAGIC_FILL: 0xF373, BOMB_FILL: 0xF375, ARROW_FILL: 0xF376,
  };
  var PLAY_MODES = { 0x07: 1, 0x09: 1, 0x0B: 1 };   // dungeon, overworld, special overworld

  function inPlay(ram) {
    return ram.length >= 0x20000 && PLAY_MODES[ram[A.MODE]] && ram[A.SUBMODE] === 0 &&
      ram[A.FROZEN] === 0 && ram[A.HP_MAX] >= 8 && ram[A.HP] > 0;
  }
  function rupees(ram) { return ram[A.RUPEES] | (ram[A.RUPEES + 1] << 8); }
  function setRupees(ram, v) { v = Math.max(0, Math.min(999, v)); ram[A.RUPEES] = v & 0xFF; ram[A.RUPEES + 1] = v >> 8; }
  function fill(ram, addr, amount, cap) { ram[addr] = Math.min(cap, ram[addr] + amount); }

  // SNES pad bits, same order as Snes9xCore.BTN
  var B = { B: 1 << 0, Y: 1 << 1, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7 };
  function swapBits(pad, a, b) {
    var ha = pad & a, hb = pad & b;
    pad &= ~(a | b);
    if (ha) pad |= b;
    if (hb) pad |= a;
    return pad;
  }

  // ── the effects ─────────────────────────────────────────────────────────
  // Instant effects run once (apply). Timed ones last `secs` seconds of play
  // (the clock stops in menus and text boxes); a second gift adds more time.
  // Timed effects only filter input or hold a value down each frame, so a
  // save state, reset or reload can never leave the game stuck changed.
  var EFFECTS = {
    heal_full:   { name: 'Full heal', good: true,
      apply: function (r) { fill(r, A.HP_FILL, r[A.HP_MAX] - r[A.HP], 0xA0); } },
    heal_1:      { name: '+1 heart', good: true,
      apply: function (r) { fill(r, A.HP_FILL, 8, 0xA0); } },
    hurt_2:      { name: '-2 hearts', good: false,          // never kills
      apply: function (r) { r[A.HP] = Math.max(Math.min(8, r[A.HP]), r[A.HP] - 16); } },
    hp_1:        { name: 'Down to 1 heart', good: false,
      apply: function (r) { if (r[A.HP] > 8) r[A.HP] = 8; } },
    magic_full:  { name: 'Refill magic', good: true,
      apply: function (r) { r[A.MAGIC_FILL] = 0x80; } },
    magic_drain: { name: 'Drain magic', good: false,
      apply: function (r) { r[A.MAGIC] = 0; r[A.MAGIC_FILL] = 0; } },
    rupees_plus: { name: '+50 rupees', good: true,
      apply: function (r) { setRupees(r, rupees(r) + 50); } },
    rupees_minus:{ name: '-50 rupees', good: false,
      apply: function (r) { setRupees(r, rupees(r) - 50); } },
    bombs_plus:  { name: '+10 bombs', good: true,          // the game caps it at your bag size
      apply: function (r) { fill(r, A.BOMB_FILL, 10, 50); } },
    bombs_none:  { name: 'Lose all bombs', good: false,
      apply: function (r) { r[A.BOMBS] = 0; r[A.BOMB_FILL] = 0; } },
    arrows_plus: { name: '+10 arrows', good: true,
      apply: function (r) { fill(r, A.ARROW_FILL, 10, 70); } },
    arrows_none: { name: 'Lose all arrows', good: false,
      apply: function (r) { r[A.ARROWS] = 0; r[A.ARROW_FILL] = 0; } },

    invert:      { name: 'Inverted D-pad', good: false, secs: 20,
      input: function (p) { return swapBits(swapBits(p, B.UP, B.DOWN), B.LEFT, B.RIGHT); } },
    no_sword:    { name: 'No sword', good: false, secs: 20,
      input: function (p) { return p & ~B.B; } },
    no_item:     { name: 'No Y item', good: false, secs: 20,
      input: function (p) { return p & ~B.Y; } },
    swap_by:     { name: 'B and Y swapped', good: false, secs: 20,
      input: function (p) { return swapBits(p, B.B, B.Y); } },
    one_hit:     { name: 'One-heart mode', good: false, secs: 30,
      frame: function (r) { if (r[A.HP] > 8) r[A.HP] = 8; r[A.HP_FILL] = 0; } },
    no_magic:    { name: 'Magic locked', good: false, secs: 30,
      frame: function (r) { r[A.MAGIC] = 0; r[A.MAGIC_FILL] = 0; } },
  };

  // ── queue and timers ────────────────────────────────────────────────────
  var queue = [];              // { id, user, label }
  var active = {};             // id -> frames left
  var gap = 0;                 // frames until the next queued effect may run
  var GAP_FRAMES = 45;         // ~0.75 s between effects, so each one is seen
  var MAX_QUEUE = 60;

  function trigger(id, user, label) {
    var fx = EFFECTS[id];
    if (!fx) { console.warn('[crowd] unknown effect', id); return false; }
    if (queue.length >= MAX_QUEUE) return false;
    queue.push({ id: id, user: user || '', label: label || '' });
    render();
    return true;
  }

  function onFrame(core) {
    var ram = core.wram();
    if (!inPlay(ram)) return;
    // timed effects
    for (var id in active) {
      var fx = EFFECTS[id];
      if (fx.frame) fx.frame(ram);
      if (--active[id] <= 0) { delete active[id]; feed(fx.name + ' ended', 'end'); render(); }
    }
    if (gap > 0) { gap--; return; }
    var job = queue.shift();
    if (!job) return;
    var f = EFFECTS[job.id];
    if (f.secs) active[job.id] = (active[job.id] || 0) + Math.round(f.secs * (core.fps || 60.1));
    else f.apply(ram);
    gap = GAP_FRAMES;
    feed((job.user ? job.user + ': ' : '') + (job.label ? job.label + ' → ' : '') + f.name + (f.secs ? ' (' + f.secs + 's)' : ''),
      f.good ? 'good' : 'bad');
    send({ type: 'applied', effect: job.id, user: job.user });
    render();
  }

  function onInput(pad) {
    var p = window.Snes9xPlayer, core = p && p.core;
    if (!core) return pad;
    var any = false;
    for (var id in active) { if (EFFECTS[id].input) { any = true; break; } }
    if (!any || !inPlay(core.wram())) return pad;
    for (var k in active) if (EFFECTS[k].input) pad = EFFECTS[k].input(pad);
    return pad;
  }

  // ── on-screen feed (top-right of the game, so a TikTok viewer sees it) ──
  var feedEl = null;
  var CSS =
    '.cc-feed { position: absolute; right: 8px; top: 8px; z-index: 25; display: flex; flex-direction: column; align-items: flex-end;' +
    ' gap: 4px; pointer-events: none; max-width: 70%; font: 600 12px/1.25 system-ui, sans-serif; }' +
    '.cc-feed div { background: rgba(10,12,16,.82); color: #fff; padding: 4px 9px; border-radius: 6px; border-left: 3px solid #8b95a3;' +
    ' transition: opacity .4s; text-shadow: 0 1px 1px #000; }' +
    '.cc-feed .good { border-left-color: #3fb950; } .cc-feed .bad { border-left-color: #e5534b; } .cc-feed .end { opacity: .7; }' +
    '.cc-feed .info { border-left-color: #e3b341; }';
  function feed(text, kind) {
    if (!cfg.feed || typeof document === 'undefined') return;
    if (!feedEl || !feedEl.isConnected) {
      var host = document.querySelector('.s9x'); if (!host) return;
      if (!document.getElementById('cc-css')) { var st = document.createElement('style'); st.id = 'cc-css'; st.textContent = CSS; document.head.appendChild(st); }
      feedEl = document.createElement('div'); feedEl.className = 'cc-feed'; host.appendChild(feedEl);
    }
    var d = document.createElement('div');
    d.className = kind || ''; d.textContent = text;
    feedEl.appendChild(d);
    while (feedEl.children.length > 4) feedEl.firstChild.remove();
    setTimeout(function () { d.style.opacity = '0'; setTimeout(function () { d.remove(); }, 450); }, 4000);
  }

  // ── connection to the bridge ────────────────────────────────────────────
  var ws = null, status = 'off', retryT = null, retryMs = 2000, bridgeInfo = '';
  function send(msg) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) {} } }

  function connect() {
    clearTimeout(retryT);
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
    if (!cfg.enabled) { status = 'off'; render(); return; }
    status = 'connecting'; render();
    try { ws = new WebSocket(cfg.url); } catch (e) { status = 'bad address'; render(); return; }
    ws.onopen = function () {
      status = 'connected'; retryMs = 2000; render();
      send({ type: 'hello', app: 'alttpr-snes9x', effects: list() });
    };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'effect') {
        var n = Math.max(1, Math.min(10, m.count | 0 || 1));
        for (var i = 0; i < n; i++) trigger(m.effect, m.user, m.label);
      } else if (m.type === 'status') {
        bridgeInfo = m.text || ''; render();
        if (m.text) feed(m.text, 'info');
      }
    };
    ws.onclose = function () {
      ws = null;
      if (!cfg.enabled) return;
      status = 'waiting for bridge'; render();
      retryT = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    ws.onerror = function () {};
  }

  // ── menu section (in the emulator's ⋯ menu) ─────────────────────────────
  var rerender = null;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function menuHtml(rr) {
    if (rr) rerender = rr;
    var timed = Object.keys(active).map(function (id) { return EFFECTS[id].name + ' ' + Math.ceil(active[id] / 60) + 's'; });
    var tests = Object.keys(EFFECTS).map(function (id) {
      return '<button type="button" data-ext="cc-test" data-id="' + id + '">' + esc(EFFECTS[id].name) + '</button>';
    }).join('');
    return '<h4>Crowd effects</h4>' +
      '<div class="row"><span>TikTok effects on</span><input type="checkbox" data-ext="cc-enabled"' + (cfg.enabled ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Bridge address</span><input type="text" data-ext="cc-url" value="' + esc(cfg.url) + '" style="width:55%;max-width:240px"></div>' +
      '<div class="row"><span>Show feed on game</span><input type="checkbox" data-ext="cc-feed"' + (cfg.feed ? ' checked' : '') + '></div>' +
      '<p class="hint">Status: ' + esc(status) + (bridgeInfo ? ' · ' + esc(bridgeInfo) : '') +
        ' · ' + queue.length + ' queued' + (timed.length ? ' · active: ' + esc(timed.join(', ')) : '') + '</p>' +
      '<p class="hint">Test an effect (it runs when you return to the game):</p>' +
      '<div class="acts">' + tests + '</div>' +
      '<div class="acts" style="margin-top:6px"><button type="button" data-ext="cc-clear">Clear queue and timers</button></div>';
  }
  function menuClick(b, rr) {
    rerender = rr;
    var a = b.dataset.ext;
    if (a === 'cc-test') trigger(b.dataset.id, 'test');
    else if (a === 'cc-clear') { queue.length = 0; active = {}; }
    rr();
  }
  function menuInput(el) {
    var a = el.dataset.ext;
    if (a === 'cc-enabled') { cfg.enabled = el.checked; saveCfg(); connect(); }
    else if (a === 'cc-feed') { cfg.feed = el.checked; saveCfg(); }
    else if (a === 'cc-url') {
      cfg.url = el.value.trim(); saveCfg();
      clearTimeout(menuInput.t); menuInput.t = setTimeout(connect, 800);
    }
  }
  function render() {
    // keep the menu's status line current while it's open (not while typing)
    if (!rerender || typeof document === 'undefined') return;
    var m = document.querySelector('.s9x-menu');
    if (!m || m.hidden) return;
    var ae = document.activeElement;
    if (ae && ae.dataset && ae.dataset.ext === 'cc-url') return;
    clearTimeout(render.t); render.t = setTimeout(function () { try { rerender(); } catch (e) {} }, 50);
  }

  function list() {
    return Object.keys(EFFECTS).map(function (id) {
      return { id: id, name: EFFECTS[id].name, secs: EFFECTS[id].secs || 0, good: !!EFFECTS[id].good };
    });
  }

  // ── wire into the player ────────────────────────────────────────────────
  function install() {
    var P = root.Snes9xPlayer;
    if (!P || !P.hooks) return false;
    P.hooks.frame = onFrame;
    P.hooks.input = onInput;
    P.hooks.menu = { html: menuHtml, click: menuClick, input: menuInput };
    connect();
    return true;
  }

  var api = {
    trigger: trigger, list: list, EFFECTS: EFFECTS, ADDR: A, inPlay: inPlay,
    _onFrame: onFrame, _onInput: onInput,
    get queue() { return queue.slice(); }, get active() { return Object.assign({}, active); },
    get status() { return status; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.CrowdEffects = api;
    if (!install()) document.addEventListener('DOMContentLoaded', install);
  }
})(typeof self !== 'undefined' ? self : this);
