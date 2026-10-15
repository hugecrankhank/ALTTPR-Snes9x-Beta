# Crowd effects (TikTok LIVE)

Viewers' gifts, likes, follows and shares change your game: hearts, magic,
rupees, bombs, arrows, inverted controls, no sword and more. The ROM is never
changed; any seed works.

```
TikTok LIVE ──► TikFinity ──ws://localhost:21213──► bridge.mjs ──ws://localhost:21214──► game page ──► Snes9x RAM / buttons
```

- `effects.js` runs in the game page. It queues effects and applies them only
  in normal play (not in menus, text boxes or screen transitions), about
  0.75 s apart, and shows a small feed on the game picture.
- `bridge/bridge.mjs` runs on the PC you stream from. It hears your LIVE
  through TikFinity (free) and forwards events using `bridge/mapping.json`.

## Setup

1. Install Node.js 20 or newer, and **TikFinity** (free, https://tikfinity.zerody.one).
2. Open TikFinity, log in with your TikTok account, and leave it running. Its
   Events API / WebSocket port should be 21213 (the default).
3. In `crowd/bridge`: double-click `start-bridge.bat` (or run `node bridge.mjs`).
   No `npm install` is needed in TikFinity mode. Full steps: `bridge/INSTRUCTIONS.txt`.
   (Windows PowerShell: use `npm.cmd install` / `npm.cmd start` if `npm` is blocked.)
   It should print *connected to TikFinity*.
4. In the game on the **same PC**: ⋯ menu → **Crowd effects** → turn on, with
   the address `ws://localhost:21214`. The status line should say
   *connected*. If the browser asks to allow access to devices on your local
   network, allow it.
5. Go live. Map gifts to effects in `mapping.json`.

Every gift that arrives is printed in the bridge window with its exact name,
even unmapped ones, so you can copy names into `mapping.json`. The file
reloads by itself when you save it.

## Testing without going live

- `npm run test-mode`, then type `gift Rose 3`, `like 600`, `follow`, or an
  effect id like `invert`.
- Or use the test buttons in ⋯ menu → Crowd effects (no bridge needed).

## Effects

| id | effect | | id | effect (timed) |
|---|---|---|---|---|
| `heal_full` | Full heal | | `invert` | Inverted D-pad, 20 s |
| `heal_1` | +1 heart | | `no_sword` | No sword, 20 s |
| `hurt_2` | −2 hearts (never kills) | | `no_item` | No Y item, 20 s |
| `hp_1` | Down to 1 heart | | `swap_by` | B and Y swapped, 20 s |
| `magic_full` / `magic_drain` | Refill / drain magic | | `one_hit` | One-heart mode, 30 s |
| `rupees_plus` / `rupees_minus` | ±50 rupees | | `no_magic` | Magic locked, 30 s |
| `bombs_plus` / `bombs_none` | +10 / lose all bombs | | `ice` | Ice physics (slippery floors everywhere), 20 s |
| `enemy_spawn` | Extra enemy (copies one already in the room) | | | |
| `insta_kill` | Instant death (a bottled fairy still saves you) | | | |
| `seed_preset` / `seed_chaos` | Random preset / CHAOS seed (see below) | | | |
| `arrows_plus` / `arrows_none` | +10 / lose all arrows | | `cucco_storm` | Cucco attack: angry cuccos fly at Link, 30 s of outdoor time (the clock pauses indoors) |

**App rolls** (use the app's own buttons):

| id | effect |
|---|---|
| `sprite_roll` | Random sprite from the whole library (changes Link right away) |
| `sprite_fav` | Random sprite from your ★ favourites |
| `msu_roll` | Random MSU-1 pack from your ★ favourite packs |
| `seed_roll` | **New seed** with the current Randomizer settings — ends the current game |

`seed_roll` is off until you check **Allow seed reroll** in ⋯ menu → Crowd
effects. When it fires, a banner on the game shows who sent it and counts
down 10 seconds, then shows the seed being made and the result (with the
seed's code). A **Cancel new seed** button appears in that menu during the
countdown. The banner can be turned off there too. If a roll can't happen (no favourites
yet, no packs), the feed says so instead of popping up a dialog.

Timed effects count only time spent in play and stack (a second gift adds
time). `ice` and `cucco_storm` switch on features built into the randomizer
ROM itself; on a ROM without them the feed says so and nothing happens. They only filter buttons or hold a value each frame, so save states,
resets and reloads can't leave the game stuck changed.

## Seed rolls by coins

`coinTiers` in mapping.json: a donation worth at least that many coins (gift
value × streak count) does that effect instead of the gift's own; the highest
tier reached wins. Defaults: 1000 `seed_roll` (same settings), 1200
`seed_preset` (a random preset from Saved presets: your ★ ones if any, else
all but glitched-logic ones), 2000 `seed_chaos` (random generator, every menu
randomized except glitched logic, race, AVIANART timer modes and Kara's
damage challenge; up to 3 tries). The randomizer side is
`window.UnifiedRando.crowd` in `randomizer/app.js`.

## Subathon clock

The bridge keeps a countdown (`timer-state.json`, restored paused on restart).
Control page: `http://localhost:21214/timer/control` (set, start, pause,
adjust; it sends an `x-ccbridge` header, which other sites can't). Every coin
adds `1 / timer.coinsPerSecond` seconds (fractions carry over between donations;
the older `secondsPerCoin` still works) while the clock is set and not finished.
It shows on the game (bottom centre, can be turned off in Crowd effects) and
as an OBS source at `/timer` (`?size=`, `?bg=0`, `?label=0`).

## Scrolling gift list (OBS)

While the bridge runs, `http://localhost:21214/ticker` is a scrolling bar of
every mapped gift and its effect, for an OBS browser source or a TikTok LIVE
Studio link source. `?height=`, `?speed=` and `?bg=0` adjust it. Gift
pictures come from `bridge/icons/<Gift name>.png`.

## mapping.json

- `gifts`: gift name (any case) or gift id → effect id.
- `likes`: `{ "every": 300, "effect": "heal_1" }` fires once per 300 likes.
- `follow`, `share`: effect id; once per viewer per 10 minutes.
- `durations`: seconds for timed effects, e.g. `{ "one_hit": 20 }`.
- `ticker`: `title`, `speed`, and `labels` (nicer effect names) for the gift list.
- `maxPerGift`: cap for a gift streak (e.g. 20 Roses still gives 5 heals).
- `source`: `"tikfinity"` (default) or `"direct"`. Direct mode connects to
  TikTok without TikFinity, using `tiktok-live-connector` and needs `username`,
  `signServer` (`"euler"` or an `https://` sign server) and a paid
  `signApiKey`.
- `port`: the bridge's own port (default 21214; 21213 is TikFinity's).
- `allowedOrigins`: pages allowed to connect to the bridge.

## Good to know

- **Phone play:** a page on `https://` can only reach `ws://localhost`, so the
  game must run on the PC with the bridge. To play on a phone, put the bridge
  behind an `https` tunnel (for example
  `cloudflared tunnel --url http://localhost:21214`) and set the menu's bridge
  address to the `wss://…` address it prints, and add the game's origin to
  `allowedOrigins` if you open it from somewhere else.
- **TikTok connection:** TikTok requires every LIVE connection to be signed by
  an outside sign server. Euler Stream (used by `tiktok-live-connector`) and
  tik.tools both charge for this now, which is why the default goes through
  TikFinity, which handles the TikTok side for free.
- Not for races: this changes the game mid-run.
