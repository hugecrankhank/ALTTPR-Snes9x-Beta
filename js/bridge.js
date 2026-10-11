/*
 * window.AlttpBridge: answers usb2snes-style memory reads for the Hutch
 * tracker straight from the Snes9x core's memory. Because we build the
 * core ourselves, it exports pointers to WRAM, SRAM and ROM, so every read
 * is a direct view of live emulator memory. No snapshots, no heap search.
 *
 * usb2snes / SD2SNES address space:
 *   0x000000-0xDFFFFF  ROM   (file offset, copier header stripped)
 *   0xE00000-0xEFFFFF  SRAM  (cartridge save RAM)
 *   0xF50000-0xF6FFFF  WRAM  ($7E0000-$7FFFFF)
 */
(function () {
  'use strict';
  var WRAM_BASE = 0xF50000, SRAM_BASE = 0xE00000, WRAM_SIZE = 0x20000;
  var core = null, running = false, romName = '';
  var listeners = new Set();

  function status() {
    return { romLoaded: !!(core && core.loaded), running: running, mode: core && core.loaded && running ? 'live' : 'idle', romName: romName };
  }
  function emit() { var s = status(); listeners.forEach(function (fn) { try { fn(s); } catch (e) {} }); }

  function copy(out, src, off, len) {
    if (!src || off >= src.length) return;
    out.set(src.subarray(off, Math.min(off + len, src.length)));
  }

  function read(addr, len) {
    var out = new Uint8Array(len);
    if (!core || !core.loaded) return out;
    if (addr >= WRAM_BASE && addr < WRAM_BASE + WRAM_SIZE) copy(out, core.wram(), addr - WRAM_BASE, len);
    else if (addr >= SRAM_BASE && addr < 0xF00000) copy(out, core.sram(), addr - SRAM_BASE, len);
    else if (addr < SRAM_BASE) copy(out, core.rom(), addr, len);
    return out;
  }

  window.AlttpBridge = {
    read: read,
    ready: function () { return !!(core && core.loaded && running); },
    status: status,
    deviceName: 'Snes9x (built-in)',
    attach: function (c, name) { core = c; romName = name || ''; emit(); },
    setRunning: function (r) { if (running !== r) { running = r; emit(); } },
    invalidate: function () {},
    onStatus: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
    // Debug helper: AlttpBridge.peek(0x7EF340, 16)
    peek: function (snesAddr, len) {
      var a = (snesAddr >= 0x7E0000 && snesAddr < 0x800000) ? WRAM_BASE + (snesAddr - 0x7E0000) : snesAddr;
      return Array.from(read(a, len || 16), function (b) { return b.toString(16).padStart(2, '0'); }).join(' ');
    },
  };
})();
