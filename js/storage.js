/*
 * IndexedDB storage: the last ROM (so phones can resume without picking the
 * file again), in-game saves (SRAM) and save-state slots, keyed by the
 * ROM's SHA-256 so every seed keeps its own saves. Nothing leaves the device.
 */
(function () {
  'use strict';
  var DB = 'alttpr-snes9x', VER = 1, dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        ['kv', 'sram', 'states'].forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        var r = fn(s);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  var S = {
    get: function (store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); },
    put: function (store, key, val) { return tx(store, 'readwrite', function (s) { return s.put(val, key); }); },
    del: function (store, key) { return tx(store, 'readwrite', function (s) { return s.delete(key); }); },
    hash: function (bytes) {
      if (!crypto.subtle) {   // plain-http LAN testing: subtle isn't available, use FNV-1a
        var h = 0x811c9dc5; for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
        return Promise.resolve('fnv' + (h >>> 0).toString(16) + '-' + bytes.length);
      }
      return crypto.subtle.digest('SHA-256', bytes).then(function (b) {
        return Array.from(new Uint8Array(b), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      });
    },
  };
  window.EmuStore = S;
})();
