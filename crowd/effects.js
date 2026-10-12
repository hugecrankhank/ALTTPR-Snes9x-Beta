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
 * Three effects use the app's own buttons instead of RAM: a random sprite,
 * a random favourite MSU-1 pack, and a whole new seed (off unless "Allow
 * seed reroll" is checked in the menu; it counts down 10 s first and can be
 * cancelled there).
 *
 * Settings (bridge address, on/off) are in the emulator menu under
 * "Crowd effects". The bridge address defaults to ws://localhost:21214
 * (21213 is TikFinity's own port).
 */
(function (root) {
  'use strict';

  var SETTINGS_KEY = 's9x-crowd-settings';
  var cfg = { enabled: false, url: 'ws://localhost:21214', feed: true, allowReroll: false };
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
    // These two flip switches the randomizer ROM itself keeps for crowd
    // control (z3randomizer: IceModifier $7F50C7, CuccoStormer $7F50C5).
    // `hold` sets the switch while the effect runs and clears it otherwise,
    // so a save state taken mid-effect can't leave it stuck on. `romCheck` is
    // the ROM's own read of that switch; without it the effect is skipped.
    ice:         { name: 'Ice physics', good: false, secs: 20,
      hold: { addr: 0x150C7, on: 0x01 }, romCheck: [0x0F, 0xC7, 0x50, 0x7F] },   // ORA.l $7F50C7
    cucco_storm: { name: 'Cucco attack', good: false, secs: 30, outdoors: true,
      hold: { addr: 0x150C5, on: 0x01 }, romCheck: [0xAF, 0xC5, 0x50, 0x7F] },   // LDA.l $7F50C5

    one_hit:     { name: 'One-heart mode', good: false, secs: 30,
      frame: function (r) { if (r[A.HP] > 8) r[A.HP] = 8; r[A.HP_FILL] = 0; } },
    no_magic:    { name: 'Magic locked', good: false, secs: 30,
      frame: function (r) { r[A.MAGIC] = 0; r[A.MAGIC_FILL] = 0; } },

    // These press the app's own roll buttons (randomizer/app.js, reroll.js).
    sprite_roll: { name: 'Random sprite', good: true,
      app: function () { return press(['r-sprite-random', 'sprite-btn'], 'the sprite buttons'); } },
    sprite_fav:  { name: 'Random favourite sprite', good: true,
      app: function () { return press(['r-sprite-fav-roll', 'sprite-fav-btn'], 'the sprite buttons'); } },
    msu_roll:    { name: 'Random MSU pack', good: true,
      app: function () { return press(['music-roll-btn'], 'MSU packs (add some and star favourites in ♪)'); } },
    seed_roll:   { name: 'New seed!', good: false,
      app: function () { return startReroll(); } },
  };

  // ── app actions ────────────────────────────────────────────────────────
  // The roll functions show an alert() when they can't do it (no favourites
  // yet...). A dialog would freeze the stream, so while one of ours is
  // running, alerts go to the feed instead.
  var quietUntil = 0, realAlert = null;
  function quietAlerts() {
    if (typeof window === 'undefined' || !window.alert) return;
    quietUntil = Date.now() + 20000;
    if (realAlert) return;
    realAlert = window.alert;
    window.alert = function (msg) {
      if (Date.now() < quietUntil) { feed(String(msg), 'info'); return; }
      return realAlert.call(window, msg);
    };
  }
  function press(ids, what) {
    if (typeof document === 'undefined') return false;
    for (var i = 0; i < ids.length; i++) {
      var b = document.getElementById(ids[i]);
      if (!b) continue;
      if (b.disabled) { feed('Busy, try again in a moment', 'info'); return false; }
      quietAlerts();
      b.click();
      return true;
    }
    feed('Not available: ' + what, 'info');
    return false;
  }

  // A new seed closes this game, so: only if allowed, and with a countdown.
  var rerollT = null, rerollLeft = 0;
  function startReroll() {
    if (!cfg.allowReroll) { feed('Seed reroll is turned off in Crowd effects', 'info'); return false; }
    if (rerollT) { feed('A new seed is already coming', 'info'); return false; }
    if (typeof document === 'undefined' || !document.getElementById('r-generate')) { feed('Not available: the randomizer', 'info'); return false; }
    rerollLeft = 10;
    feed('NEW SEED in 10s!', 'bad');
    rerollT = setInterval(function () {
      rerollLeft--;
      if (rerollLeft > 0) { if (rerollLeft <= 3 || rerollLeft === 5) feed('New seed in ' + rerollLeft + '…', 'bad'); render(); return; }
      clearInterval(rerollT); rerollT = null; render();
      // reroll.js without its "are you sure?" box: empty the Seed box, Generate & Play
      var gen = document.getElementById('r-generate'), seed = document.getElementById('r-seed');
      if (!gen || gen.disabled) { feed('A seed is already being made', 'info'); return; }
      quietAlerts();
      if (seed) {
        seed.value = '';
        seed.dispatchEvent(new Event('input', { bubbles: true }));
        seed.dispatchEvent(new Event('change', { bubbles: true }));
      }
      feed('Rolling a new seed…', 'bad');
      gen.click();
    }, 1000);
    render();
    return true;
  }
  function cancelReroll() {
    if (!rerollT) return;
    clearInterval(rerollT); rerollT = null;
    feed('New seed cancelled', 'info');
  }

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

  // Does this ROM read the switch an effect needs? Looked up once per ROM.
  var romSupport = {}, romKey = '';
  function romHas(core, sig) {
    var rom; try { rom = core.rom(); } catch (e) { return false; }
    if (!rom || !rom.length) return false;
    var key = rom.length + ':' + rom[0x7FDC] + ',' + rom[0x7FDD] + ',' + rom[0x7FC0] + ',' + rom[0x7FC1] + ',' + rom[0x7FC2];
    if (key !== romKey) { romKey = key; romSupport = {}; }
    var k = sig.join(',');
    if (!(k in romSupport)) {
      var found = false;
      outer: for (var i = 0, n = rom.length - sig.length; i <= n; i++) {
        if (rom[i] !== sig[0]) continue;
        for (var j = 1; j < sig.length; j++) if (rom[i + j] !== sig[j]) continue outer;
        found = true; break;
      }
      romSupport[k] = found;
    }
    return romSupport[k];
  }

  function holdSwitches(core, ram) {
    if (ram.length < 0x20000) return;
    for (var id in EFFECTS) {
      var h = EFFECTS[id].hold; if (!h) continue;
      var want = active[id] ? h.on : 0;
      if (ram[h.addr] !== want && romHas(core, EFFECTS[id].romCheck)) ram[h.addr] = want;
    }
  }

  function onFrame(core) {
    var ram = core.wram();
    holdSwitches(core, ram);
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
    if (f.romCheck && !romHas(core, f.romCheck)) {
      feed(f.name + ' needs a randomizer ROM (not this one)', 'info'); render(); return;
    }
    if (f.outdoors && ram[0x1B]) feed(f.name + ' only shows up outdoors', 'info');
    if (f.secs) active[job.id] = (active[job.id] || 0) + Math.round(f.secs * (core.fps || 60.1));
    else if (f.app) { try { f.app(); } catch (e) { console.warn('[crowd]', job.id, e); } }
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
      } else if (m.event && !m.type && bridgeInfo.indexOf('TikFinity') !== 0) {
        // TikFinity's own feed ({event, data}): the address points at TikFinity,
        // not the bridge, which listens one port up in TikFinity mode.
        bridgeInfo = 'TikFinity, not the bridge: use ws://localhost:21214'; render();
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
      '<div class="row"><span>Allow seed reroll (ends this game)</span><input type="checkbox" data-ext="cc-reroll"' + (cfg.allowReroll ? ' checked' : '') + '></div>' +
      (rerollT ? '<div class="acts"><button type="button" class="primary" data-ext="cc-cancel-reroll">Cancel new seed (' + rerollLeft + 's)</button></div>' : '') +
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
    else if (a === 'cc-clear') { queue.length = 0; active = {}; cancelReroll(); }
    else if (a === 'cc-cancel-reroll') cancelReroll();
    rr();
  }
  function menuInput(el) {
    var a = el.dataset.ext;
    if (a === 'cc-enabled') { cfg.enabled = el.checked; saveCfg(); connect(); }
    else if (a === 'cc-feed') { cfg.feed = el.checked; saveCfg(); }
    else if (a === 'cc-reroll') { cfg.allowReroll = el.checked; saveCfg(); if (!el.checked) cancelReroll(); rerender && rerender(); }
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
    trigger: trigger, list: list, cancelReroll: cancelReroll, EFFECTS: EFFECTS, ADDR: A, inPlay: inPlay,
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
