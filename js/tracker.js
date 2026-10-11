/*
 * Hutch tracker frames: settings -> URLs, Items/Map tabs, item grid scaling,
 * map de-duplication and auto-fit. Carried over from ALTTPR Unified.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  // ── settings → tracker URLs ───────────────────────────────────────────────
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('alttpr-s9x-tracker') || '{}'); } catch (e) {}
  $('gamemode').value = saved.gamemode || 'open';
  $('dungeonitems').value = saved.dungeonitems || 'standard';

  function trackerUrls() {
    var gm = $('gamemode').value, di = $('dungeonitems').value;
    var common = '&gamemode=' + gm + '&dungeonitems=' + di + '&bg=black';
    return {
      items: 'tracker/itemtracker.html?scale=1' + common,
      map: 'tracker/map.html?zoom=0.6&logic=nmg&entranceshuffle=no&entrancemode=none' + common,
    };
  }
  function loadTrackers() {
    var u = trackerUrls();
    $('items-frame').src = u.items;
    $('map-frame').src = u.map;
  }
  ['gamemode', 'dungeonitems'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      localStorage.setItem('alttpr-s9x-tracker', JSON.stringify({
        gamemode: $('gamemode').value, dungeonitems: $('dungeonitems').value }));
      loadTrackers();
    });
  });
  loadTrackers();

  document.querySelectorAll('aside .tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('aside .tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('frames').className = b.dataset.view === 'both' ? '' : b.dataset.view;
    });
  });

  // ── item tracker: scale to fit its panel ──────────────────────────────────
  // Hutch's item grid is ~500px wide and ~411px tall. Measure its real size
  // and shrink it to fit the panel in both directions, so it never clips at
  // the sides (phones) or shows a scrollbar (the 400px desktop panel).
  var ITEMS_W = 500, ITEMS_H = 400;
  function itemsNaturalHeight() {
    try {
      var d = $('items-frame').contentDocument, w = d.defaultView;
      if (!d || !d.body) return 0;
      var bottom = 0;
      Array.prototype.forEach.call(d.body.children, function (el) {
        if (el.tagName === 'SCRIPT' || el.offsetParent === null && w.getComputedStyle(el).position !== 'fixed') return;
        var r = el.getBoundingClientRect();
        if (r.height) bottom = Math.max(bottom, r.bottom + w.scrollY);
      });
      return Math.ceil(bottom + (parseFloat(w.getComputedStyle(d.body).marginBottom) || 0));
    } catch (e) { return 0; }
  }
  function fitItems() {
    var wrap = $('items-wrap'), fr = $('items-frame');
    var w = wrap.clientWidth;
    if (!w) return;
    var phone = window.innerWidth <= 900;
    var full = $('frames').classList.contains('items-only') && !phone;
    var natH = itemsNaturalHeight() || ITEMS_H;
    var availH = full ? wrap.clientHeight : ITEMS_H;
    var k = Math.min(1, w / ITEMS_W);
    if (!phone) k = Math.min(k, availH / natH);
    if (phone) { availH = Math.ceil(natH * k); wrap.style.height = availH + 'px'; }
    else wrap.style.height = '';
    if (k < 0.999) {
      fr.style.width = (w / k) + 'px';
      fr.style.height = (availH / k) + 'px';
      fr.style.transform = 'scale(' + k + ')';
    } else {
      fr.style.width = fr.style.height = fr.style.transform = '';
    }
    // Sub-pixel rounding can leave a 1px overflow; never show a scrollbar.
    try { $('items-frame').contentDocument.documentElement.style.overflow = 'hidden'; } catch (e) {}
  }
  var itemsTimer = null;
  function fitItemsSoon() { clearTimeout(itemsTimer); itemsTimer = setTimeout(fitItems, 60); }
  $('items-frame').addEventListener('load', function () {
    fitItemsSoon(); setTimeout(fitItems, 800);
    // Hutch's own −/+ size buttons change the grid size; refit when they do.
    try {
      var iw = $('items-frame').contentWindow, c = iw.document.querySelector('.tracker-container');
      if (c && iw.ResizeObserver) new iw.ResizeObserver(fitItemsSoon).observe(c);
    } catch (e) {}
  });
  window.addEventListener('resize', fitItemsSoon);
  document.querySelectorAll('aside .tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTimeout(fitItems, 0); });
  });

  // ── map: skip redraws when the game data hasn't changed ───────────────────
  // About once a second the item tracker sends the map a fresh item snapshot
  // and room data, and Hutch's map rewrites every marker on both worlds each
  // time, even when nothing changed. That restarts marker styling and shows
  // as a periodic flash. Drop updates identical to the previous one; any real
  // change (an item, a chest, a manual mark) still goes straight through.
  function installMapDedupe(w) {
    if (!w || w.__unifiedDedupe) return;
    w.__unifiedDedupe = true;
    var origRooms = w.onRoomsUpdated, lastRooms = null;
    if (typeof origRooms === 'function') {
      w.onRoomsUpdated = function (data) {
        try {
          if (data && lastRooms && data.length === lastRooms.length) {
            var same = true;
            for (var i = 0; i < data.length; i++) if (data[i] !== lastRooms[i]) { same = false; break; }
            if (same) return;
          }
          lastRooms = data ? Array.prototype.slice.call(data) : null;
        } catch (e) {}
        return origRooms.apply(this, arguments);
      };
    }
    var bc = w._bc;
    if (bc && typeof bc.onmessage === 'function') {
      // The item tracker alternates a full snapshot and a slimmer poll
      // snapshot (different key sets), so compare each one against the last
      // snapshot of the same shape rather than just the previous message.
      var origMsg = bc.onmessage, lastByShape = {};
      bc.onmessage = function (e) {
        if (e && e.data && e.data.type === 'items' && e.data.data) {
          try {
            var snap = e.data.data, keys = Object.keys(snap).sort();
            var shape = keys.join(','), sig = JSON.stringify(snap, keys);
            if (lastByShape[shape] === sig) return;
            lastByShape[shape] = sig;
          } catch (x) {}
        }
        return origMsg.call(this, e);
      };
    }
  }
  $('map-frame').addEventListener('load', function () {
    try { installMapDedupe($('map-frame').contentWindow); } catch (e) {}
  });

  // ── map auto-fit: always show Light AND Dark World ────────────────────────
  // Hutch draws each world at a fixed 512px side by side and clips overflow,
  // so in this panel the Dark World was cut off. Size both maps to fit the
  // frame, choosing side-by-side or stacked, whichever gives bigger maps.
  // Map markers are positioned in %, so any size works.
  function fitMap() {
    var f = $('map-frame'), d;
    try { d = f.contentDocument; } catch (e) { return; }
    if (!d) return;
    var outer = d.getElementById('maps-outer'), maps = d.getElementById('maps');
    if (!outer || !maps || !outer.clientWidth) return;
    var cs = d.defaultView.getComputedStyle(outer);
    var w = outer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var h = outer.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var gap = 12;
    var side = Math.min((w - gap) / 2, h);       // side by side
    var stack = Math.min(w, (h - gap) / 2);      // stacked
    var vertical = stack > side;
    var size = Math.max(120, Math.floor(vertical ? stack : side));
    maps.classList.toggle('vertical', vertical);
    var lbl = d.getElementById('layout-sel'); if (lbl) lbl.value = vertical ? 'vertical' : 'horizontal';
    d.querySelectorAll('.map-wrap').forEach(function (el) {
      el.style.width = size + 'px'; el.style.height = size + 'px';
    });
    outer.style.textAlign = 'center';
    // Sync Hutch's zoom control to the fitted size so its −/+ buttons step
    // from here (his steps now go down to 50%) and the label is accurate.
    try {
      var mw = f.contentWindow, pct = size / 512 * 100;
      if (mw.ZOOM_STEPS) {
        var idx = 0;
        mw.ZOOM_STEPS.forEach(function (z, i) { if (z <= pct + 0.5) idx = i; });
        mw.zoomIdx = idx;
      }
      var zl = d.getElementById('zoom-label'); if (zl) zl.textContent = Math.round(pct) + '%';
      // Hutch (Oct 5): markers keep full size down to 75%, then shrink with
      // the map. His applyZoom sets --mk; mirror it since we size directly.
      d.documentElement.style.setProperty('--mk', pct < 75 ? (pct / 75).toFixed(3) : '1');
    } catch (e) {}
  }
  var fitTimer = null;
  function fitMapSoon() { clearTimeout(fitTimer); fitTimer = setTimeout(fitMap, 60); }
  $('map-frame').addEventListener('load', function () {
    fitMapSoon(); setTimeout(fitMap, 800);   // again after Hutch's own init
    try {
      var w = $('map-frame').contentWindow;
      w.addEventListener('resize', fitMapSoon);
      // Hutch's bottom bar can wrap and change height; refit when it does.
      var bb = w.document.getElementById('bottombar');
      if (bb && w.ResizeObserver) new w.ResizeObserver(fitMapSoon).observe(bb);
    } catch (e) {}
  });
  window.addEventListener('resize', fitMapSoon);
  document.querySelectorAll('aside .tabs button').forEach(function (b) {
    b.addEventListener('click', fitMapSoon);
  });
})();
