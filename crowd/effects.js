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
  var cfg = { enabled: false, url: 'ws://localhost:21214', feed: true, allowReroll: false, rerollOverlay: true, showTimer: true };
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

  // ── extra enemy: copy an enemy that's already in the room ───────────────
  // A sprite only draws right if its graphics are loaded for this area, and
  // only the enemies already here are guaranteed to be. So the new enemy is a
  // full copy of one of them (every per-sprite table, offsets from the
  // zelda3 reverse engineering), put into a free slot next to the original.
  var SLOT_TABLES = [0xB58, 0xB6B, 0xB89, 0xBA0, 0xBB0, 0xBE0, 0xC9A, 0xCAA, 0xCBA, 0xCD2, 0xCE2,
    0xD00, 0xD10, 0xD20, 0xD30, 0xD40, 0xD50, 0xD60, 0xD70, 0xD80, 0xD90, 0xDA0, 0xDB0, 0xDC0, 0xDD0, 0xDE0, 0xDF0,
    0xE00, 0xE10, 0xE20, 0xE30, 0xE40, 0xE50, 0xE60, 0xE70, 0xE80, 0xE90, 0xEA0, 0xEB0, 0xEC0, 0xED0, 0xEE0, 0xEF0,
    0xF00, 0xF10, 0xF20, 0xF30, 0xF40, 0xF50, 0xF60, 0xF70, 0xF80, 0xF90,
    0x1F9C2, 0x1FA1C, 0x1FA2C, 0x1FA3C, 0x1FA4C];
  var S = { STATE: 0xDD0, TYPE: 0xE20, N: 0xBC0, XL: 0xD10, XH: 0xD30, YL: 0xD00, YH: 0xD20, FLOOR: 0xF20, HIT: 0xEF0 };
  // Ordinary enemies only: no bosses, NPCs, items, switches, traps, or
  // anything that grabs Link (Wallmaster) or is part of a bigger enemy.
  var CLONEABLE = {};
  [0x08, 0x0A, 0x0D, 0x0E, 0x0F, 0x11, 0x12, 0x13, 0x18, 0x19, 0x20, 0x22, 0x23, 0x24, 0x26, 0x27,
   0x41, 0x42, 0x43, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x58,
   0x6A, 0x6B, 0x6D, 0x6E, 0x6F, 0x71, 0x7C, 0x81, 0x83, 0x84, 0x85, 0x86, 0x8B, 0x8E, 0x8F, 0x91,
   0x94, 0x99, 0x9A, 0x9B, 0x9C, 0x9D, 0xA1, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xC3, 0xC4, 0xC7,
   0xC9, 0xCF, 0xD0, 0xD3].forEach(function (t) { CLONEABLE[t] = 1; });
  function sx(r, k) { return r[S.XL + k] | (r[S.XH + k] << 8); }
  function sy(r, k) { return r[S.YL + k] | (r[S.YH + k] << 8); }
  function cloneEnemy(r) {
    var lx = r[0x22] | (r[0x23] << 8), ly = r[0x20] | (r[0x21] << 8);
    var src = [], free = -1;
    for (var k = 0; k < 16; k++) {
      var st = r[S.STATE + k];
      if (st === 0) { if (free < 0 || k > free) free = k; continue; }
      if (st === 9 && CLONEABLE[r[S.TYPE + k]] && r[S.FLOOR + k] === r[0xEE] &&
          Math.abs(sx(r, k) - lx) < 0x140 && Math.abs(sy(r, k) - ly) < 0x120) src.push(k);
    }
    if (!src.length) return 'No enemies here to copy';
    if (free < 0) return 'Too many sprites on screen';
    var from = src[Math.floor(Math.random() * src.length)];
    for (var i = 0; i < SLOT_TABLES.length; i++) r[SLOT_TABLES[i] + free] = r[SLOT_TABLES[i] + from];
    r[S.N + free] = 0xFF;                 // not from the room's list: killing it marks nothing
    r[S.HIT + free] = 0;
    // next to the original, nudged toward Link so it joins the fight
    var x = sx(r, from) + (lx > sx(r, from) ? 12 : -12), y = sy(r, from) + (ly > sy(r, from) ? 12 : -12);
    r[S.XL + free] = x & 0xFF; r[S.XH + free] = (x >> 8) & 0xFF;
    r[S.YL + free] = y & 0xFF; r[S.YH + free] = (y >> 8) & 0xFF;
    return true;
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
    // Hands the game a hit worth all of Link's hearts, so it runs its own
    // death: a bottled fairy still saves him, and the cape / Cane of
    // Byrna's invincibility still blocks it, exactly like a real hit.
    insta_kill:  { name: 'Instant death', good: false,
      apply: function (r) { r[0x373] = r[A.HP]; } },
    enemy_spawn: { name: 'Extra enemy', good: false,
      apply: function (r) { return cloneEnemy(r); } },

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
      app: function (job) { return startReroll(job, 'same'); } },
    seed_preset: { name: 'Random preset seed!', good: false,
      app: function (job) { return startReroll(job, 'preset'); } },
    seed_chaos:  { name: 'CHAOS seed!', good: false,
      app: function (job) { return startReroll(job, 'chaos'); } },
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
  // A banner over the game shows viewers who triggered it, the countdown, the
  // seed being made, and the result. Three kinds of roll:
  //   same    the settings the streamer has now
  //   preset  a random preset from the Saved presets menu
  //   chaos   a random generator with every one of its menus randomized
  // (the last two use the randomizer's own helpers, randomizer/app.js crowdApi)
  var REROLL_SECS = 10, MAX_TRIES = 3;
  // A random preset or chaos pick that's still being made after this long is
  // given up on (the randomizer's Stop button) and another one is picked, so
  // a heavy combination doesn't hold the stream up for many minutes.
  var GIVE_UP_SECS = 180;
  var ROLL_KIND = {
    same:   { count: 'NEW SEED IN ', roll: 'Rolling a new seed…' },
    preset: { count: 'RANDOM PRESET IN ', roll: 'Rolling a random preset…' },
    chaos:  { count: 'CHAOS SEED IN ', roll: 'Rolling a CHAOS seed…' },
  };
  var rerollT = null, rerollLeft = 0, rerollBy = '', rerollMode = 'same', rerollPick = '', rerollTry = 0, rerollBusy = false;
  function randoApi() { var r = root.UnifiedRando; return r && r.crowd; }
  function startReroll(job, mode) {
    mode = ROLL_KIND[mode] ? mode : 'same';
    if (!cfg.allowReroll) { feed('Seed reroll is turned off in Crowd effects', 'info'); return false; }
    if (rerollT || rollWatch || rerollBusy) { feed('A new seed is already coming', 'info'); return false; }
    if (typeof document === 'undefined' || !document.getElementById('r-generate')) { feed('Not available: the randomizer', 'info'); return false; }
    if (mode !== 'same' && !randoApi()) { feed('Not available: the randomizer isn\'t ready', 'info'); return false; }
    rerollBy = (job && job.user && job.user !== 'test') ? job.user : '';
    rerollMode = mode; rerollPick = ''; rerollTry = 0;
    rerollLeft = REROLL_SECS;
    feed(ROLL_KIND[mode].count + REROLL_SECS + 's!', 'bad');
    showRerollCountdown();
    rerollT = setInterval(function () {
      rerollLeft--;
      if (rerollLeft > 0) {
        if (rerollLeft <= 3 || rerollLeft === 5) feed(ROLL_KIND[rerollMode].count + rerollLeft + '…', 'bad');
        showRerollCountdown(); render(); return;
      }
      clearInterval(rerollT); rerollT = null; render();
      rollNow();
    }, 1000);
    render();
    return true;
  }

  // Set up the settings for this kind of roll, then press Generate & Play.
  function rollNow() {
    var gen = document.getElementById('r-generate');
    if (!gen || gen.disabled) { feed('A seed is already being made', 'info'); banner('done-bad', 'No new seed', 'A seed was already being made', 4000); return; }
    rerollTry++;
    rerollBusy = true;
    var setup;
    try {
      var api = randoApi();
      if (rerollMode === 'preset') {
        var list = api.pool ? api.pool() : api.presets();
        if (!list.length) throw new Error('there are no presets in the menu');
        var pick = list[Math.floor(Math.random() * list.length)];
        setup = api.usePreset(pick.value).then(function (label) {
          if (!label) throw new Error('couldn\'t set up ' + pick.label);
          return label;
        });
      } else if (rerollMode === 'chaos') {
        setup = api.chaos();
      } else setup = Promise.resolve('');
    } catch (e) { setup = Promise.reject(e); }
    setup.then(function (pickText) {
      rerollBusy = false;
      rerollPick = pickText;
      var g = document.getElementById('r-generate'), seed = document.getElementById('r-seed');
      if (!g || g.disabled) { banner('done-bad', 'No new seed', 'A seed was already being made', 4000); return; }
      quietAlerts();
      // reroll.js without its "are you sure?" box: empty the Seed box, Generate & Play
      if (seed) {
        seed.value = '';
        seed.dispatchEvent(new Event('input', { bubbles: true }));
        seed.dispatchEvent(new Event('change', { bubbles: true }));
      }
      feed(rerollMode === 'preset' ? 'Random preset: ' + pickText : rerollMode === 'chaos' ? 'CHAOS seed: ' + pickText.split(':')[0] : 'Rolling a new seed…', 'bad');
      g.click();
      watchRoll();
    }, function (e) {
      rerollBusy = false;
      console.warn('[crowd] seed roll setup', e);
      banner('done-bad', 'Seed reroll failed', String((e && e.message) || e), 6000);
      render();
    });
  }

  function cancelReroll() {
    if (!rerollT) return;
    clearInterval(rerollT); rerollT = null;
    feed('New seed cancelled', 'info');
    banner('done-bad', 'New seed cancelled', 'The streamer kept this seed', 4000);
  }
  function showRerollCountdown() {
    banner('count', ROLL_KIND[rerollMode].count + rerollLeft,
      (rerollBy ? 'from ' + rerollBy + ' · ' : '') + 'this game ends', 0, rerollLeft / REROLL_SECS);
  }

  // Follow the randomizer while it works: its Generate button stays disabled
  // until the seed is ready, and its status line says what it's doing. A
  // random preset or chaos roll that fails picks again (up to 3 tries).
  var rollWatch = null;
  function watchRoll() {
    var started = Date.now(), seenBusy = false, gaveUp = false;
    var title = ROLL_KIND[rerollMode].roll;
    var detail = rerollPick;
    clearInterval(rollWatch);
    rollWatch = setInterval(function () {
      var gen = document.getElementById('r-generate'), st = document.getElementById('r-status');
      var text = st ? st.textContent.trim() : '';
      var secs = Math.round((Date.now() - started) / 1000);
      if (gen && gen.disabled) seenBusy = true;
      if (!seenBusy && secs < 3) { banner('roll', title, 'Starting', 0, 0, detail); return; }
      var stop = document.getElementById('r-stop');
      var canGiveUp = rerollMode !== 'same' && rerollTry < MAX_TRIES && stop && !stop.hidden;
      if (gen && gen.disabled && canGiveUp && secs >= GIVE_UP_SECS && !gaveUp) {
        gaveUp = true;
        feed('Too slow, picking again', 'info');
        stop.click();
        return;
      }
      if (gen && gen.disabled && (secs < 900 || gaveUp)) {
        banner('roll', title, (text.replace(/\s*\d+s$/, '') || 'Working') + ' · ' + secs + 's' +
          (canGiveUp && !gaveUp ? ' (new pick at ' + GIVE_UP_SECS + 's)' : ''), 0, 0, detail);
        return;
      }
      clearInterval(rollWatch); rollWatch = null;
      var ok = st && st.className === 'ok' && /^(.*\. )?Ready/.test(text);
      if (ok) {
        var code = (text.match(/code ([^,(.]+(?: \/ [^,(.]+)*)/) || [])[1];
        var sub = (rerollBy ? 'Courtesy of ' + rerollBy : 'Good luck') + (code ? ' · code ' + code.trim() : '');
        var head = rerollMode === 'chaos' ? 'CHAOS seed ready!' : rerollMode === 'preset' ? 'Random preset ready!' : 'New seed ready!';
        banner('done-ok', head, sub, rerollPick ? 10000 : 6000, 0, detail);
      } else if (rerollMode !== 'same' && rerollTry < MAX_TRIES && (gaveUp || !/^Stopped/.test(text))) {
        feed('That one didn\'t work, picking again (' + (rerollTry + 1) + '/' + MAX_TRIES + ')', 'info');
        banner('roll', ROLL_KIND[rerollMode].roll, gaveUp ? 'That one was taking too long, picking again' : 'That pick didn\'t work, picking again', 0);
        setTimeout(rollNow, 800);
      } else {
        banner('done-bad', 'Seed reroll failed', text || 'Kept the current game', 6000);
      }
      render();
    }, 300);
  }

  // ── subathon clock (the bridge keeps the time; this just shows it) ──────
  var clockEl = null, clockPopT = null, lastAddId = 0;
  var CLOCK_CSS =
    '.cc-clock { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 24; pointer-events: none;' +
    ' display: flex; align-items: baseline; gap: 8px; padding: 4px 12px; border-radius: 8px; background: rgba(10,12,16,.8);' +
    ' color: #fff; font: 800 18px/1.1 ui-monospace, "Cascadia Mono", Consolas, monospace; text-shadow: 0 1px 2px #000;' +
    ' border: 1px solid rgba(227,179,65,.6); font-variant-numeric: tabular-nums; }' +
    '.cc-clock.paused .t { opacity: .6; } .cc-clock.ended { border-color: #e5534b; }' +
    '.cc-clock .p { color: #3fb950; font-size: 13px; font-family: system-ui, sans-serif; transition: opacity .6s; }';
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = sec % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function showClock(t) {
    if (typeof document === 'undefined') return;
    var on = cfg.showTimer && t && t.active;
    if (!on) { if (clockEl) { clockEl.remove(); clockEl = null; } return; }
    var host = document.querySelector('.s9x'); if (!host) return;
    if (!document.getElementById('cc-clock-css')) { var st = document.createElement('style'); st.id = 'cc-clock-css'; st.textContent = CLOCK_CSS; document.head.appendChild(st); }
    if (!clockEl) { clockEl = document.createElement('div'); clockEl.innerHTML = '<span class="t"></span><span class="p"></span>'; }
    if (clockEl.parentNode !== host) host.appendChild(clockEl);
    clockEl.className = 'cc-clock' + (t.ended ? ' ended' : !t.running ? ' paused' : '');
    clockEl.querySelector('.t').textContent = t.ended ? 'TIME!' : fmtClock(t.remaining);
    var a = t.lastAdd;
    if (a && a.id !== lastAddId) {
      var first = !lastAddId; lastAddId = a.id;
      if (!first && a.seconds > 0) {
        var p = clockEl.querySelector('.p');
        var sx = a.seconds, add = sx < 60 ? sx + 's' : sx < 3600 ? Math.floor(sx / 60) + 'm' + (sx % 60 ? ' ' + sx % 60 + 's' : '') : fmtClock(sx);
        p.textContent = '+' + add + (a.user ? ' ' + a.user : '');
        p.style.opacity = '1';
        clearTimeout(clockPopT); clockPopT = setTimeout(function () { p.style.opacity = '0'; }, 4000);
      }
    }
  }

  // The banner itself: one element on the game picture, re-attached if the
  // player rebuilds its screen when the new ROM starts.
  var bannerEl = null, bannerHideT = null;
  var BANNER_CSS =
    '.cc-reroll { position: absolute; left: 50%; top: 14%; transform: translateX(-50%); z-index: 26; pointer-events: none;' +
    ' min-width: 58%; max-width: 92%; box-sizing: border-box; padding: 10px 16px 12px; border-radius: 10px; text-align: center;' +
    ' background: rgba(10,12,16,.86); color: #fff; font: 700 13px/1.3 system-ui, sans-serif; text-shadow: 0 1px 2px #000;' +
    ' border: 2px solid #e5534b; box-shadow: 0 4px 18px rgba(0,0,0,.5); transition: opacity .5s; }' +
    '.cc-reroll .t { font-size: clamp(15px, 3.6vw, 28px); letter-spacing: .04em; }' +
    '.cc-reroll .s { margin-top: 3px; font-weight: 600; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '.cc-reroll .d { margin-top: 5px; font-weight: 700; font-size: 13px; color: #f0c674; line-height: 1.35; }' +
    '.cc-reroll .bar { margin-top: 8px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.18); overflow: hidden; }' +
    '.cc-reroll .bar i { display: block; height: 100%; background: #e5534b; transition: width 1s linear; }' +
    '.cc-reroll.roll { border-color: #e3b341; } .cc-reroll.roll .bar i { width: 35% !important; background: #e3b341; animation: cc-slide 1.1s ease-in-out infinite alternate; }' +
    '.cc-reroll.done-ok { border-color: #3fb950; } .cc-reroll.done-bad { border-color: #8b95a3; }' +
    '.cc-reroll.count .t { animation: cc-pulse 1s ease-in-out infinite; }' +
    '@keyframes cc-slide { from { transform: translateX(0); } to { transform: translateX(185%); } }' +
    '@keyframes cc-pulse { 50% { transform: scale(1.06); } }' +
    '@media (prefers-reduced-motion: reduce) { .cc-reroll .t, .cc-reroll .bar i { animation: none !important; } }';
  function banner(kind, title, sub, hideAfter, frac, detail) {
    if (typeof document === 'undefined') return;
    clearTimeout(bannerHideT);
    if (!cfg.rerollOverlay) { if (bannerEl) bannerEl.remove(); return; }
    var host = document.querySelector('.s9x'); if (!host) return;
    if (!document.getElementById('cc-reroll-css')) { var st = document.createElement('style'); st.id = 'cc-reroll-css'; st.textContent = BANNER_CSS; document.head.appendChild(st); }
    if (!bannerEl) { bannerEl = document.createElement('div'); bannerEl.setAttribute('role', 'status'); bannerEl.innerHTML = '<div class="t"></div><div class="s"></div><div class="d"></div><div class="bar"><i></i></div>'; }
    if (bannerEl.parentNode !== host) host.appendChild(bannerEl);
    bannerEl.className = 'cc-reroll ' + kind;
    bannerEl.style.opacity = '1';
    bannerEl.querySelector('.t').textContent = title;
    bannerEl.querySelector('.s').textContent = sub || '';
    var dEl = bannerEl.querySelector('.d'); dEl.textContent = detail || ''; dEl.hidden = !detail;
    var bar = bannerEl.querySelector('.bar');
    bar.hidden = !(kind === 'count' || kind === 'roll');
    if (kind === 'count') bar.firstChild.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + '%';
    if (hideAfter) bannerHideT = setTimeout(function () {
      if (!bannerEl) return;
      bannerEl.style.opacity = '0';
      bannerHideT = setTimeout(function () { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }, 550);
    }, hideAfter);
  }

  // ── queue and timers ────────────────────────────────────────────────────
  var queue = [];              // { id, user, label }
  var active = {};             // id -> frames left
  var paused = {};             // outdoor-only effects waiting indoors
  var gap = 0;                 // frames until the next queued effect may run
  var GAP_FRAMES = 45;         // ~0.75 s between effects, so each one is seen
  var MAX_QUEUE = 60;

  // mapping.json can change how long timed effects last ("durations").
  var durations = {};
  function secsOf(id) {
    var f = EFFECTS[id]; if (!f || !f.secs) return 0;
    var d = +durations[id];
    return d > 0 && d <= 600 ? d : f.secs;
  }

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
    var outside = ram[A.MODE] === 0x09;   // the ROM only spawns cuccos on the overworld
    for (var id in active) {
      var fx = EFFECTS[id];
      if (fx.frame) fx.frame(ram);
      if (fx.outdoors) {
        // Outdoor-only effects pause their clock indoors and pick up again outside.
        if (!outside) {
          if (!paused[id]) { paused[id] = true; feed(fx.name + ' paused indoors (' + Math.ceil(active[id] / 60) + 's left)', 'info'); render(); }
          continue;
        }
        if (paused[id]) { delete paused[id]; feed(fx.name + ' resumed', 'bad'); render(); }
      }
      if (--active[id] <= 0) { delete active[id]; delete paused[id]; feed(fx.name + ' ended', 'end'); render(); }
    }
    if (gap > 0) { gap--; return; }
    var job = queue.shift();
    if (!job) return;
    var f = EFFECTS[job.id];
    if (f.romCheck && !romHas(core, f.romCheck)) {
      feed(f.name + ' needs a randomizer ROM (not this one)', 'info'); render(); return;
    }
    var secs = secsOf(job.id);
    if (secs) active[job.id] = (active[job.id] || 0) + Math.round(secs * (core.fps || 60.1));
    else if (f.app) { try { f.app(job); } catch (e) { console.warn('[crowd]', job.id, e); } }
    else {
      var res = f.apply(ram);
      if (typeof res === 'string') { feed(f.name + ': ' + res, 'info'); render(); return; }
    }
    gap = GAP_FRAMES;
    feed((job.user ? job.user + ': ' : '') + (job.label ? job.label + ' → ' : '') + f.name + (secs ? ' (' + secs + 's)' : ''),
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
      } else if (m.type === 'timer') {
        showClock(m);
      } else if (m.type === 'durations') {
        durations = m.secs && typeof m.secs === 'object' ? m.secs : {};
        render();
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
    var timed = Object.keys(active).map(function (id) { return EFFECTS[id].name + ' ' + Math.ceil(active[id] / 60) + 's' + (paused[id] ? ' (paused indoors)' : ''); });
    var tests = Object.keys(EFFECTS).map(function (id) {
      return '<button type="button" data-ext="cc-test" data-id="' + id + '">' + esc(EFFECTS[id].name) + '</button>';
    }).join('');
    return '<h4>Crowd effects</h4>' +
      '<div class="row"><span>TikTok effects on</span><input type="checkbox" data-ext="cc-enabled"' + (cfg.enabled ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Bridge address</span><input type="text" data-ext="cc-url" value="' + esc(cfg.url) + '" style="width:55%;max-width:240px"></div>' +
      '<div class="row"><span>Show feed on game</span><input type="checkbox" data-ext="cc-feed"' + (cfg.feed ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Allow seed reroll (ends this game)</span><input type="checkbox" data-ext="cc-reroll"' + (cfg.allowReroll ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Show subathon clock on game</span><input type="checkbox" data-ext="cc-show-timer"' + (cfg.showTimer ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Show seed-reroll banner on game</span><input type="checkbox" data-ext="cc-reroll-overlay"' + (cfg.rerollOverlay ? ' checked' : '') + '></div>' +
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
    else if (a === 'cc-clear') { queue.length = 0; active = {}; paused = {}; cancelReroll(); }
    else if (a === 'cc-cancel-reroll') cancelReroll();
    rr();
  }
  function menuInput(el) {
    var a = el.dataset.ext;
    if (a === 'cc-enabled') { cfg.enabled = el.checked; saveCfg(); connect(); }
    else if (a === 'cc-feed') { cfg.feed = el.checked; saveCfg(); }
    else if (a === 'cc-show-timer') { cfg.showTimer = el.checked; saveCfg(); if (!el.checked && clockEl) { clockEl.remove(); clockEl = null; } }
    else if (a === 'cc-reroll-overlay') { cfg.rerollOverlay = el.checked; saveCfg(); if (!el.checked && bannerEl) { bannerEl.remove(); bannerEl = null; } }
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
      return { id: id, name: EFFECTS[id].name, secs: secsOf(id), good: !!EFFECTS[id].good };
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
    _onFrame: onFrame, _onInput: onInput, _showClock: showClock,
    get queue() { return queue.slice(); }, get active() { return Object.assign({}, active); },
    get status() { return status; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.CrowdEffects = api;
    if (!install()) document.addEventListener('DOMContentLoaded', install);
  }
})(typeof self !== 'undefined' ? self : this);
