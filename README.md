# ALTTPR Snes9x — Snes9x + Hutch tracker in one page

A Link to the Past Randomizer running on **Snes9x compiled to WebAssembly**,
with the Hutch-ALTTPR item and map trackers autotracking alongside it.
Works on desktop and phones, installs as an app, and needs no SNI,
QUsb2Snes, Lua scripts, or second window.

This is a separate project from ALTTPR Unified. That one runs Snes9x inside
EmulatorJS; this one builds Snes9x itself, which removes the middle layer.

## What you get

- **Graphics filters**: 6xBRZ (default), 4xBRZ, Sharp pixels, Smooth,
  Sharp bilinear, CRT. These are the libretro GLSL shaders running on the GPU,
  so 6xBRZ looks the same as RetroArch's.
- **Phone controls**: D-pad with diagonals, ABXY (slide between buttons,
  or press the gap to hit two at once), L/R, Select/Start, adjustable opacity,
  vibration on Android. Portrait puts the controls under the game with the
  tracker below; landscape goes full-screen with the tracker in a drawer.
- **Controllers and keyboard**: any standard Bluetooth/USB pad works on its
  own. Keys: arrows, Z/X/A/S = B/A/Y/X, Q/W = L/R, Enter = Start,
  Backspace = Select, Tab = fast-forward, P = pause, F5/F8 = save/load state.
- **Saves**: in-game saves are kept automatically per seed; 4 save-state
  slots per seed; the last ROM is remembered so you can tap **Continue**.
- **Tracker**: Hutch's item and map trackers, unmodified apart from one
  script line, with the Items/Map tabs, auto-fit and flicker fix from
  ALTTPR Unified.
- Installable (PWA), keeps the screen awake while playing, pauses and saves
  when you switch apps, works offline after the first visit.

## Run it

Serve the folder over HTTP (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8080      # or: npx serve .
```

Open http://localhost:8080 and tap **Load ROM…**. Pushing to `main` deploys
to GitHub Pages through `.github/workflows/deploy.yml`.

Get a seed at https://alttpr.com/en/randomizer using your own Japanese 1.0
ROM. Set **World** and **Dungeon items** in ⚙ Settings to match the seed.

## How it works

```
index.html
├── core/snes9x.wasm      libretro Snes9x, built with wasi-sdk (no Emscripten)
│   └── core/glue.cpp     tiny libretro frontend; exports run/frame/audio/RAM/state
├── js/core.js            loads the wasm, minimal WASI shim
├── js/video.js           WebGL2 multi-pass shader runner (shaders/*.glsl)
├── js/audio.js + audio-worklet.js   resampling with drift correction
├── js/input.js           keyboard, gamepads, touch
├── js/bridge.js          AlttpBridge: usb2snes reads straight from core memory
└── tracker/ (Hutch)  ←  bridge/sni-shim.js swaps its WebSocket for the bridge
```

The core exports pointers to WRAM, SRAM and ROM, so the tracker reads live
memory directly: no save-state snapshots and no heap search.

Debug in the browser console:

```js
AlttpBridge.peek(0x7EF340, 32)   // inventory bytes
S9X.core.fps                     // 60.0988
```

## Rebuilding the core

`core/snes9x.wasm` is committed, so you don't need to build anything to run
the site. To rebuild it:

```bash
git clone https://github.com/libretro/snes9x
# wasi-sdk 25: https://github.com/WebAssembly/wasi-sdk/releases
WASI_SDK=/path/to/wasi-sdk-25.0-x86_64-linux SNES9X=/path/to/snes9x ./core/build.sh
```

## Credits and licenses

- **Snes9x** (libretro port): Snes9x license, free for non-commercial use;
  see `core/LICENSES/snes9x-LICENSE`. Source commit in `core/SNES9X_SOURCE.txt`.
- **Tracker**: [Hutch-ALTTPR Tracker](https://github.com/hutchch/ALTTPR-Tracker)
  by hutchch, MIT (`tracker/LICENSE`).
- **Shaders**: [libretro/glsl-shaders](https://github.com/libretro/glsl-shaders);
  each file keeps its license header (xBRZ is GPL-3.0).
- No ROMs are included. Use your own legally obtained copy.
