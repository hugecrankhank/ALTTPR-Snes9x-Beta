/*
 * App shell: boots the Snes9x core, runs the frame loop, and wires up ROM
 * loading, saves, settings, touch controls, controller status, wake lock
 * and the installable-app bits.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var B = EmuInput.BTN;

  // ── settings ────────────────────────────────────────────────────────────
  var DEFAULTS = { filter: 'xbrz6', aspect: '8:7', volume: 0.7, touch: 'auto', opacity: 0.55, haptics: true, slot: 1 };
  var cfg = Object.assign({}, DEFAULTS);
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('alttpr-s9x-settings') || '{}')); } catch (e) {}
  function saveCfg() { try { localStorage.setItem('alttpr-s9x-settings', JSON.stringify(cfg)); } catch (e) {} }

  // ── state ───────────────────────────────────────────────────────────────
  var core = null, coreP = null;
  var video = null, audio = new EmuAudio(), input = new EmuInput();
  var running = false, paused = false, ff = false;
  var romHash = '', romName = '', lastSram = null;
  var toastTimer = null;

  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  // Start fetching/compiling the core immediately so it's ready by the time a ROM is picked.
  coreP = Snes9xCore.create('core/snes9x.wasm').then(function (c) { core = c; return c; });
  coreP.catch(function (e) { console.error(e); toast('Emulator failed to load: ' + e.message); });

  // ── video ───────────────────────────────────────────────────────────────
  try { video = new Video($('screen')); } catch (e) {
    $('placeholder').querySelector('p').textContent = 'This browser has no WebGL2, which the emulator needs. Try an up-to-date Chrome, Safari or Firefox.';
  }
  function applyAspect() { if (video) { video.aspect = cfg.aspect === '4:3' ? 4 / 3 : 8 / 7; video.dirty = true; } }
  function applyFilter() {
    if (!video) return;
    video.setPreset(cfg.filter).catch(function (e) {
      console.error(e);
      toast('That filter isn\'t supported here; using sharp pixels.');
      cfg.filter = 'nearest'; $('opt-filter').value = 'nearest'; saveCfg();
      video.setPreset('nearest');
    });
  }
  applyAspect(); applyFilter();

  // ── frame loop ──────────────────────────────────────────────────────────
  // If the display refresh is within 1% of the SNES rate (~60.1 Hz), run
  // exactly one frame per display refresh for perfectly smooth scrolling;
  // the audio worklet absorbs the tiny speed difference. Otherwise (120 Hz
  // screens, throttled tabs) pace frames with a time accumulator.
  var acc = 0, last = 0, ema = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    if (!video) return;
    video.fit();
    var dt = last ? Math.min(now - last, 100) : 16.7; last = now;
    ema = ema ? ema * 0.95 + dt * 0.05 : dt;
    if (!running || paused) { video.draw(); return; }
    var frameMs = 1000 / core.fps, pad = input.read(), n = 0;
    var vsync = !ff && Math.abs(ema - frameMs) / frameMs < 0.01;
    if (vsync) { n = 1; acc = 0; }
    else {
      acc += dt * (ff ? 4 : 1);
      n = Math.floor(acc / frameMs); acc -= n * frameMs;
      var max = ff ? 8 : 3;
      if (n > max) { n = max; acc = 0; }
    }
    for (var i = 0; i < n; i++) {
      core.runFrame(pad, 0);
      var a = core.audio();
      if (!ff) audio.push(a);
    }
    if (n) video.upload(core.frame());
    video.draw();
  }
  requestAnimationFrame(tick);

  // ── ROM loading ─────────────────────────────────────────────────────────
  function looksLikeRom(bytes, name) {
    if (/\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4B)) {
      alert('That looks like a .zip file. Unzip it first and load the .sfc inside.'); return false;
    }
    var body = bytes.length % 1024 === 512 ? bytes.length - 512 : bytes.length;
    if (body < 0x80000 || body > 0x800000 || body % 0x8000 !== 0)
      return confirm('"' + name + '" doesn\'t look like a SNES ROM. Load it anyway?');
    return true;
  }

  function startGame(bytes, name) {
    return coreP.then(function () {
      return flushSram();
    }).then(function () {
      if (!core.load(bytes)) throw new Error('Snes9x could not load "' + name + '".');
      romName = name;
      audio.setRate(core.sampleRate); audio.clear();
      return EmuStore.hash(bytes);
    }).then(function (h) {
      romHash = h;
      return EmuStore.get('sram', h).catch(function () { return null; });
    }).then(function (saved) {
      var s = core.sram();
      if (saved && saved.length === s.length) s.set(saved);
      lastSram = core.sram().slice();
      var ph = $('placeholder'); if (ph) ph.hidden = true;
      document.body.classList.add('playing');
      running = true; paused = false; setPauseUi();
      AlttpBridge.attach(core, name);
      AlttpBridge.setRunning(true);
      wake(true);
      document.title = name.replace(/\.[^.]+$/, '') + ' · ALTTPR Snes9x';
      EmuStore.put('kv', 'lastRom', { name: name, bytes: bytes }).catch(function () {});
    }).catch(function (e) { alert(e.message || e); });
  }

  $('rom-input').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    audio.unlock();
    file.arrayBuffer().then(function (buf) {
      ev.target.value = '';
      var bytes = new Uint8Array(buf);
      if (!looksLikeRom(bytes, file.name)) return;
      if (running && !confirm('Load a different ROM? Unsaved progress in the current game will be lost (in-game saves are kept).')) return;
      startGame(bytes, file.name);
    });
  });

  // Offer to continue the last ROM (saves phones a trip through Files).
  EmuStore.get('kv', 'lastRom').then(function (r) {
    if (!r || !r.bytes || running) return;
    var b = $('resume-btn');
    b.hidden = false;
    b.textContent = 'Continue ' + r.name.replace(/\.[^.]+$/, '');
    b.onclick = function () { audio.unlock(); startGame(r.bytes, r.name); };
  }).catch(function () {});

  // ── in-game saves (SRAM) ────────────────────────────────────────────────
  function sramChanged() {
    var s = core && core.loaded ? core.sram() : null;
    if (!s || !s.length || !lastSram) return null;
    for (var i = 0; i < s.length; i++) if (s[i] !== lastSram[i]) return s;
    return null;
  }
  function flushSram() {
    var s = sramChanged();
    if (!s || !romHash) return Promise.resolve();
    lastSram = s.slice();
    return EmuStore.put('sram', romHash, lastSram).catch(function (e) { console.warn('[sram]', e); });
  }
  setInterval(flushSram, 3000);

  // ── save states ─────────────────────────────────────────────────────────
  function saveState() {
    if (!running) return;
    var st = core.saveState();
    if (!st) { toast('Couldn\'t save state'); return; }
    EmuStore.put('states', romHash + ':' + cfg.slot, { at: Date.now(), data: st })
      .then(function () { toast('Saved to slot ' + cfg.slot); }, function () { toast('Couldn\'t save state'); });
  }
  function loadState() {
    if (!running) return;
    EmuStore.get('states', romHash + ':' + cfg.slot).then(function (r) {
      if (!r) { toast('Slot ' + cfg.slot + ' is empty'); return; }
      if (core.loadState(r.data)) { audio.clear(); toast('Loaded slot ' + cfg.slot); }
      else toast('That state didn\'t load');
    });
  }

  // ── toolbar ─────────────────────────────────────────────────────────────
  function setPauseUi() { $('btn-pause').classList.toggle('on', paused); $('btn-pause').textContent = paused ? '▶' : '❚❚'; $('btn-pause').title = paused ? 'Resume (P)' : 'Pause (P)'; }
  function setPaused(p) {
    if (!running) return;
    paused = p; setPauseUi();
    AlttpBridge.setRunning(!p);
    if (p) { flushSram(); audio.clear(); }
    wake(!p);
  }
  function setFF(on) { ff = on; $('btn-ff').classList.toggle('on', on); if (!on) audio.clear(); }
  $('btn-pause').onclick = function () { setPaused(!paused); };
  $('btn-ff').onclick = function () { setFF(!ff); };
  $('btn-save').onclick = saveState;
  $('btn-load').onclick = loadState;
  $('btn-reset').onclick = function () { if (running && confirm('Reset the game?')) { core.reset(); audio.clear(); } };
  $('btn-menu').onclick = function () { openSettings(); };
  $('btn-tracker').onclick = function () { document.body.classList.toggle('drawer-open'); setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 260); };
  var fsTarget = document.documentElement;
  if (fsTarget.requestFullscreen) {
    $('btn-fs').onclick = function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else fsTarget.requestFullscreen({ navigationUI: 'hide' }).then(function () {
        try { if (screen.orientation && screen.orientation.lock && innerWidth > innerHeight) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
      }).catch(function () {});
    };
  } else $('btn-fs').hidden = true;

  // Hotkeys
  input.hotkeys = {
    Tab: function (down) { setFF(down); },
    KeyP: function (down) { if (down) setPaused(!paused); },
    F5: function (down) { if (down) saveState(); },
    F8: function (down) { if (down) loadState(); },
  };
  input.onActivity = function () { audio.unlock(); };
  ['pointerdown', 'keydown', 'touchend'].forEach(function (t) {
    document.addEventListener(t, function () { audio.unlock(); }, true);
  });

  // Pause when hidden (phone locked / app switched), save first.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { flushSram(); if (running && !paused) { setPaused(true); autoPaused = true; } }
    else if (autoPaused) { autoPaused = false; setPaused(false); }
  });
  var autoPaused = false;
  window.addEventListener('pagehide', flushSram);

  // ── touch controls ──────────────────────────────────────────────────────
  input.bindTouch($('touch'));
  var coarse = window.matchMedia('(pointer: coarse)');
  function applyTouch() {
    var show = cfg.touch === 'on' || (cfg.touch === 'auto' && (coarse.matches || 'ontouchstart' in window && navigator.maxTouchPoints > 0));
    document.body.classList.toggle('touch-on', !!show);
    document.documentElement.style.setProperty('--pad-opacity', cfg.opacity);
    input.haptics = !!cfg.haptics;
    window.dispatchEvent(new Event('resize'));
  }
  if (coarse.addEventListener) coarse.addEventListener('change', applyTouch);
  applyTouch();

  // ── settings dialog ─────────────────────────────────────────────────────
  var filterSel = $('opt-filter');
  Object.keys(Video.PRESETS).forEach(function (k) {
    var o = document.createElement('option'); o.value = k; o.textContent = Video.PRESETS[k].name; filterSel.appendChild(o);
  });
  function syncSettingsUi() {
    filterSel.value = cfg.filter; $('opt-aspect').value = cfg.aspect; $('opt-volume').value = cfg.volume;
    $('opt-touch').value = cfg.touch; $('opt-opacity').value = cfg.opacity; $('opt-haptics').checked = !!cfg.haptics;
    $('opt-slot').value = String(cfg.slot);
  }
  function openSettings() { syncSettingsUi(); var d = $('settings'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  $('settings-close').onclick = function () { var d = $('settings'); if (d.close) d.close(); else d.removeAttribute('open'); };
  filterSel.onchange = function () { cfg.filter = filterSel.value; saveCfg(); applyFilter(); };
  $('opt-aspect').onchange = function (e) { cfg.aspect = e.target.value; saveCfg(); applyAspect(); };
  $('opt-volume').oninput = function (e) { cfg.volume = +e.target.value; audio.setVolume(cfg.volume); saveCfg(); };
  $('opt-touch').onchange = function (e) { cfg.touch = e.target.value; saveCfg(); applyTouch(); };
  $('opt-opacity').oninput = function (e) { cfg.opacity = +e.target.value; saveCfg(); applyTouch(); };
  $('opt-haptics').onchange = function (e) { cfg.haptics = e.target.checked; saveCfg(); applyTouch(); };
  $('opt-slot').onchange = function (e) { cfg.slot = +e.target.value; saveCfg(); };
  audio.setVolume(cfg.volume);

  // ── controller indicator ────────────────────────────────────────────────
  function paintPad() {
    var el = $('pad-status');
    input.gamepadMask();
    if (input.padName) { el.className = 'on'; el.title = input.padName; el.querySelector('span').textContent = 'Controller'; }
    else { el.className = ''; el.title = 'Connect a controller, then press any button on it'; el.querySelector('span').textContent = 'No controller'; }
  }
  setInterval(paintPad, 1000);
  window.addEventListener('gamepadconnected', function (e) { paintPad(); toast('Controller connected'); });
  window.addEventListener('gamepaddisconnected', paintPad);
  paintPad();

  // ── tracker link pill ───────────────────────────────────────────────────
  function paint(s) {
    var el = $('link-status'), txt = el.querySelector('span');
    el.className = '';
    if (!s.romLoaded) txt.textContent = 'No game loaded';
    else if (s.mode === 'live') { el.className = 'live'; txt.textContent = 'Tracker linked'; }
    else txt.textContent = 'Paused';
  }
  AlttpBridge.onStatus(paint);
  paint(AlttpBridge.status());

  // ── keep the screen on while playing ────────────────────────────────────
  var lock = null;
  function wake(on) {
    if (!('wakeLock' in navigator)) return;
    if (on && !lock && !document.hidden) navigator.wakeLock.request('screen').then(function (l) { lock = l; l.addEventListener('release', function () { lock = null; }); }).catch(function () {});
    else if (!on && lock) { lock.release().catch(function () {}); lock = null; }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && running && !paused) wake(true); });

  // ── installable app ─────────────────────────────────────────────────────
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[sw]', e); });
    });
  }
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; $('install-btn').hidden = false; });
  $('install-btn').addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () { deferredPrompt = null; $('install-btn').hidden = true; });
  });
  window.addEventListener('appinstalled', function () { $('install-btn').hidden = true; });

  // Debug handle
  window.S9X = { get core() { return core; }, get video() { return video; }, audio: audio, input: input, startGame: startGame };
})();
